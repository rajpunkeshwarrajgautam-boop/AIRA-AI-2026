import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Library,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  SlidersHorizontal,
  Telescope,
  Workflow,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Attachment, ModelId, WorkspaceMode } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';

interface ChatInputProps {
  onSendMessage: (text: string, attachments: Attachment[]) => void;
  isLoading: boolean;
  onStop?: () => void;
  currentModel: ModelId;
  extendedThinking: boolean;
  workspaceMode: WorkspaceMode;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
}

const MODE_OPTIONS: Array<{
  id: WorkspaceMode;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'chat', label: 'Chat', hint: 'General reasoning and creation', icon: MessageSquareText },
  { id: 'research', label: 'Research', hint: 'Investigate and synthesize evidence', icon: Telescope },
  { id: 'agents', label: 'Agents', hint: 'Plan autonomous multi-step missions', icon: Bot },
  { id: 'library', label: 'Library', hint: 'Work from workspace knowledge', icon: Library },
  { id: 'automations', label: 'Automations', hint: 'Design trigger-action workflows', icon: Workflow },
];

const STYLE_OPTIONS = [
  { id: 'Normal', hint: 'Balanced detail and structure' },
  { id: 'Concise', hint: 'Direct and compact' },
  { id: 'Explanatory', hint: 'Detailed step-by-step explanation' },
] as const;

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  isLoading,
  currentModel,
  extendedThinking,
  workspaceMode,
  onWorkspaceModeChange,
}) => {
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [styleMode, setStyleMode] = useState<(typeof STYLE_OPTIONS)[number]['id']>('Normal');
  const [showStyleMenu, setShowStyleMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const modeInfo = MODE_OPTIONS.find(mode => mode.id === workspaceMode) || MODE_OPTIONS[0];
  const ModeIcon = modeInfo.icon;
  const modelInfo = AVAILABLE_MODELS.find(model => model.id === currentModel) || AVAILABLE_MODELS[0];

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [inputText]);

  useEffect(() => {
    if (!showModeMenu && !showStyleMenu) return;
    const handlePointer = (event: PointerEvent) => {
      if (controlsRef.current?.contains(event.target as Node)) return;
      setShowModeMenu(false);
      setShowStyleMenu(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowModeMenu(false);
        setShowStyleMenu(false);
      }
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showModeMenu, showStyleMenu]);

  const placeholderMap: Record<WorkspaceMode, string> = {
    chat: 'How can Aira help you today?',
    research: 'What would you like Aira to research?',
    agents: 'Describe the outcome you want an agent to deliver...',
    automations: 'Describe the trigger and action to automate...',
    library: 'Ask Aira about your workspace knowledge...',
  };

  const placeholder = placeholderMap[workspaceMode] || placeholderMap.chat;
  const canSubmit = Boolean(inputText.trim() || attachments.length > 0) && !isLoading;

  const contextualHint = useMemo(() => {
    if (attachments.length > 0) return `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} ready for analysis`;
    if (extendedThinking) return 'Deep reasoning is active for complex work';
    return modeInfo.hint;
  }, [attachments.length, extendedThinking, modeInfo.hint]);

  const handleSubmit = () => {
    const trimmed = inputText.trim();
    if ((!trimmed && attachments.length === 0) || isLoading) return;
    let finalPrompt = trimmed;
    if (styleMode === 'Concise') finalPrompt = `[Style: Please respond concisely and directly] ${trimmed}`;
    if (styleMode === 'Explanatory') finalPrompt = `[Style: Please explain in detail with a structured breakdown] ${trimmed}`;
    onSendMessage(finalPrompt, attachments);
    setInputText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = loadEvent => {
        const content = loadEvent.target?.result as string;
        setAttachments(previous => [...previous, {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          size: `${(file.size / 1024).toFixed(1)} KB`,
          type: file.type || 'text/plain',
          content,
        }]);
      };
      if (file.type.startsWith('image/')) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-4 pb-3 sm:pb-6" ref={controlsRef}>
      <motion.div
        layout
        className="overflow-visible rounded-[20px] border border-claude-border-light bg-claude-surface-light shadow-[0_8px_30px_-12px_rgba(45,40,30,0.16)] transition-colors focus-within:border-claude-terracotta/35 dark:border-claude-border-dark dark:bg-claude-surface-dark dark:shadow-[0_12px_36px_-14px_rgba(0,0,0,0.65)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-claude-border-light/70 px-3 py-1.5 sm:px-3.5 sm:py-2 dark:border-claude-border-dark/70">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] bg-claude-terracotta/10 text-claude-accentInk">
              <ModeIcon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold text-claude-text-light dark:text-white">{modeInfo.label}</span>
              <span className="hidden sm:block truncate text-[10px] text-claude-muted-light dark:text-claude-muted-dark">{contextualHint}</span>
            </span>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 text-[10px] text-claude-muted-light sm:flex dark:text-claude-muted-dark">
            <span className="rounded-md bg-claude-surface2-light px-2 py-1 font-medium dark:bg-claude-surface2-dark">{modelInfo.name}</span>
            {extendedThinking && modelInfo.supportsThinking && (
              <span className="flex items-center gap-1 rounded-md bg-claude-terracotta/10 px-2 py-1 font-medium text-claude-accentInk">
                <Brain className="h-3 w-3" />
                Deep
              </span>
            )}
          </div>
        </div>

        <AnimatePresence initial={false}>
          {attachments.length > 0 && (
            <motion.div
              initial={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap gap-2 px-3.5 pt-3">
                {attachments.map(attachment => (
                  <motion.div
                    layout
                    key={attachment.id}
                    className="group flex max-w-full items-center gap-2 rounded-[10px] border border-claude-border-light bg-claude-surface2-light px-2.5 py-1.5 text-xs text-claude-text-light dark:border-claude-border-dark dark:bg-claude-surface2-dark dark:text-claude-text-dark"
                  >
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-claude-accentInk" />
                    <span className="max-w-[180px] truncate font-medium">{attachment.name}</span>
                    <span className="hidden font-mono text-[9px] text-claude-muted-light sm:inline dark:text-claude-muted-dark">{attachment.size}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() => setAttachments(previous => previous.filter(item => item.id !== attachment.id))}
                      className="rounded-md p-0.5 text-claude-muted-light transition-colors hover:bg-red-50 hover:text-red-500 dark:text-claude-muted-dark dark:hover:bg-red-500/10"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={event => setInputText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          className="max-h-[38vh] w-full resize-none bg-transparent px-3 pb-1 pt-2 sm:px-4 sm:pb-2 sm:pt-3.5 text-base leading-relaxed text-claude-text-light outline-none selection:bg-claude-terracotta/20 placeholder:text-claude-muted-light/55 dark:text-claude-text-dark dark:placeholder:text-claude-muted-dark/55"
        />

        <div className="flex min-w-0 items-center justify-between gap-1.5 px-2.5 sm:px-3 pb-1.5 sm:pb-3 pt-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <input ref={fileInputRef} type="file" multiple onChange={handleFileUpload} className="hidden" />
            <motion.button
              type="button"
              whileTap={reducedMotion ? undefined : { scale: 0.92 }}
              onClick={() => fileInputRef.current?.click()}
              title="Add documents or images"
              className="min-h-10 min-w-10 sm:min-h-0 sm:min-w-0 rounded-[9px] p-2 text-claude-muted-light transition-colors hover:bg-claude-surface2-light hover:text-claude-text-light dark:text-claude-muted-dark dark:hover:bg-claude-surface2-dark dark:hover:text-white"
            >
              <Paperclip className="h-4 w-4" />
            </motion.button>

            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowModeMenu(open => !open);
                  setShowStyleMenu(false);
                }}
                className={`flex items-center min-h-10 sm:min-h-0 gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                  showModeMenu || workspaceMode !== 'chat'
                    ? 'bg-claude-terracotta/10 text-claude-accentInk'
                    : 'text-claude-muted-light hover:bg-claude-surface2-light dark:text-claude-muted-dark dark:hover:bg-claude-surface2-dark'
                }`}
              >
                <ModeIcon className="h-3.5 w-3.5" />
                <span>{modeInfo.label}</span>
                <ChevronDown className="h-3 w-3" />
              </button>

              <AnimatePresence>
                {showModeMenu && (
                  <motion.div
                    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
                    transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 390, damping: 31 }}
                    className="absolute bottom-10 left-0 z-50 w-[min(260px,calc(100vw-96px))] rounded-[16px] border border-claude-border-light bg-white/95 p-1.5 shadow-[0_16px_44px_-18px_rgba(45,40,30,0.45)] backdrop-blur-xl dark:border-claude-border-dark dark:bg-[#1d1c19]/95"
                  >
                    {MODE_OPTIONS.map(mode => {
                      const Icon = mode.icon;
                      const selected = mode.id === workspaceMode;
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => {
                            onWorkspaceModeChange(mode.id);
                            setShowModeMenu(false);
                          }}
                          className="relative isolate flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left outline-none"
                        >
                          {selected && (
                            <motion.span
                              layoutId="composer-mode-active"
                              className="absolute inset-0 -z-10 rounded-[11px] bg-claude-surface2-light dark:bg-claude-surface2-dark"
                              transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 430, damping: 34 }}
                            />
                          )}
                          <span className={`flex h-7 w-7 items-center justify-center rounded-[9px] ${
                            selected ? 'bg-claude-terracotta/10 text-claude-accentInk' : 'text-claude-muted-light dark:text-claude-muted-dark'
                          }`}>
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[11px] font-semibold text-claude-text-light dark:text-white">{mode.label}</span>
                            <span className="block truncate text-[9px] text-claude-muted-light dark:text-claude-muted-dark">{mode.hint}</span>
                          </span>
                          {selected && <Check className="h-3.5 w-3.5 text-claude-accentInk" />}
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="relative hidden sm:block">
              <button
                type="button"
                onClick={() => {
                  setShowStyleMenu(open => !open);
                  setShowModeMenu(false);
                }}
                className="flex items-center min-h-10 sm:min-h-0 gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[11px] font-medium text-claude-muted-light transition-colors hover:bg-claude-surface2-light dark:text-claude-muted-dark dark:hover:bg-claude-surface2-dark"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>{styleMode}</span>
                <ChevronDown className="h-3 w-3" />
              </button>

              <AnimatePresence>
                {showStyleMenu && (
                  <motion.div
                    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
                    className="absolute bottom-10 left-0 z-50 w-[220px] rounded-[16px] border border-claude-border-light bg-white/95 p-1.5 shadow-[0_16px_44px_-18px_rgba(45,40,30,0.45)] backdrop-blur-xl dark:border-claude-border-dark dark:bg-[#1d1c19]/95"
                  >
                    {STYLE_OPTIONS.map(style => {
                      const selected = style.id === styleMode;
                      return (
                        <button
                          key={style.id}
                          type="button"
                          onClick={() => {
                            setStyleMode(style.id);
                            setShowStyleMenu(false);
                          }}
                          className="flex w-full items-center justify-between gap-3 rounded-[11px] px-3 py-2 text-left hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark"
                        >
                          <span>
                            <span className="block text-[11px] font-semibold text-claude-text-light dark:text-white">{style.id}</span>
                            <span className="block text-[9px] text-claude-muted-light dark:text-claude-muted-dark">{style.hint}</span>
                          </span>
                          {selected && <Check className="h-3.5 w-3.5 text-claude-accentInk" />}
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <motion.button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            whileTap={canSubmit && !reducedMotion ? { scale: 0.9 } : undefined}
            title={isLoading ? 'Aira is responding' : 'Send message (Enter)'}
            className={`flex h-10 w-10 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
              canSubmit
                ? 'gradient-terracotta-btn text-claude-onAccent shadow-sm'
                : 'bg-claude-surface2-light text-claude-muted-light/40 dark:bg-claude-surface2-dark dark:text-claude-muted-dark/40'
            }`}
          >
            {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4 stroke-[2.2]" />}
          </motion.button>
        </div>
      </motion.div>

      <div className="mt-1 sm:mt-3 text-center text-[10px] sm:text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
        Aira can make mistakes. Verify important information.
      </div>
    </div>
  );
};
