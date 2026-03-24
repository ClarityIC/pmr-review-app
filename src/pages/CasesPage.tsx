import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Loader2, FileText, ArrowUpDown, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import NavBar from '../components/NavBar.js';
import StatusBadge from '../components/StatusBadge.js';
import { User } from '../main.js';
import { formatDate, cn } from '../lib/utils.js';

interface Props {
  user: User | null; onLogout: () => void;
  darkMode: boolean; onToggleDark: () => void;
  addError: (msg: string) => void;
}

interface CaseRecord {
  id: string; patientName: string; dateOfInjury: string;
  dateProcessed: string | null; createdAt: string;
  status: string; files: any[];
}

type SortCol = 'patientName' | 'dateOfInjury' | 'dateProcessed' | 'createdAt' | 'status';

export default function CasesPage({ user, onLogout, darkMode, onToggleDark, addError }: Props) {
  const navigate = useNavigate();
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortCol>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showNewCase, setShowNewCase] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDOI, setNewDOI] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ sortBy, sortDir, ...(search ? { search } : {}) });
      const res = await fetch(`/api/cases?${params}`);
      if (res.status === 401) { onLogout(); return; }
      const data = await res.json();
      setCases(data.cases || []);
    } catch (e) { console.error('[cases/load]', e); addError("Couldn't load your cases — please refresh the page."); }
    finally { setLoading(false); }
  }, [search, sortBy, sortDir]);

  useEffect(() => { load(); }, [load]);

  const handleSort = (col: SortCol) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (sortBy !== col) return <ArrowUpDown className="w-3 h-3 opacity-30" />;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />;
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newDOI.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientName: newName.trim(), dateOfInjury: newDOI.trim() }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); console.error('[cases/create]', d.error); throw new Error('failed'); }
      const data = await res.json();
      navigate(`/cases/${data.case.id}`);
    } catch (e: any) { addError("Couldn't create the case — please try again."); }
    finally { setCreating(false); }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (!window.confirm(`Delete the case for "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/cases/${id}`, { method: 'DELETE' });
    setCases(prev => prev.filter(c => c.id !== id));
  };

  const thBtn = (col: SortCol, label: string) => (
    <button onClick={() => handleSort(col)} className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100">
      {label} <SortIcon col={col} />
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <NavBar user={user} onLogout={onLogout} darkMode={darkMode} onToggleDark={onToggleDark} />

      <main className="flex-1 p-6 max-w-6xl mx-auto w-full">
        {/* Toolbar */}
        <div className="mb-6 flex items-center gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search cases by patient name..."
              className="w-full pl-9 pr-4 py-2.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 dark:text-slate-100 placeholder-slate-400"
            />
          </div>
          <span className="text-sm text-slate-500">{cases.length} case{cases.length !== 1 ? 's' : ''}</span>
          <button
            onClick={() => setShowNewCase(true)}
            className="ml-auto flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" /> New Case
          </button>
        </div>

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center py-24"><Loader2 className="w-7 h-7 text-indigo-500 animate-spin" /></div>
        ) : cases.length === 0 ? (
          <div className="text-center py-24">
            <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-slate-700 dark:text-slate-300 mb-1">
              {search ? 'No matching cases' : 'No cases yet'}
            </h3>
            <p className="text-sm text-slate-500 mb-6">
              {search ? 'Try a different search.' : 'Create your first case to get started.'}
            </p>
            {!search && (
              <button onClick={() => setShowNewCase(true)} className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">
                <Plus className="w-4 h-4" /> New Case
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-medium border-b border-slate-200 dark:border-slate-700 text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3">{thBtn('patientName', 'Patient Name')}</th>
                  <th className="px-5 py-3">{thBtn('dateOfInjury', 'Date of Injury')}</th>
                  <th className="px-5 py-3">{thBtn('dateProcessed', 'Processed')}</th>
                  <th className="px-5 py-3">{thBtn('status', 'Status')}</th>
                  <th className="px-5 py-3">Files</th>
                  <th className="px-5 py-3 w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {cases.map((c, idx) => (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/cases/${c.id}`)}
                    className={cn(
                      'cursor-pointer hover:bg-indigo-50/50 dark:hover:bg-indigo-900/10 transition-colors',
                      idx % 2 === 1 && 'bg-slate-50/50 dark:bg-slate-900/50'
                    )}
                  >
                    <td className="px-5 py-3.5 font-medium text-slate-900 dark:text-slate-100">{c.patientName}</td>
                    <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{c.dateOfInjury}</td>
                    <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{formatDate(c.dateProcessed)}</td>
                    <td className="px-5 py-3.5"><StatusBadge status={c.status} /></td>
                    <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{c.files?.length || 0}</td>
                    <td className="px-5 py-3.5">
                      <button
                        onClick={e => handleDelete(e, c.id, c.patientName)}
                        className="p-1.5 text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* New Case Modal */}
      <AnimatePresence>
        {showNewCase && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setShowNewCase(false)} />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="p-6 border-b border-slate-100 dark:border-slate-800">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">New Case</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Enter patient details to create a new review case.</p>
              </div>
              <form onSubmit={handleCreate} className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Patient Name</label>
                  <input type="text" required autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                    placeholder="e.g., John Smith"
                    className="w-full px-3 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 dark:text-slate-100" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Date of Injury</label>
                  <input type="date" required value={newDOI} onChange={e => setNewDOI(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 dark:text-slate-100" />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={() => setShowNewCase(false)}
                    className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={creating}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm disabled:opacity-50">
                    {creating && <Loader2 className="w-4 h-4 animate-spin" />} Create Case
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
