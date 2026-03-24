/**
 * Pipeline orchestrator — coordinates Steps 1–5 for one or more uploaded files.
 *
 * Steps 1–3 run per-file sequentially (chunk → DocAI → BigQuery ingest).
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
import { step2 } from './step2-docai.js';
import { step3 } from './step3-reassemble.js';
import { step4 } from './step4-table1.js';
import { step5 } from './step5-table2.js';
import { updateCase, addFileToCase, getCase, TableVersion } from '../cases.js';
import { getFirestore, getDocAI } from '../config.js';
import { BUCKET_AUTH } from '../gcs.js';
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
 * Cancel any active DocAI LROs for a case and mark the run as cancelled.
 * Safe to call even if no pipeline is running.
 */
export async function cancelPipeline(caseId: string): Promise<void> {
  cancelledRuns.add(caseId);
  const lros = activeLRONames.get(caseId) || [];
  activeLRONames.delete(caseId);
  if (lros.length > 0) {
    const docai = getDocAI();
    await Promise.all(
      lros.map(name =>
        (docai.operationsClient as any).cancelOperation({ name }).catch(() => {}),
      ),
    );
    console.log(`[pipeline] Cancelled ${lros.length} DocAI LRO(s) for case ${caseId}`);
  }
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

    // ── Steps 1–3: Per-file ingestion ─────────────────────────────────────────
    for (let i = 0; i < files.length; i++) {
      const { fileId, fileName, localFilePath } = files[i];
      log('info', `Processing file ${i + 1}/${files.length}: ${fileName}`);

      // Step 1: Upload original + chunk
      if (isCancelled()) throw new Error('Processing was cancelled.');
      const step1Result = await step1(localFilePath, caseId, fileId, fileName, processingPath, log);

      // Register the file in Firestore now that it's safely in GCS
      await addFileToCase(caseId, {
        id: fileId,
        name: fileName,
        gcsPath: `cases/${caseId}/${fileId}/${fileName}`,
        gcsBucket: BUCKET_AUTH(),
        sizeBytes: statSync(localFilePath).size,
        uploadedAt: new Date().toISOString(),
      });

      // Step 2: Dual Document AI processing (sync or async depending on processingPath)
      if (isCancelled()) throw new Error('Processing was cancelled.');
      const step2Result = await step2(step1Result.chunks, caseId, fileId, processingPath, log, {
        isCancelled,
        onLROsStarted: (names) => activeLRONames.set(caseId, names),
      });

      // Step 3: Reassemble + BigQuery ingest + staging scrub
      if (isCancelled()) throw new Error('Processing was cancelled.');
      await step3(step1Result.chunks, step2Result, caseId, fileId, fileName, log);

      // Clean up local temp file immediately — GCS is now the only copy
      try { unlinkSync(localFilePath); } catch {}
      pendingCleanup.delete(localFilePath);
    }

    // ── Step 4: Table 1 generation (whole case) ───────────────────────────────
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
    });

    log('success', `Pipeline complete! Table 1: ${table1Rows.length} records, Table 2: ${table2Rows.length} conditions`);

  } catch (err: any) {
    const msg = err?.message || String(err);
    if (cancelledRuns.has(caseId)) {
      // Cancel endpoint already set status → 'draft'; don't overwrite with 'error'
      log('warn', 'Processing was cancelled.');
    } else {
      log('error', `Pipeline failed: ${msg}`);
      console.error('[pipeline] Fatal error:', err);
      await updateCase(caseId, { status: 'error', errorMessage: msg }).catch(() => {});
    }
  } finally {
    activeRuns.delete(caseId);
    cancelledRuns.delete(caseId);
    activeLRONames.delete(caseId);
    // Clean up any temp files that weren't removed inline (e.g. pipeline failed before step 3)
    for (const p of pendingCleanup) {
      try { unlinkSync(p); } catch {}
    }
  }
}
