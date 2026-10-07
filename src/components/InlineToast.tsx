import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

interface InlineToastProps {
  message: string | null;
}

export const InlineToast: React.FC<InlineToastProps> = ({ message }) => {
  const reducedMotion = useReducedMotion();

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-4 z-[240] -translate-x-1/2"
      aria-live="polite"
      aria-atomic="true"
    >
      <AnimatePresence mode="wait">
        {message && (
          <motion.div
            key={message}
            role="status"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 420, damping: 32 }}
            className="flex items-center gap-2 rounded-full border border-claude-border-light bg-white/92 px-3.5 py-2 text-[12px] font-medium text-claude-text-light shadow-[0_12px_32px_-14px_rgba(45,40,30,0.38)] backdrop-blur-xl dark:border-claude-border-dark dark:bg-[#1d1c19]/92 dark:text-white dark:shadow-[0_14px_36px_-14px_rgba(0,0,0,0.75)]"
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <span>{message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
