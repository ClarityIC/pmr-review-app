/**
 * BigQuery helpers for Table 0 — the structured document corpus.
 *
 * Schema per row (one row per reassembled chunk):
 *   chunk_id       STRING   — unique ID for this chunk
 *   case_id        STRING   — FK to Firestore cases collection
 *   file_id        STRING   — FK to CaseFile.id
 *   file_name      STRING   — original filename
 *   chunk_index    INTEGER  — 0-based chunk index within the file
 *   abs_page_start INTEGER  — first page in the original document (1-based, after offset applied)
 *   abs_page_end   INTEGER  — last page in the original document (1-based, after offset applied)
 *   raw_text       STRING   — full concatenated text for this chunk (from OCR)
 *   layout_chunks  JSON     — context-aware chunks from Layout Parser
 *   ocr_pages      JSON     — per-page OCR data (tokens, blocks, geometry)
 *   created_at     TIMESTAMP
 */
import { getBigQuery, getEnv } from './config.js';

const DATASET = () => getEnv('BQ_DATASET') || 'prr_data';
const TABLE0  = () => getEnv('BQ_TABLE0') || 'documents';

export const TABLE0_SCHEMA = [
  { name: 'chunk_id',       type: 'STRING',    mode: 'REQUIRED' },
  { name: 'case_id',        type: 'STRING',    mode: 'REQUIRED' },
  { name: 'file_id',        type: 'STRING',    mode: 'REQUIRED' },
  { name: 'file_name',      type: 'STRING',    mode: 'NULLABLE' },
  { name: 'chunk_index',    type: 'INTEGER',   mode: 'REQUIRED' },
  { name: 'abs_page_start', type: 'INTEGER',   mode: 'REQUIRED' },
  { name: 'abs_page_end',   type: 'INTEGER',   mode: 'REQUIRED' },
  { name: 'raw_text',       type: 'STRING',    mode: 'NULLABLE' },
  { name: 'layout_chunks',  type: 'JSON',      mode: 'NULLABLE' },
  { name: 'ocr_pages',      type: 'JSON',      mode: 'NULLABLE' },
  { name: 'created_at',     type: 'TIMESTAMP', mode: 'REQUIRED' },
];

/** Create dataset and Table 0 if they don't exist. */
export async function ensureTable0Exists(): Promise<void> {
  const bq = getBigQuery();
  const dataset = bq.dataset(DATASET());
  const [dsExists] = await dataset.exists();
  if (!dsExists) {
    await dataset.create({ location: 'US' });
    console.log(`[BQ] Created dataset: ${DATASET()}`);
  }
  const table = dataset.table(TABLE0());
  const [tExists] = await table.exists();
  if (!tExists) {
    await table.create({ schema: TABLE0_SCHEMA, timePartitioning: { type: 'DAY', field: 'created_at' } });
    console.log(`[BQ] Created table: ${DATASET()}.${TABLE0()}`);
  }
}

export interface Table0Row {
  chunk_id: string;
  case_id: string;
  file_id: string;
  file_name: string;
  chunk_index: number;
  abs_page_start: number;
  abs_page_end: number;
  raw_text: string;
  layout_chunks: string;   // JSON string
  ocr_pages: string;       // JSON string
  created_at: string;      // ISO timestamp
}

/** Insert rows into Table 0. Uses streaming insert, one row at a time to handle large payloads. */
export async function insertRows(rows: Table0Row[]): Promise<void> {
  if (rows.length === 0) return;
  const bq = getBigQuery();
  const table = bq.dataset(DATASET()).table(TABLE0());
  for (const row of rows) {
    await table.insert([row]);
  }
  console.log(`[BQ] Inserted ${rows.length} rows for case ${rows[0].case_id}`);
}

/** Safely parse a JSON column that may be a string, object, or null. */
function parseJsonColumn(raw: any): any[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Retrieve structured, annotated text for a case — designed as Gemini input.
 *
 * Uses Layout Parser chunks as the primary text source (semantically segmented,
 * with page spans and heading hierarchy). Falls back to OCR raw_text when
 * layout_chunks is null/empty. Groups text by file with metadata headers.
 */
export async function getCaseText(caseId: string): Promise<string> {
  const bq = getBigQuery();
  const query = `
    SELECT file_name, abs_page_start, abs_page_end, raw_text, layout_chunks
    FROM \`${bq.projectId}.${DATASET()}.${TABLE0()}\`
    WHERE case_id = @caseId
    ORDER BY abs_page_start ASC, chunk_index ASC
  `;
  const [rows] = await bq.query({ query, params: { caseId } });
  if (!rows.length) return '';

  // Pre-pass: compute full page range per file
  const filePageRange = new Map<string, { min: number; max: number }>();
  for (const row of rows) {
    const fn = row.file_name || 'Unknown file';
    const existing = filePageRange.get(fn);
    if (existing) {
      existing.min = Math.min(existing.min, row.abs_page_start);
      existing.max = Math.max(existing.max, row.abs_page_end);
    } else {
      filePageRange.set(fn, { min: row.abs_page_start, max: row.abs_page_end });
    }
  }

  const sections: string[] = [];
  let currentFile = '';

  for (const row of rows) {
    const fileName = row.file_name || 'Unknown file';

    // Emit file header when file changes
    if (fileName !== currentFile) {
      currentFile = fileName;
      const range = filePageRange.get(fileName)!;
      sections.push(`\n══ FILE: "${fileName}" (Pages ${range.min}–${range.max}) ══\n`);
    }

    // Try Layout Parser chunks first, fall back to raw_text
    const layoutChunks = parseJsonColumn(row.layout_chunks);

    if (layoutChunks.length > 0) {
      for (const chunk of layoutChunks) {
        const ps = chunk.pageSpan;
        const pageLabel = ps
          ? (ps.pageStart === ps.pageEnd
              ? `── Page ${ps.pageStart} ──`
              : `── Pages ${ps.pageStart}–${ps.pageEnd} ──`)
          : `── Pages ${row.abs_page_start}–${row.abs_page_end} ──`;

        const headingCtx = (chunk.pageHeaders || [])
          .map((h: any) => h.text || '')
          .filter(Boolean)
          .join(' > ');

        let text = '';
        if (headingCtx) text += `[${headingCtx}]\n`;
        text += chunk.content || '';

        sections.push(`${pageLabel}\n${text}`);
      }
    } else {
      // Fallback: raw OCR text with page range header
      const pageLabel = row.abs_page_start === row.abs_page_end
        ? `── Page ${row.abs_page_start} ──`
        : `── Pages ${row.abs_page_start}–${row.abs_page_end} ──`;
      sections.push(`${pageLabel}\n${row.raw_text || ''}`);
    }
  }

  return sections.join('\n\n');
}

/** Get full structured rows for a case (used by Table 2 which also needs Table 1 context). */
export async function getCaseRows(caseId: string): Promise<any[]> {
  const bq = getBigQuery();
  const query = `
    SELECT *
    FROM \`${bq.projectId}.${DATASET()}.${TABLE0()}\`
    WHERE case_id = @caseId
    ORDER BY chunk_index ASC
  `;
  const [rows] = await bq.query({ query, params: { caseId } });
  return rows;
}

/** Delete all rows for a case (used if re-processing). */
export async function deleteCaseRows(caseId: string): Promise<void> {
  const bq = getBigQuery();
  const query = `DELETE FROM \`${bq.projectId}.${DATASET()}.${TABLE0()}\` WHERE case_id = @caseId`;
  await bq.query({ query, params: { caseId } });
  console.log(`[BQ] Deleted rows for case ${caseId}`);
}

/** Check which file_ids already have rows in BigQuery for a given case. */
export async function getCaseFileIds(caseId: string): Promise<string[]> {
  const bq = getBigQuery();
  const query = `SELECT DISTINCT file_id FROM \`${bq.projectId}.${DATASET()}.${TABLE0()}\` WHERE case_id = @caseId`;
  try {
    const [rows] = await bq.query({ query, params: { caseId } });
    return rows.map((r: any) => r.file_id);
  } catch {
    return []; // Table may not exist yet
  }
}

/**
 * Delete rows whose case_id is NOT in the provided list of known IDs.
 * Used during orphan cleanup after cases have been deleted from Firestore.
 * UUIDs contain only [0-9a-f-] so safe to inline into SQL.
 */
export async function deleteOrphanRows(knownCaseIds: string[]): Promise<void> {
  if (knownCaseIds.length === 0) return; // safety: don't wipe table if no known cases
  const bq = getBigQuery();
  const idList = knownCaseIds.map(id => `'${id}'`).join(', ');
  const query = `
    DELETE FROM \`${bq.projectId}.${DATASET()}.${TABLE0()}\`
    WHERE case_id NOT IN (${idList})
  `;
  try {
    await bq.query(query);
    console.log(`[BQ] Orphan row cleanup complete (${knownCaseIds.length} known cases)`);
  } catch (e: any) {
    // Table may not exist yet — not an error
    if (!e.message?.includes('Not found')) throw e;
  }
}
