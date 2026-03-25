import React, { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Moon, Sun, Settings, X, LogOut, ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils.js';

interface User { email: string; name: string; picture?: string | null; }

interface Props {
  user: User | null;
  onLogout: () => void;
  darkMode: boolean;
  onToggleDark: () => void;
}

export default function NavBar({ user, onLogout, darkMode, onToggleDark }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-5 py-3 flex items-center justify-between sticky top-0 z-30 shadow-sm">
      {/* Logo + Breadcrumb */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/cases')} className="hover:opacity-80 transition-opacity shrink-0">
          <img src={darkMode ? '/clarity-logo-dark.webp' : '/clarity-logo.png'} alt="Clarity IC" className="h-7 object-contain" />
        </button>
        <nav className="flex items-center gap-1.5 text-sm">
          {location.pathname === '/admin' ? (
            <>
              <button onClick={() => navigate('/cases')} className="text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">Prior Records Review</button>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-slate-800 dark:text-slate-100">Admin</span>
            </>
          ) : location.pathname.startsWith('/cases/') ? (
            <>
              <span className="text-slate-500 dark:text-slate-400 hidden sm:inline">Prior Records Review</span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400 hidden sm:inline" />
              <button onClick={() => navigate('/cases')} className="text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">Cases</button>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="font-semibold text-slate-800 dark:text-slate-100">Case Review</span>
            </>
          ) : (
            <>
              <span className="text-slate-500 dark:text-slate-400 hidden sm:inline">Prior Records Review</span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400 hidden sm:inline" />
              <span className="font-semibold text-slate-800 dark:text-slate-100">Cases</span>
            </>
          )}
        </nav>
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-2">
        {/* Dark mode toggle */}
        <button
          onClick={onToggleDark}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          aria-label="Toggle dark mode"
        >
          {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            {user?.picture
              ? <img src={user.picture} alt={user.name} className="w-7 h-7 rounded-full" referrerPolicy="no-referrer" />
              : <div className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-xs font-bold text-indigo-600 dark:text-indigo-300">{user?.name?.charAt(0) || '?'}</div>
            }
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          <AnimatePresence>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.96 }}
                  className="absolute right-0 mt-2 w-60 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-30 py-2 overflow-hidden"
                >
                  {user && (
                    <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 mb-1">
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{user.name}</div>
                      <div className="text-xs text-slate-500 truncate">{user.email}</div>
                    </div>
                  )}
                  <button
                    onClick={() => { setMenuOpen(false); navigate('/admin'); }}
                    className="w-full px-4 py-2.5 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-3 transition-colors"
                  >
                    <Settings className="w-4 h-4 text-slate-400" /> Admin Panel
                  </button>
                  {user && (
                    <button
                      onClick={() => { setMenuOpen(false); onLogout(); }}
                      className="w-full px-4 py-2.5 text-left text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 flex items-center gap-3 transition-colors"
                    >
                      <LogOut className="w-4 h-4" /> Sign Out
                    </button>
                  )}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
