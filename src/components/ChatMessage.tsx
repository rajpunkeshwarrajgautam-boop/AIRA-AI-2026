import React, { useRef, useState } from 'react';
import {
  Check,
  Copy,
  FileText,
  RotateCw,
  ClipboardPaste,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Message, Artifact } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';
import { AiraMark } from './AiraMark';
import { renderMarkdownToHtml } from '../utils/markdown';
import { copyMessageAsRichText } from '../utils/richClipboard';
import { ThinkingBlock } from './ThinkingBlock';
import { ArtifactCard } from './ArtifactCard';

interface ChatMessageProps {
  message: Message;
  userName: string;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetry?: () => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  userName,
  onOpenArtifact,
  onRetry,
}) => {
  const [copied, setCopied] = useState(false);
  const [richCopyStatus, setRichCopyStatus] = useState<'rich' | 'fallback' | 'failed' | null>(null);
  const assistantContentRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const isUser = message.role === 'user';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const handleRichCopy = async () => {
    if (!assistantContentRef.current) return;
    try {
      const result = await copyMessageAsRichText(message.content, assistantContentRef.current);
      setRichCopyStatus(result === 'rich' ? 'rich' : 'fallback');
    } catch {
      setRichCopyStatus('failed');
    }
    window.setTimeout(() => setRichCopyStatus(null), 2600);
  };

  return (
    <motion.div
      layout
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 140, damping: 22, mass: 0.78 }}
      className={`group mx-auto w-full min-w-0 max-w-4xl px-3 sm:px-4 py-4 sm:py-5 md:px-6 ${isUser ? 'flex justify-end' : ''}`}
    >
      {isUser ? (
        <div className="flex max-w-[85%] flex-col items-end">
          {userName && (
            <span className="mb-1.5 px-1 font-mono text-[11px] text-claude-muted-light/70 dark:text-claude-muted-dark/70">
              {userName}
            </span>
          )}
          <div className="w-fit rounded-2xl border border-claude-borderMuted-light bg-claude-surface2-light px-5 py-3 text-claude-text-light shadow-sm md:px-6 md:py-4 dark:border-claude-borderMuted-dark dark:bg-claude-surface2-dark dark:text-claude-text-dark">
            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 border-b border-claude-border-light pb-3 dark:border-claude-border-dark">
                {message.attachments.map(attachment => (
                  <div
                    key={attachment.id}
                    className="flex items-center gap-2 rounded-lg border border-claude-borderMuted-light bg-claude-surface-light px-3 py-1.5 text-xs shadow-sm dark:border-claude-borderMuted-dark dark:bg-claude-surface-dark"
                  >
                    <FileText className="h-3.5 w-3.5 text-claude-terracotta" />
                    <span className="max-w-[140px] truncate font-medium">{attachment.name}</span>
                  </div>
                ))}
              </div>
            )}
            <div
              className="aira-prose whitespace-pre-wrap break-words font-sans text-base leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
            />
          </div>
        </div>
      ) : (
        <div className="flex w-full items-start gap-5">
          <div className="mt-1 shrink-0">
            <AiraMark size="sm" />
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold tracking-tight text-claude-text-light dark:text-claude-text-dark">
                Aira
              </span>
              {message.modelUsed && (
                <span className="rounded-full bg-claude-surface2-light px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-claude-muted-light dark:bg-claude-surface2-dark dark:text-claude-muted-dark">
                  {AVAILABLE_MODELS.find(model => model.id === message.modelUsed)?.name}
                </span>
              )}
            </div>

            {message.thinking && <ThinkingBlock thinking={message.thinking} />}

            <motion.div layout>
              <div
                ref={assistantContentRef}
                className="aira-prose min-w-0 break-words font-sans text-base leading-[1.7] text-claude-text-light md:text-[17px] dark:text-claude-text-dark"
                dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
              />
              {message.isStreaming && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 0] }}
                  transition={{ duration: 1.35, repeat: Infinity, ease: 'linear' }}
                  className="ml-1.5 inline-block h-[18px] w-[5px] rounded-full bg-claude-terracotta align-middle"
                />
              )}
            </motion.div>

            {message.artifacts && message.artifacts.length > 0 && (
              <motion.div layout className="pt-3">
                {message.artifacts.map(artifact => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    onOpen={onOpenArtifact}
                  />
                ))}
              </motion.div>
            )}

            {!message.isStreaming && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: reducedMotion ? 0 : 0.18 }}
                className="flex min-h-8 items-center gap-1.5 pt-1 text-claude-muted-light opacity-100 sm:opacity-0 sm:transition-opacity sm:duration-200 sm:group-hover:opacity-100 dark:text-claude-muted-dark"
              >
                <motion.button
                  type="button"
                  onClick={handleCopy}
                  whileTap={reducedMotion ? undefined : { scale: 0.94 }}
                  className={`flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    copied
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'hover:bg-claude-surface2-light hover:text-claude-text-light dark:hover:bg-claude-surface2-dark dark:hover:text-white'
                  }`}
                  title="Copy message"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={copied ? 'copied' : 'copy'}
                      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 2 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -2 }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </motion.span>
                  </AnimatePresence>
                </motion.button>

                <motion.button
                  type="button"
                  onClick={handleRichCopy}
                  whileTap={reducedMotion ? undefined : { scale: 0.94 }}
                  className="flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-claude-surface2-light hover:text-claude-text-light dark:hover:bg-claude-surface2-dark dark:hover:text-white"
                  aria-label="Copy as Rich Text"
                  title="Copy formatted text, tables and math for compatible editors"
                >
                  {richCopyStatus === 'rich'
                    ? <Check className="h-3.5 w-3.5 text-emerald-600" />
                    : <ClipboardPaste className="h-3.5 w-3.5" />}
                  <span>{richCopyStatus === 'rich' ? 'Rich text copied'
                    : richCopyStatus === 'fallback' ? 'Markdown copied (rich text unavailable)'
                    : richCopyStatus === 'failed' ? 'Copy failed'
                    : 'Copy as Rich Text'}</span>
                </motion.button>
                <span className="sr-only" aria-live="polite">
                  {richCopyStatus === 'rich' ? 'Rich text copied to clipboard'
                    : richCopyStatus === 'fallback' ? 'Rich clipboard unavailable; Markdown copied instead'
                    : richCopyStatus === 'failed' ? 'Unable to copy message'
                    : ''}
                </span>

                {onRetry && (
                  <motion.button
                    type="button"
                    onClick={onRetry}
                    whileTap={reducedMotion ? undefined : { scale: 0.94 }}
                    className="flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-claude-surface2-light hover:text-claude-text-light dark:hover:bg-claude-surface2-dark dark:hover:text-white"
                    title="Retry response"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    Retry
                  </motion.button>
                )}
              </motion.div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
};
