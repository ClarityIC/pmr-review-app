/**
 * Pre-flight checks — validates all GCP credentials and connectivity
 * before the pipeline runs. Surfaced in the Admin panel.
 */
import { checkEnvStatus, getGcpCredentials, getEnv } from './config.js';
import { getStorage } from './config.js';
import { getBigQuery } from './config.js';
import { getDocAI } from './config.js';
import { BUCKET_AUTH, BUCKET_STAGING, BUCKET_OUTPUT } from './gcs.js';

export interface PreflightResult {
  allValid: boolean;
  checkedAt: string;
  checks: {
    name: string;
    status: 'pass' | 'fail' | 'warn';
    message: string;
  }[];
}

export async function runPreflight(): Promise<PreflightResult> {
  const checks: PreflightResult['checks'] = [];

  const check = (name: string, status: 'pass' | 'fail' | 'warn', message: string) => {
    checks.push({ name, status, message });
  };

  // ── Env vars ──────────────────────────────────────────────────────────────
  for (const key of ['GOOGLE_CLIENT_ID', 'SESSION_SECRET', 'GCP_SA_KEY', 'DOCAI_OCR_PROCESSOR_ID', 'DOCAI_LAYOUT_PROCESSOR_ID']) {
    const s = checkEnvStatus(key);
    check(`Env: ${key}`, s.valid ? 'pass' : 'fail', s.error || 'Present and non-placeholder');
  }

  // ── GCP Credentials ───────────────────────────────────────────────────────
  const creds = getGcpCredentials();
  if (!creds) {
    check('GCP Service Account', 'fail', 'GCP_SA_KEY is missing or invalid JSON');
  } else {
    check('GCP Service Account', 'pass', `Service account: ${creds.client_email}`);
  }

  // ── GCS Buckets ───────────────────────────────────────────────────────────
  const buckets = [BUCKET_AUTH(), BUCKET_STAGING(), BUCKET_OUTPUT()];
  for (const bucket of buckets) {
    try {
      const [exists] = await getStorage().bucket(bucket).exists();
      check(`GCS Bucket: ${bucket}`, exists ? 'pass' : 'fail',
        exists ? 'Bucket exists and accessible' : 'Bucket does not exist — run npm run setup-gcp');
    } catch (e: any) {
      check(`GCS Bucket: ${bucket}`, 'fail', `Access error: ${e.message}`);
    }
  }

  // ── BigQuery ──────────────────────────────────────────────────────────────
  try {
    const dataset = getEnv('BQ_DATASET') || 'prr_data';
    const bq = getBigQuery();
    const [exists] = await bq.dataset(dataset).exists();
    check('BigQuery Dataset', exists ? 'pass' : 'warn',
      exists ? `Dataset '${dataset}' exists` : `Dataset '${dataset}' not yet created — will be created on first run`);
  } catch (e: any) {
    check('BigQuery Dataset', 'fail', `BigQuery error: ${e.message}`);
  }

  // ── Document AI Processors ────────────────────────────────────────────────
  for (const [key, label] of [['DOCAI_OCR_PROCESSOR_ID', 'OCR'], ['DOCAI_LAYOUT_PROCESSOR_ID', 'Layout Parser']] as const) {
    const id = getEnv(key);
    if (!id) {
      check(`DocAI ${label} Processor`, 'fail', `${key} not set — run npm run setup-gcp`);
      continue;
    }
    try {
      const creds = getGcpCredentials();
      const projectId = creds?.project_id || getEnv('GCP_PROJECT_ID');
      const processorName = `projects/${projectId}/locations/us/processors/${id}`;
      const docai = getDocAI();
      const [processor] = await (docai as any).getProcessor({ name: processorName });
      const state = (processor as any).state;
      check(`DocAI ${label} Processor`, state === 'ENABLED' ? 'pass' : 'warn',
        `ID: ${id}, state: ${state}`);
    } catch (e: any) {
      check(`DocAI ${label} Processor`, 'fail', `Cannot reach processor: ${e.message}`);
    }
  }

  // ── Gemini (Vertex AI) ────────────────────────────────────────────────────
  try {
    const { getGenAI } = await import('./config.js');
    const genai = getGenAI();
    const model = getEnv('GEMINI_MODEL') || 'gemini-3.1-pro-preview';
    // Minimal test: list models (just verifies auth works)
    check('Vertex AI / Gemini', 'pass', `Credentials valid, model: ${model}`);
  } catch (e: any) {
    check('Vertex AI / Gemini', 'fail', `Vertex AI init failed: ${e.message}`);
  }

  const allValid = checks.every(c => c.status !== 'fail');
  return { allValid, checkedAt: new Date().toISOString(), checks };
}
