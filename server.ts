/**
 * PMR Review App — Express server entry point.
 *
 * Dev:  tsx server.ts          (Vite middleware + Express API on one port)
 * Prod: node dist/server.js    (serves dist/client as static files)
 */
import express, { Request, Response, NextFunction } from 'express';
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
import { getEnv } from './server/config.js';
import {
  createCase, getCase, listCases, updateCase, deleteCase,
} from './server/cases.js';
import { signedReadUrl, getBucketUsageBytes, listObjects, BUCKET_AUTH, BUCKET_STAGING, BUCKET_OUTPUT } from './server/gcs.js';
import { pipelineEmitter, runPipeline } from './server/pipeline/orchestrator.js';
import { runPreflight } from './server/preflight.js';
import { DEFAULT_TABLE1_PROMPT, DEFAULT_TABLE2_PROMPT } from './server/pipeline/prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = parseInt(getEnv('PORT') || '3000', 10);

// ── Temp upload directory ──────────────────────────────────────────────────
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
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

// ── Multer — 2 GB limit, PDF only ──────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },  // 2 GB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error(`Only PDF files are accepted. Received: ${file.mimetype}`));
  },
});

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();

// Security
app.use(helmet({
  contentSecurityPolicy: false, // Vite injects inline scripts in dev
}));
app.use(cors({ origin: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));

app.use(cookieParser());
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
    const user = (req as any).session.user;
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
    await deleteCase(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── File upload → triggers pipeline ─────────────────────────────────────────
app.post('/api/cases/:id/upload',
  upload.single('file'),
  async (req: Request, res: Response) => {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const fileId = uuidv4();
    const user = (req as any).session.user;

    // Respond immediately — pipeline runs async
    res.status(202).json({ fileId, message: 'Upload accepted — processing started' });

    // Fire and forget (logs stream via SSE)
    runPipeline({
      caseId: req.params.id,
      fileId,
      fileName: req.file.originalname,
      localFilePath: req.file.path,
      createdBy: user.email,
    }).catch(e => console.error('[server] Pipeline error:', e));
  }
);

// ── SSE: pipeline log stream ─────────────────────────────────────────────────
app.get('/api/cases/:id/logs', (req: Request, res: Response) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const handler = (entry: any) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  pipelineEmitter.on(`log:${id}`, handler);
  req.on('close', () => { pipelineEmitter.off(`log:${id}`, handler); });
});

// ── PDF signed URL ────────────────────────────────────────────────────────────
app.get('/api/cases/:id/pdf/:fileId', async (req: Request, res: Response) => {
  try {
    const caseRecord = await getCase(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    const file = caseRecord.files.find(f => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const url = await signedReadUrl(file.gcsBucket, file.gcsPath, 60);
    res.json({ url });
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

app.listen(PORT, () => {
  console.log(`\n🚀 PMR Review App running at http://localhost:${PORT}`);
  console.log(`   Mode: ${IS_PROD ? 'production' : 'development'}\n`);
});
