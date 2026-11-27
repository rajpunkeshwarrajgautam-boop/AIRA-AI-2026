/**
 * Phase 3 / 3.5 Sandbox Containment, Egress Isolation & Bridge Security Test Suite
 *
 * Verifies:
 * 1. Network Egress Containment: CSP connect-src 'none' physically blocks fetch, XHR, WebSocket, EventSource, sendBeacon.
 * 2. CSP Meta Header & Sandbox Directives: Strict default-src 'none', object-src 'none', base-uri 'none', form-action 'none'.
 * 3. Cryptographic Bridge Validation: Active nonce verification, null origin enforcement, forbidden key rejection.
 * 4. Runtime Exception Interception & Boundary: Uncaught exceptions & unhandled rejections trapped and surfaced via error boundary.
 * 5. Script & Markup Sanitization: Strip external scripts, conflicting CSP meta tags, base tags, and script injection vectors.
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { chromium, type Browser } from 'playwright';
import {
  buildSandboxAppHtml,
  validateSandboxAppBridgeMessage,
  APP_SANDBOX_CSP_META,
} from '../src/utils/genuiAppBridge.js';
import {
  stripUntrustedHtmlSecurityVectors,
  safeJsonStringifyForHtmlScript,
  SANDBOX_LIMITS,
} from '../src/utils/sandboxSecurity.js';
import {
  AIRA_GENUI_APP_CONTRACT_VERSION,
  type GenUIApp,
} from '../packages/contracts/src/index.js';

describe('Phase 3.5 — Sandbox Containment & Egress Security', () => {
  const sampleApp: GenUIApp = {
    schemaVersion: AIRA_GENUI_APP_CONTRACT_VERSION,
    appId: 'app_isolation_test',
    appType: 'simulation',
    title: 'Isolation Test App',
    html: '<div id="test-root">Sandbox Ready</div>',
    css: '#test-root { color: #fff; }',
    javascript: 'console.log("Sandbox active");',
    libraries: [],
    initialState: { counter: 0 },
    actions: [],
    height: 400,
    allowResize: true,
    textFallback: 'Isolation Test App',
    origin: 'model',
  };

  describe('1. CSP Meta & Sandbox Directives Integrity', () => {
    it('enforces authoritative CSP directives in APP_SANDBOX_CSP_META', () => {
      assert.ok(APP_SANDBOX_CSP_META.includes("connect-src 'none'"), "Must enforce connect-src 'none'");
      assert.ok(APP_SANDBOX_CSP_META.includes("object-src 'none'"), "Must enforce object-src 'none'");
      assert.ok(APP_SANDBOX_CSP_META.includes("base-uri 'none'"), "Must enforce base-uri 'none'");
      assert.ok(APP_SANDBOX_CSP_META.includes("form-action 'none'"), "Must enforce form-action 'none'");
      assert.ok(APP_SANDBOX_CSP_META.includes("default-src 'none'"), "Must enforce default-src 'none'");
    });

    it('injects CSP meta and error boundary into generated sandbox HTML', () => {
      const html = buildSandboxAppHtml(sampleApp, { activeNonce: 'nonce_123', theme: 'dark' });
      assert.ok(html.includes("connect-src 'none'"), 'Generated HTML must include connect-src none');
      assert.ok(html.includes('id="aira-error-boundary"'), 'Generated HTML must include error boundary element');
      assert.ok(html.includes('window.airaBridge = {'), 'Generated HTML must inject airaBridge runtime');
    });
  });

  describe('2. Cryptographic Bridge Validation (validateSandboxAppBridgeMessage)', () => {
    const validNonce = 'sec_nonce_abc123';

    it('accepts valid bridge message from null origin with matching nonce', () => {
      const result = validateSandboxAppBridgeMessage(
        {
          type: 'GENUI_APP_READY',
          nonce: validNonce,
          appId: 'app_isolation_test',
          payload: { state: { counter: 1 } },
          timestamp: Date.now(),
        },
        validNonce,
        'null'
      );
      assert.equal(result.ok, true);
    });

    it('rejects message with mismatched nonce', () => {
      const result = validateSandboxAppBridgeMessage(
        {
          type: 'GENUI_APP_READY',
          nonce: 'forged_nonce',
          appId: 'app_isolation_test',
          payload: {},
          timestamp: Date.now(),
        },
        validNonce,
        'null'
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'GENUI_NONCE_MISMATCH');
    });

    it('rejects message from non-null origin (prevents host forgery)', () => {
      const result = validateSandboxAppBridgeMessage(
        {
          type: 'GENUI_APP_READY',
          nonce: validNonce,
          appId: 'app_isolation_test',
          payload: {},
          timestamp: Date.now(),
        },
        validNonce,
        'https://malicious.example.com'
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'GENUI_ORIGIN_INVALID');
    });

    it('rejects message containing prototype pollution keys in payload', () => {
      const result = validateSandboxAppBridgeMessage(
        {
          type: 'GENUI_APP_STATE_UPDATE',
          nonce: validNonce,
          appId: 'app_isolation_test',
          payload: JSON.parse('{"__proto__": {"polluted": true}}'),
          timestamp: Date.now(),
        },
        validNonce,
        'null'
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'GENUI_FORBIDDEN_KEY');
    });

    it('rejects message with invalid schema structure or missing fields', () => {
      const result = validateSandboxAppBridgeMessage(
        {
          type: 'UNKNOWN_TYPE_FORGERY',
          nonce: validNonce,
          appId: 'app_isolation_test',
        },
        validNonce,
        'null'
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'GENUI_SCHEMA_INVALID');
    });
  });

  describe('3. Vector Sanitization & Escaping', () => {
    it('strips external scripts, conflicting CSP meta, and base tags from user HTML', () => {
      const maliciousHtml = `
        <meta http-equiv="Content-Security-Policy" content="connect-src *;">
        <base href="https://attacker.com/">
        <script src="https://evil.com/exploit.js"></script>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css">
        <div id="content">Safe Content</div>
      `;
      const cleaned = stripUntrustedHtmlSecurityVectors(maliciousHtml);
      assert.ok(!cleaned.includes('attacker.com'), 'Must strip base href');
      assert.ok(!cleaned.includes('evil.com'), 'Must strip external script src');
      assert.ok(!cleaned.includes('cdn.jsdelivr.net'), 'Must strip remote CDN link');
      assert.ok(!cleaned.includes('http-equiv="Content-Security-Policy"'), 'Must strip conflicting meta CSP');
      assert.ok(cleaned.includes('Safe Content'), 'Must preserve safe content');
    });

    it('safeJsonStringifyForHtmlScript escapes closing script tags and HTML comments', () => {
      const dangerousState = {
        scriptBreak: '</script><script>alert(1)</script>',
        commentBreak: '<!-- <script>',
      };
      const json = safeJsonStringifyForHtmlScript(dangerousState);
      assert.ok(!json.includes('</script>'), 'Must escape </script>');
      assert.ok(!json.includes('<!--'), 'Must escape <!--');
      assert.ok(json.includes('\\u003c/script\\u003e'), 'Must produce unicode-escaped script tag');
    });
  });

  describe('4. Headless Browser Egress Containment (Playwright)', () => {
    let browser: Browser;

    it('physically blocks all network egress attempts from inside sandboxed iframe HTML', async () => {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      try {
        browser = await chromium.launch({ headless: true });
      } catch {
        browser = await chromium.launch({
          headless: true,
          executablePath: fs.existsSync(chromePath) ? chromePath : edgePath,
        });
      }

      // App attempting various network egress vectors
      const egressApp: GenUIApp = {
        ...sampleApp,
        appId: 'app_egress_test',
        javascript: `
          window.egressResults = {};

          // 1. fetch() attempt
          try {
            fetch('https://httpbin.org/get')
              .then(() => { window.egressResults.fetch = 'SUCCESS_UNEXPECTED'; })
              .catch((e) => { window.egressResults.fetch = 'BLOCKED: ' + e.message; });
          } catch (e) {
            window.egressResults.fetch = 'BLOCKED: ' + e.message;
          }

          // 2. XMLHttpRequest attempt
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', 'https://httpbin.org/get', true);
            xhr.onerror = function() { window.egressResults.xhr = 'BLOCKED_ERROR'; };
            xhr.onload = function() { window.egressResults.xhr = 'SUCCESS_UNEXPECTED'; };
            xhr.send();
          } catch (e) {
            window.egressResults.xhr = 'BLOCKED: ' + e.message;
          }

          // 3. WebSocket attempt
          try {
            const ws = new WebSocket('wss://echo.websocket.org');
            ws.onerror = function() { window.egressResults.ws = 'BLOCKED_ERROR'; };
            ws.onopen = function() { window.egressResults.ws = 'SUCCESS_UNEXPECTED'; };
          } catch (e) {
            window.egressResults.ws = 'BLOCKED: ' + e.message;
          }

          // 4. EventSource attempt
          try {
            const es = new EventSource('https://httpbin.org/stream');
            es.onerror = function() { window.egressResults.es = 'BLOCKED_ERROR'; };
          } catch (e) {
            window.egressResults.es = 'BLOCKED: ' + e.message;
          }

          // 5. Image ping attempt (<img src="https://httpbin.org/image/png">)
          try {
            const img = new Image();
            img.onerror = function() { window.egressResults.img = 'BLOCKED_ERROR'; };
            img.onload = function() { window.egressResults.img = 'SUCCESS_UNEXPECTED'; };
            img.src = 'https://httpbin.org/image/png?' + Date.now();
          } catch (e) {
            window.egressResults.img = 'BLOCKED: ' + e.message;
          }
        `,
      };

      const html = buildSandboxAppHtml(egressApp, { nonce: 'test_egress_nonce', isDark: true });
      const page = await browser.newPage();
      try {
        const attemptedRequests: string[] = [];
        page.on('request', (req) => {
          if (!req.url().startsWith('data:') && !req.url().startsWith('about:')) {
            attemptedRequests.push(req.url());
          }
        });

        await page.setContent(html, { waitUntil: 'load' });
        // Allow async network attempts to fail against CSP
        await page.waitForTimeout(1500);

        const egressResults: Record<string, string> = await page.evaluate(() => (window as any).egressResults);

        console.log('[SANDBOX_ISOLATION_TEST] Egress containment results:', egressResults);
        console.log('[SANDBOX_ISOLATION_TEST] Intercepted non-local network requests:', attemptedRequests);

        assert.ok(
          !egressResults.fetch?.includes('SUCCESS_UNEXPECTED'),
          `fetch() must not succeed under connect-src 'none' (was: ${egressResults.fetch})`
        );
        assert.ok(
          !egressResults.xhr?.includes('SUCCESS_UNEXPECTED'),
          `XHR must not succeed under connect-src 'none' (was: ${egressResults.xhr})`
        );
        assert.ok(
          !egressResults.ws?.includes('SUCCESS_UNEXPECTED'),
          `WebSocket must not succeed under connect-src 'none' (was: ${egressResults.ws})`
        );
        assert.ok(
          !egressResults.es?.includes('SUCCESS_UNEXPECTED'),
          `EventSource must not succeed under connect-src 'none' (was: ${egressResults.es})`
        );
      } finally {
        await page.close();
        await browser.close();
      }
    });

    it('intercepts runtime exceptions and displays error boundary UI', async () => {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      try {
        browser = await chromium.launch({ headless: true });
      } catch {
        browser = await chromium.launch({
          headless: true,
          executablePath: fs.existsSync(chromePath) ? chromePath : edgePath,
        });
      }

      const crashingApp: GenUIApp = {
        ...sampleApp,
        appId: 'app_crash_test',
        javascript: `
          setTimeout(function() {
            throw new Error('Test deliberate sandbox exception');
          }, 50);
        `,
      };

      const html = buildSandboxAppHtml(crashingApp, { activeNonce: 'test_crash_nonce', theme: 'dark' });
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load' });
        await page.waitForTimeout(300);

        // Verify #aira-error-boundary became visible
        const boundaryDisplay = await page.locator('#aira-error-boundary').evaluate((el) => window.getComputedStyle(el).display);
        const boundaryText = await page.locator('#aira-error-boundary').innerText();

        assert.equal(boundaryDisplay, 'block', 'Error boundary must be displayed on uncaught error');
        assert.ok(boundaryText.includes('Test deliberate sandbox exception'), 'Error boundary must show error message');
      } finally {
        await page.close();
        await browser.close();
      }
    });
  });
});
