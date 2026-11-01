import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BrowserAdapter, PersistedBrowserSessionState } from '../packages/tool-runtime/src/adapters/browser-adapter.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

test('Mission C — Browser Persistence, Tenant Isolation, and Recovery Across Worker Termination', async (t) => {
  const principalA: ExecutionPrincipal = {
    userId: 'user_browser_alpha',
    sessionId: 'session_alpha_1',
    workspaceId: 'ws_alpha',
    scopes: ['browser.read', 'browser.write']
  };

  const principalB: ExecutionPrincipal = {
    userId: 'user_browser_beta',
    sessionId: 'session_beta_1',
    workspaceId: 'ws_beta',
    scopes: ['browser.read', 'browser.write']
  };

  let adapter1 = new BrowserAdapter();

  await t.test('1. Session Creation, Navigation, and State Export', async () => {
    // Navigate to public page
    const navResult = await adapter1.navigate(principalA, 'https://example.com');
    assert.ok(navResult.url.includes('example.com'));
    assert.ok(navResult.pageHeading);
    assert.equal(navResult.untrustedExternalData, true);

    // Verify session was tracked
    const sessions = adapter1.listSessions(principalA);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].principalId, principalA.userId);

    // Export permitted session state
    const exportedState = await adapter1.exportSessionState(principalA);
    assert.ok(exportedState);
    assert.equal(exportedState.principalId, principalA.userId);
    assert.ok(exportedState.currentUrl.includes('example.com'));
    assert.ok(Array.isArray(exportedState.cookies));
    assert.ok(Array.isArray(exportedState.origins));
  });

  await t.test('2. Worker Termination and Restoration Across Process Boundary', async () => {
    // Simulate active session with state in worker 1
    const stateBeforeCrash: PersistedBrowserSessionState = {
      sessionKey: `${principalA.userId}:${principalA.sessionId}`,
      principalId: principalA.userId,
      workspaceId: principalA.workspaceId,
      currentUrl: 'https://example.com',
      cookies: [
        {
          name: 'aira_test_session',
          value: 'token_secret_123',
          domain: '.example.com',
          path: '/',
          expires: Date.now() / 1000 + 3600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax'
        }
      ],
      origins: [
        {
          origin: 'https://example.com',
          localStorage: [{ name: 'user_theme', value: 'midnight_luxury' }]
        }
      ],
      exportedAt: Date.now()
    };

    // Simulate worker 1 crashing / shutting down
    await adapter1.shutdown();

    // Worker 2 boots up with a new independent BrowserAdapter
    const adapter2 = new BrowserAdapter();

    // Verify worker 2 has zero sessions initially
    assert.equal(adapter2.listSessions(principalA).length, 0);

    // Restore permitted session state
    const restoredSession = await adapter2.importSessionState(principalA, stateBeforeCrash);
    assert.ok(restoredSession);
    assert.equal(restoredSession.principalId, principalA.userId);

    // Verify cookies survived restart
    const cookiesAfter = await restoredSession.context.cookies(['https://example.com']);
    const testCookie = cookiesAfter.find(c => c.name === 'aira_test_session');
    assert.ok(testCookie, 'Authentication cookie must survive worker restart');
    assert.equal(testCookie?.value, 'token_secret_123');

    // Clean up adapter2
    await adapter2.shutdown();
  });

  await t.test('3. Cross-Tenant Session Hijacking Rejection', async () => {
    const adapter = new BrowserAdapter();

    const stateA: PersistedBrowserSessionState = {
      sessionKey: `${principalA.userId}:${principalA.sessionId}`,
      principalId: principalA.userId,
      workspaceId: principalA.workspaceId,
      currentUrl: 'https://example.com',
      cookies: [{ name: 'secret_a', value: '123', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [],
      exportedAt: Date.now()
    };

    // Principal B attempts to import Principal A's session state
    await assert.rejects(
      async () => {
        await adapter.importSessionState(principalB, stateA);
      },
      /SECURITY_VIOLATION: Principal "user_browser_beta" cannot restore session owned by "user_browser_alpha"/,
      'Tenant B must be strictly blocked from restoring Tenant A session state'
    );

    await adapter.shutdown();
  });

  await t.test('4. Full DOM Interactions, Scroll, Wait, and Screenshot Bounds', async () => {
    const adapter = new BrowserAdapter();

    try {
      // Navigation
      const nav = await adapter.navigate(principalA, 'https://example.com');
      assert.equal(nav.status, 200);

      // Extract DOM
      const dom = await adapter.extractDom(principalA);
      assert.ok(dom.title.includes('Example Domain'));
      assert.ok(dom.extractedText.length > 0);

      // Scroll
      const scrollRes = await adapter.scroll(principalA, 300);
      assert.ok(scrollRes.scrolled);
      assert.equal(scrollRes.deltaY, 300);

      // Wait
      const waitRes = await adapter.waitFor(principalA, undefined, 5000);
      assert.equal(waitRes.ready, true);

      // Screenshot
      const shot = await adapter.screenshot(principalA);
      assert.ok(shot.base64.length > 50);
      assert.equal(shot.format, 'image/png');

      // Clean close session
      await adapter.closeSession(principalA);
      assert.equal(adapter.listSessions(principalA).length, 0);
    } finally {
      await adapter.shutdown();
    }
  });

  await t.test('5. Workspace and Session Key Ownership Boundaries', async () => {
    const adapter = new BrowserAdapter();

    const stateWorkspaceMismatch: PersistedBrowserSessionState = {
      sessionKey: `${principalA.userId}:${principalA.sessionId}`,
      principalId: principalA.userId,
      workspaceId: 'ws_different_confidential',
      currentUrl: 'https://example.com',
      cookies: [],
      origins: [],
      exportedAt: Date.now()
    };

    await assert.rejects(
      async () => {
        await adapter.importSessionState(principalA, stateWorkspaceMismatch);
      },
      /SECURITY_VIOLATION: Workspace mismatch/,
      'Must reject session state with mismatched workspaceId'
    );

    const stateSessionMismatch: PersistedBrowserSessionState = {
      sessionKey: `${principalA.userId}:session_alien_999`,
      principalId: principalA.userId,
      workspaceId: principalA.workspaceId,
      currentUrl: 'https://example.com',
      cookies: [],
      origins: [],
      exportedAt: Date.now()
    };

    await assert.rejects(
      async () => {
        await adapter.importSessionState(principalA, stateSessionMismatch);
      },
      /SECURITY_VIOLATION: Session key mismatch/,
      'Must reject session state with mismatched sessionKey'
    );

    await adapter.shutdown();
  });

  await t.test('6. AES-256-GCM Session Snapshot Encryption & Redacted Cookie Masking', async () => {
    const adapter = new BrowserAdapter();

    try {
      await adapter.navigate(principalA, 'https://example.com');
      const secretPassphrase = crypto.randomBytes(32).toString('hex');

      // 6a. Export encrypted session state
      const encryptedBlob = await adapter.exportEncryptedSessionState(principalA, secretPassphrase);
      assert.ok(encryptedBlob);
      const parsedEnvelope = JSON.parse(encryptedBlob);
      assert.equal(parsedEnvelope.version, 1);
      assert.equal(parsedEnvelope.principalId, principalA.userId);
      assert.ok(parsedEnvelope.iv);
      assert.ok(parsedEnvelope.tag);
      assert.ok(parsedEnvelope.data);

      // Verify raw cookie tokens are NOT in the encrypted blob text
      assert.ok(!encryptedBlob.includes('aira_session_secret'));

      // 6b. Cross-tenant decryption rejection
      await assert.rejects(
        async () => {
          await adapter.importEncryptedSessionState(principalB, encryptedBlob, secretPassphrase);
        },
        /SECURITY_VIOLATION: Principal "user_browser_beta" cannot decrypt/,
        'Tenant B must not be able to decrypt Tenant A session envelope'
      );

      // 6c. Successful restoration for authorized principal
      const restored = await adapter.importEncryptedSessionState(principalA, encryptedBlob, secretPassphrase);
      assert.ok(restored);
      assert.equal(restored.principalId, principalA.userId);

      // 6d. Sanitization test: Public API / log representation must redact raw cookie secrets
      const sampleCookieSecret = `session_auth_token_${crypto.randomBytes(8).toString('hex')}`;
      const rawState: PersistedBrowserSessionState = {
        sessionKey: `${principalA.userId}:${principalA.sessionId}`,
        principalId: principalA.userId,
        workspaceId: principalA.workspaceId,
        currentUrl: 'https://example.com',
        cookies: [{ name: 'auth_token', value: sampleCookieSecret, domain: 'example.com', path: '/' }],
        origins: [{ origin: 'https://example.com', localStorage: [] }],
        exportedAt: Date.now()
      };

      const sanitized = adapter.sanitizeSessionStateForPublic(rawState);
      const sanitizedJson = JSON.stringify(sanitized);
      assert.ok(!sanitizedJson.includes(sampleCookieSecret), 'Raw cookie secrets must NEVER be present in sanitized session state');
      assert.ok(sanitizedJson.includes('[REDACTED_COOKIE]'), 'Cookie values must be replaced with [REDACTED_COOKIE]');
    } finally {
      await adapter.shutdown();
    }
  });
});
