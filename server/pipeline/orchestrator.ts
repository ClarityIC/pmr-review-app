/**
 * Pipeline orchestrator — coordinates Steps 1–5 for one or more uploaded files.
 *
 * Path 1 (sync): Steps 1–3 run per-file sequentially.
 * Path 2 (async LRO): Step 1 runs per-file, Step 2 batches ALL chunks into
 *   a single pair of LROs, Step 3 runs per-file to reassemble.
 * Steps 4–5 run once after all files are ingested, querying the full case corpus.
 *
 * SSE log streaming: emits structured log events per caseId so the frontend
 * can show real-time progress in the log drawer.
 */
import { EventEmitter } from 'events';
import { statSync, unlinkSync, readFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';
import { FieldValue } from '@google-cloud/firestore';
import { step1 } from './step1-chunk.js';
import type { ProcessingPath } from './step1-chunk.js';
import { step2, pollLRO } from './step2-docai.js';
import type { DocAIResult } from './step2-docai.js';
import { step3 } from './step3-reassemble.js';
import { step4 } from './step4-table1.js';
import { step5 } from './step5-table2.js';
import { updateCase, addFileToCase, getCase, TableVersion } from '../cases.js';
import type { PipelineCheckpoint } from '../cases.js';
import { getFirestore, getDocAI } from '../config.js';
import { BUCKET_AUTH, BUCKET_OUTPUT, deletePrefix, listChunkRefs } from '../gcs.js';
import { ensureTable0Exists, deleteCaseRows } from '../bigquery.js';

export type LogLevel = 'info' | 'success' | 'error' | 'warn';
export type Log = (level: LogLevel, message: string) => void;

// Global SSE emitter — keyed by caseId
export const pipelineEmitter = new EventEmitter();
pipelineEmitter.setMaxListeners(100);

// Track active runs for deduplication — keyed by caseId
const activeRuns = new Set<string>();

// Track active DocAI LRO operation names — keyed by caseId
const activeLRONames = new Map<string, string[]>();

/** Expose active LRO names for the admin operations monitor. */
export function getActiveLRONames(): ReadonlyMap<string, string[]> {
  return activeLRONames;
}

// Track runs that have been cancelled (so pipeline steps can bail out)
const cancelledRuns = new Set<string>();

// Per-run sequence counter — makes each Firestore log entry unique for arrayUnion
const logSeqs = new Map<string, number>();

/**
 * Persist active LRO names to Firestore so they survive server restarts.
 * Called when LROs are started; cleared when they complete or are cancelled.
 */
async function persistLRONames(caseId: string, names: string[]): Promise<void> {
  try {
    await getFirestore().collection('cases').doc(caseId)
      .update({ activeLRONames: names });
  } catch {}
}

async function clearPersistedLRONames(caseId: string): Promise<void> {
  try {
    await getFirestore().collection('cases').doc(caseId)
      .update({ activeLRONames: [] });
  } catch {}
}

/**
 * Retrieve LRO names from Firestore (fallback when in-memory map is empty,
 * e.g. after a server restart).
 */
export async function getPersistedLRONames(caseId: string): Promise<string[]> {
  try {
    const doc = await getFirestore().collection('cases').doc(caseId).get();
    return doc.data()?.activeLRONames || [];
  } catch { return []; }
}

/**
 * Cancel any active DocAI LROs for a case and mark the run as cancelled.
 * Safe to call even if no pipeline is running. Falls back to Firestore
 * if the in-memory map is empty (e.g. after a server restart).
 */
/** Persist pipeline checkpoint to Firestore so the pipeline can resume after server restart. */
async function writeCheckpoint(caseId: string, cp: PipelineCheckpoint): Promise<void> {
  try {
    await getFirestore().collection('cases').doc(caseId)
      .update({ pipelineCheckpoint: cp });
  } catch {}
}

export async function cancelPipeline(caseId: string): Promise<void> {
  emitLog(caseId, 'warn', 'Cancellation requested — stopping pipeline…');
  cancelledRuns.add(caseId);
  let lros = activeLRONames.get(caseId) || [];
  activeLRONames.delete(caseId);

  // Fallback: read from Firestore if in-memory map was empty (post-restart)
  if (lros.length === 0) {
    lros = await getPersistedLRONames(caseId);
  }

  if (lros.length > 0) {
    emitLog(caseId, 'warn', `Cancelling ${lros.length} active Document AI operation(s)…`);
    const docai = getDocAI();
    await Promise.all(
      lros.map(name =>
        (docai.operationsClient as any).cancelOperation({ name }).catch(() => {}),
      ),
    );
    console.log(`[pipeline] Cancelled ${lros.length} DocAI LRO(s) for case ${caseId}`);
  }

  await clearPersistedLRONames(caseId);
  // Clear checkpoint — user explicitly cancelled, don't resume on restart
  try {
    await getFirestore().collection('cases').doc(caseId)
      .update({ pipelineCheckpoint: null });
  } catch {}
  emitLog(caseId, 'warn', 'Pipeline cancelled successfully.');
}

export function emitLog(caseId: string, level: LogLevel, message: string) {
  const seq = (logSeqs.get(caseId) ?? 0) + 1;
  logSeqs.set(caseId, seq);
  const entry = { level, message, timestamp: new Date().toISOString(), seq };
  pipelineEmitter.emit(`log:${caseId}`, entry);
  // Persist to Firestore so any Cloud Run instance can replay on SSE reconnect
  try {
    getFirestore().collection('cases').doc(caseId)
      .update({ processingLogs: FieldValue.arrayUnion(entry) })
      .catch(() => {});
  } catch {}
  const prefix = level === 'error' ? '✗' : level === 'success' ? '✓' : level === 'warn' ? '⚠' : '·';
  console.log(`[pipeline:${caseId.slice(0, 8)}] ${prefix} ${message}`);
}

export interface FileInput {
  fileId: string;
  fileName: string;
  localFilePath: string;
}

export interface RunOptions {
  caseId: string;
  files: FileInput[];
  createdBy: string;
  reprocess?: boolean;   // if true, delete existing Table 0 rows first
}

/**
 * Run the full 5-step pipeline for one or more uploaded files.
 * Steps 1–3 execute per-file; Steps 4–5 execute once for the whole case.
 * This runs asynchronously — callers should not await it directly
 * (the HTTP response returns immediately; progress flows via SSE).
 */
export async function runPipeline(opts: RunOptions): Promise<void> {
  const { caseId, files, reprocess } = opts;

  if (activeRuns.has(caseId)) {
    console.warn(`[pipeline] Duplicate run ignored for case ${caseId}`);
    return;
  }
  activeRuns.add(caseId);
  cancelledRuns.delete(caseId); // clear any stale cancel flag from a previous run
  logSeqs.delete(caseId); // reset sequence counter for this run
  // Clear any previous run's logs in Firestore
  try {
    getFirestore().collection('cases').doc(caseId)
      .update({ processingLogs: [] })
      .catch(() => {});
  } catch {}

  // Track which temp files still need cleanup (removed inline after each step3)
  const pendingCleanup = new Set(files.map(f => f.localFilePath));

  const log: Log = (level, message) => emitLog(caseId, level, message);
  const isCancelled = () => cancelledRuns.has(caseId);

  // Track progress for error reporting
  let currentFileIndex = 0;
  let currentStep = '';

  try {
    await updateCase(caseId, { status: 'processing' });
    log('info', `Pipeline started for ${files.length} file(s): ${files.map(f => f.fileName).join(', ')}`);

    // Ensure BigQuery Table 0 exists (idempotent)
    await ensureTable0Exists();

    // If re-processing, clean up old rows before ingesting new ones
    if (reprocess) {
      log('warn', '[Pipeline] Re-processing — deleting existing Table 0 rows for this case');
      await deleteCaseRows(caseId);
    }

    // ── Pre-scan total pages to determine processing path ─────────────────────
    let totalPages = 0;
    for (const f of files) {
      const bytes = readFileSync(f.localFilePath);
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      totalPages += pdf.getPageCount();
    }
    const totalSizeMB = files.reduce((sum, f) => sum + statSync(f.localFilePath).size, 0) / (1024 * 1024);
    const estChunkMB  = totalPages > 0 ? (totalSizeMB / totalPages) * 15 : 0;
    const processingPath: ProcessingPath =
      totalPages <= 150 && estChunkMB <= 40 ? 'path1-sync' : 'path2-async';
    log(
      'info',
      `Total pages: ${totalPages} → ${processingPath === 'path1-sync'
        ? 'Path 1 (synchronous — fast)'
        : 'Path 2 (async LRO)'}`,
    );

    // Write initial checkpoint so resume-on-restart knows the processing path
    const checkpoint: PipelineCheckpoint = {
      processingPath, totalPages,
      step1Complete: false, step2Complete: false, step3Complete: false,
    };
    await writeCheckpoint(caseId, checkpoint);

    // ── Steps 1–3: Per-file ingestion ─────────────────────────────────────────

    if (processingPath === 'path2-async') {
      // ── Path 2: batch all chunks into a single pair of LROs ───────────────
      // Phase A: run all step1s and register files
      const fileResults: Array<{ fileId: string; fileName: string; chunks: import('./step1-chunk.js').ChunkRef[] }> = [];
      for (let i = 0; i < files.length; i++) {
        currentFileIndex = i;
        const { fileId, fileName, localFilePath } = files[i];
        log('info', `Processing file ${i + 1}/${files.length}: ${fileName}`);

        currentStep = 'Step 1 (upload + chunking)';
        if (isCancelled()) throw new Error('Processing was cancelled.');
        const step1Result = await step1(localFilePath, caseId, fileId, fileName, processingPath, log);

        await addFileToCase(caseId, {
          id: fileId,
          name: fileName,
          gcsPath: `cases/${caseId}/${fileId}/${fileName}`,
          gcsBucket: BUCKET_AUTH(),
          sizeBytes: statSync(localFilePath).size,
          uploadedAt: new Date().toISOString(),
        });

        fileResults.push({ fileId, fileName, chunks: step1Result.chunks });

        // Clean up local temp file — GCS staging has the chunks for LRO
        try { unlinkSync(localFilePath); } catch {}
        pendingCleanup.delete(localFilePath);
      }

      // All files chunked and registered — checkpoint Step 1 complete
      checkpoint.step1Complete = true;
      await writeCheckpoint(caseId, checkpoint);

      // Phase B: single batched step2 with all chunks from all files
      currentStep = 'Step 2 (Document AI processing)';
      if (isCancelled()) throw new Error('Processing was cancelled.');
      const allChunks = fileResults.flatMap(fr => fr.chunks);
      log('info', `[Step 2] Batching ${allChunks.length} chunk(s) from ${fileResults.length} file(s) into a single LRO pair`);
      const step2Result = await step2(allChunks, caseId, processingPath, log, {
        isCancelled,
        onLROsStarted: (names) => { activeLRONames.set(caseId, names); persistLRONames(caseId, names); },
      });

      // Checkpoint Step 2 complete — store output prefixes for resume
      checkpoint.step2Complete = true;
      if (step2Result.path === 'path2-async') {
        checkpoint.ocrOutputPrefix = step2Result.ocrOutputPrefix;
        checkpoint.layoutOutputPrefix = step2Result.layoutOutputPrefix;
      }
      await writeCheckpoint(caseId, checkpoint);

      // Phase C: per-file step3
      let chunkOffset = 0;
      for (let i = 0; i < fileResults.length; i++) {
        currentFileIndex = i;
        const fr = fileResults[i];
        currentStep = `Step 3 (reassembly + BigQuery ingestion — ${fr.fileName})`;
        if (isCancelled()) throw new Error('Processing was cancelled.');
        await step3(fr.chunks, step2Result, caseId, fr.fileId, fr.fileName, log, {
          globalChunkOffset: chunkOffset,
        });
        chunkOffset += fr.chunks.length;
      }

      // Checkpoint Step 3 complete (DocAI output scrubbing deferred to after pipeline success)
      checkpoint.step3Complete = true;
      await writeCheckpoint(caseId, checkpoint);

    } else {
      // ── Path 1: per-file sequential (sync processDocument, no LROs) ───────
      for (let i = 0; i < files.length; i++) {
        currentFileIndex = i;
        const { fileId, fileName, localFilePath } = files[i];
        log('info', `Processing file ${i + 1}/${files.length}: ${fileName}`);

        currentStep = 'Step 1 (upload + chunking)';
        if (isCancelled()) throw new Error('Processing was cancelled.');
        const step1Result = await step1(localFilePath, caseId, fileId, fileName, processingPath, log);

        await addFileToCase(caseId, {
          id: fileId,
          name: fileName,
          gcsPath: `cases/${caseId}/${fileId}/${fileName}`,
          gcsBucket: BUCKET_AUTH(),
          sizeBytes: statSync(localFilePath).size,
          uploadedAt: new Date().toISOString(),
        });

        // Mark step1 complete after last file is registered
        if (i === files.length - 1) {
          checkpoint.step1Complete = true;
          await writeCheckpoint(caseId, checkpoint);
        }

        currentStep = 'Step 2 (Document AI processing)';
        if (isCancelled()) throw new Error('Processing was cancelled.');
        const step2Result = await step2(step1Result.chunks, caseId, processingPath, log, {
          isCancelled,
          onLROsStarted: (names) => { activeLRONames.set(caseId, names); persistLRONames(caseId, names); },
        });

        currentStep = 'Step 3 (reassembly + BigQuery ingestion)';
        if (isCancelled()) throw new Error('Processing was cancelled.');
        await step3(step1Result.chunks, step2Result, caseId, fileId, fileName, log);

        try { unlinkSync(localFilePath); } catch {}
        pendingCleanup.delete(localFilePath);
      }

      // All files complete through step 3 for Path 1
      checkpoint.step1Complete = true;
      checkpoint.step2Complete = true;
      checkpoint.step3Complete = true;
      await writeCheckpoint(caseId, checkpoint);
    }

    // ── Step 4: Table 1 generation (whole case) ───────────────────────────────
    currentStep = 'Step 4 (Table 1 generation)';
    if (isCancelled()) throw new Error('Processing was cancelled.');
    const caseData = await getCase(caseId);
    const t1Prompt = caseData?.table1Prompt;
    const { rows: table1Rows, markdownTable: table1Md } = await step4(
      caseId,
      t1Prompt,
      log,
    );

    await updateCase(caseId, { table1: table1Rows, table1Markdown: table1Md });

    // ── Step 5: Table 2 generation (whole case) ───────────────────────────────
    currentStep = 'Step 5 (Table 2 generation)';
    if (isCancelled()) throw new Error('Processing was cancelled.');
    const t2Prompt = caseData?.table2Prompt;
    const { rows: table2Rows, markdownTable: table2Md } = await step5(
      caseId,
      table1Md,
      t2Prompt,
      log,
    );

    // ── Finalise ──────────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const t1Version: TableVersion = {
      version: 1, rows: table1Rows, markdownTable: table1Md,
      prompt: t1Prompt || 'default', generatedAt: now, generatedBy: opts.createdBy,
    };
    const t2Version: TableVersion = {
      version: 1, rows: table2Rows, markdownTable: table2Md,
      prompt: t2Prompt || 'default', generatedAt: now, generatedBy: opts.createdBy,
    };

    await updateCase(caseId, {
      status: 'complete',
      table1: table1Rows,
      table2: table2Rows,
      table1Markdown: table1Md,
      table2Markdown: table2Md,
      table1Versions: [t1Version],
      table2Versions: [t2Version],
      table1ActiveVersion: 0,
      table2ActiveVersion: 0,
      dateProcessed: now,
      totalPages,
      pipelineCheckpoint: null, // clear — pipeline complete
    } as any);

    log('success', `Pipeline complete! Table 1: ${table1Rows.length} records, Table 2: ${table2Rows.length} conditions`);

    // ── Final cleanup: scrub DocAI outputs now that pipeline succeeded ──────
    if (checkpoint.ocrOutputPrefix || checkpoint.layoutOutputPrefix) {
      log('info', 'Scrubbing DocAI output staging (pipeline complete)');
      if (checkpoint.ocrOutputPrefix) {
        await deletePrefix(BUCKET_OUTPUT(), checkpoint.ocrOutputPrefix).catch(() => {});
      }
      if (checkpoint.layoutOutputPrefix) {
        await deletePrefix(BUCKET_OUTPUT(), checkpoint.layoutOutputPrefix).catch(() => {});
      }
    }

  } catch (err: any) {
    const msg = err?.message || String(err);
    if (cancelledRuns.has(caseId)) {
      // Cancel endpoint already set status → 'draft'; don't overwrite with 'error'
      log('warn', 'Processing was cancelled.');
    } else {
      log('error', `Pipeline failed during ${currentStep || 'initialization'}: ${msg}`);

      // Log which file was active and which files were never processed
      if (files.length > 1) {
        const failedFile = files[currentFileIndex];
        if (failedFile) {
          log('error', `Failed while processing file ${currentFileIndex + 1}/${files.length}: ${failedFile.fileName}`);
        }
        const skippedFiles = files.slice(currentFileIndex + 1);
        if (skippedFiles.length > 0) {
          const skippedNames = skippedFiles.map(f => f.fileName).join(', ');
          log('error', `${skippedFiles.length} file(s) never processed: ${skippedNames}`);
        }
      }

      console.error('[pipeline] Fatal error:', err);
      const detailedMsg = `${currentStep || 'Pipeline'} failed on file "${files[currentFileIndex]?.fileName || 'unknown'}": ${msg}`;
      await updateCase(caseId, { status: 'error', errorMessage: detailedMsg }).catch(() => {});
    }
  } finally {
    activeRuns.delete(caseId);
    activeLRONames.delete(caseId);
    // Only clear persisted LRO names if the run completed or was cancelled.
    // On error, leave them so resume-on-restart can pick up the LROs.
    if (!cancelledRuns.has(caseId)) {
      // Check if we completed successfully (checkpoint cleared = complete)
      const snap = await getFirestore().collection('cases').doc(caseId).get().catch(() => null);
      const cp = snap?.data()?.pipelineCheckpoint;
      if (!cp) {
        // Pipeline completed — safe to clear LRO names
        clearPersistedLRONames(caseId);
      }
      // If checkpoint still exists, pipeline errored — leave LRO names for resume
    } else {
      // Cancelled — LRO names already cleared in cancelPipeline()
    }
    cancelledRuns.delete(caseId);
    // Clean up any temp files that weren't removed inline (e.g. pipeline failed before step 3)
    for (const p of pendingCleanup) {
      try { unlinkSync(p); } catch {}
    }
  }
}

// ── Resume pipeline after server restart ────────────────────────────────────

/**
 * Resume a pipeline that was interrupted by a server restart.
 * Reads the pipelineCheckpoint from Firestore and picks up at the last completed step.
 * Called from startup recovery in server.ts.
 */
export async function resumePipeline(caseId: string): Promise<void> {
  if (activeRuns.has(caseId)) {
    console.warn(`[resume] Duplicate resume ignored for case ${caseId}`);
    return;
  }
  activeRuns.add(caseId);
  cancelledRuns.delete(caseId);
  logSeqs.delete(caseId);

  // Clear old processing logs so the user sees a fresh resume stream
  try {
    await getFirestore().collection('cases').doc(caseId)
      .update({ processingLogs: [] });
  } catch {}

  const log: Log = (level, message) => emitLog(caseId, level, message);
  const isCancelled = () => cancelledRuns.has(caseId);
  let currentStep = 'resume initialization';

  try {
    const caseData = await getCase(caseId);
    if (!caseData) throw new Error('Case not found');
    const cp = caseData.pipelineCheckpoint;
    if (!cp) throw new Error('No pipeline checkpoint — cannot resume');
    if (!cp.step1Complete) throw new Error('Step 1 incomplete — cannot resume without local files');

    log('info', `Resuming pipeline after server restart (path: ${cp.processingPath}, totalPages: ${cp.totalPages})`);
    log('info', `Checkpoint: step1=${cp.step1Complete}, step2=${cp.step2Complete}, step3=${cp.step3Complete}`);

    await ensureTable0Exists();

    const cancelOpts = {
      isCancelled,
      onLROsStarted: (names: string[]) => { activeLRONames.set(caseId, names); persistLRONames(caseId, names); },
    };

    // ── Resume Step 2 if needed ─────────────────────────────────────────────
    if (!cp.step2Complete) {
      currentStep = 'Step 2 (Document AI processing — resume)';
      if (isCancelled()) throw new Error('Processing was cancelled.');

      if (cp.processingPath === 'path2-async') {
        // Check if LROs are still running or already done
        const lroNames = await getPersistedLRONames(caseId);

        if (lroNames.length > 0) {
          log('info', `[Resume] Found ${lroNames.length} persisted LRO name(s) — checking status`);
          const docai = getDocAI();

          // Check status of each LRO
          const statuses = await Promise.all(lroNames.map(async (name) => {
            try {
              const [op] = await (docai.operationsClient as any).getOperation({ name });
              return { name, done: op.done, error: op.error, metadata: op.metadata };
            } catch (e: any) {
              return { name, done: false, error: { message: e.message }, metadata: null };
            }
          }));

          const failed = statuses.filter(s => s.done && s.error);
          if (failed.length > 0) {
            throw new Error(`DocAI LRO failed: ${JSON.stringify(failed[0].error)}`);
          }

          const stillRunning = statuses.filter(s => !s.done);
          if (stillRunning.length > 0) {
            log('info', `[Resume] ${stillRunning.length} LRO(s) still running — resuming polling`);
            await Promise.all(stillRunning.map(s => {
              const label = s.name.includes('ocr') || lroNames.indexOf(s.name) === 0 ? 'OCR' : 'Layout';
              return pollLRO(docai, s.name, label, log, isCancelled);
            }));
          }

          const allDone = statuses.filter(s => s.done && !s.error);
          if (allDone.length > 0) {
            log('success', `[Resume] ${allDone.length} LRO(s) already completed before restart`);
          }

          log('success', '[Resume] All Document AI LROs complete');
        } else {
          // No LRO names — step2 was never started or LROs weren't persisted
          // Reconstruct chunks and re-run step2
          log('info', '[Resume] No persisted LRO names — re-running Step 2');
          const allChunks: Array<{ chunkId: string; chunkIndex: number; absolutePageOffset: number; pageCount: number; gcsUri: string }> = [];
          for (const file of caseData.files) {
            const chunks = await listChunkRefs(caseId, file.id);
            if (chunks.length === 0) throw new Error(`No staging chunks for file "${file.name}" — cannot resume`);
            allChunks.push(...chunks);
          }
          const step2Result = await step2(allChunks, caseId, cp.processingPath, log, cancelOpts);
          if (step2Result.path === 'path2-async') {
            cp.ocrOutputPrefix = step2Result.ocrOutputPrefix;
            cp.layoutOutputPrefix = step2Result.layoutOutputPrefix;
          }
        }

        // Ensure output prefixes are set (from checkpoint or from deterministic path)
        if (!cp.ocrOutputPrefix) cp.ocrOutputPrefix = `cases/${caseId}/docai-output/ocr/`;
        if (!cp.layoutOutputPrefix) cp.layoutOutputPrefix = `cases/${caseId}/docai-output/layout/`;

      } else {
        // Path 1 sync — in-memory docs lost, re-run step2 + step3 per file
        log('info', '[Resume] Path 1: re-running Step 2 + Step 3 from staging chunks');
        await deleteCaseRows(caseId); // ensure idempotency

        for (const file of caseData.files) {
          if (isCancelled()) throw new Error('Processing was cancelled.');
          const chunks = await listChunkRefs(caseId, file.id);
          if (chunks.length === 0) throw new Error(`No staging chunks for file "${file.name}" — cannot resume`);

          log('info', `[Resume] Re-processing file: ${file.name} (${chunks.length} chunk(s))`);
          const step2Result = await step2(chunks, caseId, 'path1-sync', log, cancelOpts);
          await step3(chunks, step2Result, caseId, file.id, file.name, log);
        }

        cp.step2Complete = true;
        cp.step3Complete = true;
        await writeCheckpoint(caseId, cp);
      }

      if (cp.processingPath === 'path2-async') {
        cp.step2Complete = true;
        await writeCheckpoint(caseId, cp);
      }
    }

    // ── Resume Step 3 if needed (Path 2 only — Path 1 handled above) ────────
    if (!cp.step3Complete) {
      currentStep = 'Step 3 (reassembly + BigQuery ingestion — resume)';
      if (isCancelled()) throw new Error('Processing was cancelled.');

      log('info', '[Resume] Running Step 3: reassembly + BigQuery ingestion');
      await deleteCaseRows(caseId); // ensure idempotency

      const docaiResult: DocAIResult = {
        path: 'path2-async',
        ocrOutputPrefix: cp.ocrOutputPrefix!,
        layoutOutputPrefix: cp.layoutOutputPrefix!,
      };

      let chunkOffset = 0;
      for (const file of caseData.files) {
        if (isCancelled()) throw new Error('Processing was cancelled.');
        const chunks = await listChunkRefs(caseId, file.id);
        if (chunks.length === 0) {
          log('warn', `[Resume] No staging chunks for file "${file.name}" — skipping (may already be scrubbed)`);
          continue;
        }
        await step3(chunks, docaiResult, caseId, file.id, file.name, log, {
          globalChunkOffset: chunkOffset,
        });
        chunkOffset += chunks.length;
      }

      cp.step3Complete = true;
      await writeCheckpoint(caseId, cp);
    }

    // ── Resume Steps 4-5 (idempotent — read from BigQuery, write to Firestore) ──
    const freshCase = await getCase(caseId);

    if (!freshCase?.table1?.length) {
      currentStep = 'Step 4 (Table 1 generation — resume)';
      if (isCancelled()) throw new Error('Processing was cancelled.');
      log('info', '[Resume] Running Step 4: Table 1 generation');
      const t1Prompt = freshCase?.table1Prompt;
      const { rows: table1Rows, markdownTable: table1Md } = await step4(caseId, t1Prompt, log);
      await updateCase(caseId, { table1: table1Rows, table1Markdown: table1Md });
    } else {
      log('info', '[Resume] Step 4 already complete — skipping');
    }

    if (!freshCase?.table2?.length) {
      currentStep = 'Step 5 (Table 2 generation — resume)';
      if (isCancelled()) throw new Error('Processing was cancelled.');
      log('info', '[Resume] Running Step 5: Table 2 generation');
      const latestCase = await getCase(caseId);
      const t2Prompt = latestCase?.table2Prompt;
      const { rows: table2Rows, markdownTable: table2Md } = await step5(
        caseId, latestCase!.table1Markdown!, t2Prompt, log,
      );
      await updateCase(caseId, { table2: table2Rows, table2Markdown: table2Md });
    } else {
      log('info', '[Resume] Step 5 already complete — skipping');
    }

    // ── Finalise ──────────────────────────────────────────────────────────────
    const finalCase = await getCase(caseId);
    const now = new Date().toISOString();
    const t1Version: TableVersion = {
      version: 1, rows: finalCase!.table1, markdownTable: finalCase!.table1Markdown!,
      prompt: finalCase?.table1Prompt || 'default', generatedAt: now, generatedBy: 'system (resumed)',
    };
    const t2Version: TableVersion = {
      version: 1, rows: finalCase!.table2, markdownTable: finalCase!.table2Markdown!,
      prompt: finalCase?.table2Prompt || 'default', generatedAt: now, generatedBy: 'system (resumed)',
    };

    await updateCase(caseId, {
      status: 'complete',
      table1Versions: [t1Version],
      table2Versions: [t2Version],
      table1ActiveVersion: 0,
      table2ActiveVersion: 0,
      dateProcessed: now,
      totalPages: cp.totalPages,
      pipelineCheckpoint: null,
    } as any);

    log('success', `Pipeline resumed and completed! Table 1: ${finalCase!.table1.length} records, Table 2: ${finalCase!.table2.length} conditions`);

    // ── Final cleanup: scrub DocAI outputs now that pipeline succeeded ──────
    if (cp.ocrOutputPrefix || cp.layoutOutputPrefix) {
      log('info', 'Scrubbing DocAI output staging (pipeline complete)');
      if (cp.ocrOutputPrefix) {
        await deletePrefix(BUCKET_OUTPUT(), cp.ocrOutputPrefix).catch(() => {});
      }
      if (cp.layoutOutputPrefix) {
        await deletePrefix(BUCKET_OUTPUT(), cp.layoutOutputPrefix).catch(() => {});
      }
    }

  } catch (err: any) {
    const msg = err?.message || String(err);
    if (cancelledRuns.has(caseId)) {
      log('warn', 'Processing was cancelled.');
    } else {
      log('error', `Resume failed during ${currentStep}: ${msg}`);
      console.error('[resume] Fatal error:', err);
      await updateCase(caseId, { status: 'error', errorMessage: `Resume failed: ${msg}. Use "Retry Processing" to reprocess.` }).catch(() => {});
    }
  } finally {
    activeRuns.delete(caseId);
    activeLRONames.delete(caseId);
    // Check if completed successfully before clearing LRO names
    const snap = await getFirestore().collection('cases').doc(caseId).get().catch(() => null);
    const cp = snap?.data()?.pipelineCheckpoint;
    if (!cp) clearPersistedLRONames(caseId);
    cancelledRuns.delete(caseId);
  }
}
