import React, { useState, useRef, useEffect } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, Filter } from 'lucide-react';
import { cn } from '../lib/utils.js';

export type SortDirection = 'asc' | 'desc' | null;
export type SortConfig = { key: string; direction: SortDirection };
export type FilterConfig = Record<string, string>;

interface Props {
  label: string;
  columnKey: string;
  sortConfig: SortConfig;
  onSort: (key: string) => void;
  filterValue: string;
  onFilter: (key: string, value: string) => void;
  uniqueValues?: string[];
  className?: string;
  style?: React.CSSProperties;
  resizeHandle?: React.ReactNode;
}

export default function SortableFilterableHeader({
  label, columnKey, sortConfig, onSort,
  filterValue, onFilter, uniqueValues = [], className, style, resizeHandle,
}: Props) {
  const [showFilter, setShowFilter] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowFilter(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isSorted = sortConfig.key === columnKey;
  const isFiltered = filterValue !== '';

  return (
    <th className={cn('px-4 py-3 whitespace-nowrap relative border-r border-slate-100 dark:border-slate-800 last:border-r-0', className)} style={style}>
      <div className="flex items-center gap-1" ref={ref}>
        <button
          onClick={() => onSort(columnKey)}
          className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100 transition-colors text-left"
        >
          <span>{label}</span>
          {isSorted && sortConfig.direction === 'asc'  && <ArrowUp   className="w-3 h-3 shrink-0" />}
          {isSorted && sortConfig.direction === 'desc' && <ArrowDown  className="w-3 h-3 shrink-0" />}
          {!isSorted && <ArrowUpDown className="w-3 h-3 shrink-0 opacity-30" />}
        </button>
        <button
          onClick={() => setShowFilter(v => !v)}
          className={cn('p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors', isFiltered ? 'text-indigo-600' : 'text-slate-400')}
        >
          <Filter className="w-3 h-3" />
        </button>

        {showFilter && (
          <div className="absolute top-full left-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-40 min-w-[200px] p-2">
            <input
              type="text"
              value={filterValue}
              onChange={e => onFilter(columnKey, e.target.value)}
              placeholder={`Filter ${label}...`}
              className="w-full text-xs border border-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 rounded-lg px-2 py-1.5 mb-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              autoFocus
              onKeyDown={e => { if (e.key === 'Escape') setShowFilter(false); }}
            />
            {filterValue && (
              <button onClick={() => onFilter(columnKey, '')} className="text-[11px] text-indigo-600 hover:underline px-1 mb-1">
                Clear filter
              </button>
            )}
            {uniqueValues.length > 0 && (
              <div className="max-h-[150px] overflow-y-auto border-t border-slate-100 dark:border-slate-700 pt-1">
                {uniqueValues.slice(0, 30).map((v, i) => (
                  <button
                    key={i}
                    onClick={() => { onFilter(columnKey, v); setShowFilter(false); }}
                    className="block w-full text-left text-[11px] text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 px-2 py-1 rounded truncate"
                  >
                    {v || '(empty)'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {resizeHandle}
    </th>
  );
}

/** Apply sort + filter to a dataset */
export function applySortFilter<T extends Record<string, any>>(
  data: T[],
  sort: SortConfig,
  filters: FilterConfig,
): T[] {
  let result = [...data];
  Object.entries(filters).forEach(([key, value]) => {
    if (value) {
      const lv = value.toLowerCase();
      result = result.filter(row => String(row[key] ?? '').toLowerCase().includes(lv));
    }
  });
  if (sort.key && sort.direction) {
    result.sort((a, b) => {
      const av = String(a[sort.key] ?? '');
      const bv = String(b[sort.key] ?? '');
      const cmp = av.localeCompare(bv, undefined, { numeric: true });
      return sort.direction === 'asc' ? cmp : -cmp;
    });
  }
  return result;
}

export function handleSort(
  key: string,
  setSortConfig: React.Dispatch<React.SetStateAction<SortConfig>>,
) {
  setSortConfig(prev => {
    if (prev.key !== key) return { key, direction: 'asc' };
    if (prev.direction === 'asc') return { key, direction: 'desc' };
    return { key: '', direction: null };
  });
}
