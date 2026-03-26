import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  }
  catch { return iso; }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Parse a cell value for conditional formatting tokens.
 * Gemini prefixes cell text with `@@COLOR` (e.g. `@@red Some text`).
 * Returns the stripped text and Tailwind classes for bg + text color.
 */
const CELL_COLORS: Record<string, { light: string; dark: string }> = {
  red:     { light: 'bg-red-100 text-red-800',     dark: 'dark:bg-red-900/30 dark:text-red-200' },
  rose:    { light: 'bg-rose-100 text-rose-800',    dark: 'dark:bg-rose-900/30 dark:text-rose-200' },
  amber:   { light: 'bg-amber-100 text-amber-800',  dark: 'dark:bg-amber-900/30 dark:text-amber-200' },
  yellow:  { light: 'bg-yellow-100 text-yellow-800', dark: 'dark:bg-yellow-900/30 dark:text-yellow-200' },
  green:   { light: 'bg-green-100 text-green-800',   dark: 'dark:bg-green-900/30 dark:text-green-200' },
  emerald: { light: 'bg-emerald-100 text-emerald-800', dark: 'dark:bg-emerald-900/30 dark:text-emerald-200' },
  blue:    { light: 'bg-blue-100 text-blue-800',     dark: 'dark:bg-blue-900/30 dark:text-blue-200' },
  indigo:  { light: 'bg-indigo-100 text-indigo-800',  dark: 'dark:bg-indigo-900/30 dark:text-indigo-200' },
  purple:  { light: 'bg-purple-100 text-purple-800',  dark: 'dark:bg-purple-900/30 dark:text-purple-200' },
  slate:   { light: 'bg-slate-200 text-slate-600',    dark: 'dark:bg-slate-700/50 dark:text-slate-300' },
};

export function parseCellColor(raw: string): { text: string; colorClass: string } {
  if (!raw) return { text: '', colorClass: '' };
  const match = raw.match(/^@@(\w+)\s+/);
  if (!match) return { text: raw, colorClass: '' };
  const colorName = match[1].toLowerCase();
  const entry = CELL_COLORS[colorName];
  if (!entry) return { text: raw, colorClass: '' };
  return { text: raw.slice(match[0].length), colorClass: `${entry.light} ${entry.dark}` };
}
