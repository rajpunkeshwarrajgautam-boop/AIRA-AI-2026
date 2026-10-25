import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/utils/constants.ts';
import { neonAuth } from '../src/lib/neonAuth.ts';
import {
  getSettingsStorageKey,
  loadSettings,
  saveSettings,
} from '../src/utils/storage.ts';

class TestStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

test('A, guest, and B settings remain distinct across logout, switch, and reload', () => {
  const prior = (globalThis as any).localStorage;
  const storage = new TestStorage();
  (globalThis as any).localStorage = storage;
  try {
    const privateA = {
      ...DEFAULT_SETTINGS,
      customInstructions: 'Private Account A instruction',
      userBio: 'Account A confidential profile',
      anthropicApiKey: 'synthetic-a-secret',
      openRouterApiKey: 'synthetic-a-router-key',
    };
    saveSettings(privateA, 'user-A');
    assert.equal(loadSettings().customInstructions, '');
    assert.equal(loadSettings('user-B').anthropicApiKey, '');

    const guest = { ...DEFAULT_SETTINGS, customInstructions: 'Guest-specific instruction' };
    saveSettings(guest);
    const privateB = {
      ...DEFAULT_SETTINGS,
      customInstructions: 'Private Account B instruction',
      anthropicApiKey: 'synthetic-b-secret',
    };
    saveSettings(privateB, 'user-B');

    assert.equal(loadSettings('user-A').anthropicApiKey, 'synthetic-a-secret');
    assert.equal(loadSettings('user-A').userBio, 'Account A confidential profile');
    assert.equal(loadSettings().customInstructions, 'Guest-specific instruction');
    assert.equal(loadSettings('user-B').customInstructions, 'Private Account B instruction');
    assert.equal(loadSettings('user-B').anthropicApiKey, 'synthetic-b-secret');
    assert.equal(loadSettings('user-B').openRouterApiKey, '');
  } finally {
    (globalThis as any).localStorage = prior;
  }
});

test('Ambiguous legacy global settings are never imported into guest or account stores', () => {
  const prior = (globalThis as any).localStorage;
  const storage = new TestStorage();
  (globalThis as any).localStorage = storage;
  try {
    storage.setItem('aira_settings_v1', JSON.stringify({
      ...DEFAULT_SETTINGS,
      customInstructions: 'Sensitive unowned legacy instructions',
      anthropicApiKey: 'synthetic-unowned-key',
    }));
    assert.equal(loadSettings().customInstructions, '');
    assert.equal(loadSettings('owner-id').anthropicApiKey, '');
    assert.equal(storage.getItem('aira_settings_v1') !== null, true, 'Legacy data is preserved but never loaded');
  } finally {
    (globalThis as any).localStorage = prior;
  }
});

test('User IDs are encoded into distinct storage namespaces', () => {
  assert.equal(getSettingsStorageKey(), 'aira_settings_guest_v2');
  assert.equal(getSettingsStorageKey(null), 'aira_settings_guest_v2');
  assert.equal(getSettingsStorageKey('user/id+space'), 'aira_settings_user_user%2Fid%2Bspace_v2');
  assert.notEqual(getSettingsStorageKey('user-A'), getSettingsStorageKey('user-B'));
});

test('Corrupted settings storage returns defaults without mixing principals', () => {
  const prior = (globalThis as any).localStorage;
  const storage = new TestStorage();
  (globalThis as any).localStorage = storage;
  try {
    storage.setItem(getSettingsStorageKey('user-A'), '{invalid');
    assert.equal(loadSettings('user-A').activeModel, DEFAULT_SETTINGS.activeModel);
    assert.equal(loadSettings('user-B').customInstructions, '');
  } finally {
    (globalThis as any).localStorage = prior;
  }
});


test('Cached profile is not verified until the BFF supplies a session-bound token', () => {
  const user = { id: 'owner-A', name: 'Owner A', email: 'owner-a@example.test' };
  const observed: Array<string | null> = [];
  neonAuth.saveSession(null);
  const unsubscribe = neonAuth.onAuthStateChange(() => {
    observed.push(neonAuth.getVerifiedBffUser()?.id || null);
  });
  try {
    neonAuth.saveSession({ user, token: 'bff_session' });
    assert.equal(neonAuth.getCurrentUser()?.id, 'owner-A');
    assert.equal(neonAuth.getVerifiedBffUser(), null, 'Cached metadata must never count as verification');
    neonAuth.saveSession({ user, token: 'bff_session', csrfToken: 'server_verified_token' });
    assert.equal(neonAuth.getVerifiedBffUser()?.id, 'owner-A');
    assert.equal(observed.at(-1), 'owner-A', 'Unverified → verified renewal must notify UI');
    neonAuth.saveSession({ user: { id: 'owner-B', name: 'Owner B', email: 'b@example.test' }, token: 'bff_session' });
    assert.equal(neonAuth.getVerifiedBffUser(), null, 'A different account must be unverified without server proof');
  } finally {
    unsubscribe();
    neonAuth.saveSession(null);
  }
});
