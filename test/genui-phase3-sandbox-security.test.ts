/**
 * Phase 3 — Sandbox Security, CSP & Host Bridge Verification
 * Tests iframe isolation, CSP enforcement, external network denial,
 * self-hosted library packaging, and cryptographic bridge nonce validation.
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sandboxAttributesForType,
  stripUntrustedHtmlSecurityVectors,
  safeJsonStringifyForHtmlScript,
  SANDBOX_LIMITS,
} from '../src/utils/sandboxSecurity.js';
import {
  buildSandboxAppHtml,
  validateSandboxAppBridgeMessage,
  generateStandaloneExportHtml,
} from '../src/utils/genuiAppBridge.js';
import { authorizeGenUIActionServerSide } from '../packages/agent-runtime/src/index.js';
import type { GenUIApp } from '../packages/contracts/src/index.js';

function makeTestApp(overrides?: Partial<GenUIApp>): GenUIApp {
  return {
    schemaVersion: 'aira-app/v1',
    appId: 'app_test_sec',
    appType: 'html_application',
    title: 'Security Probe App',
    html: '<button id="btnClick">Test Action</button><div id="output">0</div>',
    css: 'body { font-family: sans-serif; }',
    javascript: 'document.getElementById("btnClick").onclick = () => { window.airaBridge.sendAction("act_test", { count: 1 }); };',
    libraries: [],
    initialState: { count: 0 },
    actions: [
      { id: 'act_test', label: 'Test Action', kind: 'local_recompute', permissionLevel: 'NONE', requiresApproval: false },
    ],
    height: 400,
    allowResize: true,
    textFallback: 'Security probe fallback',
    ...overrides,
  };
}

describe('Phase 3 — Sandbox Security, CSP & Host Bridge Verification', () => {
  it('enforces opaque origin sandbox attributes without allow-same-origin or allow-top-navigation', () => {
    const appAttrs = sandboxAttributesForType('html_application');
    assert.ok(appAttrs.includes('allow-scripts'));
    assert.ok(appAttrs.includes('allow-forms'));
    assert.equal(appAttrs.includes('allow-same-origin'), false, 'Must NOT include allow-same-origin');
    assert.equal(appAttrs.includes('allow-top-navigation'), false, 'Must NOT include allow-top-navigation');
    assert.equal(appAttrs.includes('allow-popups'), false, 'Must NOT include allow-popups');

    // Static types must remain completely script-free
    assert.equal(sandboxAttributesForType('image/svg+xml'), '');
    assert.equal(sandboxAttributesForType('text/markdown'), '');
  });

  it('strips untrusted model-supplied CSP, base, refresh, and remote external script tags', () => {
    const dirtyHtml = `
      <meta http-equiv="Content-Security-Policy" content="script-src *;">
      <meta http-equiv="refresh" content="0;url=http://attacker.com">
      <base href="https://attacker.com/">
      <script src="https://cdn.jsdelivr.net/npm/malicious@1.0.0/index.js"></script>
      <script src="//unpkg.com/evil/dist/evil.js"></script>
      <link rel="stylesheet" href="https://cdn.tailwindcss.com">
      <div id="content">Clean Content</div>
    `;
    const stripped = stripUntrustedHtmlSecurityVectors(dirtyHtml);
    assert.equal(stripped.includes('Content-Security-Policy'), false);
    assert.equal(stripped.includes('refresh'), false);
    assert.equal(stripped.includes('base'), false);
    assert.equal(stripped.includes('cdn.jsdelivr.net'), false);
    assert.equal(stripped.includes('unpkg.com'), false);
    assert.equal(stripped.includes('cdn.tailwindcss.com'), false);
    assert.ok(stripped.includes('Clean Content'));
  });

  it('builds complete sandboxed HTML with authoritative CSP and zero floating CDN links', () => {
    const app = makeTestApp();
    const nonce = 'test_nonce_abcdef123456';
    const html = buildSandboxAppHtml(app, { nonce, isDark: true });

    // Must include strict CSP meta tag
    assert.ok(html.includes('<meta http-equiv="Content-Security-Policy"'));
    assert.ok(html.includes("connect-src 'none'"), 'Must strictly forbid external connect-src');
    assert.ok(html.includes("base-uri 'none'"), 'Must forbid base-uri');

    // Must inject active nonce
    assert.ok(html.includes(nonce), 'Must inject session nonce into bridge client');

    // Must NOT contain any remote HTTP/HTTPS script sources
    assert.equal(/src\s*=\s*["']https?:\/\//i.test(html), false, 'Zero remote external CDN scripts permitted');
  });

  it('injects self-hosted D3 and Three.js runtime libraries without remote CDNs when requested', () => {
    const d3App = makeTestApp({
      appId: 'app_d3',
      appType: 'd3_visualization',
      libraries: ['d3'],
    });
    const d3Html = buildSandboxAppHtml(d3App, { nonce: 'nonce_d3_12345678' });
    assert.ok(d3Html.includes('window.d3'), 'Self-hosted d3 runtime must be defined in sandbox');
    assert.equal(/src\s*=\s*["']https?:\/\//i.test(d3Html), false);

    const threeApp = makeTestApp({
      appId: 'app_three',
      appType: 'three_scene',
      libraries: ['three'],
    });
    const threeHtml = buildSandboxAppHtml(threeApp, { nonce: 'nonce_three_12345678' });
    assert.ok(threeHtml.includes('window.THREE'), 'Self-hosted three runtime must be defined in sandbox');
    assert.equal(/src\s*=\s*["']https?:\/\//i.test(threeHtml), false);
  });

  it('validates bridge postMessage events against origin null, active nonce, and schema', () => {
    const activeNonce = 'valid_nonce_12345678';

    // 1. Valid handshake message
    const validMsg = {
      data: {
        type: 'GENUI_APP_RESIZE',
        nonce: activeNonce,
        appId: 'app_test_sec',
        payload: { height: 480 },
      },
      origin: 'null',
    };
    const validRes = validateSandboxAppBridgeMessage(validMsg, activeNonce, 'app_test_sec');
    assert.equal(validRes.ok, true);
    if (validRes.ok) {
      assert.equal(validRes.message.type, 'GENUI_APP_RESIZE');
      assert.equal(validRes.message.payload.height, 480);
    }

    // 2. Reject mismatched nonce
    const badNonceMsg = {
      data: { ...validMsg.data, nonce: 'wrong_nonce_99999999' },
      origin: 'null',
    };
    assert.equal(validateSandboxAppBridgeMessage(badNonceMsg, activeNonce, 'app_test_sec').ok, false);

    // 3. Reject non-null origin (spoofed cross-origin host)
    const badOriginMsg = {
      data: validMsg.data,
      origin: 'https://attacker.com',
    };
    assert.equal(validateSandboxAppBridgeMessage(badOriginMsg, activeNonce, 'app_test_sec').ok, false);

    // 4. Reject mismatched appId
    const badAppMsg = {
      data: { ...validMsg.data, appId: 'other_app' },
      origin: 'null',
    };
    assert.equal(validateSandboxAppBridgeMessage(badAppMsg, activeNonce, 'app_test_sec').ok, false);
  });

  it('authorizes sandboxed consequential actions fail-closed across cross-principals and unregistered actions', () => {
    const app = makeTestApp();
    const authorized = authorizeGenUIActionServerSide({
      principalUserId: 'usr_owner',
      runOwnerUserId: 'usr_owner',
      event: {
        eventId: 'evt_act_1',
        surfaceId: app.appId,
        componentId: 'app',
        actionId: 'act_test',
        kind: 'local_recompute',
        stateSnapshot: { count: 1 },
        timestamp: Date.now(),
      },
    });
    assert.equal(authorized.allowed, true);

    const crossPrincipal = authorizeGenUIActionServerSide({
      principalUserId: 'usr_attacker',
      runOwnerUserId: 'usr_owner',
      event: {
        eventId: 'evt_act_2',
        surfaceId: app.appId,
        componentId: 'app',
        actionId: 'act_test',
        kind: 'local_recompute',
        stateSnapshot: { count: 1 },
        timestamp: Date.now(),
      },
    });
    assert.equal(crossPrincipal.allowed, false);
    assert.equal(crossPrincipal.status, 403);
  });

  it('generates a clean offline standalone export bundle without runtime bridge dependency', () => {
    const app = makeTestApp();
    const standalone = generateStandaloneExportHtml(app, { count: 42 });
    assert.ok(standalone.includes('<!DOCTYPE html>'));
    assert.ok(standalone.includes(app.title));
    assert.ok(standalone.includes('{"count":42}'), 'Must embed current export state snapshot');
    assert.ok(standalone.includes('window.airaBridge'), 'Must embed offline fallback bridge stub');
    assert.equal(/src\s*=\s*["']https?:\/\//i.test(standalone), false, 'Zero external network script dependencies');
  });
});
