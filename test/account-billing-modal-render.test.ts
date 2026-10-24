import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountBillingModal } from '../src/components/AccountBillingModal.tsx';

test('guest account panel never renders example balances or obsolete provider branding', () => {
  const html = renderToStaticMarkup(React.createElement(AccountBillingModal, {
    isOpen: true,
    onClose: () => {},
    onOpenPricing: () => {}
  }));
  assert.match(html, /AIRA Account/);
  assert.match(html, /Billing information unavailable/);
  assert.doesNotMatch(html, /Neon Auth Protected/);
  assert.doesNotMatch(html, /Available Premium Credits/);
  assert.doesNotMatch(html, /100 welcome credits/);
});
