/**
 * PMR Review App — Express server entry point.
 *
 * Dev:  tsx server.ts          (Vite middleware + Express API on one port)
 * Prod: node dist/server.js    (serves dist/client as static files)
 */
import express, { Request, Response } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

import { authRouter, requireAuth } from './server/auth.js';
import { getEnv, getDocAI, getStorage } from './server/config.js';
import {
  createCase, getCase, listCases, updateCase, deleteCase,
} from './server/cases.js';
import { signedWriteUrl, getBucketUsageBytes, listObjects, deletePrefix, deleteObject, downloadFile, BUCKET_AUTH, BUCKET_STAGING, BUCKET_OUTPUT } from './server/gcs.js';
import { deleteCaseRows, deleteOrphanRows } from './server/bigquery.js';
import { runPipeline, resumePipeline, cancelPipeline, getActiveLRONames, getPersistedLRONames, FileInput } from './server/pipeline/orchestrator.js';
import { regenerateTable } from './server/pipeline/regenerate.js';
import { runPreflight } from './server/preflight.js';
import { DEFAULT_TABLE1_PROMPT, DEFAULT_TABLE2_PROMPT } from './server/pipeline/prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = parseInt(getEnv('PORT') || '3000', 10);

// ── Temp upload directory ──────────────────────────────────────────────────
// Use /tmp for uploads — the project directory is on Google Drive which can
// evict temp files during long-running pipelines (7+ min for Document AI).
const UPLOAD_DIR = path.join('/tmp', 'pmr-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Cleanup stale temp files older than 2 hours on startup
function cleanupStaleFiles(dir: string, maxAgeMs = 2 * 60 * 60 * 1000) {
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        stat.isDirectory() ? fs.rmSync(full, { recursive: true }) : fs.unlinkSync(full);
        console.log(`[startup] Removed stale file: ${entry}`);
      }
    } catch {}
  }
}
cleanupStaleFiles(UPLOAD_DIR);
cleanupStaleFiles(path.join(process.cwd(), 'chunks'));

// ── Startup recovery: resume or reset stuck cases from a dead instance ──────
// If a case has a pipelineCheckpoint with step1Complete, we can resume from
// where it left off. Otherwise, mark as error (user must manually retry).
setImmediate(async () => {
  try {
    const { listCases: _list, updateCase: _update } = await import('./server/cases.js');
    const { getDocAI: _getDocAI } = await import('./server/config.js');
    const { getPersistedLRONames: _getPersistedLROs } = await import('./server/pipeline/orchestrator.js');
    const cases = await _list();
    const stuck = cases.filter(c => c.status === 'processing' || c.regeneratingTable);
    if (stuck.length === 0) return;
    console.log(`[startup] Found ${stuck.length} stuck case(s) — checking for resumability`);

    for (const c of stuck) {
      // Regeneration interruption — just clear the lock
      if (c.regeneratingTable) {
        await _update(c.id, { regeneratingTable: null });
        console.log(`[startup] Case ${c.id}: cleared stale regeneratingTable lock`);
        continue;
      }

      const cp = (c as any).pipelineCheckpoint;

      // No checkpoint or Step 1 incomplete → cannot resume
      if (!cp || !cp.step1Complete) {
        // Cancel any persisted LROs before marking as error
        try {
          const lros = await _getPersistedLROs(c.id);
          if (lros.length > 0) {
            const docai = _getDocAI();
            await Promise.all(lros.map((name: string) =>
              (docai.operationsClient as any).cancelOperation({ name }).catch(() => {}),
            ));
          }
        } catch {}

        const reason = cp
          ? 'Processing interrupted during file upload/chunking.'
          : 'Processing interrupted before any step completed.';
        await _update(c.id, {
          status: 'error' as const,
          errorMessage: `${reason} Use "Retry Processing" to reprocess.`,
        });
        console.log(`[startup] Case ${c.id}: not resumable — marked as error`);
        continue;
      }

      // Step 1 complete → resume pipeline from checkpoint
      console.log(`[startup] Case ${c.id}: resuming pipeline (step1=${cp.step1Complete}, step2=${cp.step2Complete}, step3=${cp.step3Complete})`);
      resumePipeline(c.id).catch(async (e: any) => {
        console.error(`[startup] Resume failed for case ${c.id}:`, e);
        await _update(c.id, {
          status: 'error' as const,
          errorMessage: `Resume after restart failed: ${e.message}. Use "Retry Processing" to reprocess.`,
        }).catch(() => {});
      });
    }
  } catch (e) {
    console.error('[startup] Failed to check stuck cases:', e);
  }
});

// ── Multer — 2 GB limit, PDF only ──────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // 2 GB
  fileFilter: (_req, file, cb) => {
    const byMime = file.mimetype === 'application/pdf' || file.mimetype === 'application/x-pdf';
    const byExt  = file.originalname.toLowerCase().endsWith('.pdf');
    if (byMime || byExt) cb(null, true);
    else cb(new Error(`Only PDF files are accepted.`));
  },
});

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();

// Cloud Run sits behind a Google Front End proxy — trust one hop so
// express-rate-limit (and req.ip) use the real client IP from X-Forwarded-For.
if (IS_PROD) app.set('trust proxy', 1);

// Security
app.use(helmet({
  contentSecurityPolicy: false, // Vite injects inline scripts in dev
}));
app.use(cors({ origin: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false, trustProxy: false } }));

const COOKIE_SECRET = getEnv('SESSION_SECRET') || 'dev-secret-change-me';
app.use(cookieParser(COOKIE_SECRET));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  secret: getEnv('SESSION_SECRET') || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
  },
}));

// ── Auth routes (no requireAuth) ────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ── All remaining API routes require auth ───────────────────────────────────
app.use('/api', requireAuth as any);

// ── Cases ───────────────────────────────────────────────────────────────────
app.get('/api/cases', async (req: Request, res: Response) => {
  try {
    const cases = await listCases({
      search: req.query.search as string,
      sortBy: req.query.sortBy as string,
      sortDir: req.query.sortDir as string,
    });
    res.json({ cases });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cases', async (req: Request, res: Response) => {
  try {
    const { patientName, dateOfInjury } = req.body;
    if (!patientName?.trim() || !dateOfInjury?.trim()) {
      return res.status(400).json({ error: 'patientName and dateOfInjury are required' });
    }
    const user = (req as any).user;
    const caseRecord = await createCase(patientName.trim(), dateOfInjury.trim(), user.email);
    res.status(201).json({ case: caseRecord });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cases/:id', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    res.json({ case: caseRecord });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/cases/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await cancelPipeline(id);              // cancel any active DocAI LROs first
    await deleteCase(id);                  // remove Firestore document
    // Purge GCS (all 3 buckets) + BigQuery in the background (non-blocking)
    Promise.all([
      deletePrefix(BUCKET_AUTH(), `cases/${id}/`),
      deletePrefix(BUCKET_STAGING(), `cases/${id}/`),
      deletePrefix(BUCKET_OUTPUT(), `cases/${id}/`),
      deleteCaseRows(id),
    ]).catch(e => console.error(`[delete] Purge error for ${id}:`, e));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cancel active processing (keeps the case, reverts to draft) ───────────────
app.post('/api/cases/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await cancelPipeline(id);
    await updateCase(id, { status: 'draft' });
    // Step 3 won't run after a cancel, so scrub any staging files left behind
    Promise.all([
      deletePrefix(BUCKET_STAGING(), `cases/${id}/`),
      deletePrefix(BUCKET_OUTPUT(), `cases/${id}/`),
    ]).catch(e => console.error(`[cancel] Staging cleanup error for ${id}:`, e));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Retry processing using files already in the authoritative GCS bucket ────────
// Used when a case is in error state and files are already stored in GCS.
// Downloads each file to a temp path, then re-runs the full pipeline.
app.post('/api/cases/:id/reprocess', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    if (caseRecord.status === 'processing') return res.status(409).json({ error: 'Already processing' });
    if (!caseRecord.files?.length) return res.status(400).json({ error: 'No files to reprocess' });

    const user = (req as any).user;

    // Respond immediately — download + pipeline run async
    res.status(202).json({ message: 'Reprocessing started' });

    (async () => {
      const files: FileInput[] = [];
      for (const f of caseRecord.files) {
        const localPath = path.join(UPLOAD_DIR, `${uuidv4()}.pdf`);
        await downloadFile(f.gcsBucket, f.gcsPath, localPath);
        files.push({ fileId: f.id, fileName: f.name, localFilePath: localPath });
      }
      // Reset files array so the pipeline re-adds them cleanly (no Firestore duplicates)
      await updateCase(req.params.id, { files: [] });
      await runPipeline({ caseId: req.params.id, files, createdBy: user.email, reprocess: true });
    })().catch(async (e) => {
      console.error('[reprocess]', e);
      await updateCase(req.params.id, {
        status: 'error',
        errorMessage: 'Retry failed — please try again.',
      }).catch(() => {});
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Signed-URL upload flow (bypasses Cloud Run 32 MiB body limit) ───────────
// Step 1: Client requests signed upload URLs for each file
app.post('/api/cases/:id/upload-urls',
  async (req: Request, res: Response, next: Function) => {
    try {
      const caseRecord = await getCase(req.params.id);
      if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

      const { files } = req.body as { files: { name: string; size: number }[] };
      if (!files?.length) return res.status(400).json({ error: 'No files specified' });

      const result = await Promise.all(files.map(async (f) => {
        const fileId = uuidv4();
        const gcsPath = `uploads/${req.params.id}/${fileId}/${f.name}`;
        const url = await signedWriteUrl(BUCKET_AUTH(), gcsPath);
        return { fileId, name: f.name, gcsPath, url };
      }));

      res.json({ files: result });
    } catch (e: any) {
      next(e);
    }
  }
);

// Step 2: Client signals all files are uploaded → start pipeline
app.post('/api/cases/:id/process',
  async (req: Request, res: Response, next: Function) => {
    try {
      const caseRecord = await getCase(req.params.id);
      if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

      const { files: uploadedFiles } = req.body as { files: { fileId: string; name: string; gcsPath: string }[] };
      if (!uploadedFiles?.length) return res.status(400).json({ error: 'No files specified' });

      const user = (req as any).user;

      // Download each file from GCS to local temp so the pipeline can read them
      const pipelineFiles: FileInput[] = [];
      for (const f of uploadedFiles) {
        const localPath = path.join(UPLOAD_DIR, `${f.fileId}.pdf`);
        await downloadFile(BUCKET_AUTH(), f.gcsPath, localPath);
        pipelineFiles.push({ fileId: f.fileId, fileName: f.name, localFilePath: localPath });
      }

      // Clean up the temporary GCS upload objects (pipeline step 1 will re-upload to the canonical path)
      for (const f of uploadedFiles) {
        await deleteObject(BUCKET_AUTH(), f.gcsPath).catch(() => {});
      }

      res.status(202).json({ message: 'Processing started' });

      // Fire and forget (logs stream via SSE)
      runPipeline({
        caseId: req.params.id,
        files: pipelineFiles,
        createdBy: user.email,
      }).catch(e => console.error('[server] Pipeline error:', e));
    } catch (e: any) {
      next(e);
    }
  }
);

// ── Legacy file upload (small files via multer — kept as fallback) ───────────
app.post('/api/cases/:id/upload',
  upload.array('files', 20),
  async (req: Request, res: Response, next: Function) => {
    try {
      const caseRecord = await getCase(req.params.id);
      if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

      const uploadedFiles = req.files as Express.Multer.File[];
      if (!uploadedFiles?.length) return res.status(400).json({ error: 'No files uploaded' });

      const user = (req as any).user;
      const files: FileInput[] = uploadedFiles.map(f => ({
        fileId: uuidv4(),
        fileName: f.originalname,
        localFilePath: f.path,
      }));

      // Respond immediately — pipeline runs async
      res.status(202).json({ fileIds: files.map(f => f.fileId), message: 'Upload accepted — processing started' });

      // Fire and forget (logs stream via SSE)
      runPipeline({
        caseId: req.params.id,
        files,
        createdBy: user.email,
      }).catch(e => console.error('[server] Pipeline error:', e));
    } catch (e: any) {
      next(e);
    }
  }
);

// ── SSE: pipeline log stream ─────────────────────────────────────────────────
// Polls Firestore every 3 s so reconnecting clients on any Cloud Run instance
// get the full replay and all subsequent entries.
app.get('/api/cases/:id/logs', (req: Request, res: Response) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  let sentCount = 0;
  req.on('close', () => { closed = true; });

  // drain: extra poll cycles to run after status leaves 'processing'
  // (catches final log entries whose Firestore writes are still in-flight)
  const poll = async (drain = 0) => {
    if (closed) return;
    try {
      const caseDoc = await getCase(id);
      if (!caseDoc) { closed = true; return; }

      const logs = (caseDoc.processingLogs || [])
        .slice()
        .sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0));

      for (let i = sentCount; i < logs.length; i++) {
        // Strip the internal seq field before sending to the client
        const { seq: _seq, ...entry } = logs[i] as any;
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
      sentCount = logs.length;

      if (!closed) {
        if (caseDoc.status === 'processing' || caseDoc.regeneratingTable) {
          setTimeout(() => poll(0), 3000);
        } else if (drain > 0) {
          setTimeout(() => poll(drain - 1), 1500);
        }
        // else: pipeline finished + drain complete → stop polling
      }
    } catch {
      if (!closed) setTimeout(() => poll(drain), 5000);
    }
  };

  poll(2); // start immediately; 2 drain cycles available after completion
});

// ── PDF signed URL ────────────────────────────────────────────────────────────
app.get('/api/cases/:id/pdf/:fileId', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    const file = caseRecord.files.find(f => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    // Stream the PDF directly through Express to avoid GCS CORS issues
    const gcsFile = getStorage().bucket(file.gcsBucket).file(file.gcsPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
    const stream = gcsFile.createReadStream();
    stream.on('error', (err: any) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    stream.pipe(res);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── XLSX download ─────────────────────────────────────────────────────────────
app.get('/api/cases/:id/download/:table', async (req: Request, res: Response) => {
  try {
    const { default: XLSX } = await import('xlsx');
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    const tableKey = req.params.table === 'table2' ? 'table2' : 'table1';
    const rows = caseRecord[tableKey] || [];
    if (rows.length === 0) return res.status(404).json({ error: 'No data to download' });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    const sheetName = tableKey === 'table1' ? 'Medical Chronology' : 'Patient Conditions';
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const safePatient = caseRecord.patientName.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    const filename = `${safePatient} - ${sheetName}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: preflight ──────────────────────────────────────────────────────────
app.get('/api/admin/preflight', async (_req: Request, res: Response) => {
  try {
    const result = await runPreflight();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: storage monitor ────────────────────────────────────────────────────
app.get('/api/admin/storage', async (_req: Request, res: Response) => {
  try {
    const [authBytes, stagingBytes, outputBytes] = await Promise.all([
      getBucketUsageBytes(BUCKET_AUTH()),
      getBucketUsageBytes(BUCKET_STAGING()),
      getBucketUsageBytes(BUCKET_OUTPUT()),
    ]);
    const limitBytes = 10 * 1024 * 1024 * 1024; // 10 GB
    res.json({
      limitBytes,
      buckets: [
        { name: BUCKET_AUTH(), label: 'Authoritative Files (persistent)', bytes: authBytes },
        { name: BUCKET_STAGING(), label: 'Staging Input (ephemeral)', bytes: stagingBytes },
        { name: BUCKET_OUTPUT(), label: 'Staging Output (ephemeral)', bytes: outputBytes },
      ],
      totalBytes: authBytes + stagingBytes + outputBytes,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: purge orphaned GCS + BigQuery data for deleted cases ───────────────
app.post('/api/admin/purge-orphans', async (_req: Request, res: Response) => {
  try {
    // All currently known case IDs from Firestore
    const cases = await listCases();
    const knownIds = new Set(cases.map(c => c.id));

    // List objects across all 3 buckets to find orphaned case IDs
    const [authObjs, stagingObjs, outputObjs] = await Promise.all([
      listObjects(BUCKET_AUTH(), 'cases/'),
      listObjects(BUCKET_STAGING(), 'cases/'),
      listObjects(BUCKET_OUTPUT(), 'cases/'),
    ]);

    const extractIds = (objs: { name: string }[]) =>
      objs.map(o => o.name.split('/')[1]).filter(Boolean);

    const allGcsCaseIds = new Set([
      ...extractIds(authObjs),
      ...extractIds(stagingObjs),
      ...extractIds(outputObjs),
    ]);

    // Delete from all 3 buckets for cases no longer in Firestore
    const orphanIds = [...allGcsCaseIds].filter(id => !knownIds.has(id));
    await Promise.all(
      orphanIds.flatMap(id => [
        deletePrefix(BUCKET_AUTH(), `cases/${id}/`),
        deletePrefix(BUCKET_STAGING(), `cases/${id}/`),
        deletePrefix(BUCKET_OUTPUT(), `cases/${id}/`),
      ]),
    );

    // Also scrub staging buckets for known cases that are NOT currently processing
    // (handles leftover chunks from cancelled or failed pipeline runs)
    const stagingCaseIds = new Set(extractIds(stagingObjs));
    const outputCaseIds = new Set(extractIds(outputObjs));
    const nonProcessingKnown = cases.filter(c => c.status !== 'processing');
    const stagingScrubIds = nonProcessingKnown
      .filter(c => stagingCaseIds.has(c.id) || outputCaseIds.has(c.id))
      .map(c => c.id);
    await Promise.all(
      stagingScrubIds.flatMap(id => [
        deletePrefix(BUCKET_STAGING(), `cases/${id}/`),
        deletePrefix(BUCKET_OUTPUT(), `cases/${id}/`),
      ]),
    );

    // BigQuery: delete rows whose case_id is not in the known set
    await deleteOrphanRows([...knownIds]);

    res.json({
      purgedCases: orphanIds.length,
      orphanIds,
      stagingScrubbed: stagingScrubIds.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: DocAI operations monitor ──────────────────────────────────────────
// DocAI's operations API only supports GetOperation and CancelOperation —
// ListOperations is not implemented (neither gRPC nor REST).
// We track active LRO names in-memory in the orchestrator and call GetOperation
// on each individually to get current status.

app.get('/api/admin/docai/operations', async (_req: Request, res: Response) => {
  try {
    const docai = getDocAI();

    // Collect all tracked LRO names from the in-memory map
    const lroMap = getActiveLRONames();
    const allNames: string[] = [];
    for (const names of lroMap.values()) allNames.push(...names);

    // Also check Firestore for persisted LROs (survives server restarts)
    const cases = await listCases();
    const processingCaseIds = cases.filter(c => c.status === 'processing').map(c => c.id);
    const inMemoryNames = new Set(allNames);
    for (const cid of processingCaseIds) {
      const persisted = await getPersistedLRONames(cid);
      for (const n of persisted) {
        if (!inMemoryNames.has(n)) { allNames.push(n); inMemoryNames.add(n); }
      }
    }

    // Check each LRO's current status via GetOperation (IS supported by DocAI)
    const pendingOperations = (await Promise.all(
      allNames.map(async (name) => {
        try {
          const [op] = await (docai.operationsClient as any).getOperation({ name });
          if (op.done) return null;
          const meta = op.metadata as any;
          const state = meta?.commonMetadata?.state || meta?.state || 'RUNNING';
          return { name, state };
        } catch {
          return { name, state: 'UNKNOWN' };
        }
      }),
    )).filter(Boolean) as { name: string; state: string }[];

    const processingCases = cases
      .filter(c => c.status === 'processing')
      .map(c => ({ id: c.id, patientName: c.patientName }));

    res.json({ pendingOperations, pendingCount: pendingOperations.length, processingCases, lroError: null });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/docai/cancel-all', async (_req: Request, res: Response) => {
  try {
    const docai = getDocAI();

    // Collect LRO names from in-memory map
    const lroMap = getActiveLRONames();
    const allNames: string[] = [];
    for (const names of lroMap.values()) allNames.push(...names);

    // Also collect persisted LROs from Firestore (survives server restarts)
    const cases = await listCases();
    const processingCases = cases.filter(c => c.status === 'processing');
    const inMemoryNames = new Set(allNames);
    for (const c of processingCases) {
      const persisted = await getPersistedLRONames(c.id);
      for (const n of persisted) {
        if (!inMemoryNames.has(n)) { allNames.push(n); inMemoryNames.add(n); }
      }
    }

    // Cancel all LROs via CancelOperation
    await Promise.all(
      allNames.map(name =>
        (docai.operationsClient as any).cancelOperation({ name }).catch(() => {}),
      ),
    );
    await Promise.all(
      processingCases.map(async c => {
        await cancelPipeline(c.id);
        await updateCase(c.id, { status: 'draft' });
      }),
    );

    res.json({ cancelledLROs: allNames.length, cancelledCases: processingCases.length, lroError: null });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: prompt management ──────────────────────────────────────────────────
// Prompts are stored globally in Firestore under a "prompts" collection
// (one doc per table: "table1", "table2"), with a history array.

app.get('/api/admin/prompts/:table', async (req: Request, res: Response) => {
  try {
    const { getFirestore } = await import('./server/config.js');
    const tableKey = req.params.table === 'table2' ? 'table2' : 'table1';
    const doc = await getFirestore().collection('prompts').doc(tableKey).get();
    if (!doc.exists) {
      return res.json({
        current: tableKey === 'table1' ? DEFAULT_TABLE1_PROMPT : DEFAULT_TABLE2_PROMPT,
        history: [],
      });
    }
    res.json(doc.data());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/prompts/:table', async (req: Request, res: Response) => {
  try {
    const { getFirestore } = await import('./server/config.js');
    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt is required' });
    const tableKey = req.params.table === 'table2' ? 'table2' : 'table1';
    const docRef = getFirestore().collection('prompts').doc(tableKey);
    const existing = await docRef.get();
    const now = new Date().toISOString();
    const historyEntry = { prompt: prompt.trim(), savedAt: now };

    let history: any[] = existing.exists ? (existing.data()?.history || []) : [];
    history = [historyEntry, ...history].slice(0, 15); // keep last 15

    await docRef.set({ current: prompt.trim(), history, updatedAt: now });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Table regeneration ──────────────────────────────────────────────────────

// Get the prompt to pre-fill the regeneration editor (per-case, per-table)
app.get('/api/cases/:id/prompts/:table', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

    const tableKey = req.params.table === 'table2' ? 'table2' : 'table1';
    const versionsKey = tableKey === 'table1' ? 'table1Versions' : 'table2Versions';
    const versions = caseRecord[versionsKey] || [];

    // Resolution: most recent version's prompt → case override → global → default
    let prompt: string;
    let source: string;
    if (versions.length > 0 && versions[0].prompt && versions[0].prompt !== 'default' && versions[0].prompt !== 'initial pipeline') {
      prompt = versions[0].prompt;
      source = 'version';
    } else if (caseRecord[`${tableKey}Prompt` as keyof typeof caseRecord]) {
      prompt = caseRecord[`${tableKey}Prompt` as keyof typeof caseRecord] as string;
      source = 'case-override';
    } else {
      // Try global Firestore prompt, then hardcoded default
      const { getFirestore: _getFs } = await import('./server/config.js');
      const doc = await _getFs().collection('prompts').doc(tableKey).get();
      if (doc.exists && doc.data()?.current) {
        prompt = doc.data()!.current;
        source = 'global';
      } else {
        prompt = tableKey === 'table1' ? DEFAULT_TABLE1_PROMPT : DEFAULT_TABLE2_PROMPT;
        source = 'default';
      }
    }

    // Build per-case prompt history from versions
    const history = versions
      .filter((v: any) => v.prompt && v.prompt !== 'default' && v.prompt !== 'initial pipeline')
      .map((v: any) => ({
        prompt: v.prompt,
        usedAt: v.generatedAt,
        version: v.version,
      }));

    res.json({ prompt, source, history });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger table regeneration
app.post('/api/cases/:id/regenerate/:table', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    if (caseRecord.status !== 'complete') {
      return res.status(400).json({ error: 'Case must be in "complete" status to regenerate a table.' });
    }
    if (caseRecord.regeneratingTable) {
      // Treat lock as stale if updatedAt is more than 10 minutes ago (e.g. server crashed, clear failed)
      const updatedAt = caseRecord.updatedAt ? new Date(caseRecord.updatedAt).getTime() : 0;
      const staleAfterMs = 10 * 60 * 1000;
      if (Date.now() - updatedAt < staleAfterMs) {
        return res.status(409).json({ error: `Already regenerating ${caseRecord.regeneratingTable}. Please wait.` });
      }
      // Stale lock — clear it and proceed
      console.warn(`[regenerate] Clearing stale regeneration lock for case ${req.params.id}`);
      await updateCase(req.params.id, { regeneratingTable: null });
    }

    const tableKey = req.params.table === 'table2' ? 'table2' : 'table1';
    const { prompt, table1Version } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt is required' });

    const user = (req as any).user;

    // Respond immediately — regeneration runs async
    res.status(202).json({ message: 'Regeneration started' });

    regenerateTable(req.params.id, tableKey, prompt.trim(), user.email, table1Version != null ? Number(table1Version) : undefined)
      .catch(e => console.error('[regenerate]', e));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get a specific table version's rows
app.get('/api/cases/:id/table-version/:table/:version', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

    const tableKey = req.params.table === 'table2' ? 'table2' : 'table1';
    const versions = caseRecord[tableKey === 'table1' ? 'table1Versions' : 'table2Versions'] || [];
    const versionNum = parseInt(req.params.version, 10);
    const version = versions.find((v: any) => v.version === versionNum);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    res.json({
      version: version.version,
      rows: version.rows,
      generatedAt: version.generatedAt,
      generatedBy: version.generatedBy,
      prompt: version.prompt,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Activate a past table version (make it the current displayed table)
app.post('/api/cases/:id/table-version/:table/:version/activate', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

    const tableKey = req.params.table === 'table2' ? 'table2' : 'table1';
    const versionsKey = tableKey === 'table1' ? 'table1Versions' : 'table2Versions';
    const versions = caseRecord[versionsKey] || [];
    const versionNum = parseInt(req.params.version, 10);
    const versionIdx = versions.findIndex((v: any) => v.version === versionNum);
    if (versionIdx === -1) return res.status(404).json({ error: 'Version not found' });

    const version = versions[versionIdx];
    const patch: Record<string, any> = {
      [tableKey]: version.rows,
      [`${tableKey}ActiveVersion`]: versionIdx,
    };
    // For Table 1, also update the markdown (Table 2 regen depends on it)
    if (tableKey === 'table1' && version.markdownTable) {
      patch.table1Markdown = version.markdownTable;
    }

    await updateCase(req.params.id, patch);
    res.json({ ok: true, activatedVersion: version.version });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: recent case logs ───────────────────────────────────────────────────
// Pipeline logs are kept in Firestore under a "pipelineLogs" collection
app.get('/api/admin/logs', async (_req: Request, res: Response) => {
  try {
    const { getFirestore } = await import('./server/config.js');
    const snap = await getFirestore().collection('pipelineLogs')
      .orderBy('startedAt', 'desc').limit(10).get();
    res.json({ logs: snap.docs.map(d => d.data()) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Frontend ─────────────────────────────────────────────────────────────────
if (IS_PROD) {
  app.use(express.static(path.join(__dirname, 'dist/client')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dist/client/index.html'));
  });
} else {
  // Dev: Vite middleware
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

// ── Global JSON error handler (catches multer errors + any uncaught next(err)) ─
app.use((err: any, _req: Request, res: Response, _next: Function) => {
  const status  = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'File exceeds the 2 GB size limit.'
    : (err.message || 'Internal server error');
  console.error('[server] Error:', err.code || err.message);
  if (!res.headersSent) res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 PMR Review App running at http://localhost:${PORT}`);
  console.log(`   Mode: ${IS_PROD ? 'production' : 'development'}\n`);
});
