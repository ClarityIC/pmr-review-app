/**
 * STEP 3: Deterministic Reassembly, BigQuery Ingestion, and Storage Scrubbing
 *
 * 1. Download OCR + Layout Parser JSON outputs from GCS.
 * 2. Apply absolute_page_offset to all page numbers and spatial coordinates.
 * 3. Stitch chunks into a unified corpus and insert into BigQuery Table 0.
 * 4. Delete all staging chunks (input + output) to enforce the "one copy" rule.
 */
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { getStorage } from '../config.js';
import { insertRows, Table0Row } from '../bigquery.js';
import { deletePrefix, BUCKET_STAGING, BUCKET_OUTPUT } from '../gcs.js';
import { ChunkRef } from './step1-chunk.js';
import { DocAIResult } from './step2-docai.js';
import { Log } from './orchestrator.js';
import path from 'path';
import fs from 'fs';

export async function step3(
  chunks: ChunkRef[],
  docaiResult: DocAIResult,
  caseId: string,
  fileId: string,
  fileName: string,
  log: Log,
): Promise<void> {
  log('info', '[Step 3] Starting reassembly and BigQuery ingestion');

  const outputBucket = (process.env.GCS_STAGING_OUTPUT_BUCKET || 'cic-docai-staging-outputs');
  const storage = getStorage();

  // ── Download and parse all OCR + Layout outputs ────────────────────────────
  const [ocrFiles] = await storage.bucket(outputBucket).getFiles({ prefix: docaiResult.ocrOutputPrefix });
  const [layoutFiles] = await storage.bucket(outputBucket).getFiles({ prefix: docaiResult.layoutOutputPrefix });

  log('info', `[Step 3] Found ${ocrFiles.length} OCR output files, ${layoutFiles.length} Layout output files`);

  // Index layout outputs by their source input URI (Document AI includes this in the response)
  const layoutByInput = new Map<string, any>();
  for (const f of layoutFiles) {
    if (!f.name.endsWith('.json')) continue;
    const [content] = await f.download();
    const doc = JSON.parse(content.toString('utf8'));
    // Document AI output includes the source GCS URI in the response
    const inputUri = doc?.context?.documentId?.gcsUri || f.name;
    layoutByInput.set(inputUri, doc);
  }

  const bqRows: Table0Row[] = [];

  // ── Process each OCR output file and apply page offsets ───────────────────
  for (const f of ocrFiles) {
    if (!f.name.endsWith('.json')) continue;

    const [content] = await f.download();
    const ocrDoc = JSON.parse(content.toString('utf8'));

    // Find which chunk this output belongs to by matching the source URI
    const sourceUri = ocrDoc?.context?.documentId?.gcsUri || '';
    const chunk = chunks.find(c => c.gcsUri === sourceUri) || chunks[0]; // fallback to order

    const chunkIndex = chunk?.chunkIndex ?? 0;
    const pageOffset = chunk?.absolutePageOffset ?? 0;

    // Apply absolute page offset to all page numbers
    const ocrPages = (ocrDoc.pages || []).map((page: any, i: number) => ({
      ...page,
      pageNumber: pageOffset + (page.pageNumber ?? i + 1),
    }));

    // Get matching layout chunks for this source
    const layoutDoc = layoutByInput.get(sourceUri);
    const layoutChunks = layoutDoc?.chunkedDocument?.chunks || [];

    // Adjust layout chunk page refs too
    const adjustedLayoutChunks = layoutChunks.map((lc: any) => ({
      ...lc,
      pageSpan: lc.pageSpan ? {
        pageStart: pageOffset + (lc.pageSpan.pageStart || 1),
        pageEnd:   pageOffset + (lc.pageSpan.pageEnd   || 1),
      } : undefined,
    }));

    const absStart = pageOffset + 1;
    const absEnd   = pageOffset + (ocrPages.length || chunk?.pageCount || 0);

    bqRows.push({
      chunk_id:       uuidv4(),
      case_id:        caseId,
      file_id:        fileId,
      file_name:      fileName,
      chunk_index:    chunkIndex,
      abs_page_start: absStart,
      abs_page_end:   absEnd,
      raw_text:       ocrDoc.text || '',
      layout_chunks:  JSON.stringify(adjustedLayoutChunks),
      ocr_pages:      JSON.stringify(ocrPages),
      created_at:     new Date().toISOString(),
    });

    log('info', `[Step 3] Processed chunk ${chunkIndex}: pages ${absStart}–${absEnd}`);
  }

  // Sort rows by chunk index before inserting
  bqRows.sort((a, b) => a.chunk_index - b.chunk_index);

  log('info', `[Step 3] Inserting ${bqRows.length} rows into BigQuery Table 0`);
  await insertRows(bqRows);
  log('success', '[Step 3] BigQuery ingestion complete');

  // ── Storage scrubbing: delete all staging data ────────────────────────────
  log('info', '[Step 3] Scrubbing staging buckets (enforcing one-copy rule)');

  const inputPrefix = `cases/${caseId}/${fileId}/chunks`;
  const [inputDeleted] = await Promise.all([
    deletePrefix(BUCKET_STAGING(), inputPrefix),
    deletePrefix(outputBucket, docaiResult.ocrOutputPrefix),
    deletePrefix(outputBucket, docaiResult.layoutOutputPrefix),
  ]);

  // Also delete local temp chunk files
  const tmpDir = path.join(process.cwd(), 'chunks', caseId, fileId);
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  log('success', '[Step 3] Storage scrubbing complete — only original PDF remains in GCS');
}
