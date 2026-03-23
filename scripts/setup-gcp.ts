/**
 * GCP Setup Script — run once to provision all required cloud resources.
 * Usage: npm run setup-gcp
 *
 * Creates:
 *   - GCS buckets (authoritative + staging input + staging output)
 *   - BigQuery dataset + Table 0
 *   - Document AI processors (OCR v2.1 + Layout Parser v1.6-pro)
 *
 * Safe to re-run — all operations are idempotent.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Storage } from '@google-cloud/storage';
import { BigQuery } from '@google-cloud/bigquery';
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { TABLE0_SCHEMA } from '../server/bigquery.js';

function getCredentials() {
  const raw = (process.env.GCP_SA_KEY || '').trim();
  if (!raw) throw new Error('GCP_SA_KEY is not set in .env');
  return JSON.parse(raw);
}

const creds   = getCredentials();
const project = creds.project_id;
const storage = new Storage({ projectId: project, credentials: creds });
const bq      = new BigQuery({ projectId: project, credentials: creds });
const docai   = new DocumentProcessorServiceClient({
  apiEndpoint: 'us-documentai.googleapis.com',
  credentials: creds,
});

async function ensureBucket(name: string, label: string) {
  const bucket = storage.bucket(name);
  const [exists] = await bucket.exists();
  if (exists) {
    console.log(`  ✓ GCS bucket already exists: ${name}`);
    return;
  }
  await bucket.create({ location: 'US' });
  console.log(`  ✓ Created GCS bucket: ${name} (${label})`);
}

async function ensureBQDataset(dataset: string) {
  const ds = bq.dataset(dataset);
  const [exists] = await ds.exists();
  if (exists) { console.log(`  ✓ BigQuery dataset already exists: ${dataset}`); return; }
  await ds.create({ location: 'US' });
  console.log(`  ✓ Created BigQuery dataset: ${dataset}`);
}

async function ensureBQTable(dataset: string, table: string) {
  const t = bq.dataset(dataset).table(table);
  const [exists] = await t.exists();
  if (exists) { console.log(`  ✓ BigQuery Table 0 already exists: ${dataset}.${table}`); return; }
  await t.create({ schema: TABLE0_SCHEMA, timePartitioning: { type: 'DAY', field: 'created_at' } });
  console.log(`  ✓ Created BigQuery Table 0: ${dataset}.${table}`);
}

async function createProcessor(
  type: string,
  displayName: string,
  versionId: string,
  envKey: string,
) {
  const existing = process.env[envKey]?.trim();

  // Check if processor already exists
  const parent = `projects/${project}/locations/us`;
  const [processors] = await docai.listProcessors({ parent });
  const found = processors.find((p: any) => p.type === type);

  if (found) {
    const id = (found as any).name!.split('/').pop()!;
    console.log(`  ✓ Document AI processor already exists: ${displayName} (${id})`);
    if (!existing) {
      console.log(`  → Add to .env:  ${envKey}=${id}`);
    }
    return id;
  }

  const [op] = await docai.createProcessor({
    parent,
    processor: { type, displayName } as any,
  });
  const createdProcessor = op as any;
  const id = createdProcessor.name!.split('/').pop()!;
  console.log(`  ✓ Created Document AI processor: ${displayName} (${id})`);
  console.log(`  → Add to .env:  ${envKey}=${id}`);
  return id;
}

async function deleteV1Resources() {
  console.log('\n📦 Cleaning up v1 resources...');

  // Delete old GCS bucket (cic-prr-uploads)
  try {
    const oldBucket = storage.bucket('cic-prr-uploads');
    const [exists] = await oldBucket.exists();
    if (exists) {
      const [files] = await oldBucket.getFiles();
      await Promise.all(files.map(f => f.delete().catch(() => {})));
      await oldBucket.delete();
      console.log('  ✓ Deleted old GCS bucket: cic-prr-uploads');
    }
  } catch (e: any) { console.warn(`  ⚠ Could not delete cic-prr-uploads: ${e.message}`); }

  // Delete Firestore v1 cases
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId: project, credentials: creds });
  const snap = await db.collection('cases').get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (snap.size > 0) {
    await batch.commit();
    console.log(`  ✓ Deleted ${snap.size} v1 case(s) from Firestore`);
  } else {
    console.log('  ✓ Firestore already empty');
  }

  // Delete old Document AI processor
  const parent = `projects/${project}/locations/us`;
  const [processors] = await docai.listProcessors({ parent });
  const oldId = '253322e1ce1a3293';
  const oldProc = processors.find((p: any) => (p as any).name?.endsWith(oldId));
  if (oldProc) {
    try {
      await docai.deleteProcessor({ name: (oldProc as any).name });
      console.log(`  ✓ Deleted v1 Document AI processor: ${oldId}`);
    } catch (e: any) { console.warn(`  ⚠ Could not delete old processor: ${e.message}`); }
  }
}

async function main() {
  console.log(`\n🚀 PMR App GCP Setup`);
  console.log(`   Project: ${project}\n`);

  await deleteV1Resources();

  console.log('\n📦 Creating v2 GCS buckets...');
  await ensureBucket('cic-authoritative-case-files', 'Permanent original uploads');
  await ensureBucket('cic-docai-staging-inputs',     'Ephemeral DocAI input chunks');
  await ensureBucket('cic-docai-staging-outputs',    'Ephemeral DocAI JSON outputs');

  console.log('\n📊 Creating BigQuery dataset + Table 0...');
  await ensureBQDataset('prr_data');
  await ensureBQTable('prr_data', 'documents');

  console.log('\n🤖 Creating Document AI processors...');
  const ocrId = await createProcessor(
    'OCR_PROCESSOR',
    'PMR OCR Processor',
    'pretrained-ocr-v2.1-2024-08-07',
    'DOCAI_OCR_PROCESSOR_ID',
  );
  const layoutId = await createProcessor(
    'LAYOUT_PARSER_PROCESSOR',
    'PMR Layout Parser',
    'pretrained-layout-parser-v1.6-pro-2025-12-01',
    'DOCAI_LAYOUT_PROCESSOR_ID',
  );

  console.log('\n✅ GCP setup complete!\n');
  console.log('Next steps:');
  console.log('1. Copy the processor IDs above into your .env file');
  console.log('2. Run: npm run dev\n');
}

main().catch(e => { console.error('Setup failed:', e); process.exit(1); });
