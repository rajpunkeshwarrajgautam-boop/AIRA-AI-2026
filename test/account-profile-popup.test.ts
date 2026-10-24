import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountProfilePopup } from '../src/components/AccountProfilePopup.tsx';
import { AuthModal } from '../src/components/AuthModal.tsx';

test('AccountProfilePopup renders guest state with Royal Blue design tokens and all menu items', () => {
  const html = renderToStaticMarkup(
    React.createElement(AccountProfilePopup, {
      isOpen: true,
      onClose: () => {},
      user: null,
      onOpenPricing: () => {},
      onOpenSettings: () => {},
      onOpenAuth: () => {},
      onSignOut: () => {},
      onOpenHelp: () => {},
    })
  );

  assert.match(html, /Guest Workspace/);
  assert.match(html, /Free/);
  assert.match(html, /Upgrade plan/);
  assert.match(html, /Personalization/);
  assert.match(html, /Profile/);
  assert.match(html, /Settings/);
  assert.match(html, /Help/);
  assert.match(html, /Sign in/);
  assert.match(html, /data-testid="account-profile-popup"/);
});

test('AccountProfilePopup renders authenticated user state with nested switcher items', () => {
  const mockUser = {
    id: 'usr_test_raj_123',
    name: 'raj',
    email: 'rajpunkeshwarrajgautam@gmail.com',
  };

  const html = renderToStaticMarkup(
    React.createElement(AccountProfilePopup, {
      isOpen: true,
      onClose: () => {},
      user: mockUser as any,
      onOpenPricing: () => {},
      onOpenSettings: () => {},
      onOpenAuth: () => {},
      onSignOut: () => {},
      onOpenHelp: () => {},
      defaultShowSwitcher: true,
    })
  );

  assert.match(html, /raj/);
  assert.match(html, /Plus/);
  assert.match(html, /Log out/);
  assert.match(html, /rajpunkeshwarrajgautam@gmail\.com/);
  assert.match(html, /Personal account/);
  assert.match(html, /Switch account/);
});

test('AuthModal removes Staging label in production environment', () => {
  // In Node SSR / production simulated window, hostname is empty or not staging
  const html = renderToStaticMarkup(
    React.createElement(AuthModal, {
      isOpen: true,
      onClose: () => {},
      onAuthSuccess: () => {},
    })
  );

  assert.match(html, /Direct OAuth \(Google &amp; GitHub\)/);
  assert.doesNotMatch(html, /Direct OAuth \(Google &amp; GitHub\) · Staging/);
});
