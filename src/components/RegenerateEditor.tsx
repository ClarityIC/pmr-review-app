import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, ChevronDown, Clock, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import MarkdownEditor from './MarkdownEditor.js';

interface T1VersionInfo {
  version: number;
  generatedAt: string;
}

interface Props {
  caseId: string;
  table: 'table1' | 'table2';
  onClose: () => void;
  onSuccess: () => void;
  addError: (msg: string) => void;
  table1Versions?: T1VersionInfo[];
  table1ActiveVersion?: number; // index into versions array (displayed version)
}

type Phase = 'editing' | 'regenerating' | 'error';

interface HistoryEntry {
  prompt: string;
  usedAt: string;
  version: number;
}

export default function RegenerateEditor({ caseId, table, onClose, onSuccess, addError, table1Versions, table1ActiveVersion }: Props) {
  const [promptText, setPromptText] = useState('');
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('editing');
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const sseRef = useRef<EventSource | null>(null);
  // Table 1 version selector (only used when regenerating Table 2)
  const showT1Selector = table === 'table2' && table1Versions && table1Versions.length > 0;
  const [selectedT1VersionIdx, setSelectedT1VersionIdx] = useState(0); // default to latest (index 0)

  const tableLabel = table === 'table1' ? 'Table 1: Medical Chronology' : 'Table 2: Patient Conditions';

  // Load prompt on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/cases/${caseId}/prompts/${table}`);
        if (!res.ok) throw new Error('Failed to load prompt');
        const data = await res.json();
        setPromptText(data.prompt || '');
        setHistory(data.history || []);
      } catch (e: any) {
        addError("Couldn't load the prompt for regeneration.");
        onClose();
      } finally {
        setLoading(false);
      }
    })();
  }, [caseId, table]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => { sseRef.current?.close(); };
  }, []);

  const handleRegenerate = useCallback(async () => {
    if (!promptText.trim()) return;
    setPhase('regenerating');
    setStatusMessages([]);
    setErrorMessage('');

    // Trigger the regeneration FIRST so the server clears old logs before SSE connects
    try {
      const res = await fetch(`/api/cases/${caseId}/regenerate/${table}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptText.trim(),
          ...(showT1Selector && table1Versions ? { table1Version: table1Versions[selectedT1VersionIdx].version } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(data.error || 'Failed to start regeneration');
      }
    } catch (e: any) {
      setErrorMessage(e.message || 'Failed to start regeneration');
      setPhase('error');
      return;
    }

    // Subscribe to SSE AFTER the regeneration request returns (logs are now cleared)
    const es = new EventSource(`/api/cases/${caseId}/logs`);
    sseRef.current = es;
    const seenKeys = new Set<string>();
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        // Deduplicate replayed entries on reconnect
        const key = `${evt.timestamp}|${evt.message}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        setStatusMessages(prev => [...prev, evt.message]);

        // Detect completion or error
        if (evt.message?.includes('Regeneration complete')) {
          es.close();
          sseRef.current = null;
          setTimeout(() => onSuccess(), 1500);
        }
        if (evt.level === 'error' && evt.message?.includes('Regeneration failed')) {
          es.close();
          sseRef.current = null;
          const cleanMsg = evt.message.replace('Regeneration failed: ', '');
          setErrorMessage(cleanMsg);
          setPhase('error');
        }
      } catch {}
    };
  }, [caseId, table, promptText, onSuccess]);

  const loadHistoryEntry = (entry: HistoryEntry) => {
    setPromptText(entry.prompt);
    setHistoryOpen(false);
  };

  const formatDateTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && phase === 'editing') onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden mx-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Regenerate {tableLabel}
          </h2>
          {phase === 'editing' && (
            <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          {phase === 'editing' && (
            <>
              {loading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
                </div>
              ) : (
                <>
                  {/* History dropdown */}
                  {history.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => setHistoryOpen(v => !v)}
                        className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 transition-colors"
                      >
                        <Clock className="w-3.5 h-3.5" /> Prompt History ({history.length}) <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <AnimatePresence>
                        {historyOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="absolute top-full mt-1 left-0 w-96 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-20 overflow-hidden max-h-64 overflow-y-auto"
                          >
                            {history.map((h, i) => (
                              <button
                                key={i}
                                onClick={() => loadHistoryEntry(h)}
                                className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-100 dark:border-slate-700 last:border-0 transition-colors"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-slate-500">
                                    Version {h.version} — {formatDateTime(h.usedAt)}
                                  </span>
                                  {i === 0 && (
                                    <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded-full">
                                      Latest
                                    </span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* Table 1 version selector (only for Table 2 regen) */}
                  {showT1Selector && table1Versions && (
                    <div className="flex items-center gap-3">
                      <label className="text-sm font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        Table 1 Reference:
                      </label>
                      <select
                        value={selectedT1VersionIdx}
                        onChange={e => setSelectedT1VersionIdx(Number(e.target.value))}
                        className="flex-1 text-sm px-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        {table1Versions.map((v, i) => {
                          const tags: string[] = [];
                          if (i === 0) tags.push('Latest');
                          if (i === (table1ActiveVersion ?? 0)) tags.push('Displayed');
                          const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : '';
                          return (
                            <option key={v.version} value={i}>
                              Version {v.version} — {formatDateTime(v.generatedAt)}{suffix}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  {/* Prompt editor */}
                  <MarkdownEditor
                    value={promptText}
                    onChange={setPromptText}
                    rows={24}
                  />
                </>
              )}
            </>
          )}

          {/* Progress overlay */}
          {phase === 'regenerating' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-6">
              <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Regenerating {tableLabel}...
              </div>
              <div className="w-full max-w-md max-h-48 overflow-y-auto bg-slate-50 dark:bg-slate-800 rounded-lg p-3 font-mono text-xs text-slate-600 dark:text-slate-400 space-y-1">
                {statusMessages.length === 0 && (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" /> Waiting for status...
                  </div>
                )}
                {statusMessages.map((msg, i) => (
                  <div key={i}>{msg}</div>
                ))}
              </div>
            </div>
          )}

          {/* Error state */}
          {phase === 'error' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-6">
              <div className="w-full max-w-md bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-xl p-6 text-center space-y-4">
                <div className="text-rose-700 dark:text-rose-300 font-medium">
                  Regeneration Failed
                </div>
                <div className="text-sm text-rose-600 dark:text-rose-400">
                  {errorMessage}
                </div>
                <button
                  onClick={() => setPhase('editing')}
                  className="px-4 py-2 text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors shadow-sm"
                >
                  Ok
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer (only in editing phase) */}
        {phase === 'editing' && !loading && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-slate-200 dark:border-slate-700">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-slate-600 hover:border-rose-400 hover:text-rose-600 dark:hover:border-rose-500 dark:hover:text-rose-400 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleRegenerate}
              disabled={!promptText.trim()}
              className="px-4 py-2 text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl transition-colors shadow-sm disabled:opacity-50"
            >
              Regenerate Table
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
