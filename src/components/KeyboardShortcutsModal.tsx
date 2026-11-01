import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { motion } from 'framer-motion';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  items: ShortcutItem[];
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [isMac] = useState(() => 
    typeof navigator !== 'undefined' ? /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent) : false
  );
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const modKey = isMac ? '⌘' : 'Ctrl';

  const sections: ShortcutSection[] = [
    {
      title: 'Global Navigation',
      items: [
        { keys: [modKey, 'K'], description: 'Open global Command Palette & Search' },
        { keys: [modKey, 'N'], description: 'Create a new conversation with default model' },
        { keys: [modKey, 'Shift', 'S'], description: 'Toggle left sidebar collapse' },
        { keys: [modKey, ','], description: 'Open Application Settings' },
        { keys: ['?'], description: 'Show this keyboard shortcuts reference' },
      ]
    },
    {
      title: 'Chat & Composer',
      items: [
        { keys: ['Enter'], description: 'Send current message' },
        { keys: ['Shift', 'Enter'], description: 'Insert a new line without sending' },
        { keys: [modKey, '/'], description: 'Focus chat message composer' },
        { keys: ['Esc'], description: 'Stop streaming generation or cancel active execution' },
      ]
    },
    {
      title: 'Menus & Overlays',
      items: [
        { keys: ['Esc'], description: 'Close any active dialog, menu, or modal' },
        { keys: ['Tab'], description: 'Focus next interactive element' },
        { keys: ['Shift', 'Tab'], description: 'Focus previous interactive element' },
        { keys: ['↑', '↓'], description: 'Navigate items within menus and palettes' },
      ]
    }
  ];

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
    >
      <motion.div
        ref={modalRef}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-claude-surface-light dark:bg-[#1a1b1e] border border-claude-border-light dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center text-amber-500">
              <Keyboard className="w-5 h-5" />
            </div>
            <div>
              <h2 id="shortcuts-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                Keyboard Shortcuts Reference
              </h2>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Fast keyboard navigation adapted to your system ({isMac ? 'macOS' : 'Windows / Linux'})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
            aria-label="Close shortcuts"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-3">
                {section.title}
              </h3>
              <div className="space-y-2">
                {section.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/30 dark:bg-white/[0.01]"
                  >
                    <span className="text-xs font-medium text-claude-text-light dark:text-white">
                      {item.description}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0 ml-4">
                      {item.keys.map((k, kIdx) => (
                        <kbd
                          key={kIdx}
                          className="px-2 py-1 text-[11px] font-mono font-bold rounded-lg border border-claude-border-light dark:border-white/20 bg-claude-surface-light dark:bg-white/10 text-claude-text-light dark:text-white shadow-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02] flex items-center justify-between text-xs">
          <span className="text-claude-muted-light dark:text-claude-muted-dark">
            Keyboard accessibility conforms to WCAG 2.1 AA specifications.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-aira-blue hover:bg-aira-blue/90 text-white font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </motion.div>
    </div>
  );
};
