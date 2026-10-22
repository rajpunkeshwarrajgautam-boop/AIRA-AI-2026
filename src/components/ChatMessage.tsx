import React, { useRef, useState, useMemo } from 'react';
import {
  Check,
  Copy,
  FileText,
  RotateCw,
  ClipboardPaste,
  Wrench,
  Calendar,
  Play,
  CheckCircle2,
  ExternalLink,
  Image as ImageIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Message, Artifact } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';
import { AiraMark } from './AiraMark';
import { renderMarkdownToHtml } from '../utils/markdown';
import { copyMessageAsRichText } from '../utils/richClipboard';
import { ThinkingBlock } from './ThinkingBlock';
import { ArtifactCard } from './ArtifactCard';
import { extractArtifactsFromText } from '../utils/artifactParser';

interface ChatMessageProps {
  message: Message;
  userName: string;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetry?: () => void;
  onSwitchToAgentAndReview?: (prompt: string) => void;
  onConfirmAutomation?: (proposal: any) => void;
  onAuthorizeVision?: (proposal: any) => void;
  onCancelVisionProposal?: (proposalId: string) => void;
  isConfirmingAutomation?: boolean;
  isAuthorizingVision?: boolean;
}

export interface ProvenanceBadgeInfo {
  providerLabel: string;
  modelLabel: string;
  statusSuffix: string;
  text: string;
  className: string;
  title: string;
  isVerified: boolean;
  executionStatus: string;
}

export function formatProvenanceBadge(provenance: NonNullable<Message['provenance']>): ProvenanceBadgeInfo {
  const providerLabel =
    provenance.provider === 'nvidia'
      ? 'NVIDIA'
      : provenance.provider === 'anthropic'
      ? 'Anthropic'
      : provenance.provider === 'openai'
      ? 'OpenAI'
      : provenance.provider === 'mock'
      ? 'Mock'
      : 'Aira';

  const modelLabel = provenance.executedModel.split('/').pop() || provenance.executedModel;
  const isVerified = Boolean(provenance.verified);
  const isFallback = Boolean(provenance.fallbackOccurred || provenance.executionStatus === 'FALLBACK');
  const isFailed = provenance.executionStatus === 'FAILED';

  let statusSuffix = '';
  if (isFailed) {
    statusSuffix = ' (Failed)';
  } else if (isFallback) {
    statusSuffix = isVerified ? ' (Fallback)' : ' (Fallback · Unconfirmed)';
  } else if (!isVerified) {
    statusSuffix = ' (Unconfirmed)';
  }

  const text = `${providerLabel} · ${modelLabel}${statusSuffix}`;

  const className = `rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
    isFailed
      ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/30'
      : !isVerified
      ? 'bg-amber-500/10 text-amber-700/90 dark:text-amber-400/90 border border-dashed border-amber-500/40 dark:border-amber-400/30'
      : 'bg-claude-surface2-light text-claude-muted-light dark:bg-claude-surface2-dark dark:text-claude-muted-dark'
  }`;

  const verificationDesc = isVerified ? 'Confirmed' : 'Unconfirmed (verified: false)';
  const fallbackDesc = provenance.fallbackOccurred && provenance.fallbackReason ? ` (Fallback: ${provenance.fallbackReason})` : '';
  const title = `Provider: ${provenance.provider.toUpperCase()} | Executed Model: ${provenance.executedModel} | Verification: ${verificationDesc}${fallbackDesc}`;

  return {
    providerLabel,
    modelLabel,
    statusSuffix,
    text,
    className,
    title,
    isVerified,
    executionStatus: provenance.executionStatus
  };
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  userName,
  onOpenArtifact,
  onRetry,
  onSwitchToAgentAndReview,
  onConfirmAutomation,
  onAuthorizeVision,
  onCancelVisionProposal,
  isConfirmingAutomation,
  isAuthorizingVision,
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

  const renderedArtifacts = useMemo(() => {
    if (message.artifacts && message.artifacts.length > 0) {
      return message.artifacts;
    }
    if (message.content && (message.content.includes('<antArtifact') || message.content.includes('<airaArtifact'))) {
      return extractArtifactsFromText(message.content).artifacts;
    }
    return [];
  }, [message.artifacts, message.content]);

  return (
    <motion.div
      layout
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 140, damping: 22, mass: 0.78 }}
      className={`group mx-auto w-full min-w-0 max-w-4xl px-3 sm:px-4 py-3 sm:py-5 md:px-6 ${isUser ? 'flex justify-end' : ''}`}
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
        <div className="flex w-full items-start gap-2 sm:gap-5">
          <div className="mt-1 hidden shrink-0 sm:block">
            <AiraMark size="sm" />
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold tracking-tight text-claude-text-light dark:text-claude-text-dark">
                Aira
              </span>
              {message.provenance ? (() => {
                const badge = formatProvenanceBadge(message.provenance);
                return (
                  <span
                    data-testid="model-provenance-badge"
                    data-verified={badge.isVerified ? 'true' : 'false'}
                    data-execution-status={badge.executionStatus}
                    className={badge.className}
                    title={badge.title}
                  >
                    {badge.text}
                  </span>
                );
              })() : message.modelUsed && (
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

            {renderedArtifacts.length > 0 && (
              <motion.div layout className="pt-3">
                {renderedArtifacts.map(artifact => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    onOpen={onOpenArtifact}
                  />
                ))}
              </motion.div>
            )}

            {message.builderHandoff && (
              <div className="mt-3 p-3.5 rounded-xl border border-aira-blue/30 bg-aira-blue/5 dark:bg-aira-blue/10 flex flex-col gap-2.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-aira-blue dark:text-blue-400">
                  <Wrench className="w-4 h-4" />
                  <span>Scaffold Application with Sandboxed Builder</span>
                </div>
                <p className="text-[11px] text-claude-muted-light dark:text-slate-300">
                  To create files, execute commands in an isolated sandbox, and generate live previews, switch to Agent Mode to review the task and grant permissions.
                </p>
                <button
                  type="button"
                  onClick={() => onSwitchToAgentAndReview?.(message.builderHandoff!.prompt)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-aira-blue hover:bg-aira-blue/90 text-white font-medium text-xs transition-colors shadow-sm self-start"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Switch to Agent & Review Task</span>
                </button>
              </div>
            )}

            {message.automationProposal && (
              <div className="mt-3 p-3.5 rounded-xl border border-aira-gold/40 bg-aira-gold/5 dark:bg-aira-gold/10 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
                    <Calendar className="w-4 h-4" />
                    <span>Pending Scheduled Automation</span>
                  </div>
                  <span className="text-[10px] font-mono text-aira-gold bg-aira-gold/10 px-1.5 py-0.5 rounded">Confirmation Required</span>
                </div>
                <div className="text-[11px] text-claude-muted-light dark:text-slate-300 space-y-1">
                  <p><strong>Task:</strong> {message.automationProposal.name}</p>
                  <p><strong>Schedule:</strong> {message.automationProposal.humanSchedule || message.automationProposal.cronExpression}</p>
                  {message.automationProposal.timezone && (
                    <p><strong>Timezone:</strong> {message.automationProposal.timezone}</p>
                  )}
                  <p className="text-[10px] font-mono text-claude-muted-light/80 dark:text-slate-400">
                    <strong>Cadence:</strong> {message.automationProposal.cronExpression}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isConfirmingAutomation}
                  onClick={() => onConfirmAutomation?.(message.automationProposal)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-aira-gold hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-xs transition-colors shadow-sm self-start"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{isConfirmingAutomation ? 'Scheduling...' : 'Confirm and Schedule Automation'}</span>
                </button>
              </div>
            )}

            {message.visionProposal && (
              <div className="mt-3 p-3.5 rounded-xl border border-aira-blue/40 bg-aira-blue/5 dark:bg-aira-blue/10 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-aira-blue">
                    <ImageIcon className="w-4 h-4" />
                    <span>Billable Vision Generation · Authorization Required</span>
                  </div>
                  <span className="text-[10px] font-mono text-aira-blue bg-aira-blue/10 px-1.5 py-0.5 rounded font-semibold">
                    {message.visionProposal.estimatedCredits} Credits
                  </span>
                </div>
                <div className="text-[11px] text-claude-muted-light dark:text-slate-300 space-y-1">
                  <p><strong>Prompt:</strong> &ldquo;{message.visionProposal.prompt}&rdquo;</p>
                  <p>
                    <strong>Tariff Disclosure:</strong> {message.visionProposal.estimatedCredits} Credits will be reserved upon authorization ({message.visionProposal.options?.quality === 'premium' ? 'Premium' : 'Standard Economy'}, {message.visionProposal.options?.aspectRatio || '1:1'}).
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={isAuthorizingVision}
                    onClick={() => onAuthorizeVision?.(message.visionProposal)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-aira-blue hover:bg-aira-blue/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-xs transition-colors shadow-sm"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{isAuthorizingVision ? 'Authorizing & Generating...' : 'Authorize & Generate Image'}</span>
                  </button>
                  {onCancelVisionProposal && (
                    <button
                      type="button"
                      disabled={isAuthorizingVision}
                      onClick={() => onCancelVisionProposal(message.visionProposal!.id)}
                      className="px-3 py-1.5 rounded-lg border border-claude-border-light dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 text-xs text-claude-muted-light dark:text-slate-400 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}

            {message.citations && message.citations.length > 0 && (
              <div className="mt-3 p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] space-y-2">
                <div className="text-[11px] font-semibold text-claude-muted-light dark:text-slate-400">
                  Verified Primary Sources ({message.citations.length}):
                </div>
                <div className="space-y-1.5">
                  {message.citations.map((cite, idx) => (
                    <div key={idx} className="text-[11px] flex items-start gap-1.5">
                      <span className="font-mono text-aira-blue text-[10px]">[{idx + 1}]</span>
                      <div className="min-w-0">
                        {cite.uri ? (
                          <a href={cite.uri} target="_blank" rel="noopener noreferrer" className="text-aira-blue hover:underline font-medium inline-flex items-center gap-1">
                            <span>{cite.sourceTitle || cite.uri}</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        ) : (
                          <span className="font-medium text-claude-text-light dark:text-white">{cite.sourceTitle}</span>
                        )}
                        {cite.snippet && (
                          <p className="text-[10px] text-claude-muted-light dark:text-slate-400 line-clamp-2 mt-0.5">{cite.snippet}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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
