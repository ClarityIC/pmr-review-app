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
import { statSync, unlinkSync } from 'fs';
import { FieldValue } from '@google-cloud/firestore';
import { step1 } from './step1-chunk.js';
import { step2 } from './step2-docai.js';
import { step3 } from './step3-reassemble.js';
import { step4 } from './step4-table1.js';
import { step5 } from './step5-table2.js';
import { updateCase, addFileToCase, getCase } from '../cases.js';
import { getFirestore } from '../config.js';
import { BUCKET_AUTH } from '../gcs.js';
import { ensureTable0Exists, deleteCaseRows } from '../bigquery.js';

export type LogLevel = 'info' | 'success' | 'error' | 'warn';
export type Log = (level: LogLevel, message: string) => void;

// Global SSE emitter — keyed by caseId
export const pipelineEmitter = new EventEmitter();
pipelineEmitter.setMaxListeners(100);

// Track active runs for deduplication — keyed by caseId
const activeRuns = new Set<string>();

// Per-run sequence counter — makes each Firestore log entry unique for arrayUnion
const logSeqs = new Map<string, number>();

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

    // ── Steps 1–3: Per-file ingestion ─────────────────────────────────────────
    for (let i = 0; i < files.length; i++) {
      const { fileId, fileName, localFilePath } = files[i];
      log('info', `Processing file ${i + 1}/${files.length}: ${fileName}`);

      // Step 1: Upload original + chunk
      const step1Result = await step1(localFilePath, caseId, fileId, fileName, log);

      // Register the file in Firestore now that it's safely in GCS
      await addFileToCase(caseId, {
        id: fileId,
        name: fileName,
        gcsPath: `cases/${caseId}/${fileId}/${fileName}`,
        gcsBucket: BUCKET_AUTH(),
        sizeBytes: statSync(localFilePath).size,
        uploadedAt: new Date().toISOString(),
      });

      // Step 2: Dual Document AI batch processing
      const step2Result = await step2(step1Result.chunks, caseId, fileId, log);

      // Step 3: Reassemble + BigQuery ingest + staging scrub
      await step3(step1Result.chunks, step2Result, caseId, fileId, fileName, log);

      // Clean up local temp file immediately — GCS is now the only copy
      try { unlinkSync(localFilePath); } catch {}
      pendingCleanup.delete(localFilePath);
    }

    // ── Step 4: Table 1 generation (whole case) ───────────────────────────────
    const caseData = await getCase(caseId);
    const { rows: table1Rows, markdownTable: table1Md } = await step4(
      caseId,
      caseData?.table1Prompt,
      log,
    );

    await updateCase(caseId, { table1: table1Rows });

    // ── Step 5: Table 2 generation (whole case) ───────────────────────────────
    const { rows: table2Rows } = await step5(
      caseId,
      table1Md,
      caseData?.table2Prompt,
      log,
    );

    // ── Finalise ──────────────────────────────────────────────────────────────
    await updateCase(caseId, {
      status: 'complete',
      table1: table1Rows,
      table2: table2Rows,
      dateProcessed: new Date().toISOString(),
    });

    log('success', `Pipeline complete! Table 1: ${table1Rows.length} records, Table 2: ${table2Rows.length} conditions`);

  } catch (err: any) {
    const msg = err?.message || String(err);
    log('error', `Pipeline failed: ${msg}`);
    console.error('[pipeline] Fatal error:', err);
    await updateCase(caseId, { status: 'error', errorMessage: msg }).catch(() => {});
  } finally {
    activeRuns.delete(caseId);
    // Clean up any temp files that weren't removed inline (e.g. pipeline failed before step 3)
    for (const p of pendingCleanup) {
      try { unlinkSync(p); } catch {}
    }
  }
}
