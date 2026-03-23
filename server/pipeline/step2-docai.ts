/**
 * STEP 2: Asynchronous Dual-Processor Extraction (Document AI)
 *
 * Concurrently submits all chunks to:
 *   - Processor A: Enterprise Document OCR v2.1 (structural + textual digitization)
 *   - Processor B: Layout Parser v1.6-pro (semantic layout + contextual chunking)
 *
 * LRO polling: exactly every 10 seconds (non-exponential), until SUCCEEDED or FAILED.
 */
import { getDocAI, getEnv, getGcpProjectId } from '../config.js';
import { ChunkRef } from './step1-chunk.js';
import { BUCKET_OUTPUT } from '../gcs.js';
import { Log } from './orchestrator.js';

const OCR_PROCESSOR_VERSION     = 'pretrained-ocr-v2.1-2024-08-07';
const LAYOUT_PROCESSOR_VERSION  = 'pretrained-layout-parser-v1.6-pro-2025-12-01';
const LRO_POLL_INTERVAL_MS      = 10_000; // exactly 10 seconds — spec requirement

export interface DocAIResult {
  ocrOutputPrefix: string;     // GCS prefix where OCR JSON outputs landed
  layoutOutputPrefix: string;  // GCS prefix where Layout Parser JSON outputs landed
}

export async function step2(
  chunks: ChunkRef[],
  caseId: string,
  fileId: string,
  log: Log,
): Promise<DocAIResult> {
  log('info', '[Step 2] Starting dual Document AI batch processing');

  const projectId = getGcpProjectId();
  const location = 'us';
  const ocrProcessorId = getEnv('DOCAI_OCR_PROCESSOR_ID');
  const layoutProcessorId = getEnv('DOCAI_LAYOUT_PROCESSOR_ID');

  if (!ocrProcessorId) throw new Error('DOCAI_OCR_PROCESSOR_ID is not set. Run npm run setup-gcp first.');
  if (!layoutProcessorId) throw new Error('DOCAI_LAYOUT_PROCESSOR_ID is not set. Run npm run setup-gcp first.');

  const ocrProcessorName = `projects/${projectId}/locations/${location}/processors/${ocrProcessorId}/processorVersions/${OCR_PROCESSOR_VERSION}`;
  const layoutProcessorName = `projects/${projectId}/locations/${location}/processors/${layoutProcessorId}/processorVersions/${LAYOUT_PROCESSOR_VERSION}`;

  const outputBucket = BUCKET_OUTPUT();
  const ocrOutputPrefix    = `cases/${caseId}/${fileId}/ocr-output/`;
  const layoutOutputPrefix = `cases/${caseId}/${fileId}/layout-output/`;

  // Build input documents list (all chunk GCS URIs)
  const inputDocuments = chunks.map(c => ({
    gcsDocument: { gcsUri: c.gcsUri, mimeType: 'application/pdf' },
  }));

  // ── Launch both LROs concurrently ─────────────────────────────────────────
  log('info', `[Step 2] Submitting ${chunks.length} chunks to OCR processor`);
  log('info', `[Step 2] Submitting ${chunks.length} chunks to Layout Parser`);

  const docai = getDocAI();

  const [ocrOp] = await docai.batchProcessDocuments({
    name: ocrProcessorName,
    inputDocuments: { documents: inputDocuments } as any,
    documentOutputConfig: {
      gcsOutputConfig: { gcsUri: `gs://${outputBucket}/${ocrOutputPrefix}` },
    },
    skipHumanReview: true,
  });

  const [layoutOp] = await docai.batchProcessDocuments({
    name: layoutProcessorName,
    inputDocuments: { documents: inputDocuments } as any,
    documentOutputConfig: {
      gcsOutputConfig: { gcsUri: `gs://${outputBucket}/${layoutOutputPrefix}` },
    },
    skipHumanReview: true,
  });

  log('info', `[Step 2] OCR LRO started: ${ocrOp.name}`);
  log('info', `[Step 2] Layout LRO started: ${layoutOp.name}`);

  // ── Poll both LROs at exactly 10-second intervals ─────────────────────────
  const [ocrDone, layoutDone] = await Promise.all([
    pollLRO(docai, ocrOp.name!, 'OCR', log),
    pollLRO(docai, layoutOp.name!, 'Layout', log),
  ]);

  log('success', '[Step 2] Both Document AI processors completed successfully');
  return { ocrOutputPrefix, layoutOutputPrefix };
}

async function pollLRO(docai: any, operationName: string, label: string, log: Log): Promise<void> {
  let attempts = 0;
  while (true) {
    await sleep(LRO_POLL_INTERVAL_MS);
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
