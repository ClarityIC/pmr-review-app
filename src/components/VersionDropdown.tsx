import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils.js';

interface TableVersion {
  version: number;
  generatedAt: string;
  rows?: any[];
}

interface Props {
  caseId: string;
  table: 'table1' | 'table2';
  versions: TableVersion[];
  activeVersionIndex: number;
  onVersionChange: (version: number) => void;
}

function formatVersionDate(iso: string): string {
  const d = new Date(iso);
  const pt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = (type: string) => pt.find(v => v.type === type)?.value || '';
  return `${p('month')}-${p('day')}-${p('year')} ${p('hour')}:${p('minute')} PT`;
}

export default function VersionDropdown({ caseId, table, versions, activeVersionIndex, onVersionChange }: Props) {
  const [open, setOpen] = useState(false);
  const [activating, setActivating] = useState(false);

  if (!versions || versions.length <= 1) return null;

  const activeVersion = versions[activeVersionIndex] || versions[0];

  const handleSelect = async (v: TableVersion) => {
    setOpen(false);
    if (v.version === activeVersion.version) return;
    setActivating(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/table-version/${table}/${v.version}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Failed to activate version');
      onVersionChange(v.version);
    } catch (e) {
      console.error('[version/activate]', e);
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        disabled={activating}
        className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-2.5 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 transition-colors disabled:opacity-50"
      >
        Version {activeVersion.version} — {formatVersionDate(activeVersion.generatedAt)}{activeVersion.rows?.length != null ? ` (${activeVersion.rows.length} records)` : ''}
        <ChevronDown className="w-3 h-3" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            {/* Click-away overlay */}
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="absolute top-full mt-1 left-0 w-max min-w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-20 overflow-hidden max-h-64 overflow-y-auto"
            >
              {versions.map((v, i) => {
                const isCurrent = i === activeVersionIndex;
                return (
                  <button
                    key={v.version}
                    onClick={() => handleSelect(v)}
                    className={cn(
                      'w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-100 dark:border-slate-700 last:border-0 transition-colors text-xs',
                      isCurrent && 'bg-indigo-50/50 dark:bg-indigo-900/20',
                    )}
                  >
                    <span className={cn('whitespace-nowrap', isCurrent && 'font-bold text-slate-900 dark:text-slate-100')}>
                      Version {v.version} — {formatVersionDate(v.generatedAt)}{v.rows?.length != null ? ` (${v.rows.length} records)` : ''}
                      {isCurrent && <span className="ml-1.5 text-indigo-600 dark:text-indigo-400">(Viewing)</span>}
                    </span>
                  </button>
                );
              })}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
