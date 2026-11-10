/**
 * 5-Stage Interactive Onboarding Tour Utilities
 * Manages account-isolated walkthrough state, stage progression,
 * and server-side synchronization.
 */

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
 * Synchronize onboarding actions with the backend server.
 */
export async function syncOnboardingActionToServer(
  action: 'stage' | 'finish' | 'skip' | 'restart',
  stage?: OnboardingStage,
  userId?: string | null
): Promise<void> {
  try {
    await fetch('/api/user/onboarding', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userId ? { 'x-user-id': userId } : {})
      },
      body: JSON.stringify({ action, stage })
    });
  } catch {
    // Offline or server not responding; local state is preserved
  }
}

/**
 * Fetch remote onboarding state if online and update local cache if remote is more advanced.
 */
export async function fetchOnboardingFromServer(userId?: string | null): Promise<OnboardingState | null> {
  try {
    const res = await fetch('/api/user/onboarding', {
      headers: userId ? { 'x-user-id': userId } : {}
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.completed === 'boolean') {
      const state: OnboardingState = {
        completed: Boolean(data.completed),
        currentStage: ONBOARDING_STAGES.includes(data.currentStage) ? data.currentStage : 'intro',
        skipped: Boolean(data.skipped)
      };
      persistState(state, userId);
      return state;
    }
    return null;
  } catch {
    return null;
  }
}
