/**
 * STEP 2: Bifurcated Dual-Processor Extraction (Document AI)
 *
 * Path 1 (≤150 total pages): Synchronous processDocument
 *   - Uses rawDocument (inline bytes) — gcsDocument is NOT supported for sync
 *   - OCR + Layout run in parallel (not serial)
 *   - OCR: fixed concurrency (semaphore 5)
 *   - Layout: adaptive concurrency — starts at 8, auto-tightens on quota hit
 *   - Failed chunks return sentinels, then get resubmitted with fresh GCS bytes
 *
 * Path 2 (>150 total pages): Asynchronous batchProcess LRO — existing behavior,
 *   polling every exactly 10 seconds until SUCCEEDED.
 */
import { getDocAI, getStorage, getEnv, getGcpProjectId } from '../config.js';
import { ChunkRef, ProcessingPath } from './step1-chunk.js';
import { BUCKET_OUTPUT, BUCKET_STAGING } from '../gcs.js';
import { Log } from './orchestrator.js';

const OCR_PROCESSOR_VERSION     = 'pretrained-ocr-v2.1-2024-08-07';
const LAYOUT_PROCESSOR_VERSION  = 'pretrained-layout-parser-v1.6-2026-01-13';
const LRO_POLL_INTERVAL_MS      = 30_000; // 30 seconds

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}m:${String(s).padStart(2, '0')}s`;
}

export type DocAIResult =
  | { path: 'path1-sync'; ocrDocs: any[]; layoutDocs: any[] }
  | { path: 'path2-async'; ocrOutputPrefix: string; layoutOutputPrefix: string };

export interface CancelOpts {
  isCancelled: () => boolean;
  onLROsStarted: (names: string[]) => void;
}

// ── Concurrency primitives ──────────────────────────────────────────────────

class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];
  constructor(max: number) { this.available = max; }
  async acquire(): Promise<void> {
    if (this.available > 0) { this.available--; return; }
    return new Promise<void>(r => this.queue.push(r));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.available++; }
  }
}

/**
 * Adaptive concurrency limiter — starts optimistic and auto-tightens when
 * RESOURCE_EXHAUSTED is detected, then holds at the discovered ceiling.
 */
class AdaptiveSemaphore {
  private inFlight = 0;
  private maxConcurrent: number;
  private discovered = false;
  private queue: Array<() => void> = [];

  constructor(initialMax: number) { this.maxConcurrent = initialMax; }

  async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) { this.inFlight++; return; }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) { this.inFlight++; next(); }
  }

  /** Called on RESOURCE_EXHAUSTED — tightens concurrency to what was working. */
  onQuotaHit(): void {
    if (!this.discovered) {
      this.maxConcurrent = Math.max(1, this.inFlight - 1);
      this.discovered = true;
    }
  }

  get currentMax(): number { return this.maxConcurrent; }
  get isLimitDiscovered(): boolean { return this.discovered; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Download a chunk's PDF bytes from the GCS staging bucket. */
async function downloadChunkBytes(chunk: ChunkRef): Promise<Buffer> {
  const gcsPath = chunk.gcsUri.replace(`gs://${BUCKET_STAGING()}/`, '');
  const [content] = await getStorage().bucket(BUCKET_STAGING()).file(gcsPath).download();
  return content;
}

type ChunkResult =
  | { ok: true; doc: any }
  | { ok: false; chunkIndex: number; error: string };

/** Process one chunk with up to MAX_ATTEMPTS retries. Returns a sentinel on failure instead of throwing. */
async function processWithRetry(
  pdfBytes: Buffer,
  chunk: ChunkRef,
  processorName: string,
  label: string,
  sem: Semaphore | AdaptiveSemaphore,
  processOptions: Record<string, any> | undefined,
  cancelOpts: CancelOpts,
  log: Log,
): Promise<ChunkResult> {
  const MAX_ATTEMPTS = 5;
  await sem.acquire();
  try {
    let delay = 2_000;
    const startMs = Date.now();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (cancelOpts.isCancelled()) throw new Error('Processing was cancelled.');
      try {
        const [response] = await getDocAI().processDocument({
          name: processorName,
          rawDocument: { content: pdfBytes, mimeType: 'application/pdf' },
          skipHumanReview: true,
          ...(processOptions ? { processOptions } : {}),
        });
        if (!response.document) throw new Error('No document returned');
        const elapsed = (Date.now() - startMs) / 1000;
        log('info', `[Step 2] ${label} chunk ${chunk.chunkIndex} complete (${formatElapsed(elapsed)})`);
        return { ok: true, doc: response.document };
      } catch (e: any) {
        const code = e?.code;
        const isQuotaError =
          code === 8 ||
          (e?.message || '').includes('Quota') ||
          (e?.message || '').includes('RESOURCE_EXHAUSTED');
        const isRetryable =
          isQuotaError || code === 4 || code === 13 || code === 14;

        // Notify adaptive semaphore of quota hit so it tightens concurrency
        if (isQuotaError && sem instanceof AdaptiveSemaphore) {
          sem.onQuotaHit();
          log('warn', `[Step 2] ${label} quota hit on chunk ${chunk.chunkIndex} — concurrency reduced to ${sem.currentMax}`);
        }

        if (isRetryable && attempt < MAX_ATTEMPTS) {
          log('warn', `[Step 2] ${label} chunk ${chunk.chunkIndex} attempt ${attempt}/${MAX_ATTEMPTS} failed (code=${code}) — retry in ${delay / 1000}s`);
          // Release slot during backoff so other chunks can proceed
          sem.release();
          await sleep(delay);
          delay = Math.min(delay * 2, 32_000);
          await sem.acquire(); // re-acquire (respects tightened limit)
        } else {
          log('warn', `[Step 2] ${label} chunk ${chunk.chunkIndex} failed after ${attempt} attempt(s): ${e.message}`);
          return { ok: false, chunkIndex: chunk.chunkIndex, error: e.message };
        }
      }
    }
    return { ok: false, chunkIndex: chunk.chunkIndex, error: 'Max attempts exhausted' };
  } finally {
    sem.release();
  }
}

// ── Main step2 function ─────────────────────────────────────────────────────

export async function step2(
  chunks: ChunkRef[],
  caseId: string,
  processingPath: ProcessingPath,
  log: Log,
  cancelOpts: CancelOpts,
): Promise<DocAIResult> {
  log('info', '[Step 2] Starting dual Document AI processing');

  const projectId = getGcpProjectId();
  const location = 'us';
  const ocrProcessorId = getEnv('DOCAI_OCR_PROCESSOR_ID');
  const layoutProcessorId = getEnv('DOCAI_LAYOUT_PROCESSOR_ID');

  if (!ocrProcessorId) throw new Error('DOCAI_OCR_PROCESSOR_ID is not set. Run npm run setup-gcp first.');
  if (!layoutProcessorId) throw new Error('DOCAI_LAYOUT_PROCESSOR_ID is not set. Run npm run setup-gcp first.');

  const ocrProcessorName    = `projects/${projectId}/locations/${location}/processors/${ocrProcessorId}/processorVersions/${OCR_PROCESSOR_VERSION}`;
  const layoutProcessorName = `projects/${projectId}/locations/${location}/processors/${layoutProcessorId}/processorVersions/${LAYOUT_PROCESSOR_VERSION}`;

  // ── PATH 1: Synchronous processing ────────────────────────────────────────
  if (processingPath === 'path1-sync') {
    log('info', `[Step 2] Path 1: synchronous processing of ${chunks.length} chunk(s)`);
    cancelOpts.onLROsStarted([]); // no LROs for sync path

    // Pre-download all chunk bytes from GCS in parallel
    log('info', '[Step 2] Downloading chunk bytes from staging bucket');
    const chunkBytes = await Promise.all(chunks.map(c => downloadChunkBytes(c)));
    log('info', `[Step 2] Downloaded ${chunkBytes.length} chunk(s)`);

    const layoutOptions = {
      layoutConfig: {
        chunkingConfig: {
          chunkSize: 500,
          includeAncestorHeadings: true,
        },
      },
    };

    const ocrSem    = new Semaphore(5);           // OCR: fixed, fast processor
    const layoutSem = new AdaptiveSemaphore(8);   // Layout: starts aggressive, auto-tightens on quota hit

    // ── OCR + Layout in parallel ────────────────────────────────────────────
    log('info', `[Step 2] Processing ${chunks.length} chunk(s) through OCR + Layout in parallel`);

    const [ocrResults, layoutResults] = await Promise.all([
      Promise.all(chunks.map((chunk, i) =>
        processWithRetry(chunkBytes[i], chunk, ocrProcessorName, 'OCR', ocrSem, undefined, cancelOpts, log),
      )),
      Promise.all(chunks.map((chunk, i) =>
        processWithRetry(chunkBytes[i], chunk, layoutProcessorName, 'Layout', layoutSem, layoutOptions, cancelOpts, log),
      )),
    ]);

    if (layoutSem.isLimitDiscovered) {
      log('info', `[Step 2] Layout quota ceiling discovered: ${layoutSem.currentMax} concurrent`);
    }

    // ── Resubmission pass: retry any failed chunks with fresh GCS bytes ─────
    const failedOcr    = ocrResults.filter((r): r is { ok: false; chunkIndex: number; error: string } => !r.ok);
    const failedLayout = layoutResults.filter((r): r is { ok: false; chunkIndex: number; error: string } => !r.ok);

    if (failedOcr.length > 0 || failedLayout.length > 0) {
      log('warn', `[Step 2] Resubmitting failed chunks — OCR: ${failedOcr.length}, Layout: ${failedLayout.length}`);

      for (const f of failedOcr) {
        const freshBytes = await downloadChunkBytes(chunks[f.chunkIndex]);
        const result = await processWithRetry(freshBytes, chunks[f.chunkIndex], ocrProcessorName, 'OCR (retry)', ocrSem, undefined, cancelOpts, log);
        if (!result.ok) throw new Error(`[Step 2] OCR chunk ${f.chunkIndex} failed permanently: ${f.error}`);
        ocrResults[f.chunkIndex] = result;
      }

      for (const f of failedLayout) {
        const freshBytes = await downloadChunkBytes(chunks[f.chunkIndex]);
        const result = await processWithRetry(freshBytes, chunks[f.chunkIndex], layoutProcessorName, 'Layout (retry)', layoutSem, layoutOptions, cancelOpts, log);
        if (!result.ok) throw new Error(`[Step 2] Layout chunk ${f.chunkIndex} failed permanently: ${f.error}`);
        layoutResults[f.chunkIndex] = result;
      }
    }

    // Extract documents (all results guaranteed ok at this point)
    const ocrDocs    = ocrResults.map(r => (r as { ok: true; doc: any }).doc);
    const layoutDocs = layoutResults.map(r => (r as { ok: true; doc: any }).doc);

    log('success', '[Step 2] Path 1 synchronous processing complete');
    return { path: 'path1-sync', ocrDocs, layoutDocs };
  }

  // ── PATH 2: Asynchronous batch LRO processing ──────────────────────────────
  log('info', '[Step 2] Path 2: async batch processing');

  const outputBucket = BUCKET_OUTPUT();
  const ocrOutputPrefix    = `cases/${caseId}/docai-output/ocr/`;
  const layoutOutputPrefix = `cases/${caseId}/docai-output/layout/`;

  // Build input documents list (all chunk GCS URIs)
  const inputDocuments = {
    gcsDocuments: {
      documents: chunks.map(c => ({ gcsUri: c.gcsUri, mimeType: 'application/pdf' })),
    },
  };

  // ── Launch both LROs concurrently ─────────────────────────────────────────
  log('info', `[Step 2] Submitting ${chunks.length} chunks to OCR processor`);
  log('info', `[Step 2] Submitting ${chunks.length} chunks to Layout Parser`);

  const docai = getDocAI();

  const [ocrOp] = await docai.batchProcessDocuments({
    name: ocrProcessorName,
    inputDocuments,
    documentOutputConfig: {
      gcsOutputConfig: { gcsUri: `gs://${outputBucket}/${ocrOutputPrefix}` },
    },
    skipHumanReview: true,
  });

  const [layoutOp] = await docai.batchProcessDocuments({
    name: layoutProcessorName,
    inputDocuments,
    documentOutputConfig: {
      gcsOutputConfig: { gcsUri: `gs://${outputBucket}/${layoutOutputPrefix}` },
    },
    skipHumanReview: true,
    processOptions: {
      layoutConfig: {
        chunkingConfig: {
          chunkSize: 500,
          includeAncestorHeadings: true,
        },
      },
    },
  });

  log('info', `[Step 2] OCR LRO started: ${ocrOp.name}`);
  log('info', `[Step 2] Layout LRO started: ${layoutOp.name}`);

  // Register active LROs so the orchestrator can cancel them if needed
  cancelOpts.onLROsStarted([ocrOp.name!, layoutOp.name!]);
  if (cancelOpts.isCancelled()) throw new Error('Processing was cancelled.');

  // ── Poll both LROs at exactly 10-second intervals ─────────────────────────
  await Promise.all([
    pollLRO(docai, ocrOp.name!, 'OCR', log, cancelOpts.isCancelled),
    pollLRO(docai, layoutOp.name!, 'Layout', log, cancelOpts.isCancelled),
  ]);

  log('success', '[Step 2] Both Document AI processors completed successfully');
  return { path: 'path2-async', ocrOutputPrefix, layoutOutputPrefix };
}

export async function pollLRO(docai: any, operationName: string, label: string, log: Log, isCancelled: () => boolean): Promise<void> {
  let attempts = 0;
  while (true) {
    await sleep(LRO_POLL_INTERVAL_MS);
    if (isCancelled()) throw new Error('Processing was cancelled.');
    attempts++;

    const [op] = await docai.operationsClient.getOperation({ name: operationName });
    const metadata = op.metadata as any;
    const state = metadata?.state || metadata?.commonMetadata?.state || 'RUNNING';

    if (op.done) {
      if (op.error) {
        throw new Error(`[Step 2] ${label} LRO failed: ${JSON.stringify(op.error)}`);
      }
      log('success', `[Step 2] ${label} processor completed successfully (~${formatElapsed(attempts * LRO_POLL_INTERVAL_MS / 1000)})`);
      return;
    }

    log('info', `[Step 2] ${label} LRO poll #${attempts}: state=${state}`);

    if (state === 'FAILED') {
      throw new Error(`[Step 2] ${label} LRO state=FAILED`);
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
