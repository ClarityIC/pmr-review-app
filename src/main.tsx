import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import './index.css';
import ErrorToast, { useErrors } from './components/ErrorToast.js';
import CasesPage from './pages/CasesPage.js';
import CasePage from './pages/CasePage.js';
import AdminPage from './pages/AdminPage.js';

declare global {
  interface Window {
    google?: {
      accounts: { id: { initialize: (c: any) => void; renderButton: (el: HTMLElement, c: any) => void; prompt: () => void } };
    };
  }
}

export interface User { email: string; name: string; picture?: string | null; }

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

function AuthenticatedApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('darkMode') === 'true');
  const { errors, addError, removeError } = useErrors();
  const googleButtonRef = useRef<HTMLDivElement>(null);

  // Apply dark class to html element
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('darkMode', String(darkMode));
  }, [darkMode]);

  // Check session on mount; surface redirect errors
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) { addError(err); window.history.replaceState({}, '', window.location.pathname); }

    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  // Init Google Identity Services (redirect mode — no popups)
  useEffect(() => {
    if (!authChecked || user || !GOOGLE_CLIENT_ID) return;
    const init = () => {
      if (!window.google?.accounts?.id || !googleButtonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        ux_mode: 'redirect',
        login_uri: window.location.origin + '/api/auth/google-redirect',
      });
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 280,
      });
    };
    if (window.google?.accounts?.id) { init(); }
    else {
      const iv = setInterval(() => { if (window.google?.accounts?.id) { clearInterval(iv); init(); } }, 100);
      return () => clearInterval(iv);
    }
  }, [authChecked, user]);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
      </div>
    );
  }

  // Login screen
  if (GOOGLE_CLIENT_ID && !user) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6">
        <ErrorToast errors={errors} onRemove={removeError} />
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-10 text-center max-w-sm w-full"
        >
          <img src="/clarity-logo.png" alt="Clarity IC" className="h-14 object-contain mx-auto mb-6" />
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 mb-1">Prior Records Review</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-8">Sign in with your @clarityic.com account to continue.</p>
          <div ref={googleButtonRef} className="flex justify-center" />
        </motion.div>
      </div>
    );
  }

  const sharedProps = { user, onLogout: handleLogout, darkMode, onToggleDark: () => setDarkMode(v => !v) };

  return (
    <BrowserRouter>
      <ErrorToast errors={errors} onRemove={removeError} />
      <Routes>
        <Route path="/cases"     element={<CasesPage {...sharedProps} addError={addError} />} />
        <Route path="/cases/:id" element={<CasePage  {...sharedProps} addError={addError} />} />
        <Route path="/admin"     element={<AdminPage  {...sharedProps} addError={addError} />} />
        <Route path="*"          element={<Navigate to="/cases" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AuthenticatedApp /></React.StrictMode>
);
