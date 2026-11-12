/**
 * 5-Stage Interactive Onboarding Tour Utilities
 * Manages account-isolated walkthrough state, stage progression,
 * and authenticated server-side synchronization without client ID trust.
 */
import { authenticatedApiFetch, neonAuth } from '../lib/neonAuth';

export const ONBOARDING_STAGES = [
  'intro',
  'chat_reasoning',
  'agent_mode',
  'projects_artifacts',
  'plans'
] as const;

export type OnboardingStage = typeof ONBOARDING_STAGES[number];

export interface OnboardingState {
  completed: boolean;
  currentStage: OnboardingStage;
  skipped: boolean;
}

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  completed: false,
  currentStage: 'intro',
  skipped: false
};

export function getOnboardingStorageKey(userId?: string | null): string {
  const scope = (userId && typeof userId === 'string' && userId.trim()) ? userId.trim() : 'guest';
  return `aira_onboarding_${scope}`;
}

/**
 * Retrieve the saved onboarding state for a specific user ID.
 */
export function getOnboardingState(userId?: string | null): OnboardingState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_ONBOARDING_STATE };
  }

  const key = getOnboardingStorageKey(userId);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const stageValid = ONBOARDING_STAGES.includes(parsed.currentStage);
        return {
          completed: Boolean(parsed.completed),
          currentStage: stageValid ? parsed.currentStage : 'intro',
          skipped: Boolean(parsed.skipped)
        };
      }
    }
  } catch (err) {
    console.warn(`[Onboarding] Error reading onboarding state from ${key}:`, err);
  }

  return { ...DEFAULT_ONBOARDING_STATE };
}

/**
 * Persist the onboarding state locally and trigger server synchronization.
 */
function persistState(state: OnboardingState, userId?: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const key = getOnboardingStorageKey(userId);
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch (err) {
    console.warn(`[Onboarding] Error saving onboarding state to ${key}:`, err);
  }
}

/**
 * Save current active stage progression without marking complete.
 */
export function saveOnboardingStage(stage: OnboardingStage, userId?: string | null): void {
  if (!ONBOARDING_STAGES.includes(stage)) return;
  const current = getOnboardingState(userId);
  const updated: OnboardingState = {
    ...current,
    currentStage: stage
  };
  persistState(updated, userId);
  void syncOnboardingActionToServer('stage', stage, userId);
}

/**
 * Skip onboarding tour: marks completed and skipped.
 */
export function skipOnboarding(userId?: string | null): void {
  const current = getOnboardingState(userId);
  const updated: OnboardingState = {
    ...current,
    completed: true,
    skipped: true
  };
  persistState(updated, userId);
  void syncOnboardingActionToServer('skip', undefined, userId);
}

/**
 * Finish onboarding tour: marks completed without skipping.
 */
export function finishOnboarding(userId?: string | null): void {
  const updated: OnboardingState = {
    completed: true,
    currentStage: 'plans',
    skipped: false
  };
  persistState(updated, userId);
  void syncOnboardingActionToServer('finish', undefined, userId);
}

/**
 * Restart onboarding tour: resets completed to false and stage to intro.
 */
export function restartOnboarding(userId?: string | null): void {
  const updated: OnboardingState = {
    completed: false,
    currentStage: 'intro',
    skipped: false
  };
  persistState(updated, userId);
  void syncOnboardingActionToServer('restart', undefined, userId);
}

/**
 * Synchronize onboarding actions with the authenticated backend server.
 * Ownership is strictly resolved server-side from the HttpOnly BFF session cookie or verified JWT;
 * client userId headers are never sent or trusted.
 */
export async function syncOnboardingActionToServer(
  action: 'stage' | 'finish' | 'skip' | 'restart',
  stage?: OnboardingStage,
  userId?: string | null
): Promise<boolean> {
  const targetUser = (userId && typeof userId === 'string') ? userId.trim() : '';
  if (!targetUser || targetUser.startsWith('guest_')) {
    return false;
  }
  const activeUser = neonAuth.getCurrentUser();
  if (!activeUser || activeUser.id !== targetUser) {
    return false;
  }
  const epoch = neonAuth.getAuthEpoch();
  try {
    const res = await authenticatedApiFetch('/api/user/onboarding', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...(stage ? { stage } : {}) })
    });
    if (!res.ok) return false;
    if (neonAuth.getAuthEpoch() !== epoch || neonAuth.getCurrentUser()?.id !== targetUser) {
      return false;
    }
    const data = await res.json().catch(() => null);
    if (data && typeof data.completed === 'boolean') {
      persistState({
        completed: Boolean(data.completed),
        currentStage: ONBOARDING_STAGES.includes(data.currentStage) ? data.currentStage : 'intro',
        skipped: Boolean(data.skipped)
      }, targetUser);
    }
    return true;
  } catch {
    // Offline or unauthenticated; local scoped state remains preserved
    return false;
  }
}

/**
 * Fetch remote onboarding state for the active authenticated principal
 * and synchronize the user-scoped cache only if the auth epoch matches.
 */
export async function fetchOnboardingFromServer(userId?: string | null): Promise<OnboardingState | null> {
  const targetUser = (userId && typeof userId === 'string') ? userId.trim() : '';
  if (!targetUser || targetUser.startsWith('guest_')) {
    return null;
  }
  const activeUser = neonAuth.getCurrentUser();
  if (!activeUser || activeUser.id !== targetUser) {
    return null;
  }
  const epoch = neonAuth.getAuthEpoch();
  try {
    const res = await authenticatedApiFetch('/api/user/onboarding', {
      method: 'GET',
      cache: 'no-store'
    });
    if (!res.ok) return null;
    if (neonAuth.getAuthEpoch() !== epoch || neonAuth.getCurrentUser()?.id !== targetUser) {
      return null;
    }
    const data = await res.json();
    if (data && typeof data.completed === 'boolean') {
      const state: OnboardingState = {
        completed: Boolean(data.completed),
        currentStage: ONBOARDING_STAGES.includes(data.currentStage) ? data.currentStage : 'intro',
        skipped: Boolean(data.skipped)
      };
      persistState(state, targetUser);
      return state;
    }
    return null;
  } catch {
    return null;
  }
}
