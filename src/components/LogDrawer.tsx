import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
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

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info:    'text-slate-400',
  success: 'text-emerald-400',
  error:   'text-rose-400',
  warn:    'text-amber-400',
};

const LEVEL_PREFIX: Record<LogEntry['level'], string> = {
  info: '·', success: '✓', error: '✗', warn: '⚠',
};

export default function LogDrawer({ logs, isOpen, onToggle }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, isOpen]);

  const formatTime = (ts: string) => {
    try { return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { return ts; }
  };

  return (
    <div className="border-t border-slate-200 dark:border-slate-700 bg-slate-950">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5" />
          <span className="font-mono text-xs">Processing Log</span>
          {logs.length > 0 && (
            <span className="bg-slate-700 text-slate-300 text-[10px] px-1.5 py-0.5 rounded-full">{logs.length}</span>
          )}
        </div>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
      </button>

      {isOpen && (
        <div className="h-48 overflow-y-auto px-4 py-2 space-y-0.5">
          {logs.length === 0 ? (
            <p className="text-slate-500 text-xs font-mono py-2">Waiting for processing to start...</p>
          ) : (
            logs.map((entry, i) => (
              <div key={i} className="log-entry flex items-start gap-2 text-[11px] leading-relaxed">
                <span className="text-slate-600 shrink-0 tabular-nums">{formatTime(entry.timestamp)}</span>
                <span className={cn('shrink-0 w-3', LEVEL_COLOR[entry.level])}>{LEVEL_PREFIX[entry.level]}</span>
                <span className={cn(LEVEL_COLOR[entry.level])}>{entry.message}</span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
