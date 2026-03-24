/**
 * STEP 3: Deterministic Reassembly, BigQuery Ingestion, and Storage Scrubbing
 *
 * Path 1: assembles BigQuery rows directly from in-memory Document objects captured
 *   from the synchronous processDocument responses in Step 2.
 *
 * Path 2: downloads OCR + Layout Parser JSON outputs from GCS, then assembles rows.
 *
 * Both paths:
 * 1. Apply absolute_page_offset to all page numbers and spatial coordinates.
 * 2. Ingest unified corpus into BigQuery as Table 0.
 * 3. Delete all staging chunks (input + output where applicable) — "one copy" rule.
 */
import { v4 as uuidv4 } from 'uuid';
import { getStorage } from '../config.js';
import { insertRows, Table0Row } from '../bigquery.js';
import { deletePrefix, BUCKET_STAGING } from '../gcs.js';
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

  let bqRows: Table0Row[];

  if (docaiResult.path === 'path1-sync') {
    // ── Path 1: use in-memory Document objects directly ─────────────────────
    log('info', '[Step 3] Path 1: assembling rows from in-memory documents');

    bqRows = chunks.map((chunk, i) => {
      const ocrDoc    = docaiResult.ocrDocs[i];
      const layoutDoc = docaiResult.layoutDocs[i];
      const pageOffset = chunk.absolutePageOffset;

      const ocrPages = (ocrDoc?.pages || []).map((page: any, pi: number) => ({
        ...page,
        pageNumber: pageOffset + (page.pageNumber ?? pi + 1),
      }));

      const layoutChunks = (layoutDoc?.chunkedDocument?.chunks || []).map((lc: any) => ({
        ...lc,
        pageSpan: lc.pageSpan
          ? { pageStart: pageOffset + (lc.pageSpan.pageStart || 1),
              pageEnd:   pageOffset + (lc.pageSpan.pageEnd   || 1) }
          : undefined,
      }));

      const absStart = pageOffset + 1;
      const absEnd   = pageOffset + (ocrPages.length || chunk.pageCount);

      log('info', `[Step 3] Chunk ${chunk.chunkIndex}: pages ${absStart}–${absEnd}`);
      return {
        chunk_id:       uuidv4(),
        case_id:        caseId,
        file_id:        fileId,
        file_name:      fileName,
        chunk_index:    chunk.chunkIndex,
        abs_page_start: absStart,
        abs_page_end:   absEnd,
        raw_text:       ocrDoc?.text || '',
        layout_chunks:  JSON.stringify(layoutChunks),
        ocr_pages:      JSON.stringify(ocrPages),
        created_at:     new Date().toISOString(),
      };
    });

  } else {
    // ── Path 2: download and parse GCS outputs ───────────────────────────────
    const outputBucket = (process.env.GCS_STAGING_OUTPUT_BUCKET || 'cic-docai-staging-outputs');
    const storage = getStorage();

    const [ocrFiles] = await storage.bucket(outputBucket).getFiles({ prefix: docaiResult.ocrOutputPrefix });
    const [layoutFiles] = await storage.bucket(outputBucket).getFiles({ prefix: docaiResult.layoutOutputPrefix });

    log('info', `[Step 3] Found ${ocrFiles.length} OCR output files, ${layoutFiles.length} Layout output files`);

    // Index layout outputs by their source input URI
    const layoutByInput = new Map<string, any>();
    for (const f of layoutFiles) {
      if (!f.name.endsWith('.json')) continue;
      const [content] = await f.download();
      const doc = JSON.parse(content.toString('utf8'));
      const inputUri = doc?.context?.documentId?.gcsUri || f.name;
      layoutByInput.set(inputUri, doc);
    }

    bqRows = [];

    for (const f of ocrFiles) {
      if (!f.name.endsWith('.json')) continue;

      const [content] = await f.download();
      const ocrDoc = JSON.parse(content.toString('utf8'));

      const sourceUri = ocrDoc?.context?.documentId?.gcsUri || '';
      const chunk = chunks.find(c => c.gcsUri === sourceUri) || chunks[0];

      const chunkIndex = chunk?.chunkIndex ?? 0;
      const pageOffset = chunk?.absolutePageOffset ?? 0;

      const ocrPages = (ocrDoc.pages || []).map((page: any, i: number) => ({
        ...page,
        pageNumber: pageOffset + (page.pageNumber ?? i + 1),
      }));

      const layoutDoc = layoutByInput.get(sourceUri);
      const layoutChunks = layoutDoc?.chunkedDocument?.chunks || [];

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
  }

  // Sort rows by chunk index before inserting
  bqRows.sort((a, b) => a.chunk_index - b.chunk_index);

  log('info', `[Step 3] Inserting ${bqRows.length} rows into BigQuery Table 0`);
  await insertRows(bqRows);
  log('success', '[Step 3] BigQuery ingestion complete');

  // ── Storage scrubbing: enforce the "one copy" rule ────────────────────────
  log('info', '[Step 3] Scrubbing staging buckets (enforcing one-copy rule)');

  const inputPrefix = `cases/${caseId}/${fileId}/chunks`;
  if (docaiResult.path === 'path2-async') {
    // outputBucket scoped here to avoid unused-var warning in Path 1
    const outputBucket = process.env.GCS_STAGING_OUTPUT_BUCKET || 'cic-docai-staging-outputs';
    await Promise.all([
      deletePrefix(BUCKET_STAGING(), inputPrefix),
      deletePrefix(outputBucket, docaiResult.ocrOutputPrefix),
      deletePrefix(outputBucket, docaiResult.layoutOutputPrefix),
    ]);
  } else {
    // Path 1: no GCS output bucket was written
    await deletePrefix(BUCKET_STAGING(), inputPrefix);
  }

  // Also delete local temp chunk files
  const tmpDir = path.join(process.cwd(), 'chunks', caseId, fileId);
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  log('success', '[Step 3] Storage scrubbing complete — only original PDF remains in GCS');
}
