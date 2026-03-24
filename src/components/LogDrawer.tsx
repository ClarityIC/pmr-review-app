import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Activity } from 'lucide-react';
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
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, isOpen]);

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    } catch { return ts; }
  };

  return (
    <div className="border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-3 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Activity className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Processing Progress</span>
          {logs.length > 0 && (
            <span className="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs px-2 py-0.5 rounded-full">
              {logs.length}
            </span>
          )}
        </div>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
      </button>

      {isOpen && (
        <div className="h-56 overflow-y-auto bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800">
          {logs.length === 0 ? (
            <p className="text-sm text-slate-400 px-5 py-4">Waiting for processing to start…</p>
          ) : (
            <div className="divide-y divide-slate-50 dark:divide-slate-800/50">
              {logs.map((entry, i) => (
                <div key={i} className="flex items-start gap-3 px-5 py-2.5">
                  <div className={cn('mt-1.5 w-2 h-2 rounded-full shrink-0', LEVEL_DOT[entry.level])} />
                  <span className={cn('flex-1 text-sm leading-relaxed', LEVEL_TEXT[entry.level])}>
                    {entry.message}
                  </span>
                  <span className="text-xs text-slate-400 shrink-0 tabular-nums mt-0.5">
                    {formatTime(entry.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
