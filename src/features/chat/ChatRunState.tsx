import { AlertTriangle, LoaderCircle, PauseCircle, Play, Wrench } from 'lucide-react';

export type ChatPhase = 'idle' | 'streaming' | 'tool-running' | 'agent-paused' | 'error' | 'quota-exceeded' | 'guest-limit';

interface ChatRunStateProps {
  phase: ChatPhase;
  detail?: string | null;
  onReviewRetry?: () => void;
  onOpenPlans?: () => void;
}

const COPY: Record<Exclude<ChatPhase, 'idle'>, string> = {
  streaming: 'AIRA is responding',
  'tool-running': 'AIRA is running a tool',
  'agent-paused': 'Agent waiting for approval',
  error: 'This response could not be completed',
  'quota-exceeded': 'Your current plan limit has been reached',
  'guest-limit': 'Sign in to continue',
};

export function ChatRunState({ phase, detail, onReviewRetry, onOpenPlans }: ChatRunStateProps) {
  if (phase === 'idle') return null;
  const gated = phase === 'quota-exceeded' || phase === 'guest-limit';
  const Icon = phase === 'streaming' ? LoaderCircle : phase === 'tool-running' ? Wrench : phase === 'agent-paused' ? PauseCircle : AlertTriangle;
  return (
    <div className="aira-v3-chat-phase" role="status" aria-live="polite" data-testid={`chat-phase-${phase}`}>
      <Icon size={16} aria-hidden="true" className={phase === 'streaming' ? 'aira-v3-spinner' : undefined} />
      <span><strong>{COPY[phase]}</strong>{detail && <small>{detail}</small>}</span>
      {gated && onOpenPlans && <button type="button" onClick={onOpenPlans}>View plans</button>}
      {phase === 'error' && onReviewRetry && <button type="button" onClick={onReviewRetry}><Play size={14} /> Review and retry</button>}
    </div>
  );
}

