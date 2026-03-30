import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  UploadCloud, Loader2, Download, ChevronLeft, ChevronRight, ChevronDown, X, Check,
  PanelRightClose, PanelRightOpen, FileText, ArrowUp, AlertCircle, CheckCircle2, Circle, XCircle, Play, StopCircle, RotateCcw,
  ZoomIn, ZoomOut, Maximize2,
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
import { cn, formatDate, formatBytes, parseCellColor } from '../lib/utils.js';

// Configure pdf.js worker — must use react-pdf's bundled pdfjs-dist to avoid version mismatch
pdfjs.GlobalWorkerOptions.workerSrc = new URL('react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

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
  const [uploadProgress, setUploadProgress] = useState<Map<number, number>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // SSE log stream
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  // Tables
  const [t1Sort, setT1Sort] = useState<SortConfig>({ key: '', direction: null });
  const [t1Filters, setT1Filters] = useState<FilterConfig>({});
  const [t2Sort, setT2Sort] = useState<SortConfig>({ key: '', direction: null });
  const [t2Filters, setT2Filters] = useState<FilterConfig>({});

  // Table collapse
  const [t1Collapsed, setT1Collapsed] = useState(false);
  const [t2Collapsed, setT2Collapsed] = useState(false);
  const [compiledFromOpen, setCompiledFromOpen] = useState(false);

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
  const [pdfPaneWidth, setPdfPaneWidth] = useState(420);
  const [pdfRetryKey, setPdfRetryKey] = useState(0);
  const [pdfContainerWidth, setPdfContainerWidth] = useState(380);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  // ── Load case ──────────────────────────────────────────────────────────────
  const loadCase = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${id}`);
      if (res.status === 401) { onLogout(); return; }
      if (!res.ok) { navigate('/cases'); return; }
      const data = await res.json();
      setCaseData(data.case);
      // Seed log drawer with persisted processing logs (if any) on initial load
      if (data.case.processingLogs?.length) {
        setLogs(prev => {
          if (prev.length > 0) return prev; // don't overwrite live SSE logs
          return data.case.processingLogs.map(({ seq, ...rest }: any) => rest);
        });
      }
    } catch (e) { console.error('[case/load]', e); addError("Couldn't load this case — please refresh the page."); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { loadCase(); }, [loadCase]);

  // ── SSE: subscribe when case is processing (with auto-reconnect) ─────────
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenLogsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!caseData) return;
    if (caseData.status !== 'processing') return;

    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(`/api/cases/${id}/logs`);
      sseRef.current = es;

      es.onmessage = e => {
        const entry: LogEntry = JSON.parse(e.data);
        // Deduplicate: Firestore replay resends already-seen entries on reconnect
        const key = `${entry.timestamp}|${entry.message}`;
        if (seenLogsRef.current.has(key)) return;
        seenLogsRef.current.add(key);

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
      es.onerror = () => {
        es.close();
        // Auto-reconnect after 3s (e.g. deploy, network blip)
        if (!disposed) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      sseRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
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
    setUploadProgress(new Map());
    seenLogsRef.current.clear(); // reset dedup so new SSE entries aren't skipped
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

      // 2. Upload each file directly to GCS via signed URL with progress tracking
      for (let i = 0; i < files.length; i++) {
        setUploadProgress(prev => new Map(prev).set(i, 0));
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', signedFiles[i].url);
          xhr.setRequestHeader('Content-Type', 'application/pdf');
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(prev => new Map(prev).set(i, pct));
            }
          };
          xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('failed'));
          xhr.onerror = () => reject(new Error('failed'));
          xhr.send(files[i]);
        });
      }

      // 3. Tell the server all files are uploaded — start the pipeline
      const processRes = await fetch(`/api/cases/${id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: signedFiles.map(f => ({ fileId: f.fileId, name: f.name, gcsPath: f.gcsPath })) }),
      });
      if (!processRes.ok) throw new Error('failed');

      // Clear file list and transition to processing view
      setPendingFiles([]);
      setUploadProgress(new Map());
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
    setCancelledFileInfo(pendingFiles.map(f => ({ name: f.name, size: f.size })));
    handleUpload(pendingFiles);
  };

  const handleCancel = async () => {
    if (!window.confirm('Are you sure? You will have to re-upload the files.')) return;
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
    seenLogsRef.current.clear(); // reset dedup so new SSE entries aren't skipped
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

  const handleRegenerateBoth = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${id}/regenerate/tables`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        addError(d.error || 'Failed to start table regeneration');
        return;
      }
      seenLogsRef.current.clear();
      setLogs([]);
      setLogDrawerOpen(true);
      await loadCase(); // re-fetches; status is now 'processing' → SSE subscribes
    } catch {
      addError('Failed to start table regeneration');
    }
  }, [id, loadCase]);

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
  const [pdfFileId, setPdfFileId] = useState<string | null>(null);
  const [pdfScale, setPdfScale] = useState(1.0);
  const [pdfPageRatio, setPdfPageRatio] = useState(0); // height/width of intrinsic page

  const openPdfAtPage = useCallback((fileId: string, fileName: string, page: number) => {
    setShowPdfPane(true);
    setPdfName(fileName);
    setPdfFileId(fileId);
    setPageNum(page);
    setPdfScale(1.0);
    // Stream directly through Express — no signed URL needed
    setPdfUrl(`/api/cases/${id}/pdf/${fileId}`);
  }, [id]);

  // ── PDF container resize observer ────────────────────────────────────────
  useEffect(() => {
    const el = pdfContentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setPdfContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showPdfPane, pdfUrl]);

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

  const isProcessing = caseData.status === 'processing';
  const hasTableData = (caseData.table1?.length ?? 0) > 0 || (caseData.table2?.length ?? 0) > 0;
  const hasResults   = (caseData.status === 'complete' || (caseData.status === 'error' && hasTableData)) && hasTableData;
  const hasError     = caseData.status === 'error';
  // Allow regeneration for error cases where ingestion finished (step3Complete) —
  // table generation failed after good BigQuery data was written, so we can
  // skip DocAI entirely and just re-run Steps 4/5.
  const canRegenerate = caseData.status === 'complete' ||
    (caseData.status === 'error' && caseData.pipelineCheckpoint?.step3Complete);

  // Pipeline step checklist — derived from checkpoint flags + table presence
  type StepStatus = 'done' | 'active' | 'pending' | 'error';
  const cp = caseData.pipelineCheckpoint;
  const isErr = caseData.status === 'error';
  const _s1 = !!cp?.step1Complete, _s2 = !!cp?.step2Complete, _s3 = !!cp?.step3Complete;
  const _s4 = (caseData.table1?.length ?? 0) > 0, _s5 = (caseData.table2?.length ?? 0) > 0;
  const _st = (done: boolean, prev: boolean): StepStatus =>
    done ? 'done' : !prev ? 'pending' : isErr ? 'error' : 'active';
  const pipelineSteps: { label: string; status: StepStatus }[] = [
    { label: 'Upload & chunk PDFs',          status: _st(_s1, true) },
    { label: 'OCR + Layout parsing',          status: _st(_s2, _s1) },
    { label: 'Reassemble & ingest',           status: _st(_s3, _s2) },
    { label: 'Generate Medical Chronology',   status: _st(_s4, _s3) },
    { label: 'Generate Patient Conditions',   status: _st(_s5, _s4) },
  ];

  const PipelineChecklist = () => (
    <ol className="flex flex-col gap-1.5">
      {pipelineSteps.map(({ label, status }, i) => (
        <li key={i} className="flex items-center gap-2.5">
          {status === 'done'    && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
          {status === 'active'  && <Loader2     className="w-4 h-4 text-indigo-500 animate-spin shrink-0" />}
          {status === 'error'   && <XCircle     className="w-4 h-4 text-rose-500 shrink-0" />}
          {status === 'pending' && <Circle      className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />}
          <span className={cn(
            'text-sm',
            status === 'done'    && 'text-slate-500 dark:text-slate-400',
            status === 'active'  && 'text-slate-800 dark:text-slate-100 font-medium',
            status === 'error'   && 'text-rose-700 dark:text-rose-400 font-medium',
            status === 'pending' && 'text-slate-400 dark:text-slate-500',
          )}>{label}</span>
        </li>
      ))}
    </ol>
  );

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
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 sticky top-[57px] z-20">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/cases')} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
              {caseData.patientName}
            </h1>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Date of Injury: {caseData.dateOfInjury}
              {caseData.files?.length > 0 && <> · {caseData.files.length} file{caseData.files.length !== 1 ? 's' : ''}</>}
              {' · '}<StatusBadge status={caseData.status} />
            </p>
          </div>
          {hasResults && (
            <div className="flex items-center gap-1 shrink-0">
              <a href="#table1" className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 px-3 py-1.5 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">T1: MedChron</a>
              <a href="#table2" className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 px-3 py-1.5 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">T2: Conditions</a>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Main content ── */}
        <div className="flex-1 flex flex-col overflow-auto">

          {/* ── Hidden file input (shared) ── */}
          <input ref={fileInputRef} type="file" accept="application/pdf" multiple className="hidden" onChange={onFilePick} />

          {/* ── Drop zone: consistent size whether or not files are staged ── */}
          {!hasResults && !isProcessing && !uploading && (
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
                    <p className="text-xs text-rose-600 dark:text-rose-400 mt-0.5 break-all">{caseData.errorMessage}</p>
                    <div className="mt-3 mb-3">
                      <PipelineChecklist />
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {canRegenerate && (
                        <button
                          onClick={handleRegenerateBoth}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" /> Regenerate Tables
                        </button>
                      )}
                      {caseData.files?.length > 0 ? (
                        <button
                          onClick={handleReprocess}
                          disabled={reprocessing}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg transition-colors"
                        >
                          {reprocessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          {reprocessing ? 'Starting…' : 'Retry Processing'}
                        </button>
                      ) : (
                        <p className="text-xs text-rose-500">Upload the file again to retry.</p>
                      )}
                    </div>
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
                          <p className="text-xs text-slate-500">{formatBytes(f.size)}</p>
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
                          <p className="text-xs text-slate-500">{formatBytes(f.size)}</p>
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

          {/* ── Upload progress view (shown while files are uploading to GCS) ── */}
          {uploading && pendingFiles.length > 0 && (
            <div className="p-6">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
                <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    Uploading {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}…
                  </p>
                </div>
                <ul className="divide-y divide-slate-50 dark:divide-slate-800">
                  {pendingFiles.map((f, idx) => (
                    <li key={idx} className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{f.name}</p>
                          <p className="text-xs text-slate-500">{formatBytes(f.size)}</p>
                        </div>
                        {uploadProgress.has(idx) && uploadProgress.get(idx)! >= 100 && (
                          <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                        )}
                      </div>
                      {uploadProgress.has(idx) && (
                        <div className="mt-2 h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-500 rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${uploadProgress.get(idx) || 0}%` }}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="px-5 py-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                  <button
                    disabled
                    className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl shadow-sm opacity-50 cursor-not-allowed"
                  >
                    <Loader2 className="w-4 h-4 animate-spin" /> Uploading…
                  </button>
                </div>
              </div>
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
                        <p className="text-xs text-slate-500">{formatBytes(f.size)}</p>
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
            <div className="p-6 flex flex-col items-center justify-center min-h-[200px] gap-5">
              <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
              <div className="text-center">
                <p className="text-base font-semibold text-slate-900 dark:text-slate-100">Processing records…</p>
                <p className="text-sm text-slate-500 mt-1">This may take up to 2 hours, depending on network traffic on the OCR server.</p>
                {logs.length > 0 && (() => {
                  const last = logs[logs.length - 1];
                  let ts = '';
                  try { ts = new Date(last.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); } catch { ts = last.timestamp; }
                  return (
                    <p className="text-xs font-mono text-slate-500 dark:text-slate-500 mt-2 text-center">
                      {ts} — {last.message}
                    </p>
                  );
                })()}
              </div>
              <PipelineChecklist />
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

          {/* ── Error banner (results view — error state but table data exists) ── */}
          {hasResults && hasError && (
            <div className="px-6 pt-4">
              <div className="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-xl flex items-center gap-3">
                <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-rose-800 dark:text-rose-300">Processing incomplete</p>
                  {caseData.errorMessage && (
                    <p className="text-xs text-rose-600 dark:text-rose-400 mt-0.5 break-words">{caseData.errorMessage}</p>
                  )}
                </div>
                {canRegenerate && (
                  <button
                    onClick={handleRegenerateBoth}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Regenerate Tables
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Source files + compilation timestamp + upload button ── */}
          {hasResults && caseData.files?.length > 0 && (
            <div className="px-6 pt-6 pb-2">
              <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3">
                  <button
                    onClick={() => setCompiledFromOpen(v => !v)}
                    className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity"
                  >
                    <ChevronRight className={cn('w-3.5 h-3.5 text-slate-400 transition-transform', compiledFromOpen && 'rotate-90')} />
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      Compiled{caseData.updatedAt && <> on {new Date(caseData.updatedAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })} at {new Date(caseData.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</>} from {caseData.files.length} file{caseData.files.length !== 1 ? 's' : ''}
                    </span>
                    {(() => {
                      const totalBytes = caseData.files.reduce((sum: number, f: any) => sum + (f.sizeBytes || 0), 0);
                      const parts: string[] = [];
                      if (caseData.totalPages) parts.push(`${caseData.totalPages} pages`);
                      if (totalBytes > 0) parts.push(formatBytes(totalBytes));
                      return parts.length > 0 ? <span className="text-slate-500 dark:text-slate-400 font-normal ml-1">({parts.join(', ')})</span> : null;
                    })()}
                  </button>
                  {!isProcessing && pendingFiles.length === 0 && (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-indigo-600 border border-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-colors shrink-0"
                    >
                      <ArrowUp className="w-3.5 h-3.5" /> Upload More Files
                    </button>
                  )}
                </div>
                {compiledFromOpen && (
                  <div className="px-4 pb-3 pt-0 border-t border-slate-200 dark:border-slate-700">
                    <ul className="mt-2 space-y-1">
                      {caseData.files.map((f: any, i: number) => (
                        <li key={i} className="text-sm text-slate-700 dark:text-slate-300 pl-5">• {f.name} <span className="text-slate-500 dark:text-slate-400">({formatBytes(f.sizeBytes || 0)})</span></li>
                      ))}
                    </ul>
                  </div>
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
                  Table 1: Medical Chronology <span className="text-slate-500 font-normal">({caseData.table1.length} records)</span>
                </h2>
              </button>
              {!t1Collapsed && (
              <>
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
                {canRegenerate && (
                  <button onClick={() => setRegenerateTarget('table1')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg transition-colors shadow-sm">
                    <RotateCcw className="w-3.5 h-3.5" /> Regenerate Table...
                  </button>
                )}
                <button onClick={() => downloadXlsx('table1')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg transition-colors shadow-sm">
                  <Download className="w-3.5 h-3.5" /> Download for Excel
                </button>
              </div>

                <div className="relative">
                <div
                  ref={t1ScrollRef}
                  className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-auto shadow-sm max-h-[70vh]"
                >
                  <table className="w-full text-sm text-left min-w-[900px]">
                    <thead className="bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10">
                      <tr>
                        {t1Keys.map((key, i) => (
                          <SortableFilterableHeader
                            key={key} label={key} columnKey={key}
                            sortConfig={t1Sort} onSort={k => handleSort(k, setT1Sort)}
                            filterValue={t1Filters[key] || ''}
                            onFilter={(k, v) => setT1Filters(prev => ({ ...prev, [k]: v }))}
                            uniqueValues={getUnique(caseData.table1, key)}
                            className={i === 0 ? 'sticky left-0 z-20 bg-slate-50 dark:bg-slate-800' : undefined}
                            style={{ width: t1ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}
                            resizeHandle={
                              <div
                                onMouseDown={e => {
                                  e.stopPropagation();
                                  const th = (e.target as HTMLElement).closest('th');
                                  startResize(key, e.clientX, th?.offsetWidth || 120, setT1ColWidths);
                                }}
                                className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-indigo-400/50"
                              />
                            }
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {table1Rows.map((row: any, idx: number) => (
                        <tr key={idx} className={cn('hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors', idx % 2 === 1 && 'bg-slate-50/50 dark:bg-slate-900/30')}>
                          {t1Keys.map((key, i) => {
                            const { text: cellText, colorClass } = parseCellColor(String(row[key] || ''));
                            return (
                              <td key={key} className={cn('px-4 py-3 text-slate-700 dark:text-slate-300 border-r border-slate-100 dark:border-slate-800 last:border-r-0', i === 0 && 'sticky left-0 z-[1] bg-white dark:bg-slate-900', i === 0 && idx % 2 === 1 && 'bg-slate-50 dark:bg-slate-900', colorClass)} style={{ width: t1ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}>
                                {key.toLowerCase().includes('citation') ? (
                                  <button
                                    onClick={() => handleCitationClick(String(row[key] || ''))}
                                    className="text-indigo-600 dark:text-indigo-400 hover:underline text-left text-xs"
                                  >
                                    {cellText || '—'}
                                  </button>
                                ) : (
                                  <div className="text-xs whitespace-pre-wrap break-words">{cellText || '—'}</div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {t1Shadow.left && (
                  <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-4 z-10 rounded-l-xl"
                       style={{ background: 'linear-gradient(to right, rgba(0,0,0,0.08), transparent)' }} />
                )}
                {t1Shadow.right && (
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-4 z-10 rounded-r-xl"
                       style={{ background: 'linear-gradient(to left, rgba(0,0,0,0.08), transparent)' }} />
                )}
                </div>
              </>
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
                  Table 2: Patient Conditions <span className="text-slate-500 font-normal">({caseData.table2.length} conditions)</span>
                </h2>
              </button>
              {!t2Collapsed && (
              <>
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
                {canRegenerate && (
                  <button onClick={() => setRegenerateTarget('table2')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg transition-colors shadow-sm">
                    <RotateCcw className="w-3.5 h-3.5" /> Regenerate Table...
                  </button>
                )}
                <button onClick={() => downloadXlsx('table2')} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg transition-colors shadow-sm">
                  <Download className="w-3.5 h-3.5" /> Download for Excel
                </button>
              </div>

                <div className="relative">
                <div
                  ref={t2ScrollRef}
                  className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-auto shadow-sm max-h-[70vh]"
                >
                  <table className="w-full text-sm text-left min-w-[900px]">
                    <thead className="bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10">
                      <tr>
                        {t2Keys.map((key, i) => (
                          <SortableFilterableHeader
                            key={key} label={key} columnKey={key}
                            sortConfig={t2Sort} onSort={k => handleSort(k, setT2Sort)}
                            filterValue={t2Filters[key] || ''}
                            onFilter={(k, v) => setT2Filters(prev => ({ ...prev, [k]: v }))}
                            uniqueValues={getUnique(caseData.table2, key)}
                            className={i === 0 ? 'sticky left-0 z-20 bg-slate-50 dark:bg-slate-800' : undefined}
                            style={{ width: t2ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}
                            resizeHandle={
                              <div
                                onMouseDown={e => {
                                  e.stopPropagation();
                                  const th = (e.target as HTMLElement).closest('th');
                                  startResize(key, e.clientX, th?.offsetWidth || 120, setT2ColWidths);
                                }}
                                className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-indigo-400/50"
                              />
                            }
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {table2Rows.map((row: any, idx: number) => (
                        <tr key={idx} className={cn('hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors', idx % 2 === 1 && 'bg-slate-50/50 dark:bg-slate-900/30')}>
                          {t2Keys.map((key, i) => {
                            const { text: cellText, colorClass } = parseCellColor(String(row[key] || ''));
                            return (
                              <td key={key} className={cn('px-4 py-3 text-slate-700 dark:text-slate-300 border-r border-slate-100 dark:border-slate-800 last:border-r-0', i === 0 && 'sticky left-0 z-[1] bg-white dark:bg-slate-900', i === 0 && idx % 2 === 1 && 'bg-slate-50 dark:bg-slate-900', colorClass)} style={{ width: t2ColWidths[key] || undefined, minWidth: 80, maxWidth: 500 }}>
                                <div className="text-xs whitespace-pre-wrap break-words">{cellText || '—'}</div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {t2Shadow.left && (
                  <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-4 z-10 rounded-l-xl"
                       style={{ background: 'linear-gradient(to right, rgba(0,0,0,0.08), transparent)' }} />
                )}
                {t2Shadow.right && (
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-4 z-10 rounded-r-xl"
                       style={{ background: 'linear-gradient(to left, rgba(0,0,0,0.08), transparent)' }} />
                )}
                </div>
              </>
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
              animate={{ width: pdfPaneWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className="relative border-l border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex flex-col overflow-hidden"
              style={{ minWidth: 280, maxWidth: '60vw' }}
            >
              {/* Resize handle */}
              <div
                className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-indigo-400/40 active:bg-indigo-500/50 z-10 transition-colors"
                onMouseDown={(e) => {
                  e.preventDefault();
                  isResizingRef.current = true;
                  const startX = e.clientX;
                  const startW = pdfPaneWidth;
                  const onMove = (ev: MouseEvent) => {
                    if (!isResizingRef.current) return;
                    const newW = Math.max(280, Math.min(window.innerWidth * 0.6, startW - (ev.clientX - startX)));
                    setPdfPaneWidth(newW);
                  };
                  const onUp = () => { isResizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                  window.addEventListener('mousemove', onMove);
                  window.addEventListener('mouseup', onUp);
                }}
              />
              {/* PDF header */}
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">{pdfName}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum <= 1} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 transition-colors">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs text-slate-600 dark:text-slate-400 tabular-nums w-16 text-center">
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
                {/* Zoom controls + download */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setPdfScale(s => Math.max(0.5, s - 0.15))} className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors" title="Zoom out">
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setPdfScale(1.0)} className="text-xs text-slate-600 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 px-1.5 py-0.5 rounded transition-colors tabular-nums" title="Reset zoom">
                      {Math.round(pdfScale * 100)}%
                    </button>
                    <button onClick={() => setPdfScale(s => Math.min(3, s + 0.15))} className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors" title="Zoom in">
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        if (!pdfPageRatio || !pdfContentRef.current) return;
                        // Available height = content area minus padding (2 * 8px)
                        const availH = pdfContentRef.current.clientHeight - 16;
                        // Page width needed so rendered page height === availH
                        const neededPageW = availH / pdfPageRatio;
                        // Pane width = page width + container padding (16px) + pane chrome (border etc)
                        const neededPaneW = neededPageW + 20;
                        const clamped = Math.max(280, Math.min(window.innerWidth * 0.6, neededPaneW));
                        setPdfPaneWidth(clamped);
                        setPdfScale(1.0);
                      }}
                      disabled={!pdfPageRatio}
                      className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 transition-colors ml-1 border-l border-slate-200 dark:border-slate-700 pl-2"
                      title="Fit full page vertically"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {pdfUrl && (
                    <a href={pdfUrl} download={pdfName} className="flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors" title="Download PDF">
                      <Download className="w-3.5 h-3.5" /> Download
                    </a>
                  )}
                </div>
              </div>

              {/* PDF content */}
              <div ref={pdfContentRef} className="flex-1 overflow-auto flex justify-center bg-slate-100 dark:bg-slate-800 p-2">
                {pdfLoading ? (
                  <div className="flex items-center justify-center w-full"><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div>
                ) : (
                  <Document
                    key={pdfRetryKey}
                    file={pdfUrl}
                    onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                    loading={<Loader2 className="w-6 h-6 text-indigo-500 animate-spin mt-8" />}
                    error={
                      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 mt-12">
                        <AlertCircle className="w-10 h-10 text-slate-400" />
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Unable to load PDF</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 text-center max-w-48">The file may still be uploading, or there was a network error.</p>
                        <button
                          onClick={() => setPdfRetryKey(k => k + 1)}
                          className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg transition-colors shadow-sm"
                        >
                          <RotateCcw className="w-3.5 h-3.5" /> Retry
                        </button>
                      </div>
                    }
                  >
                    <Page pageNumber={pageNum} width={Math.max(200, (pdfContainerWidth - 16)) * pdfScale} renderAnnotationLayer renderTextLayer
                      onLoadSuccess={(page) => {
                        if (page.originalWidth && page.originalHeight) {
                          setPdfPageRatio(page.originalHeight / page.originalWidth);
                        }
                      }}
                    />
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
            table1Versions={caseData?.table1Versions}
            table1ActiveVersion={caseData?.table1ActiveVersion}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
