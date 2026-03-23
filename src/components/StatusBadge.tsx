import { cn } from '../lib/utils.js';

type Status = 'draft' | 'processing' | 'complete' | 'error';

const STYLES: Record<Status, string> = {
  draft:      'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  processing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  complete:   'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  error:      'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400',
};

export default function StatusBadge({ status }: { status: string }) {
  const s = (status as Status) in STYLES ? (status as Status) : 'draft';
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium', STYLES[s])}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}
