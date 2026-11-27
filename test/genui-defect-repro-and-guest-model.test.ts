import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  getDefaultModelForTier,
  resolveEntitledModelForTier,
} from '../src/utils/constants.js';
import {
  loadSettings,
  saveSettings,
} from '../src/utils/storage.js';
import { isModelAllowedForTier } from '../packages/contracts/src/commercial.js';
import { ModelRouter, PlanRestrictionError } from '../packages/model-router/src/index.js';
import { requireEntitledModel } from '../apps/api/src/middleware/entitlement-guard.js';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.has(k) ? store.get(k)! : null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
  return store;
}

describe('Section 5 — Guest Default Model & Entitlement-Safe Model Resolution (TDD)', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });

  it('1. resolves guest default model strictly from guest entitlement allowlist (aira-fast, never aira-auto)', () => {
    assert.equal(getDefaultModelForTier('guest'), 'aira-fast');
    assert.equal(isModelAllowedForTier(getDefaultModelForTier('guest'), 'guest'), true);
    assert.equal(getDefaultModelForTier('free'), 'aira-auto');
    assert.equal(isModelAllowedForTier(getDefaultModelForTier('free'), 'free'), true);
  });

  it('2. initializes Guest session via loadSettings() to authorized aira-fast even when no stored settings exist', () => {
    const guestSettings = loadSettings(undefined, 'guest');
    assert.equal(guestSettings.activeModel, 'aira-fast');
    assert.equal(isModelAllowedForTier(guestSettings.activeModel, 'guest'), true);

    // Even without explicit second argument, anonymous/guest owner must resolve to aira-fast
    const implicitGuestSettings = loadSettings();
    assert.equal(implicitGuestSettings.activeModel, 'aira-fast');
  });

  it('3. preserves authorized Free/Plus/Pro user preferences and clamps stale unentitled models safely', () => {
    const freeIdentity = { userId: 'usr_free_1', email: 'free@example.com' };
    saveSettings({ ...DEFAULT_SETTINGS, activeModel: 'aira-auto' }, freeIdentity);

    const loadedFree = loadSettings(freeIdentity, 'free');
    assert.equal(loadedFree.activeModel, 'aira-auto');

    // Stale persisted Pro model on Free account must clamp cleanly to Free default (aira-auto)
    saveSettings({ ...DEFAULT_SETTINGS, activeModel: 'aira-deep' }, freeIdentity);
    const clampedFree = loadSettings(freeIdentity, 'free');
    assert.equal(clampedFree.activeModel, 'aira-auto');
    assert.equal(isModelAllowedForTier(clampedFree.activeModel, 'free'), true);

    // Legacy stale alias in storage clamps appropriately per tier
    assert.equal(resolveEntitledModelForTier('claude-3-7-sonnet', 'guest'), 'aira-fast');
    assert.equal(resolveEntitledModelForTier('claude-3-7-sonnet', 'free'), 'aira-auto');
    assert.equal(resolveEntitledModelForTier('nonexistent-model', 'plus'), 'aira-auto');
  });

  it('4. handles account switching and sign-out isolation cleanly without leaking higher-tier model to guest', () => {
    const proUser = { userId: 'usr_pro_1', email: 'pro@example.com' };
    saveSettings({ ...DEFAULT_SETTINGS, activeModel: 'aira-deep' }, proUser);
    assert.equal(loadSettings(proUser, 'pro').activeModel, 'aira-deep');

    // Switch to Free user -> does not inherit Pro model
    const freeUser = { userId: 'usr_free_2', email: 'f2@example.com' };
    assert.equal(loadSettings(freeUser, 'free').activeModel, 'aira-auto');

    // Sign out -> Guest resolves to aira-fast, while Pro user preference remains preserved for next sign-in
    const postLogoutGuest = loadSettings(undefined, 'guest');
    assert.equal(postLogoutGuest.activeModel, 'aira-fast');
    assert.equal(loadSettings(proUser, 'pro').activeModel, 'aira-deep');
  });

  it('5. avoids pending-auth race clobbering for Pro accounts while clamping unauthorized models on settlement', () => {
    const proUser = { userId: 'usr_pro_race', email: 'prorace@example.com' };
    saveSettings({ ...DEFAULT_SETTINGS, activeModel: 'aira-deep' }, proUser);

    // During initial render before billing resolves (tier unknown/pending), loadSettings preserves stored Pro choice
    const duringPending = loadSettings(proUser);
    assert.equal(duringPending.activeModel, 'aira-deep');

    // Once billing settles as 'free' (e.g. lapsed Pro), resolveEntitledModelForTier clamps cleanly
    assert.equal(resolveEntitledModelForTier(duringPending.activeModel, 'free'), 'aira-auto');
    // Once billing settles as 'pro', preference remains untouched
    assert.equal(resolveEntitledModelForTier(duringPending.activeModel, 'pro'), 'aira-deep');
  });

  it('6. preserves server-side PLAN_MODEL_RESTRICTED enforcement when direct API caller requests unauthorized model as guest', async () => {
    const middleware = requireEntitledModel();
    let statusCode = 0;
    let payload: any = null;
    let nextCalled = false;

    await middleware(
      { body: { model: 'aira-auto' }, principal: { userId: 'guest_abc', sessionId: 'sess_1' } } as any,
      {
        status(code: number) { statusCode = code; return this; },
        json(body: any) { payload = body; return this; },
      } as any,
      () => { nextCalled = true; }
    );
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
    assert.equal(payload?.error, 'PLAN_MODEL_RESTRICTED');

    const prevKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk-test-entitlement-check';
    try {
      const router = new ModelRouter();
      assert.throws(
        () => router.resolveExecution('aira-pro', 'ANSWER', { callerTier: 'guest' }),
        (err: any) => err instanceof PlanRestrictionError && err.code === 'PLAN_MODEL_RESTRICTED' && err.statusCode === 403
      );
      const guestExec = router.resolveExecution('aira-fast', 'ANSWER', { callerTier: 'guest' });
      assert.equal(guestExec.policy.model, 'aira-fast');
    } finally {
      if (prevKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prevKey;
    }
  });
});
