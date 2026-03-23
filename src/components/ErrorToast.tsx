import React from 'react';
import { X, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export interface ToastError {
  id: string;
  message: string;
}

interface Props {
  errors: ToastError[];
  onRemove: (id: string) => void;
}

export default function ErrorToast({ errors, onRemove }: Props) {
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 max-w-md w-full pointer-events-none">
      <AnimatePresence>
        {errors.map(err => (
          <motion.div
            key={err.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="pointer-events-auto bg-rose-50 border border-rose-200 text-rose-800 dark:bg-rose-950 dark:border-rose-800 dark:text-rose-200 p-4 rounded-xl shadow-xl flex items-start gap-3"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-rose-500" />
            <div className="flex-1 text-sm font-medium">{err.message}</div>
            <button
              onClick={() => onRemove(err.id)}
              className="text-rose-400 hover:text-rose-600 p-0.5 rounded transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Hook to manage toast errors with auto-dismiss */
export function useErrors() {
  const [errors, setErrors] = React.useState<ToastError[]>([]);

  const addError = React.useCallback((message: string) => {
    const id = Math.random().toString(36).slice(2, 9);
    setErrors(prev => [...prev, { id, message }]);
    setTimeout(() => setErrors(prev => prev.filter(e => e.id !== id)), 10_000);
  }, []);

  const removeError = React.useCallback((id: string) => {
    setErrors(prev => prev.filter(e => e.id !== id));
  }, []);

  return { errors, addError, removeError };
}
