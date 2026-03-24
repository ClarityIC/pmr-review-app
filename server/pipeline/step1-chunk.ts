/**
 * STEP 1: Persistent Storage, Algorithmic Segmentation, and Ephemeral Staging
 *
 * 1. Upload original PDF to cic-authoritative-case-files (permanent copy).
 * 2. Use pdf-lib to split into chunks (≤15 pages for Path 1 sync, ≤500 pages for Path 2 async).
 * 3. Track absolute_page_offset for each chunk (non-negotiable for Step 3 reassembly).
 * 4. Upload chunks to cic-docai-staging-inputs.
 */
import { PDFDocument } from 'pdf-lib';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { uploadFile, uploadBuffer, BUCKET_AUTH, BUCKET_STAGING } from '../gcs.js';
import { Log } from './orchestrator.js';

export type ProcessingPath = 'path1-sync' | 'path2-async';
export const CHUNK_SIZE_SYNC  = 15;   // Path 1: ≤15 pages per chunk (sync processDocument limit)
export const CHUNK_SIZE_ASYNC = 500;  // Path 2: ≤500 pages per chunk (async batchProcess limit)

export interface ChunkRef {
  chunkId: string;
  chunkIndex: number;
  absolutePageOffset: number;   // 0-based offset into the original document
  pageCount: number;
  gcsUri: string;               // gs:// URI in staging input bucket
  localPath?: string;           // kept until cleanup
}

export interface Step1Result {
  authGcsUri: string;           // gs:// URI of the permanent original in auth bucket
  gcsPrefix: string;            // staging prefix for all chunks of this file
  chunks: ChunkRef[];
  totalPages: number;
}

export async function step1(
  localFilePath: string,
  caseId: string,
  fileId: string,
  fileName: string,
  processingPath: ProcessingPath,
  log: Log,
): Promise<Step1Result> {
  log('info', `[Step 1] Starting upload + chunking: ${fileName}`);

  // ── 1. Upload original to authoritative bucket ────────────────────────────
  const authDest = `cases/${caseId}/${fileId}/${fileName}`;
  log('info', `[Step 1] Uploading original to gs://${BUCKET_AUTH()}/${authDest}`);
  const authGcsUri = await uploadFile(localFilePath, BUCKET_AUTH(), authDest);
  log('success', `[Step 1] Original stored: ${authGcsUri}`);

  // ── 2. Read PDF and determine total pages ─────────────────────────────────
  const pdfBytes = fs.readFileSync(localFilePath);
  const srcPdf = await PDFDocument.load(pdfBytes);
  const totalPages = srcPdf.getPageCount();
  log('info', `[Step 1] Total pages in PDF: ${totalPages}`);

  if (totalPages === 0) throw new Error('PDF has 0 pages — cannot process.');

  // ── 3. Chunk into path-dependent page segments ────────────────────────────
  const chunkSize = processingPath === 'path1-sync' ? CHUNK_SIZE_SYNC : CHUNK_SIZE_ASYNC;
  log('info', `[Step 1] Processing path: ${processingPath} — chunk size: ${chunkSize} pages`);

  const chunks: ChunkRef[] = [];
  const gcsPrefix = `cases/${caseId}/${fileId}/chunks`;
  const tmpDir = path.join(process.cwd(), 'chunks', caseId, fileId);
  fs.mkdirSync(tmpDir, { recursive: true });

  let pageOffset = 0;
  let chunkIndex = 0;

  while (pageOffset < totalPages) {
    const endPage = Math.min(pageOffset + chunkSize, totalPages);
    const pageCount = endPage - pageOffset;

    // Create a new PDF with just these pages
    const chunkPdf = await PDFDocument.create();
    const pageIndices = Array.from({ length: pageCount }, (_, i) => pageOffset + i);
    const copiedPages = await chunkPdf.copyPages(srcPdf, pageIndices);
    copiedPages.forEach(p => chunkPdf.addPage(p));

    const chunkBytes = await chunkPdf.save();
    const chunkId = uuidv4();
    const chunkFileName = `chunk_${String(chunkIndex).padStart(4, '0')}_pages_${pageOffset + 1}-${endPage}.pdf`;
    const localChunkPath = path.join(tmpDir, chunkFileName);
    fs.writeFileSync(localChunkPath, chunkBytes);

    // Upload to staging
    const stagingDest = `${gcsPrefix}/${chunkFileName}`;
    const gcsUri = await uploadBuffer(Buffer.from(chunkBytes), BUCKET_STAGING(), stagingDest, 'application/pdf');

    chunks.push({
      chunkId, chunkIndex,
      absolutePageOffset: pageOffset,   // e.g. chunk 2 (pages 501-1000) → offset=500
      pageCount,
      gcsUri,
      localPath: localChunkPath,
    });

    log('info', `[Step 1] Chunk ${chunkIndex}: pages ${pageOffset + 1}–${endPage} → ${gcsUri}`);
    pageOffset = endPage;
    chunkIndex++;
  }

  log('success', `[Step 1] Created ${chunks.length} chunk(s) for ${totalPages} pages`);
  return { authGcsUri, gcsPrefix, chunks, totalPages };
}
