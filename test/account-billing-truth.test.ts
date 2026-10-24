import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyServerSession,
  linkedProviderNames,
  parseBillingSummary
} from '../src/lib/accountBillingTruth.ts';

const realSummary = {
  principalId: 'owner',
  planId: 'plus', planName: 'AIRA Plus', subscriptionStatus: 'active',
  availableCredits: 0, lifetimeGranted: 100, lifetimeSpent: 100,
  dailyChatsUsed: 0, dailyChatLimit: 15, monthlyUnitsUsed: 0,
  monthlyUnitLimit: 150, reasoningBoostsUsed: 0, reasoningBoostLimit: 5
};

test('cached profile alone never verifies authentication', () => {
  assert.equal(classifyServerSession(null, 'owner'), 'mismatch');
  assert.equal(classifyServerSession({ status: 'ANONYMOUS', user: null }, 'owner'), 'anonymous');
  assert.equal(classifyServerSession({ status: 'AUTHENTICATED', user: { id: 'other' } }, 'owner'), 'mismatch');
  assert.equal(classifyServerSession({ status: 'AUTHENTICATED', user: { id: 'owner' } }, null), 'mismatch');
  assert.equal(classifyServerSession({ status: 'AUTHENTICATED', user: { id: 'owner' } }, 'owner'), 'verified');
});

test('linked providers are derived from the authenticated provider list, never hardcoded', () => {
  assert.deepEqual(linkedProviderNames({ providers: [{ provider: 'github' }] }), ['GitHub']);
  assert.deepEqual(linkedProviderNames({ providers: [{ provider: 'google' }, { provider: 'github' }, { provider: 'google' }] }), ['Google', 'GitHub']);
  assert.deepEqual(linkedProviderNames({ providers: [] }), []);
  assert.equal(linkedProviderNames({ error: 'unavailable' }), null);
});

test('billing rejects missing, malformed and fabricated fallback-shaped responses', () => {
  assert.equal(parseBillingSummary(null, 'owner'), null);
  assert.equal(parseBillingSummary({ planId: 'free', planName: 'AIRA Free' }, 'owner'), null);
  assert.equal(parseBillingSummary({ ...realSummary, availableCredits: -1 }, 'owner'), null);
  assert.equal(parseBillingSummary({ ...realSummary, dailyChatsUsed: '2' }, 'owner'), null);
  assert.equal(parseBillingSummary(realSummary, 'other'), null);
  assert.deepEqual(parseBillingSummary(realSummary, 'owner'), realSummary);
});
