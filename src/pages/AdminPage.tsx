import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, RefreshCw, Loader2, CheckCircle, XCircle, AlertTriangle,
  Database, HardDrive, ChevronDown, Download, Save, Clock,
  ScanSearch, StopCircle, CheckCircle2, AlertCircle,
} from 'lucide-react';
import NavBar from '../components/NavBar.js';
import { User } from '../main.js';
import { cn, formatBytes, formatDate, formatDateTime } from '../lib/utils.js';
import { motion, AnimatePresence } from 'motion/react';

interface Props {
  user: User | null; onLogout: () => void;
  darkMode: boolean; onToggleDark: () => void;
  addError: (msg: string) => void;
}

type Tab = 'workflow' | 'storage' | 'prompts' | 'preflight' | 'ocr';

export default function AdminPage({ user, onLogout, darkMode, onToggleDark, addError }: Props) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('workflow');

  const TABS: { key: Tab; label: string }[] = [
    { key: 'workflow',  label: 'Workflow' },
    { key: 'storage',   label: 'Storage Monitor' },
    { key: 'prompts',   label: 'Prompt Editor' },
    { key: 'preflight', label: 'Preflight & Logs' },
    { key: 'ocr',       label: 'OCR Requests' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <NavBar user={user} onLogout={onLogout} darkMode={darkMode} onToggleDark={onToggleDark} />

      {/* Admin header */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex items-center gap-4">
        <button onClick={() => navigate('/cases')} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">Admin Panel</h1>
      </div>

      {/* Tabs */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6">
        <div className="flex gap-1 -mb-px">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                tab === t.key
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <main className="flex-1 p-6 max-w-5xl mx-auto w-full">
        {tab === 'workflow'  && <WorkflowTab />}
        {tab === 'storage'   && <StorageTab addError={addError} />}
        {tab === 'prompts'   && <PromptsTab addError={addError} />}
        {tab === 'preflight' && <PreflightTab addError={addError} />}
        {tab === 'ocr'       && <OcrRequestsTab addError={addError} />}
      </main>
    </div>
  );
}

// ─── Workflow Tab ─────────────────────────────────────────────────────────────
function WorkflowTab() {
  const steps = [
    {
      num: 1, title: 'Upload + Chunk', color: 'indigo',
      tools: ['Google Cloud Storage', 'pdf-lib'],
      desc: 'Original PDF saved to cic-authoritative-case-files (permanent). pdf-lib splits the file into ≤500-page chunks with tracked absolute_page_offset. Chunks uploaded to cic-docai-staging-inputs.',
    },
    {
      num: 2, title: 'Dual Document AI Batch Processing', color: 'violet',
      tools: ['Document AI — OCR v2.1', 'Document AI — Layout Parser v1.6-pro'],
      desc: 'Both processors run concurrently via batchProcess LROs. Polling every 10 seconds until SUCCEEDED. OCR extracts raw text + page structure; Layout Parser extracts semantic chunks with context.',
    },
    {
      num: 3, title: 'Reassembly + BigQuery Ingestion + Scrubbing', color: 'blue',
      tools: ['BigQuery', 'Google Cloud Storage'],
      desc: 'absolute_page_offset applied to all page numbers and coordinates. Unified corpus inserted into BigQuery Table 0 (standard structured table with JSON columns). Staging chunks and DocAI JSON outputs permanently deleted — only the original PDF in GCS remains.',
    },
    {
      num: 4, title: 'Table 1: Medical Chronology', color: 'emerald',
      tools: ['BigQuery', 'Vertex AI — Gemini 3.1 Pro'],
      desc: 'Full case text queried from BigQuery. Passed to Gemini 3.1 Pro (Vertex AI) with the Table 1 prompt. Response parsed into structured rows: Record Date, Facility, Provider, Specialty, Record Type, Summary, Diagnoses, Complaints, Citation.',
    },
    {
      num: 5, title: 'Table 2: Patient Conditions', color: 'amber',
      tools: ['BigQuery', 'Vertex AI — Gemini 3.1 Pro'],
      desc: 'Both Table 0 text and Table 1 Markdown passed to Gemini as context. Generates a longitudinal conditions table: Condition, First/Last Date, Diagnostic Validation, CIC-only vs. Prior-only vs. Both, and progression notes.',
    },
  ];

  const colorMap: Record<string, string> = {
    indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
    violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
    blue:   'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    emerald:'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    amber:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  };

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-4">Document Processing Pipeline</h2>
      {steps.map((s, i) => (
        <React.Fragment key={s.num}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-5">
            <div className="flex items-start gap-4">
              <div className={cn('w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0', colorMap[s.color])}>
                {s.num}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{s.title}</span>
                  {s.tools.map(t => (
                    <span key={t} className={cn('text-xs px-2 py-0.5 rounded-full font-medium', colorMap[s.color])}>{t}</span>
                  ))}
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400">{s.desc}</p>
              </div>
            </div>
          </div>
          {i < steps.length - 1 && (
            <div className="flex justify-center text-slate-300 dark:text-slate-600 text-lg leading-none">↓</div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Storage Monitor Tab ──────────────────────────────────────────────────────
function StorageTab({ addError }: { addError: (m: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/storage');
      if (!res.ok) throw new Error('Failed');
      setData(await res.json());
    } catch (e: any) { addError(`Storage monitor error: ${e.message}`); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const limitGB = 10;
  const limitBytes = limitGB * 1024 * 1024 * 1024;
  const usedPct = data ? Math.min(100, (data.totalBytes / limitBytes) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Cloud Storage</h2>
        <button onClick={load} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 transition-colors">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      {loading ? <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div> : data && (
        <>
          {/* Overall usage bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="font-medium text-slate-900 dark:text-slate-100">Total Usage</span>
              <span className="text-sm text-slate-500">{formatBytes(data.totalBytes)} / {limitGB} GB</span>
            </div>
            <div className="h-3 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', usedPct > 90 ? 'bg-rose-500' : usedPct > 75 ? 'bg-amber-500' : 'bg-indigo-500')}
                style={{ width: `${usedPct}%` }}
              />
            </div>
            <p className="text-xs text-slate-400 mt-2">{usedPct.toFixed(1)}% used</p>
          </div>

          {/* Per-bucket breakdown */}
          {data.buckets.map((b: any) => (
            <div key={b.name} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <HardDrive className="w-4 h-4 text-slate-400" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{b.label}</div>
                  <div className="text-xs text-slate-400 font-mono">{b.name}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{formatBytes(b.bytes)}</div>
                {b.bytes === 0 && b.label.includes('ephemeral') && (
                  <div className="text-[10px] text-emerald-500 font-medium mt-0.5">Scrubbed ✓</div>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── Prompt Editor Tab ────────────────────────────────────────────────────────
function PromptsTab({ addError }: { addError: (m: string) => void }) {
  const [activeTable, setActiveTable] = useState<'table1' | 'table2'>('table1');
  const [promptText, setPromptText] = useState('');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [history, setHistory] = useState<{ prompt: string; savedAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const hasUnsaved = promptText !== savedPrompt;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/prompts/${activeTable}`);
      const data = await res.json();
      setPromptText(data.current || '');
      setSavedPrompt(data.current || '');
      setHistory(data.history || []);
    } catch (e: any) { addError(`Failed to load prompt: ${e.message}`); }
    finally { setLoading(false); }
  }, [activeTable]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!promptText.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/prompts/${activeTable}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText.trim() }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSavedPrompt(promptText.trim());
      await load(); // refresh history
    } catch (e: any) { addError(`Save failed: ${e.message}`); }
    finally { setSaving(false); }
  };

  const handleDownload = () => {
    const now = new Date();
    const pad = (n: number, l = 2) => String(n).padStart(l, '0');
    const ts = `${pad(now.getMonth() + 1)}${pad(now.getDate())}${String(now.getFullYear()).slice(2)} (${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())})`;
    const modelVersion = '3.1 Pro Preview';
    const tableNum = activeTable === 'table1' ? '1' : '2';
    const filename = `[${ts}] Table ${tableNum} Creation Prompt for Gemini ${modelVersion}.md`;
    const blob = new Blob([promptText], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const loadHistoryEntry = (entry: { prompt: string }) => {
    if (hasUnsaved) {
      if (!window.confirm('There have been unsaved edits to the prompt. Are you sure you want to replace it?')) return;
    }
    setPromptText(entry.prompt);
    setHistoryOpen(false);
  };

  return (
    <div className="space-y-4">
      {/* Table selector */}
      <div className="flex gap-2">
        {(['table1', 'table2'] as const).map(t => (
          <button key={t} onClick={() => setActiveTable(t)}
            className={cn('px-4 py-2 text-sm font-medium rounded-lg transition-colors', activeTable === t ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-indigo-300')}>
            {t === 'table1' ? 'Table 1 Prompt (Chronology)' : 'Table 2 Prompt (Conditions)'}
          </button>
        ))}
      </div>

      {loading ? <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div> : (
        <>
          {/* History dropdown */}
          {history.length > 0 && (
            <div className="relative">
              <button onClick={() => setHistoryOpen(v => !v)}
                className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 transition-colors">
                <Clock className="w-3.5 h-3.5" /> Prompt History ({history.length}) <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <AnimatePresence>
                {historyOpen && (
                  <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="absolute top-full mt-1 left-0 w-96 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-20 overflow-hidden">
                    {history.map((h, i) => {
                      const isCurrent = h.prompt === savedPrompt;
                      return (
                        <button key={i} onClick={() => loadHistoryEntry(h)}
                          className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-100 dark:border-slate-700 last:border-0 transition-colors">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500">{formatDateTime(h.savedAt)}</span>
                            {isCurrent && (
                              <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded-full">Current</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Editor */}
          <div className="relative">
            {hasUnsaved && (
              <div className="absolute -top-2 right-0 text-[10px] text-amber-500 font-medium bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 rounded-full">Unsaved changes</div>
            )}
            <textarea
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              rows={24}
              className="w-full font-mono text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
              spellCheck={false}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 justify-end">
            <button onClick={handleDownload}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors">
              <Download className="w-4 h-4" /> Download .md
            </button>
            <button onClick={handleSave} disabled={saving || !hasUnsaved}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors shadow-sm disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save & Deploy
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── OCR Requests Tab ─────────────────────────────────────────────────────────
function OcrRequestsTab({ addError }: { addError: (m: string) => void }) {
  const [status, setStatus] = useState<{
    pendingOperations: { name: string; state: string }[];
    pendingCount: number;
    processingCases: { id: string; patientName: string }[];
    lroError: string | null;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelResult, setCancelResult] = useState<{
    cancelledLROs: number;
    cancelledCases: number;
    lroError: string | null;
  } | null>(null);

  const checkStatus = async () => {
    setChecking(true);
    setCancelResult(null);
    try {
      const res = await fetch('/api/admin/docai/operations');
      if (!res.ok) throw new Error('Request failed');
      setStatus(await res.json());
    } catch (e: any) {
      addError(`Failed to check OCR status: ${e.message}`);
    } finally {
      setChecking(false);
    }
  };

  const cancelAll = async () => {
    if (!window.confirm('Cancel all pending Document AI requests? This will stop all active OCR jobs and revert any processing cases back to draft.')) return;
    setCancelling(true);
    try {
      const res = await fetch('/api/admin/docai/cancel-all', { method: 'POST' });
      if (!res.ok) throw new Error('Cancel request failed');
      const result = await res.json();
      setCancelResult(result);
      await checkStatus(); // refresh status after cancel
    } catch (e: any) {
      addError(`Failed to cancel operations: ${e.message}`);
    } finally {
      setCancelling(false);
    }
  };

  const noPending = status && status.pendingCount === 0 && status.processingCases.length === 0;
  const hasPending = status && (status.pendingCount > 0 || status.processingCases.length > 0);

  return (
    <div className="space-y-6">
      {/* ── Status section ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest">
            Request Status
          </h2>
          <button
            onClick={checkStatus}
            disabled={checking}
            className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', checking && 'animate-spin')} />
            {status ? 'Refresh' : 'Check Status'}
          </button>
        </div>

        {!status && !checking && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-8 flex flex-col items-center gap-3 text-center">
            <ScanSearch className="w-8 h-8 text-slate-300 dark:text-slate-600" />
            <p className="text-sm text-slate-400">Click <span className="font-medium text-slate-600 dark:text-slate-300">Check Status</span> to query Document AI for active OCR requests.</p>
          </div>
        )}

        {checking && (
          <div className="flex justify-center py-10">
            <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
          </div>
        )}

        {!checking && status && (
          <div className="space-y-3">
            {/* Summary card */}
            <div className={cn(
              'bg-white dark:bg-slate-900 border rounded-xl p-5',
              noPending
                ? 'border-emerald-200 dark:border-emerald-800'
                : 'border-amber-200 dark:border-amber-800',
            )}>
              <div className="flex items-center gap-3">
                {noPending
                  ? <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                  : <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />}
                <div>
                  {noPending ? (
                    <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                      No pending requests — Document AI quota is clear
                    </p>
                  ) : (
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                      {status.pendingCount > 0
                        ? `${status.pendingCount} pending LRO${status.pendingCount !== 1 ? 's' : ''} detected`
                        : `${status.processingCases.length} case${status.processingCases.length !== 1 ? 's' : ''} currently processing`}
                    </p>
                  )}
                  {status.lroError && (
                    <p className="text-xs text-slate-400 mt-0.5">
                      (DocAI operations API unavailable — showing Firestore case status only)
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Pending LROs list */}
            {status.pendingOperations.length > 0 && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Active Document AI Operations
                  </p>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {status.pendingOperations.map((op, i) => (
                    <li key={i} className="px-4 py-3 flex items-center justify-between gap-4">
                      <span className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                        {op.name.split('/operations/')[1] || op.name}
                      </span>
                      <span className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded-full shrink-0',
                        op.state === 'RUNNING'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
                      )}>
                        {op.state}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Processing cases */}
            {status.processingCases.length > 0 && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Cases Currently Processing
                  </p>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {status.processingCases.map(c => (
                    <li key={c.id} className="px-4 py-3 flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                      <span className="text-sm text-slate-800 dark:text-slate-200">{c.patientName}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-slate-200 dark:border-slate-700" />

      {/* ── Cancel section ── */}
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
            Cancel All Document AI Requests
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Sends a cancel command to every active DocAI batch processing job in this project and reverts any processing cases back to draft status.
            Use this to free up quota when requests are stuck or blocking new uploads.
          </p>
        </div>

        {/* Cancel result banner */}
        {cancelResult && (
          <div className={cn(
            'rounded-xl px-4 py-3 flex items-start gap-3',
            cancelResult.cancelledLROs > 0 || cancelResult.cancelledCases > 0
              ? 'bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800'
              : 'bg-slate-50 border border-slate-200 dark:bg-slate-800/50 dark:border-slate-700',
          )}>
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            <div className="text-sm text-emerald-800 dark:text-emerald-300">
              {cancelResult.cancelledLROs > 0 && (
                <p>{cancelResult.cancelledLROs} DocAI operation{cancelResult.cancelledLROs !== 1 ? 's' : ''} cancelled.</p>
              )}
              {cancelResult.cancelledCases > 0 && (
                <p>{cancelResult.cancelledCases} case{cancelResult.cancelledCases !== 1 ? 's' : ''} reverted to draft.</p>
              )}
              {cancelResult.cancelledLROs === 0 && cancelResult.cancelledCases === 0 && (
                <p className="text-slate-600 dark:text-slate-300">No active operations found.</p>
              )}
              {cancelResult.lroError && (
                <p className="text-xs text-slate-400 mt-0.5">(DocAI operations API unavailable — in-memory pipelines cancelled via internal tracker)</p>
              )}
            </div>
          </div>
        )}

        <button
          onClick={cancelAll}
          disabled={cancelling}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-colors shadow-sm disabled:opacity-50"
        >
          {cancelling
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <StopCircle className="w-4 h-4" />}
          {cancelling ? 'Cancelling…' : 'Cancel All Document AI Requests'}
        </button>
      </div>
    </div>
  );
}

// ─── Preflight + Logs Tab ─────────────────────────────────────────────────────
function PreflightTab({ addError }: { addError: (m: string) => void }) {
  const [preflight, setPreflight] = useState<any>(null);
  const [runningPreflight, setRunningPreflight] = useState(false);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  const runPreflight = async () => {
    setRunningPreflight(true);
    try {
      const res = await fetch('/api/admin/preflight');
      if (!res.ok) throw new Error('Preflight failed');
      setPreflight(await res.json());
    } catch (e: any) { addError(`Preflight error: ${e.message}`); }
    finally { setRunningPreflight(false); }
  };

  const loadLogs = async () => {
    try {
      const res = await fetch('/api/admin/logs');
      const data = await res.json();
      setRecentLogs(data.logs || []);
    } catch {} finally { setLogsLoading(false); }
  };

  useEffect(() => { runPreflight(); loadLogs(); }, []);

  const StatusIcon = ({ status }: { status: 'pass' | 'fail' | 'warn' }) => {
    if (status === 'pass') return <CheckCircle  className="w-4 h-4 text-emerald-500 shrink-0" />;
    if (status === 'fail') return <XCircle      className="w-4 h-4 text-rose-500 shrink-0" />;
    return                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />;
  };

  return (
    <div className="space-y-6">
      {/* Preflight section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Pre-flight Check</h2>
          <button onClick={runPreflight} disabled={runningPreflight}
            className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">
            <RefreshCw className={cn('w-3.5 h-3.5', runningPreflight && 'animate-spin')} /> Re-run
          </button>
        </div>

        {runningPreflight && !preflight ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div>
        ) : preflight && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
            <div className={cn('px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between', preflight.allValid ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'bg-rose-50 dark:bg-rose-950/20')}>
              <span className="text-sm font-semibold">{preflight.allValid ? '✓ All checks passed' : '✗ Some checks failed'}</span>
              <span className="text-xs text-slate-400">{formatDate(preflight.checkedAt)}</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {preflight.checks.map((c: any, i: number) => (
                <div key={i} className="px-4 py-3 flex items-start gap-3">
                  <StatusIcon status={c.status} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{c.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{c.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Recent logs section */}
      <div>
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-3">Recent Case Runs (Last 10)</h2>
        {logsLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div>
        ) : recentLogs.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">No pipeline runs recorded yet.</div>
        ) : (
          <div className="space-y-2">
            {recentLogs.map((log: any, i: number) => (
              <div key={i} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100 text-sm">{log.patientName || log.caseId}</span>
                  <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium',
                    log.status === 'complete' ? 'bg-emerald-100 text-emerald-700' :
                    log.status === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700')}>
                    {log.status}
                  </span>
                </div>
                <div className="text-xs text-slate-400">{formatDate(log.startedAt)}</div>
                {log.errorMessage && <div className="text-xs text-rose-500 mt-1">{log.errorMessage}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
