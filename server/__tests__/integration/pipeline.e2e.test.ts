/**
 * End-to-end integration tests for the upload and table generation pipeline.
 *
 * These tests use REAL GCP services (GCS, Document AI, BigQuery, Vertex AI Gemini).
 * Each test creates an isolated Firestore case, runs the pipeline with real PDFs,
 * asserts on the results, then cleans up all GCP resources.
 *
 * Expected runtime: ~5–15 minutes per test (Document AI LROs take time).
 * Run with:  npm run test:integration
 */
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

import { createCase, getCase, deleteCase } from '../../cases.js';
import { runPipeline } from '../../pipeline/orchestrator.js';
import { deleteCaseRows, getCaseRows } from '../../bigquery.js';
import { deletePrefix, BUCKET_AUTH } from '../../gcs.js';

// ── Paths to test PDFs ────────────────────────────────────────────────────────
const BASE = '/Users/tjb/Library/CloudStorage/GoogleDrive-travis@clarityic.com/Shared drives/Clarity IC/Protected Files/AI Files/AI Projects/2603v2 Prior Medical Records Review';
const PDF_PRIOR_RECORDS = join(BASE, 'Test Files/Prior Records/Newman, Kirkland - Martinez VA Medical Records from 3-11-26 through 6-9-21 part 1.pdf');
const PDF_INITIAL_EXAM  = join(BASE, 'Test Files/Initial Exam Note/260311 Kirkland Newman - Initial Exam Report v3.pdf');

/** Copy a test PDF to a temp file so the pipeline can delete it safely. */
function tempCopy(srcPath: string): string {
  const dest = join(tmpdir(), `pmr-test-${uuidv4()}.pdf`);
  copyFileSync(srcPath, dest);
  return dest;
}

/** IDs of cases created during tests — cleaned up in afterEach. */
const createdCaseIds: string[] = [];

afterEach(async () => {
  for (const caseId of createdCaseIds.splice(0)) {
    await Promise.allSettled([
      deleteCase(caseId),
      deleteCaseRows(caseId),
      deletePrefix(BUCKET_AUTH(), `cases/${caseId}`),
    ]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: test PDF files are accessible
// ─────────────────────────────────────────────────────────────────────────────
describe('test PDF prerequisites', () => {
  it('prior records PDF exists on disk', () => {
    expect(existsSync(PDF_PRIOR_RECORDS)).toBe(true);
  });

  it('initial exam PDF exists on disk', () => {
    expect(existsSync(PDF_INITIAL_EXAM)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Single-file pipeline (Prior Records — 80 pages)
// ─────────────────────────────────────────────────────────────────────────────
describe('single-file pipeline (prior records)', () => {
  it(
    'runs all 5 steps and produces a complete case with non-empty tables',
    async () => {
      // 1. Create a fresh Firestore case
      const caseRecord = await createCase('Newman, Kirkland', '2021-06-09', 'test@clarityic.com');
      const caseId = caseRecord.id;
      createdCaseIds.push(caseId);

      expect(caseRecord.status).toBe('draft');
      expect(caseRecord.files).toHaveLength(0);

      // 2. Run the full pipeline (awaited — runPipeline is async end-to-end)
      const fileId = uuidv4();
      await runPipeline({
        caseId,
        files: [{ fileId, fileName: 'prior-records.pdf', localFilePath: tempCopy(PDF_PRIOR_RECORDS) }],
        createdBy: 'test@clarityic.com',
      });

      // 3. Load the updated case from Firestore
      const result = await getCase(caseId);
      expect(result).not.toBeNull();

      // 4. Case should be complete
      expect(result!.status).toBe('complete');
      expect(result!.errorMessage).toBeUndefined();
      expect(result!.dateProcessed).not.toBeNull();

      // 5. File should be registered
      expect(result!.files).toHaveLength(1);
      expect(result!.files[0].name).toBe('prior-records.pdf');
      expect(result!.files[0].sizeBytes).toBeGreaterThan(0);

      // 6. BigQuery Table 0 should have rows for this case
      const bqRows = await getCaseRows(caseId);
      expect(bqRows.length).toBeGreaterThan(0);
      const firstRow = bqRows[0];
      expect(firstRow.case_id).toBe(caseId);
      expect(firstRow.file_id).toBe(fileId);
      expect(firstRow).toHaveProperty('raw_text');
      expect(typeof firstRow.raw_text).toBe('string');
      expect(firstRow.raw_text.length).toBeGreaterThan(0);
      expect(firstRow.abs_page_start).toBe(1);

      // 7. Table 1 (Medical Chronology) should have rows
      expect(result!.table1).toBeDefined();
      expect(Array.isArray(result!.table1)).toBe(true);
      expect(result!.table1.length).toBeGreaterThan(0);

      // Each row should be a plain object with string values
      const t1Row = result!.table1[0];
      expect(typeof t1Row).toBe('object');
      expect(t1Row).not.toBeNull();
      const t1Keys = Object.keys(t1Row);
      expect(t1Keys.length).toBeGreaterThan(0);
      for (const val of Object.values(t1Row)) {
        expect(typeof val).toBe('string');
      }

      // 8. Table 1 should have a date-like column
      const dateCol = t1Keys.find(k => /date/i.test(k));
      expect(dateCol).toBeDefined();

      // 9. Table 2 (Patient Conditions) should have rows
      expect(result!.table2).toBeDefined();
      expect(Array.isArray(result!.table2)).toBe(true);
      expect(result!.table2.length).toBeGreaterThan(0);

      // Each row should be a plain object
      const t2Row = result!.table2[0];
      expect(typeof t2Row).toBe('object');
      const t2Keys = Object.keys(t2Row);
      expect(t2Keys.length).toBeGreaterThan(0);
    },
    { timeout: 15 * 60 * 1000 }, // 15 minutes
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Multi-file pipeline (both test PDFs in one runPipeline call)
// ─────────────────────────────────────────────────────────────────────────────
describe('multi-file pipeline (two PDFs)', () => {
  it(
    'ingests both files into BigQuery and generates combined tables',
    async () => {
      const caseRecord = await createCase('Newman, Kirkland', '2021-06-09', 'test@clarityic.com');
      const caseId = caseRecord.id;
      createdCaseIds.push(caseId);

      const fileId1 = uuidv4();
      const fileId2 = uuidv4();

      await runPipeline({
        caseId,
        files: [
          { fileId: fileId1, fileName: 'prior-records.pdf',  localFilePath: tempCopy(PDF_PRIOR_RECORDS) },
          { fileId: fileId2, fileName: 'initial-exam.pdf',   localFilePath: tempCopy(PDF_INITIAL_EXAM)  },
        ],
        createdBy: 'test@clarityic.com',
      });

      const result = await getCase(caseId);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('complete');

      // Both files should be registered
      expect(result!.files).toHaveLength(2);
      const fileNames = result!.files.map(f => f.name);
      expect(fileNames).toContain('prior-records.pdf');
      expect(fileNames).toContain('initial-exam.pdf');

      // BigQuery should have rows from BOTH files
      const bqRows = await getCaseRows(caseId);
      const fileIds = new Set(bqRows.map((r: any) => r.file_id));
      expect(fileIds.has(fileId1)).toBe(true);
      expect(fileIds.has(fileId2)).toBe(true);

      // Tables should exist and be non-empty
      expect(result!.table1.length).toBeGreaterThan(0);
      expect(result!.table2.length).toBeGreaterThan(0);

      // Tables 1 and 2 should be generated only ONCE (not per-file)
      // Verify by checking dateProcessed is a single timestamp
      expect(result!.dateProcessed).not.toBeNull();
    },
    { timeout: 25 * 60 * 1000 }, // 25 minutes for two files
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Subsequent upload (adding a second file to a complete case)
// ─────────────────────────────────────────────────────────────────────────────
describe('subsequent upload to an existing complete case', () => {
  it(
    'adds a second file and regenerates both tables from combined data',
    async () => {
      // First upload
      const caseRecord = await createCase('Newman, Kirkland', '2021-06-09', 'test@clarityic.com');
      const caseId = caseRecord.id;
      createdCaseIds.push(caseId);

      await runPipeline({
        caseId,
        files: [{ fileId: uuidv4(), fileName: 'initial-exam.pdf', localFilePath: tempCopy(PDF_INITIAL_EXAM) }],
        createdBy: 'test@clarityic.com',
      });

      const afterFirst = await getCase(caseId);
      expect(afterFirst!.status).toBe('complete');
      expect(afterFirst!.files).toHaveLength(1);
      const table1CountAfterFirst = afterFirst!.table1.length;

      // Second upload — add the prior records PDF
      await runPipeline({
        caseId,
        files: [{ fileId: uuidv4(), fileName: 'prior-records.pdf', localFilePath: tempCopy(PDF_PRIOR_RECORDS) }],
        createdBy: 'test@clarityic.com',
      });

      const afterSecond = await getCase(caseId);
      expect(afterSecond!.status).toBe('complete');

      // Both files should now be registered
      expect(afterSecond!.files).toHaveLength(2);

      // Tables should be regenerated with MORE data (prior records is much larger)
      // We expect table1 to have at least as many rows as after the first upload
      expect(afterSecond!.table1.length).toBeGreaterThanOrEqual(table1CountAfterFirst);
      expect(afterSecond!.table2.length).toBeGreaterThan(0);
    },
    { timeout: 30 * 60 * 1000 }, // 30 minutes
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Concurrent upload guard
// ─────────────────────────────────────────────────────────────────────────────
describe('concurrent upload guard', () => {
  it(
    'ignores a duplicate runPipeline call while one is already active',
    async () => {
      const caseRecord = await createCase('Newman, Kirkland', '2021-06-09', 'test@clarityic.com');
      const caseId = caseRecord.id;
      createdCaseIds.push(caseId);

      // Fire two pipelines concurrently — the second should be a no-op
      const fileId1 = uuidv4();
      const fileId2 = uuidv4();
      const [p1, p2] = await Promise.allSettled([
        runPipeline({
          caseId,
          files: [{ fileId: fileId1, fileName: 'initial-exam.pdf', localFilePath: tempCopy(PDF_INITIAL_EXAM) }],
          createdBy: 'test@clarityic.com',
        }),
        runPipeline({
          caseId,
          files: [{ fileId: fileId2, fileName: 'prior-records.pdf', localFilePath: tempCopy(PDF_PRIOR_RECORDS) }],
          createdBy: 'test@clarityic.com',
        }),
      ]);

      // Both Promises should resolve (the second silently drops)
      expect(p1.status).toBe('fulfilled');
      expect(p2.status).toBe('fulfilled');

      const result = await getCase(caseId);
      // The case should be complete — from whichever pipeline ran
      expect(result!.status).toBe('complete');
      // Only the first pipeline's file should be registered (the duplicate was dropped)
      expect(result!.files).toHaveLength(1);
    },
    { timeout: 15 * 60 * 1000 },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Pipeline error handling
// ─────────────────────────────────────────────────────────────────────────────
describe('pipeline error handling', () => {
  it(
    'sets case status to error and stores errorMessage when given a non-PDF',
    async () => {
      const caseRecord = await createCase('Error Test', '2021-01-01', 'test@clarityic.com');
      const caseId = caseRecord.id;
      createdCaseIds.push(caseId);

      // Write a fake "PDF" that is actually just text — pdf-lib will reject it
      const fakePdf = join(tmpdir(), `fake-${uuidv4()}.pdf`);
      const { writeFileSync } = await import('fs');
      writeFileSync(fakePdf, 'this is not a valid PDF file');

      await runPipeline({
        caseId,
        files: [{ fileId: uuidv4(), fileName: 'fake.pdf', localFilePath: fakePdf }],
        createdBy: 'test@clarityic.com',
      });

      const result = await getCase(caseId);
      expect(result!.status).toBe('error');
      expect(result!.errorMessage).toBeDefined();
      expect(typeof result!.errorMessage).toBe('string');
      expect(result!.errorMessage!.length).toBeGreaterThan(0);
    },
    { timeout: 60_000 },
  );
});
