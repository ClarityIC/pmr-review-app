import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  UploadCloud, Loader2, Download, ChevronLeft, ChevronRight, X,
  PanelRightClose, PanelRightOpen, FileText, RefreshCw, AlertCircle,
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'motion/react';
import NavBar from '../components/NavBar.js';
import LogDrawer, { LogEntry } from '../components/LogDrawer.js';
import StatusBadge from '../components/StatusBadge.js';
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
    } catch { addError('Failed to load case.'); }
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
      if (entry.message.includes('Pipeline complete') || entry.level === 'error') {
        setTimeout(loadCase, 1500);
        es.close();
      }
    };
    es.onerror = () => { es.close(); };
    return () => es.close();
  }, [caseData?.status, id]);

  // ── File upload ───────────────────────────────────────────────────────────
  const handleUpload = async (file: File) => {
    if (!file.type.includes('pdf')) { addError('Only PDF files are accepted.'); return; }
    if (file.size > 2 * 1024 * 1024 * 1024) { addError('File exceeds the 2 GB limit.'); return; }

    setUploading(true);
    setLogs([]);
    setLogDrawerOpen(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/cases/${id}/upload`, { method: 'POST', body: formData });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Upload failed'); }

      // Update local case status immediately so SSE sub kicks in
      setCaseData((prev: any) => prev ? { ...prev, status: 'processing' } : prev);
    } catch (e: any) {
      addError(`Upload failed: ${e.message}`);
      setUploading(false);
    } finally {
      setUploading(false);
    }
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
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
    } catch (e: any) { addError(`Cannot open PDF: ${e.message}`); }
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

      {/* Page header */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex items-center gap-4">
        <button onClick={() => navigate('/cases')} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
            {caseData.patientName}
          </h1>
          <p className="text-xs text-slate-500">Date of Injury: {caseData.dateOfInjury} · <StatusBadge status={caseData.status} /></p>
        </div>
        {caseData.files?.length > 0 && (
          <span className="text-xs text-slate-400">{caseData.files.length} file{caseData.files.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Main content ── */}
        <div className="flex-1 flex flex-col overflow-auto">

          {/* ── Upload zone (always shown; extra prominent when no files) ── */}
          {!hasResults && !isProcessing && (
            <div className="p-6">
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all',
                  dragging
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30'
                    : 'border-slate-300 dark:border-slate-600 hover:border-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                )}
              >
                <UploadCloud className={cn('w-12 h-12 mx-auto mb-4', dragging ? 'text-indigo-500' : 'text-slate-400')} />
                <p className="text-base font-medium text-slate-700 dark:text-slate-300 mb-1">Drop PDF here or click to upload</p>
                <p className="text-sm text-slate-500">PDF files up to 2 GB · OCR + AI analysis will begin automatically</p>
                <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={onFilePick} />
              </div>

              {hasError && (
                <div className="mt-4 p-4 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-xl flex items-start gap-3">
                  <AlertCircle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-rose-800 dark:text-rose-300">Processing failed</p>
                    <p className="text-xs text-rose-600 dark:text-rose-400 mt-0.5">{caseData.errorMessage}</p>
                    <p className="text-xs text-rose-500 mt-1">Upload the file again to retry.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Processing view ── */}
          {isProcessing && (
            <div className="p-6 flex flex-col items-center justify-center min-h-[200px] gap-4">
              <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
              <div className="text-center">
                <p className="text-base font-semibold text-slate-900 dark:text-slate-100">Processing records…</p>
                <p className="text-sm text-slate-500 mt-1">This may take several minutes for large files. Watch the log below.</p>
              </div>
            </div>
          )}

          {/* ── Results: re-upload button when complete ── */}
          {hasResults && (
            <div className="px-6 pt-4 flex justify-end">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-700"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Upload new file
              </button>
              <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={onFilePick} />
            </div>
          )}

          {/* ── Table 1: Medical Chronology ── */}
          {table1Rows.length > 0 && (
            <section className="px-6 pt-6 pb-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Table 1: Medical Chronology <span className="text-slate-400 font-normal">({caseData.table1.length} records)</span>
                </h2>
                <button onClick={() => downloadXlsx('table1')} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 transition-colors">
                  <Download className="w-3.5 h-3.5" /> Download .xlsx
                </button>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-auto shadow-sm">
                <table className="w-full text-sm text-left min-w-[900px]">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      {t1Keys.map(key => (
                        <SortableFilterableHeader
                          key={key} label={key} columnKey={key}
                          sortConfig={t1Sort} onSort={k => handleSort(k, setT1Sort)}
                          filterValue={t1Filters[key] || ''}
                          onFilter={(k, v) => setT1Filters(prev => ({ ...prev, [k]: v }))}
                          uniqueValues={getUnique(caseData.table1, key)}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {table1Rows.map((row: any, idx: number) => (
                      <tr key={idx} className={cn('hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors', idx % 2 === 1 && 'bg-slate-50/50 dark:bg-slate-900/30')}>
                        {t1Keys.map(key => (
                          <td key={key} className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[240px]">
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
            </section>
          )}

          {/* ── Table 2: Patient Conditions ── */}
          {table2Rows.length > 0 && (
            <section className="px-6 pt-4 pb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Table 2: Patient Conditions <span className="text-slate-400 font-normal">({caseData.table2.length} conditions)</span>
                </h2>
                <button onClick={() => downloadXlsx('table2')} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 transition-colors">
                  <Download className="w-3.5 h-3.5" /> Download .xlsx
                </button>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-auto shadow-sm">
                <table className="w-full text-sm text-left min-w-[900px]">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      {t2Keys.map(key => (
                        <SortableFilterableHeader
                          key={key} label={key} columnKey={key}
                          sortConfig={t2Sort} onSort={k => handleSort(k, setT2Sort)}
                          filterValue={t2Filters[key] || ''}
                          onFilter={(k, v) => setT2Filters(prev => ({ ...prev, [k]: v }))}
                          uniqueValues={getUnique(caseData.table2, key)}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {table2Rows.map((row: any, idx: number) => (
                      <tr key={idx} className={cn('hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 transition-colors', idx % 2 === 1 && 'bg-slate-50/50 dark:bg-slate-900/30')}>
                        {t2Keys.map(key => (
                          <td key={key} className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-[240px]">
                            <div className="text-xs whitespace-pre-wrap break-words">{row[key] || '—'}</div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
    </div>
  );
}
