import type { PlanTier } from '../types/commercial-types';

export interface BillingSummary {
  principalId: string;
  planId: PlanTier;
  planName: string;
  subscriptionStatus: string;
  currentPeriodEnd?: string;
  availableCredits: number;
  lifetimeGranted: number;
  lifetimeSpent: number;
  dailyChatsUsed: number;
  dailyChatLimit: number;
  monthlyUnitsUsed: number;
  monthlyUnitLimit: number;
  reasoningBoostsUsed: number;
  reasoningBoostLimit: number;
}

export type ServerSessionState = 'verified' | 'anonymous' | 'mismatch';

/** A cached browser profile cannot verify a server-side session. */
export function classifyServerSession(payload: unknown, cachedPrincipalId: string | null): ServerSessionState {
  if (!payload || typeof payload !== 'object') return 'mismatch';
  const session = payload as { status?: unknown; user?: { id?: unknown } | null };
  if (session.status === 'ANONYMOUS' && !session.user) return 'anonymous';
  if (
    session.status === 'AUTHENTICATED' &&
    typeof session.user?.id === 'string' &&
    session.user.id.length > 0 &&
    session.user.id === cachedPrincipalId
  ) return 'verified';
  return 'mismatch';
}

export function linkedProviderNames(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const providers = (payload as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return null;
  const names = providers
    .map((item: unknown) => (item && typeof item === 'object' ? (item as { provider?: unknown }).provider : null))
    .filter((name): name is 'google' | 'github' => name === 'google' || name === 'github');
  return [...new Set(names.map((name) => name === 'github' ? 'GitHub' : 'Google'))];
}

/** Reject incomplete or fabricated billing snapshots instead of filling gaps with example credits. */
export function parseBillingSummary(payload: unknown, expectedPrincipalId: string | null): BillingSummary | null {
  if (!payload || typeof payload !== 'object') return null;
  const summary = payload as Record<string, unknown>;
  if (!expectedPrincipalId || summary.principalId !== expectedPrincipalId) return null;
  if (!['free', 'plus', 'pro'].includes(String(summary.planId))) return null;
  if (typeof summary.planName !== 'string' || !summary.planName.trim()) return null;
  if (typeof summary.subscriptionStatus !== 'string' || !summary.subscriptionStatus.trim()) return null;

  const metrics = [
    'availableCredits', 'lifetimeGranted', 'lifetimeSpent', 'dailyChatsUsed',
    'dailyChatLimit', 'monthlyUnitsUsed', 'monthlyUnitLimit',
    'reasoningBoostsUsed', 'reasoningBoostLimit'
  ];
  if (metrics.some((metric) => typeof summary[metric] !== 'number' ||
    !Number.isFinite(summary[metric]) || (summary[metric] as number) < 0)) return null;
  return summary as unknown as BillingSummary;
}
