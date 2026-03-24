/**
 * Centralised credential + config helpers.
 * All GCP clients are initialised lazily — never at module load time.
 */
import dotenv from 'dotenv';
dotenv.config();

export function getEnv(key: string): string {
  return (process.env[key] || '').trim();
}

export function requireEnv(key: string): string {
  const val = getEnv(key);
  if (!val) throw new Error(`Required env var ${key} is not set.`);
  return val;
}

/** Parse GCP_SA_KEY JSON, falling back to undefined for ADC. */
export function getGcpCredentials(): Record<string, any> | undefined {
  const raw = getEnv('GCP_SA_KEY');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    console.error('[config] GCP_SA_KEY is not valid JSON — falling back to ADC');
    return undefined;
  }
}

export function getGcpProjectId(): string {
  const explicit = getEnv('GCP_PROJECT_ID');
  if (explicit) return explicit;
  const creds = getGcpCredentials();
  if (creds?.project_id) return creds.project_id;
  throw new Error('Cannot determine GCP project ID. Set GCP_PROJECT_ID or GCP_SA_KEY.');
}

/** Validate a single env var and return a structured status. */
export function checkEnvStatus(key: string): { valid: boolean; status: string; error?: string } {
  const val = getEnv(key);
  if (!val) return { valid: false, status: 'MISSING', error: `${key} is not set.` };
  const placeholders = ['MY_', 'YOUR_', 'TODO', 'REPLACE_ME', 'PLACEHOLDER'];
  if (placeholders.some(p => val.toUpperCase().includes(p))) {
    return { valid: false, status: 'PLACEHOLDER', error: `${key} appears to be a placeholder value.` };
  }
  return { valid: true, status: 'VALID' };
}

// ─── Lazy GCP clients ────────────────────────────────────────────────────────

import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { BigQuery } from '@google-cloud/bigquery';
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { GoogleGenAI } from '@google/genai';

let _firestore: Firestore | null = null;
export function getFirestore(): Firestore {
  if (!_firestore) {
    const creds = getGcpCredentials();
    _firestore = creds
      ? new Firestore({ projectId: creds.project_id, credentials: creds })
      : new Firestore();
  }
  return _firestore;
}

let _storage: Storage | null = null;
export function getStorage(): Storage {
  if (!_storage) {
    const creds = getGcpCredentials();
    _storage = creds
      ? new Storage({ projectId: creds.project_id, credentials: creds })
      : new Storage();
  }
  return _storage;
}

let _bigquery: BigQuery | null = null;
export function getBigQuery(): BigQuery {
  if (!_bigquery) {
    const creds = getGcpCredentials();
    _bigquery = creds
      ? new BigQuery({ projectId: creds.project_id, credentials: creds })
      : new BigQuery();
  }
  return _bigquery;
}

let _docai: DocumentProcessorServiceClient | null = null;
export function getDocAI(): DocumentProcessorServiceClient {
  if (!_docai) {
    const creds = getGcpCredentials();
    const opts: any = { apiEndpoint: 'us-documentai.googleapis.com' };
    if (creds) opts.credentials = creds;
    _docai = new DocumentProcessorServiceClient(opts);
  }
  return _docai;
}

let _genai: GoogleGenAI | null = null;
export function getGenAI(): GoogleGenAI {
  if (!_genai) {
    const creds = getGcpCredentials();
    const projectId = getGcpProjectId();
    // Gemini 3.x preview models are only available on the global endpoint.
    // Use VERTEX_GEMINI_LOCATION to override (defaults to 'global').
    const location = getEnv('VERTEX_GEMINI_LOCATION') || 'global';
    if (!creds) throw new Error('GCP_SA_KEY is required for Vertex AI Gemini access.');
    _genai = new GoogleGenAI({
      vertexai: true,
      project: projectId,
      location,
      googleAuthOptions: { credentials: creds },
    });
  }
  return _genai;
}
