/**
 * Pipeline orchestrator — coordinates Steps 1–5 for a single uploaded file.
 *
 * SSE log streaming: emits structured log events per caseId so the frontend
 * can show real-time progress in the log drawer.
 */
import { EventEmitter } from 'events';
import { statSync, unlinkSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { step1 } from './step1-chunk.js';
import { step2 } from './step2-docai.js';
import { step3 } from './step3-reassemble.js';
import { step4 } from './step4-table1.js';
import { step5 } from './step5-table2.js';
import { updateCase, addFileToCase, getCase } from '../cases.js';
import { BUCKET_AUTH } from '../gcs.js';
import { ensureTable0Exists, deleteCaseRows } from '../bigquery.js';

export type LogLevel = 'info' | 'success' | 'error' | 'warn';
export type Log = (level: LogLevel, message: string) => void;

// Global SSE emitter — keyed by caseId
export const pipelineEmitter = new EventEmitter();
pipelineEmitter.setMaxListeners(100);

// Track active runs for deduplication
const activeRuns = new Set<string>();

export function emitLog(caseId: string, level: LogLevel, message: string) {
  const entry = { level, message, timestamp: new Date().toISOString() };
  pipelineEmitter.emit(`log:${caseId}`, entry);
  const prefix = level === 'error' ? '✗' : level === 'success' ? '✓' : level === 'warn' ? '⚠' : '·';
  console.log(`[pipeline:${caseId.slice(0, 8)}] ${prefix} ${message}`);
}

export interface RunOptions {
  caseId: string;
  fileId: string;
  fileName: string;
  localFilePath: string;
  createdBy: string;
  reprocess?: boolean;   // if true, delete existing Table 0 rows first
}

/**
 * Run the full 5-step pipeline for a single uploaded file.
 * This runs asynchronously — callers should not await it directly
 * (the HTTP response returns immediately; progress flows via SSE).
 */
export async function runPipeline(opts: RunOptions): Promise<void> {
  const { caseId, fileId, fileName, localFilePath, reprocess } = opts;
  const runKey = `${caseId}:${fileId}`;

  if (activeRuns.has(runKey)) {
    console.warn(`[pipeline] Duplicate run ignored for ${runKey}`);
    return;
  }
  activeRuns.add(runKey);

  const log: Log = (level, message) => emitLog(caseId, level, message);

  try {
    await updateCase(caseId, { status: 'processing' });
    log('info', `Pipeline started for file: ${fileName}`);

    // Ensure BigQuery Table 0 exists (idempotent)
    await ensureTable0Exists();

    // If re-processing, clean up old rows
    if (reprocess) {
      log('warn', '[Pipeline] Re-processing — deleting existing Table 0 rows for this case');
      await deleteCaseRows(caseId);
    }

    // ── Step 1: Upload original + chunk ──────────────────────────────────────
    const step1Result = await step1(localFilePath, caseId, fileId, fileName, log);

    // Register the file in Firestore now that it's in GCS
    await addFileToCase(caseId, {
      id: fileId,
      name: fileName,
      gcsPath: `cases/${caseId}/${fileId}/${fileName}`,
      gcsBucket: BUCKET_AUTH(),
      sizeBytes: statSync(localFilePath).size,
      uploadedAt: new Date().toISOString(),
    });

    // ── Step 2: Document AI batch processing ─────────────────────────────────
    const step2Result = await step2(step1Result.chunks, caseId, fileId, log);

    // ── Step 3: Reassemble + BigQuery + scrub ────────────────────────────────
    await step3(step1Result.chunks, step2Result, caseId, fileId, fileName, log);

    // ── Step 4: Table 1 generation ────────────────────────────────────────────
    const caseData = await getCase(caseId);
    const { rows: table1Rows, markdownTable: table1Md } = await step4(
      caseId,
      caseData?.table1Prompt,
      log,
    );

    await updateCase(caseId, { table1: table1Rows });

    // ── Step 5: Table 2 generation ────────────────────────────────────────────
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
    activeRuns.delete(runKey);
    // Clean up any lingering temp upload file
    try { unlinkSync(localFilePath); } catch {}
  }
}
