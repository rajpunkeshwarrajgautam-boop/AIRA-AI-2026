import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PricingModal } from '../src/components/PricingModal.tsx';
import { SettingsModal } from '../src/components/SettingsModal.tsx';
import { AccountBillingModal } from '../src/components/AccountBillingModal.tsx';
import { parseBillingSummary } from '../src/lib/accountBillingTruth.ts';

describe('V2 Slice 3: Customer-Facing Global Billing UI, Role Scoping & Decluttering', () => {
  it('1. PricingModal renders global tiers without internal GST diagnostic footer clutter', () => {
    const html = renderToStaticMarkup(
      React.createElement(PricingModal, {
        isOpen: true,
        onClose: () => {},
        currentPlan: 'free'
      })
    );

    assert.match(html, /Choose Your Intelligence Tier/);
    assert.match(html, /AIRA Free/);
    assert.match(html, /AIRA Plus/);
    assert.match(html, /AIRA Pro/);
    assert.match(html, /Country \/ Region/);
    assert.doesNotMatch(html, /GST Provisional Fixture/, 'Customer pricing modal must not expose internal tax fixture warnings');
    assert.doesNotMatch(html, /SAC 998315/, 'Customer pricing modal footer must not clutter UI with SAC code internals');
  });

  it('2. SettingsModal guest view hides subscriber payment methods, billing history & billing information forms', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsModal, {
        isOpen: true,
        onClose: () => {},
        settings: {
          theme: 'light',
          accentColor: 'orange',
          fontSize: 'medium',
          defaultModel: 'auto',
          enableStreaming: true,
          sendWithEnter: true,
          showReasoningProcess: true,
          enableWebSearch: true,
          enableMemory: true,
          customInstructions: '',
          userName: '',
          tone: 'balanced',
          language: 'en',
          enableSound: false
        } as any,
        onSaveSettings: () => {},
        conversations: [],
        projects: [],
        onImportData: () => {},
        onClearAll: () => {},
        initialTab: 'plan',
        userTier: 'guest'
      })
    );

    assert.match(html, /My Plan &amp; Usage/);
    assert.doesNotMatch(html, /Save Billing Info/);
    assert.doesNotMatch(html, /Billing history/);
    assert.doesNotMatch(html, /Payment methods/);
    assert.doesNotMatch(html, /Download PDF/);
  });

  it('3. AccountBillingModal preserves guest fail-closed truth while BillingSummary supports V2 paymentMethods', () => {
    const parsed = parseBillingSummary(
      {
        principalId: 'usr_abc123',
        planId: 'plus',
        planName: 'AIRA Plus',
        subscriptionStatus: 'active',
        availableCredits: 3000,
        lifetimeGranted: 3100,
        lifetimeSpent: 100,
        dailyChatsUsed: 1,
        dailyChatLimit: 50,
        monthlyUnitsUsed: 1,
        monthlyUnitLimit: 700,
        reasoningBoostsUsed: 0,
        reasoningBoostLimit: 50,
        paymentMethods: [
          {
            id: 'pm_1',
            gateway: 'razorpay',
            methodType: 'card',
            brand: 'Visa',
            last4: '4242',
            displayLabel: 'Visa ending in 4242',
            isDefault: true
          }
        ],
        billingProfile: {
          country: 'US',
          accountType: 'individual'
        }
      },
      'usr_abc123'
    );
    assert.ok(parsed);
    assert.equal(parsed?.paymentMethods?.[0]?.displayLabel, 'Visa ending in 4242');
    assert.equal(parsed?.billingProfile?.country, 'US');

    const guestHtml = renderToStaticMarkup(
      React.createElement(AccountBillingModal, {
        isOpen: true,
        onClose: () => {},
        onOpenPricing: () => {}
      })
    );
    assert.match(guestHtml, /AIRA Account/);
    assert.match(guestHtml, /Billing information unavailable/);
  });
});
