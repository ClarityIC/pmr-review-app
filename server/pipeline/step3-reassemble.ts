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
 * 3. Delete input staging chunks and local temp files.
 *    (DocAI output scrubbing is deferred to the orchestrator after pipeline success.)
 */
import { v4 as uuidv4 } from 'uuid';
import { getStorage } from '../config.js';
import { insertRows, Table0Row } from '../bigquery.js';
import { ChunkRef } from './step1-chunk.js';
import { DocAIResult } from './step2-docai.js';
import { Log } from './orchestrator.js';

export interface Step3Options {
  globalChunkOffset?: number; // Path 2 batched: starting index of this file's chunks in the global batch
}

export async function step3(
  chunks: ChunkRef[],
  docaiResult: DocAIResult,
  caseId: string,
  fileId: string,
  fileName: string,
  log: Log,
  options?: Step3Options,
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

      // Store only essential page metadata — full geometry would exceed BQ row limits
      const ocrPages = (ocrDoc?.pages || []).map((page: any, pi: number) => ({
        pageNumber: pageOffset + (page.pageNumber ?? pi + 1),
        dimension: page.dimension,
        detectedLanguages: page.detectedLanguages,
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

    // Index layout outputs by inputDocumentIndex (parsed from output path)
    // Path structure: {prefix}/{operationId}/{inputDocumentIndex}/{shard}.json
    const layoutByInputIdx = new Map<number, any>();
    for (const f of layoutFiles) {
      if (!f.name.endsWith('.json')) continue;
      const [content] = await f.download();
      const doc = JSON.parse(content.toString('utf8'));
      const pathParts = f.name.split('/');
      const inputIdx = parseInt(pathParts[pathParts.length - 2], 10);
      if (!isNaN(inputIdx)) {
        layoutByInputIdx.set(inputIdx, doc);
      }
    }

    const offset = options?.globalChunkOffset ?? 0;
    bqRows = [];

    for (const f of ocrFiles) {
      if (!f.name.endsWith('.json')) continue;

      const [content] = await f.download();
      const ocrDoc = JSON.parse(content.toString('utf8'));

      // Parse inputDocumentIndex from output path structure:
      // {prefix}/{operationId}/{inputIdx}/{shard}.json
      const pathParts = f.name.split('/');
      const inputIdx = parseInt(pathParts[pathParts.length - 2], 10);
      const localIdx = inputIdx - offset;

      let chunk: ChunkRef | undefined;

      if (!isNaN(localIdx) && localIdx >= 0 && localIdx < chunks.length) {
        // Primary: match via output path structure (most reliable)
        chunk = chunks[localIdx];
      } else {
        // Fallback: try URI matching (for non-batched runs or different path structures)
        const sourceUri = ocrDoc?.context?.documentId?.gcsUri || '';
        chunk = chunks.find(c => c.gcsUri === sourceUri)
          || chunks.find(c => decodeURIComponent(c.gcsUri) === decodeURIComponent(sourceUri));
      }

      if (!chunk) {
        log('warn', `[Step 3] Skipping OCR output — no matching chunk. File: ${f.name}, inputIdx: ${inputIdx}, offset: ${offset}, sourceUri: ${ocrDoc?.context?.documentId?.gcsUri || '(empty)'}`);
        continue;
      }

      const chunkIndex = chunk.chunkIndex;
      const pageOffset = chunk.absolutePageOffset;

      // Store only essential page metadata — full geometry would exceed BQ row limits
      const ocrPages = (ocrDoc.pages || []).map((page: any, i: number) => ({
        pageNumber: pageOffset + (page.pageNumber ?? i + 1),
        dimension: page.dimension,
        detectedLanguages: page.detectedLanguages,
      }));

      const layoutDoc = layoutByInputIdx.get(inputIdx);
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

  // ── Validation ─────────────────────────────────────────────────────────────
  if (bqRows.length === 0 && chunks.length > 0) {
    log('error', `[Step 3] CRITICAL: 0 rows produced from ${chunks.length} chunk(s). Output matching failed — check chunk URIs and output path structure.`);
    throw new Error(`[Step 3] No rows produced — output-to-chunk matching failed for all ${chunks.length} chunk(s)`);
  }
  if (bqRows.length < chunks.length) {
    log('warn', `[Step 3] Only ${bqRows.length}/${chunks.length} chunks matched output files. Some data may be missing.`);
  }

  // Sort rows by chunk index before inserting
  bqRows.sort((a, b) => a.chunk_index - b.chunk_index);

  log('info', `[Step 3] Inserting ${bqRows.length} rows into BigQuery Table 0`);
  await insertRows(bqRows);
  log('success', '[Step 3] BigQuery ingestion complete');

  log('success', '[Step 3] Reassembly and ingestion complete');
}
