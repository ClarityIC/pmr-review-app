import React, { useRef, useMemo } from 'react';
import { ChevronDown, ChevronUp, Activity, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '../lib/utils.js';

export interface LogEntry {
  level: 'info' | 'success' | 'error' | 'warn';
  message: string;
  timestamp: string;
}

interface Props {
  logs: LogEntry[];
  isOpen: boolean;
  onToggle: () => void;
}

const LEVEL_DOT: Record<LogEntry['level'], string> = {
  info:    'bg-slate-400',
  success: 'bg-emerald-500',
  error:   'bg-rose-500',
  warn:    'bg-amber-400',
};

const LEVEL_TEXT: Record<LogEntry['level'], string> = {
  info:    'text-slate-600 dark:text-slate-400',
  success: 'text-emerald-700 dark:text-emerald-400',
  error:   'text-rose-700 dark:text-rose-400',
  warn:    'text-amber-700 dark:text-amber-400',
};

export default function LogDrawer({ logs, isOpen, onToggle }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch { return ts; }
  };

  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  const scrollToBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current!.scrollHeight, behavior: 'smooth' });

  const successCount = useMemo(() => logs.filter(l => l.level === 'success').length, [logs]);
  const errorCount = useMemo(() => logs.filter(l => l.level === 'error').length, [logs]);

  return (
    <div className="border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-3 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Activity className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Processing Log</span>
          {isOpen && (
            <>
              <button
                onClick={e => { e.stopPropagation(); scrollToTop(); }}
                className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                title="Scroll to top"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={e => { e.stopPropagation(); scrollToBottom(); }}
                className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                title="Scroll to bottom"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {logs.length > 0 && (
            <span className="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs px-2 py-0.5 rounded-full">
              {logs.length}
            </span>
          )}
          {successCount > 0 && (
            <span className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs px-2 py-0.5 rounded-full">
              {successCount}
            </span>
          )}
          {errorCount > 0 && (
            <span className="bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 text-xs px-2 py-0.5 rounded-full">
              {errorCount}
            </span>
          )}
        </div>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
      </button>

      {isOpen && (
        <div ref={scrollRef} className="h-56 overflow-y-auto bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800">
          {logs.length === 0 ? (
            <p className="font-mono text-xs text-slate-500 px-5 py-4">No log entries yet.</p>
          ) : (
            <div className="font-mono">
              {logs.map((entry, i) => (
                <div key={i} className="flex items-start gap-2 px-5 py-1">
                  <span className="text-[10px] text-slate-500 shrink-0 tabular-nums mt-px">
                    {formatTime(entry.timestamp)}
                  </span>
                  <div className={cn('mt-1.5 w-1.5 h-1.5 rounded-full shrink-0', LEVEL_DOT[entry.level])} />
                  <span className={cn('flex-1 text-xs', LEVEL_TEXT[entry.level])}>
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
