import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  UploadCloud, Loader2, Download, ChevronLeft, ChevronRight, ChevronDown, X,
  PanelRightClose, PanelRightOpen, FileText, ArrowUp, AlertCircle, CheckCircle2, Play, StopCircle, RotateCcw,
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'motion/react';
import NavBar from '../components/NavBar.js';
import LogDrawer, { LogEntry } from '../components/LogDrawer.js';
import StatusBadge from '../components/StatusBadge.js';
import RegenerateEditor from '../components/RegenerateEditor.js';
import VersionDropdown from '../components/VersionDropdown.js';
import SortableFilterableHeader, {
  applySortFilter, handleSort,
  SortConfig, FilterConfig,
} from '../components/SortableFilterableHeader.js';
import { User } from '../main.js';
import { cn, formatDate, formatBytes } from '../lib/utils.js';

// Configure pdf.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

interface Props {
  user: User | null; onLogout: () => void;
  darkMode: boolean; onToggleDark: () => void;
  addError: (msg: string) => void;
}

export default function CasePage({ user, onLogout, darkMode, onToggleDark, addError }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Case data
  const [caseData, setCaseData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Upload
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [cancelledFileInfo, setCancelledFileInfo] = useState<Array<{ name: string; size: number }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // SSE log stream
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logDrawerOpen, setLogDrawerOpen] = useState(true);
  const sseRef = useRef<EventSource | null>(null);

  // Tables
  const [t1Sort, setT1Sort] = useState<SortConfig>({ key: '', direction: null });
  const [t1Filters, setT1Filters] = useState<FilterConfig>({});
  const [t2Sort, setT2Sort] = useState<SortConfig>({ key: '', direction: null });
  const [t2Filters, setT2Filters] = useState<FilterConfig>({});

  // Table collapse
  const [t1Collapsed, setT1Collapsed] = useState(false);
  const [t2Collapsed, setT2Collapsed] = useState(false);

  // Column resize
  const [t1ColWidths, setT1ColWidths] = useState<Record<string, number>>({});
  const [t2ColWidths, setT2ColWidths] = useState<Record<string, number>>({});

  // Success toast
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Regeneration overlay
  const [regenerateTarget, setRegenerateTarget] = useState<'table1' | 'table2' | null>(null);

  // PDF Viewer
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfName, setPdfName] = useState('');
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNum, setPageNum] = useState(1);
  const [showPdfPane, setShowPdfPane] = useState(true);
  const [pdfLoading, setPdfLoading] = useState(false);

  // ── Load case ──────────────────────────────────────────────────────────────
  const loadCase = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${id}`);
      if (res.status === 401) { onLogout(); return; }
      if (!res.ok) { navigate('/cases'); return; }
      const data = await res.json();
      setCaseData(data.case);
    } catch (e) { console.error('[case/load]', e); addError("Couldn't load this case — please refresh the page."); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { loadCase(); }, [loadCase]);

  // ── SSE: subscribe when case is processing ────────────────────────────────
  useEffect(() => {
    if (!caseData) return;
    if (caseData.status !== 'processing') return;

    const es = new EventSource(`/api/cases/${id}/logs`);
    sseRef.current = es;

    es.onmessage = e => {
      const entry: LogEntry = JSON.parse(e.data);
      setLogs(prev => [...prev, entry]);

      // Reload case data when processing finishes
      if (entry.message.includes('Pipeline complete')) {
        setCancelledFileInfo([]);
        setTimeout(loadCase, 1500);
        setTimeout(() => {
          setSuccessToast(caseData?.patientName || 'The report');
        }, 2000);
        es.close();
      } else if (entry.level === 'error') {
        setTimeout(loadCase, 1500);
        es.close();
      }
    };
    es.onerror = () => { es.close(); };
    return () => es.close();
  }, [caseData?.status, id]);

  // ── File staging + upload ─────────────────────────────────────────────────
  const stageFiles = (files: File[]) => {
    for (const f of files) {
      if (!f.type.includes('pdf')) { addError(`"${f.name}" is not a PDF.`); return; }
      if (f.size > 2 * 1024 * 1024 * 1024) { addError(`"${f.name}" exceeds the 2 GB limit.`); return; }
    }
    setCancelledFileInfo([]); // clear cancelled list once user starts re-staging
    setPendingFiles(prev => {
      const existing = new Set(prev.map(f => f.name));
      return [...prev, ...files.filter(f => !existing.has(f.name))];
    });
  };

  const handleUpload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setLogs([]);
    setLogDrawerOpen(true);

    try {
      // 1. Get signed upload URLs from the server
      const urlRes = await fetch(`/api/cases/${id}/upload-urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: files.map(f => ({ name: f.name, size: f.size })) }),
      });
      if (!urlRes.ok) {
        if (urlRes.status === 404) throw new Error('not_found');
        throw new Error('failed');
      }
      const { files: signedFiles } = await urlRes.json() as {
        files: { fileId: string; name: string; gcsPath: string; url: string }[];
      };

      // 2. Upload each file directly to GCS via signed URL (bypasses Cloud Run size limit)
      for (let i = 0; i < files.length; i++) {
        const uploadRes = await fetch(signedFiles[i].url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/pdf' },
          body: files[i],
        });
        if (!uploadRes.ok) throw new Error('failed');
      }

      // 3. Tell the server all files are uploaded — start the pipeline
      const processRes = await fetch(`/api/cases/${id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: signedFiles.map(f => ({ fileId: f.fileId, name: f.name, gcsPath: f.gcsPath })) }),
      });
      if (!processRes.ok) throw new Error('failed');

      // Update local case status immediately so SSE sub kicks in
      setCaseData((prev: any) => prev ? { ...prev, status: 'processing' } : prev);
    } catch (e: any) {
      console.error('[upload]', e);
      if (e.message === 'not_found') {
        addError("This case no longer exists — go back and refresh your cases list.");
      } else {
        addError("The files couldn't be uploaded. Please check your connection and try again.");
      }
    } finally {
      setUploading(false);
    }
  };

  const startProcessing = () => {
    const files = pendingFiles;
    setCancelledFileInfo(files.map(f => ({ name: f.name, size: f.size })));
    setPendingFiles([]);
    handleUpload(files);
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await fetch(`/api/cases/${id}/cancel`, { method: 'POST' });
      if (!res.ok) throw new Error('Cancel request failed');
      await loadCase();
    } catch {
      addError('Could not cancel processing. Please try again.');
    } finally {
      setCancelling(false);
    }
  };

  const handleReprocess = async () => {
    setReprocessing(true);
    setLogs([]);
    setLogDrawerOpen(true);
    try {
      const res = await fetch(`/api/cases/${id}/reprocess`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('[reprocess]', body.error);
        if (res.status === 400) addError("No files found to reprocess — please upload the files again.");
        else addError("Couldn't start reprocessing — please try again.");
        return;
      }
      setCaseData((prev: any) => prev ? { ...prev, status: 'processing' } : prev);
    } catch (e) {
      console.error('[reprocess]', e);
      addError("Couldn't start reprocessing — please try again.");
    } finally {
      setReprocessing(false);
    }
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) stageFiles(files);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) stageFiles(files);
  };

  // ── PDF viewer ─────────────────────────────────────────────────────────────
  const openPdfAtPage = useCallback(async (fileId: string, fileName: string, page: number) => {
    setPdfLoading(true);
    setShowPdfPane(true);
    setPdfName(fileName);
    setPageNum(page);
    try {
      const res = await fetch(`/api/cases/${id}/pdf/${fileId}`);
      if (!res.ok) throw new Error('Could not get PDF URL');
      const { url } = await res.json();
      setPdfUrl(url);
    } catch (e: any) { console.error('[pdf/open]', e); addError("Couldn't open this PDF. Please try again."); }
    finally { setPdfLoading(false); }
  }, [id]);

  // ── Citation link handler: "FileName.pdf (Page 5)" → opens viewer ─────────
  const handleCitationClick = useCallback((citation: string) => {
    if (!caseData?.files?.length) return;
    const pageMatch = citation.match(/page[s]?\s*(\d+)/i);
    const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;

    // Try to match filename
    const file = caseData.files.find((f: any) =>
      citation.toLowerCase().includes(f.name.toLowerCase().replace('.pdf', ''))
    ) || caseData.files[0];

    if (file) openPdfAtPage(file.id, file.name, page);
  }, [caseData, openPdfAtPage]);

  // ── XLSX download ──────────────────────────────────────────────────────────
  const downloadXlsx = (table: 'table1' | 'table2') => {
    const rows = caseData?.[table] || [];
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, table === 'table1' ? 'Medical Chronology' : 'Patient Conditions');
    XLSX.writeFile(wb, `${caseData.patientName} - ${table === 'table1' ? 'Medical Chronology' : 'Patient Conditions'}.xlsx`);
  };

  // ── Filtered tables ────────────────────────────────────────────────────────
  const table1Rows = useMemo(() => applySortFilter(caseData?.table1 || [], t1Sort, t1Filters), [caseData?.table1, t1Sort, t1Filters]);
  const table2Rows = useMemo(() => applySortFilter(caseData?.table2 || [], t2Sort, t2Filters), [caseData?.table2, t2Sort, t2Filters]);

  const t1Keys = useMemo(() => caseData?.table1?.[0] ? Object.keys(caseData.table1[0]) : [], [caseData]);
  const t2Keys = useMemo(() => caseData?.table2?.[0] ? Object.keys(caseData.table2[0]) : [], [caseData]);

  const getUnique = (rows: any[], key: string) =>
    Array.from(new Set(rows.map((r: any) => String(r[key] ?? '')))).sort();

  // ── Column resize handler ──
  const startResize = useCallback((
    key: string,
    startX: number,
    currentWidth: number,
    setWidths: React.Dispatch<React.SetStateAction<Record<string, number>>>,
  ) => {
    const onMove = (e: MouseEvent) => {
      const newW = Math.min(500, Math.max(80, currentWidth + e.clientX - startX));
      setWidths(prev => ({ ...prev, [key]: newW }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // ── Scroll shadow state ──
  const [t1Shadow, setT1Shadow] = useState({ left: false, right: false });
  const [t2Shadow, setT2Shadow] = useState({ left: false, right: false });
  const handleScrollShadow = useCallback((
    el: HTMLDivElement | null,
    setShadow: React.Dispatch<React.SetStateAction<{ left: boolean; right: boolean }>>,
  ) => {
    if (!el) return;
    const update = () => {
      setShadow({
        left: el.scrollLeft > 0,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    };
    update();
    el.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);

  const t1ScrollRef = useRef<HTMLDivElement>(null);
  const t2ScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => handleScrollShadow(t1ScrollRef.current, setT1Shadow), [t1ScrollRef.current, handleScrollShadow]);
  useEffect(() => handleScrollShadow(t2ScrollRef.current, setT2Shadow), [t2ScrollRef.current, handleScrollShadow]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-7 h-7 text-indigo-500 animate-spin" />
      </div>
    );
  }

  if (!caseData) return null;

  const isProcessing = caseData.status === 'processing' || uploading;
  const hasResults  = caseData.status === 'complete' && (caseData.table1?.length > 0 || caseData.table2?.length > 0);
  const hasError    = caseData.status === 'error';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <NavBar user={user} onLogout={onLogout} darkMode={darkMode} onToggleDark={onToggleDark} />

      {/* Success toast — persists until dismissed */}
      <AnimatePresence>
        {successToast && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            className="fixed bottom-6 right-6 z-50 flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl shadow-lg px-4 py-3 max-w-sm"
          >
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
            <p className="text-sm font-medium flex-1">The report for <span className="font-semibold">{successToast}</span> is ready for review.</p>
            <button onClick={() => setSuccessToast(null)} className="text-emerald-400 hover:text-emerald-600 transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Page header — sticky below navbar */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex items-center gap-4 sticky top-[57px] z-20">
        <button onClick={() => navigate('/cases')} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
            {caseData.patientName}
          </h1>
          <p className="text-xs text-slate-500">Date of Injury: {caseData.dateOfInjury} · <StatusBadge status={caseData.status} /></p>
        </div>
        {hasResults && (
          <div className="flex items-center gap-2">
            <a href="#table1" className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 px-2 py-1 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">T1: MedChron</a>
            <a href="#table2" className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 px-2 py-1 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">T2: Conditions</a>
          </div>
        )}
        {caseData.files?.length > 0 && (
          <span className="text-xs text-slate-400">{caseData.files.length} file{caseData.files.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Main content ── */}
        <div className="flex-1 flex flex-col overflow-auto">

          {/* ── Hidden file input (shared) ── */}
          <input ref={fileInputRef} type="file" accept="application/pdf" multiple className="hidden" onChange={onFilePick} />

          {/* ── Drop zone: consistent size whether or not files are staged ── */}
          {!hasResults && !isProcessing && (
            <div className="p-6 space-y-3">
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'border-2 border-dashed rounded-2xl py-8 px-12 text-center cursor-pointer transition-all',
                  dragging
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30'
                    : 'border-slate-300 dark:border-slate-600 hover:border-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                )}
              >
                <UploadCloud className={cn('w-12 h-12 mx-auto mb-4', dragging ? 'text-indigo-500' : 'text-slate-400')} />
                {pendingFiles.length > 0 ? (
                  <>
                    <p className="text-base font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''} added — drop more or click to add
                    </p>
                    <p className="text-sm text-slate-500">Review the list below, then click Start Processing</p>
                  </>
                ) : (
                  <>
                    <p className="text-base font-medium text-slate-700 dark:text-slate-300 mb-1">Drop PDF(s) here or click to upload</p>
                    <p className="text-sm text-slate-500">One or more PDF files up to 2 GB each</p>
                  </>
                )}
              </div>

              {/* Error banner (only when no files staged) */}
              {hasError && pendingFiles.length === 0 && (
                <div className="p-4 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-xl flex items-start gap-3">
                  <AlertCircle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-rose-800 dark:text-rose-300">Processing failed</p>
                    <p className="text-xs text-rose-600 dark:text-rose-400 mt-0.5">{caseData.errorMessage}</p>
                    {caseData.files?.length > 0 ? (
                      <button
                        onClick={handleReprocess}
                        disabled={reprocessing}
                        className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg transition-colors"
                      >
                        {reprocessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                        {reprocessing ? 'Starting…' : 'Retry Processing'}
                      </button>
                    ) : (
                      <p className="text-xs text-rose-500 mt-1">Upload the file again to retry.</p>
                    )}
                  </div>
                </div>
              )}

              {/* Cancelled files — shown after cancel until user re-stages new files */}
              {pendingFiles.length === 0 && cancelledFileInfo.length > 0 && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
                  <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {cancelledFileInfo.length} file{cancelledFileInfo.length !== 1 ? 's' : ''} ready to process
                    </p>
                    <button
                      onClick={() => setCancelledFileInfo([])}
                      className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                  <ul className="divide-y divide-slate-50 dark:divide-slate-800">
                    {cancelledFileInfo.map((f, idx) => (
                      <li key={idx} className="flex items-center gap-3 px-5 py-3 opacity-50">
                        <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{f.name}</p>
                          <p className="text-xs text-slate-400">{formatBytes(f.size)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="px-5 py-3.5 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800">
                    <p className="text-xs text-slate-500">Drop or select these files above to reprocess them.</p>
                  </div>
                </div>
              )}

              {/* Staged file list */}
              {pendingFiles.length > 0 && (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
                  <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''} ready to process
                    </p>
                    <button
                      onClick={() => setPendingFiles([])}
                      className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                  <ul className="divide-y divide-slate-50 dark:divide-slate-800">
                    {pendingFiles.map((f, idx) => (
                      <li key={idx} className="flex items-center gap-3 px-5 py-3">
                        <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{f.name}</p>
                          <p className="text-xs text-slate-400">{formatBytes(f.size)}</p>
                        </div>
                        <button
                          onClick={() => setPendingFiles(prev => prev.filter((_, i) => i !== idx))}
                          className="p-1 text-slate-300 hover:text-rose-500 dark:hover:text-rose-400 transition-colors"
                          title="Remove"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="px-5 py-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                    <button
                      onClick={startProcessing}
                      className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
                    >
                      <Play className="w-4 h-4" />
                      Start Processing
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Staged files panel on results screen (above tables) ── */}
          {hasResults && pendingFiles.length > 0 && !isProcessing && (
            <div className="px-6 pt-4 space-y-2">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
                <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''} ready to process
                  </p>
                  <button onClick={() => setPendingFiles([])} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">Clear all</button>
                </div>
                <ul className="divide-y divide-slate-50 dark:divide-slate-800">
                  {pendingFiles.map((f, idx) => (
                    <li key={idx} className="flex items-center gap-3 px-5 py-3">
                      <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{f.name}</p>
                        <p className="text-xs text-slate-400">{formatBytes(f.size)}</p>
                      </div>
                      <button onClick={() => setPendingFiles(prev => prev.filter((_, i) => i !== idx))} className="p-1 text-slate-300 hover:text-rose-500 transition-colors"><X className="w-4 h-4" /></button>
                    </li>
                  ))}
                </ul>
                <div className="px-5 py-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                  <button onClick={startProcessing} className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm">
                    <Play className="w-4 h-4" /> Start Processing
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Processing view ── */}
          {isProcessing && (
            <div className="p-6 flex flex-col items-center justify-center min-h-[200px] gap-4">
              <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
              <div className="text-center">
                <p className="text-base font-semibold text-slate-900 dark:text-slate-100">Processing records…</p>
                <p className="text-sm text-slate-500 mt-1">This may take up to 2 hours, depending on network traffic on the OCR server.</p>
              </div>
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 border border-slate-300 dark:border-slate-600 hover:border-rose-400 dark:hover:border-rose-500 rounded-xl transition-colors disabled:opacity-50"
              >
                {cancelling
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <StopCircle className="w-4 h-4" />}
                {cancelling ? 'Cancelling…' : 'Cancel Processing'}
              </button>
            </div>
          )}

          {/* ── Results: re-upload button when complete ── */}
          {hasResults && !isProcessing && pendingFiles.length === 0 && (
            <div className="px-6 pt-4 flex justify-end">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-colors shadow-sm"
              >
                <ArrowUp className="w-4 h-4" /> Upload more files
              </button>
            </div>
          )}

          {/* ── Source files + compilation timestamp ── */}
          {hasResults && caseData.files?.length > 0 && (
            <div className="px-6 pt-6 pb-2">
              <div className="text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                <p className="font-medium">Compiled from:</p>
                {caseData.files.map((f: any, i: number) => (
                  <p key={i} className="pl-3">{f.name}</p>
                ))}
                {caseData.updatedAt && (
                  <p className="pt-1">Generated: {new Date(caseData.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</p>
                )}
              </div>
            </div>
          )}

          {/* ── Table 1: Medical Chronology ── */}
          {table1Rows.length > 0 && (
            <section id="table1" className="px-6 pt-4 pb-4">
              <button
                onClick={() => setT1Collapsed(v => !v)}
                className="flex items-center gap-2 mb-3 group cursor-pointer"
              >
                <ChevronRight className={cn('w-4 h-4 text-slate-400 transition-transform', !t1Collapsed && 'rotate-90')} />
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Table 1: Medical Chronology <span className="text-slate-400 font-normal">({caseData.table1.length} records)</span>
                </h2>
              </button>
              <div className="flex items-center gap-3 mb-2">
                {caseData.table1Versions?.length > 1 && (
                  <VersionDropdown
                    caseId={id!}
                    table="table1"
                    versions={caseData.table1Versions}
                    activeVersionIndex={caseData.table1ActiveVersion ?? 0}
                    onVersionChange={() => loadCase()}
                  />
                )}
                <div className="flex-1" />
                {caseData.status === 'complete' && (
                  <button onClick={() => setRegenerateTarget('table1')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg transition-colors shadow-sm">
                    <RotateCcw className="w-3.5 h-3.5" /> Regenerate Table...
                  </button>
                )}
                <button onClick={() => downloadXlsx('table1')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg transition-colors shadow-sm">
                  <Download className="w-3.5 h-3.5" /> Download for Excel
                </button>
              </div>
              {!t1Collapsed && (
                <div
                  ref={t1ScrollRef}
                  className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-auto shadow-sm max-h-[70vh]"
                  style={{
                    boxShadow: [
                      t1Shadow.left ? 'inset 8px 0 6px -6px rgba(0,0,0,0.1)' : '',
                      t1Shadow.right ? 'inset -8px 0 6px -6px rgba(0,0,0,0.1)' : '',
                    ].filter(Boolean).join(', ') || undefined,
                  }}
                >
                  <table className="w-full text-sm text-left min-w-[900px]">
                    <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10">
                      <tr>
                        {t1Keys.map(key => (
                          <SortableFilterableHeader
                            key={key} label={key} columnKey={key}
                            sortConfig={t1Sort} onSort={k => handleSort(k, setT1Sort)}
                            filterValue={t1Filters[key] || ''}
                            onFilter={(k, v) => setT1Filters(prev => ({ ...prev, [k]: v }))}
                            uniqueValues={getUnique(caseData.table1, key)}
                            style={{ width: t1ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}
                            resizeHandle={
                              <div
                                onMouseDown={e => {
                                  e.stopPropagation();
                                  const th = (e.target as HTMLElement).closest('th');
                                  startResize(key, e.clientX, th?.offsetWidth || 120, setT1ColWidths);
                                }}
                                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400/50"
                              />
                            }
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {table1Rows.map((row: any, idx: number) => (
                        <tr key={idx} className={cn('hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors', idx % 2 === 1 && 'bg-slate-50/50 dark:bg-slate-900/30')}>
                          {t1Keys.map(key => (
                            <td key={key} className="px-4 py-3 text-slate-700 dark:text-slate-300 border-r border-slate-100 dark:border-slate-800 last:border-r-0" style={{ width: t1ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}>
                              {key.toLowerCase().includes('citation') ? (
                                <button
                                  onClick={() => handleCitationClick(String(row[key] || ''))}
                                  className="text-indigo-600 dark:text-indigo-400 hover:underline text-left text-xs"
                                >
                                  {row[key] || '—'}
                                </button>
                              ) : (
                                <div className="text-xs whitespace-pre-wrap break-words">{row[key] || '—'}</div>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* ── Table 2: Patient Conditions ── */}
          {table2Rows.length > 0 && (
            <section id="table2" className="px-6 pt-4 pb-8">
              <button
                onClick={() => setT2Collapsed(v => !v)}
                className="flex items-center gap-2 mb-3 group cursor-pointer"
              >
                <ChevronRight className={cn('w-4 h-4 text-slate-400 transition-transform', !t2Collapsed && 'rotate-90')} />
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Table 2: Patient Conditions <span className="text-slate-400 font-normal">({caseData.table2.length} conditions)</span>
                </h2>
              </button>
              <div className="flex items-center gap-3 mb-2">
                {caseData.table2Versions?.length > 1 && (
                  <VersionDropdown
                    caseId={id!}
                    table="table2"
                    versions={caseData.table2Versions}
                    activeVersionIndex={caseData.table2ActiveVersion ?? 0}
                    onVersionChange={() => loadCase()}
                  />
                )}
                <div className="flex-1" />
                {caseData.status === 'complete' && (
                  <button onClick={() => setRegenerateTarget('table2')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg transition-colors shadow-sm">
                    <RotateCcw className="w-3.5 h-3.5" /> Regenerate Table...
                  </button>
                )}
                <button onClick={() => downloadXlsx('table2')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg transition-colors shadow-sm">
                  <Download className="w-3.5 h-3.5" /> Download for Excel
                </button>
              </div>
              {!t2Collapsed && (
                <div
                  ref={t2ScrollRef}
                  className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-auto shadow-sm max-h-[70vh]"
                  style={{
                    boxShadow: [
                      t2Shadow.left ? 'inset 8px 0 6px -6px rgba(0,0,0,0.1)' : '',
                      t2Shadow.right ? 'inset -8px 0 6px -6px rgba(0,0,0,0.1)' : '',
                    ].filter(Boolean).join(', ') || undefined,
                  }}
                >
                  <table className="w-full text-sm text-left min-w-[900px]">
                    <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10">
                      <tr>
                        {t2Keys.map(key => (
                          <SortableFilterableHeader
                            key={key} label={key} columnKey={key}
                            sortConfig={t2Sort} onSort={k => handleSort(k, setT2Sort)}
                            filterValue={t2Filters[key] || ''}
                            onFilter={(k, v) => setT2Filters(prev => ({ ...prev, [k]: v }))}
                            uniqueValues={getUnique(caseData.table2, key)}
                            style={{ width: t2ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}
                            resizeHandle={
                              <div
                                onMouseDown={e => {
                                  e.stopPropagation();
                                  const th = (e.target as HTMLElement).closest('th');
                                  startResize(key, e.clientX, th?.offsetWidth || 120, setT2ColWidths);
                                }}
                                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400/50"
                              />
                            }
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {table2Rows.map((row: any, idx: number) => (
                        <tr key={idx} className={cn('hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors', idx % 2 === 1 && 'bg-slate-50/50 dark:bg-slate-900/30')}>
                          {t2Keys.map(key => (
                            <td key={key} className="px-4 py-3 text-slate-700 dark:text-slate-300 border-r border-slate-100 dark:border-slate-800 last:border-r-0" style={{ width: t2ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}>
                              <div className="text-xs whitespace-pre-wrap break-words">{row[key] || '—'}</div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* SSE Log Drawer */}
          <div className="sticky bottom-0 mt-auto">
            <LogDrawer logs={logs} isOpen={logDrawerOpen} onToggle={() => setLogDrawerOpen(v => !v)} />
          </div>
        </div>

        {/* ── PDF Viewer pane ── */}
        <AnimatePresence>
          {showPdfPane && pdfUrl && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 420, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className="border-l border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex flex-col overflow-hidden"
              style={{ minWidth: 320 }}
            >
              {/* PDF header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">{pdfName}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum <= 1} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 transition-colors">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-slate-500 tabular-nums w-16 text-center">
                    {pageNum} / {numPages || '?'}
                  </span>
                  <button onClick={() => setPageNum(p => Math.min(numPages, p + 1))} disabled={pageNum >= numPages} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 transition-colors">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  <button onClick={() => { setShowPdfPane(false); setPdfUrl(null); }} className="ml-1 p-1 text-slate-400 hover:text-rose-500 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* PDF content */}
              <div className="flex-1 overflow-auto flex justify-center bg-slate-100 dark:bg-slate-800 p-2">
                {pdfLoading ? (
                  <div className="flex items-center justify-center w-full"><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div>
                ) : (
                  <Document
                    file={pdfUrl}
                    onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                    loading={<Loader2 className="w-6 h-6 text-indigo-500 animate-spin mt-8" />}
                    error={<p className="text-sm text-rose-500 p-4">Failed to load PDF.</p>}
                  >
                    <Page pageNumber={pageNum} width={380} renderAnnotationLayer renderTextLayer />
                  </Document>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Toggle PDF pane button (when pane is closed) */}
        {!showPdfPane && caseData.files?.length > 0 && (
          <button
            onClick={() => {
              if (caseData.files?.[0]) openPdfAtPage(caseData.files[0].id, caseData.files[0].name, 1);
            }}
            className="fixed right-4 bottom-20 p-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-md text-slate-500 hover:text-indigo-600 transition-colors"
            title="Open PDF viewer"
          >
            <PanelRightOpen className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Regeneration overlay */}
      <AnimatePresence>
        {regenerateTarget && (
          <RegenerateEditor
            caseId={id!}
            table={regenerateTarget}
            onClose={() => setRegenerateTarget(null)}
            onSuccess={() => { setRegenerateTarget(null); loadCase(); }}
            addError={addError}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
