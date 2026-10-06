import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Edit3, MoreHorizontal, Trash2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

interface ConversationActionsDropdownProps {
  conversationId: string;
  isPinned?: boolean;
  onToggleStar: () => void;
  onRename: () => void;
  onDelete: () => void;
  visible?: boolean;
}

type MenuPosition = {
  top: number;
  left: number;
};

const MENU_WIDTH = 188;
const MENU_HEIGHT = 142;
const VIEWPORT_GUTTER = 8;

export const ConversationActionsDropdown: React.FC<ConversationActionsDropdownProps> = ({
  conversationId,
  isPinned,
  onToggleStar,
  onRename,
  onDelete,
  visible = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const menuId = useId();

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;

    const rect = trigger.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER,
      Math.max(VIEWPORT_GUTTER, rect.right - MENU_WIDTH)
    );

    const hasRoomBelow = rect.bottom + MENU_HEIGHT + VIEWPORT_GUTTER <= window.innerHeight;
    const top = hasRoomBelow
      ? rect.bottom + 6
      : Math.max(VIEWPORT_GUTTER, rect.top - MENU_HEIGHT - 6);

    setPosition({ top, left });
  };

  const closeMenu = () => {
    setIsOpen(false);
    setActiveAction(null);
  };

  const toggleMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isOpen) updatePosition();
    setIsOpen(open => !open);
  };

  const runAction = (event: React.MouseEvent, action: () => void) => {
    event.stopPropagation();
    closeMenu();
    action();
  };

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
        triggerRef.current?.focus();
      }
    };

    const handleViewportChange = () => closeMenu();

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    document.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      document.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isOpen]);

  const items = [
    {
      id: 'bookmark',
      label: isPinned ? 'Remove bookmark' : 'Bookmark',
      icon: Bookmark,
      action: onToggleStar,
      destructive: false,
    },
    {
      id: 'rename',
      label: 'Rename',
      icon: Edit3,
      action: onRename,
      destructive: false,
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: Trash2,
      action: onDelete,
      destructive: true,
    },
  ] as const;

  const menu = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Conversation actions"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
          transition={reducedMotion ? { duration: 0.12 } : { type: 'spring', stiffness: 340, damping: 27, mass: 0.72 }}
          style={{ position: 'fixed', top: position.top, left: position.left, width: MENU_WIDTH }}
          className="z-[120] rounded-[14px] border border-claude-border-light dark:border-claude-border-dark bg-white/95 dark:bg-[#1d1c19]/95 p-1.5 shadow-[0_14px_38px_-12px_rgba(29,27,24,0.35)] dark:shadow-[0_18px_42px_-14px_rgba(0,0,0,0.68)] backdrop-blur-xl"
          onClick={event => event.stopPropagation()}
        >
          {items.map(({ id, label, icon: Icon, action, destructive }) => (
            <motion.button
              key={id}
              type="button"
              role="menuitem"
              onHoverStart={() => setActiveAction(id)}
              onHoverEnd={() => setActiveAction(current => current === id ? null : current)}
              onFocus={() => setActiveAction(id)}
              onBlur={() => setActiveAction(current => current === id ? null : current)}
              onClick={event => runAction(event, action)}
              whileTap={reducedMotion ? undefined : { scale: 0.985 }}
              className={`relative isolate flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[12px] font-medium outline-none transition-colors ${
                destructive
                  ? 'text-red-500 dark:text-red-400'
                  : 'text-claude-text-light dark:text-claude-text-dark'
              }`}
            >
              {activeAction === id && (
                <motion.span
                  layoutId={`conversation-action-highlight-${conversationId}`}
                  className={`absolute inset-0 -z-10 rounded-[10px] ${
                    destructive
                      ? 'bg-red-50 dark:bg-red-500/10'
                      : 'bg-claude-surface2-light dark:bg-claude-surface2-dark'
                  }`}
                  transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 32 }}
                />
              )}
              <Icon
                className={`h-3.5 w-3.5 shrink-0 ${
                  id === 'bookmark' && isPinned ? 'fill-claude-terracotta text-claude-terracotta' : ''
                }`}
              />
              <span className="flex-1">{label}</span>
            </motion.button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className={`ml-2 flex shrink-0 items-center transition-opacity ${visible || isOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
      <motion.button
        ref={triggerRef}
        type="button"
        aria-label="Open conversation actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={toggleMenu}
        whileTap={reducedMotion ? undefined : { scale: 0.9 }}
        className={`rounded-lg p-1.5 outline-none transition-colors ${
          isOpen
            ? 'bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-text-light dark:text-white'
            : 'hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark'
        }`}
        title="Conversation actions"
      >
        <motion.span
          className="block"
          animate={reducedMotion ? undefined : { rotate: isOpen ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 360, damping: 24 }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </motion.span>
      </motion.button>
      {typeof document !== 'undefined' ? createPortal(menu, document.body) : null}
    </div>
  );
};