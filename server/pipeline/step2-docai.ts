/**
 * STEP 2: Bifurcated Dual-Processor Extraction (Document AI)
 *
 * Path 1 (≤150 total pages): Synchronous processDocument — retrieves each chunk from GCS
 *   staging, submits inline as rawDocument, max 5 concurrent per processor, exponential
 *   backoff on gRPC RESOURCE_EXHAUSTED / INTERNAL / UNAVAILABLE errors.
 *
 * Path 2 (>150 total pages): Asynchronous batchProcess LRO — existing behavior,
 *   polling every exactly 10 seconds until SUCCEEDED.
 */
import { getDocAI, getEnv, getGcpProjectId, getStorage } from '../config.js';
import { ChunkRef, ProcessingPath } from './step1-chunk.js';
import { BUCKET_OUTPUT, BUCKET_STAGING } from '../gcs.js';
import { Log } from './orchestrator.js';

const OCR_PROCESSOR_VERSION     = 'pretrained-ocr-v2.1-2024-08-07';
const LAYOUT_PROCESSOR_VERSION  = 'pretrained-layout-parser-v1.6-pro-2025-12-01';
const LRO_POLL_INTERVAL_MS      = 10_000; // exactly 10 seconds — spec requirement

export type DocAIResult =
  | { path: 'path1-sync'; ocrDocs: any[]; layoutDocs: any[] }
  | { path: 'path2-async'; ocrOutputPrefix: string; layoutOutputPrefix: string };

export interface CancelOpts {
  isCancelled: () => boolean;
  onLROsStarted: (names: string[]) => void;
}

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

export async function step2(
  chunks: ChunkRef[],
  caseId: string,
  fileId: string,
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
    log('info', `[Step 2] Path 1: synchronous processing of ${chunks.length} chunk(s) (max 5 concurrent per processor)`);
    cancelOpts.onLROsStarted([]); // no LROs for sync path

    // Retrieve chunk bytes from GCS staging on every attempt (including retries per spec)
    const downloadChunkBytes = async (chunk: ChunkRef): Promise<Buffer> => {
      const gcsPath = chunk.gcsUri.replace(`gs://${BUCKET_STAGING()}/`, '');
      const [content] = await getStorage().bucket(BUCKET_STAGING()).file(gcsPath).download();
      return content;
    };

    const processChunk = async (
      chunk: ChunkRef,
      processorName: string,
      label: string,
      sem: Semaphore,
    ): Promise<any> => {
      if (cancelOpts.isCancelled()) throw new Error('Processing was cancelled.');
      await sem.acquire();
      try {
        let delay = 2_000;
        while (true) {
          if (cancelOpts.isCancelled()) throw new Error('Processing was cancelled.');
          try {
            const pdfBytes = await downloadChunkBytes(chunk);
            const [response] = await getDocAI().processDocument({
              name: processorName,
              rawDocument: { content: pdfBytes, mimeType: 'application/pdf' },
            });
            if (!response.document) throw new Error(`[Step 2] ${label} processDocument returned no document for chunk ${chunk.chunkIndex}`);
            log('info', `[Step 2] ${label} chunk ${chunk.chunkIndex} complete (sync)`);
            return response.document;
          } catch (e: any) {
            // gRPC codes: 8=RESOURCE_EXHAUSTED (quota), 13=INTERNAL (500), 14=UNAVAILABLE (503)
            const isRetryable =
              e?.code === 8 || e?.code === 13 || e?.code === 14 ||
              (e?.message || '').includes('Quota') ||
              (e?.message || '').includes('RESOURCE_EXHAUSTED');
            if (isRetryable) {
              log('warn', `[Step 2] ${label} transient error on chunk ${chunk.chunkIndex} — retrying in ${delay / 1000}s`);
              await sleep(delay);
              delay = Math.min(delay * 2, 60_000);
            } else {
              throw e;
            }
          }
        }
      } finally {
        sem.release();
      }
    };

    const ocrSem    = new Semaphore(5);
    const layoutSem = new Semaphore(5);

    const [ocrDocs, layoutDocs] = await Promise.all([
      Promise.all(chunks.map(c => processChunk(c, ocrProcessorName,    'OCR',    ocrSem))),
      Promise.all(chunks.map(c => processChunk(c, layoutProcessorName, 'Layout', layoutSem))),
    ]);

    log('success', '[Step 2] Path 1 synchronous processing complete');
    return { path: 'path1-sync', ocrDocs, layoutDocs };
  }

  // ── PATH 2: Asynchronous batch LRO processing ──────────────────────────────
  log('info', '[Step 2] Path 2: async batch processing');

  const outputBucket = BUCKET_OUTPUT();
  const ocrOutputPrefix    = `cases/${caseId}/${fileId}/ocr-output/`;
  const layoutOutputPrefix = `cases/${caseId}/${fileId}/layout-output/`;

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

async function pollLRO(docai: any, operationName: string, label: string, log: Log, isCancelled: () => boolean): Promise<void> {
  let attempts = 0;
  while (true) {
    await sleep(LRO_POLL_INTERVAL_MS);
    if (isCancelled()) throw new Error('Processing was cancelled.');
    attempts++;

    const [op] = await docai.operationsClient.getOperation({ name: operationName });
    const metadata = op.metadata as any;
    const state = metadata?.state || metadata?.commonMetadata?.state || 'RUNNING';

    log('info', `[Step 2] ${label} LRO poll #${attempts}: state=${state}`);

    if (op.done) {
      if (op.error) {
        throw new Error(`[Step 2] ${label} LRO failed: ${JSON.stringify(op.error)}`);
      }
      log('success', `[Step 2] ${label} LRO SUCCEEDED after ${attempts} polls (~${attempts * 10}s)`);
      return;
    }

    if (state === 'FAILED') {
      throw new Error(`[Step 2] ${label} LRO state=FAILED`);
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
