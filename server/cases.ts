/**
 * Cases module — Firestore persistence for PRR case metadata.
 * Document content lives in BigQuery (Table 0); only metadata here.
 */
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { v4 as uuidv4 } from 'uuid';
import { getFirestore } from './config.js';

export type CaseStatus = 'draft' | 'processing' | 'complete' | 'error';

export interface CaseFile {
  id: string;
  name: string;
  gcsPath: string;       // path within cic-authoritative-case-files
  gcsBucket: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface CaseRecord {
  id: string;
  patientName: string;
  dateOfInjury: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  status: CaseStatus;
  dateProcessed: string | null;
  files: CaseFile[];
  table1: any[];         // Chronology rows (populated after Step 4)
  table2: any[];         // Conditions rows (populated after Step 5)
  errorMessage?: string;
  // Prompt overrides (set via Admin panel)
  table1Prompt?: string;
  table2Prompt?: string;
}

const COLLECTION = 'cases';

function db() { return getFirestore(); }

export async function createCase(patientName: string, dateOfInjury: string, createdBy: string): Promise<CaseRecord> {
  const id = uuidv4();
  const now = new Date().toISOString();
  const record: CaseRecord = {
    id, patientName, dateOfInjury, createdBy,
    createdAt: now, updatedAt: now,
    status: 'draft', dateProcessed: null,
    files: [], table1: [], table2: [],
  };
  await db().collection(COLLECTION).doc(id).set(record);
  return record;
}

export async function getCase(id: string): Promise<CaseRecord | null> {
  const snap = await db().collection(COLLECTION).doc(id).get();
  return snap.exists ? (snap.data() as CaseRecord) : null;
}

export async function listCases(opts: { search?: string; sortBy?: string; sortDir?: string } = {}): Promise<CaseRecord[]> {
  const snap = await db().collection(COLLECTION).get();
  let cases = snap.docs.map(d => d.data() as CaseRecord);

  if (opts.search) {
    const q = opts.search.toLowerCase();
    cases = cases.filter(c => c.patientName.toLowerCase().includes(q));
  }

  const by = opts.sortBy || 'createdAt';
  const dir = opts.sortDir === 'asc' ? 1 : -1;
  cases.sort((a: any, b: any) => {
    const av = a[by] ?? '';
    const bv = b[by] ?? '';
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  return cases;
}

export async function updateCase(id: string, patch: Partial<CaseRecord>): Promise<void> {
  await db().collection(COLLECTION).doc(id).update({
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteCase(id: string): Promise<void> {
  await db().collection(COLLECTION).doc(id).delete();
}

export async function addFileToCase(caseId: string, file: CaseFile): Promise<void> {
  await db().collection(COLLECTION).doc(caseId).update({
    files: FieldValue.arrayUnion(file),
    updatedAt: new Date().toISOString(),
  });
}
