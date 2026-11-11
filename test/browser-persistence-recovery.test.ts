import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  BrowserAdapter,
  PersistedBrowserSessionState,
  InMemoryBrowserSessionStorage,
  PostgresBrowserSessionStorage,
  BrowserPersistenceUnavailableError
} from '../packages/tool-runtime/src/adapters/browser-adapter.js';
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

  const testStorage = new InMemoryBrowserSessionStorage();
  let adapter1 = new BrowserAdapter({}, testStorage);

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
    const adapter = new BrowserAdapter({}, testStorage);

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
    const adapter = new BrowserAdapter({}, testStorage);

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
    const adapter = new BrowserAdapter({}, testStorage);

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
    const adapter = new BrowserAdapter({}, testStorage);

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

  await t.test('7. Durable Session Persistence, Expiration, Tamper Rejection & Clean Termination', async (subtest) => {
    const sharedStorage = new InMemoryBrowserSessionStorage();
    const secretKey = crypto.randomBytes(32).toString('hex');
    const wrongKey = crypto.randomBytes(32).toString('hex');

    // Worker 1: Creates session, navigates, saves durable encrypted snapshot
    const worker1 = new BrowserAdapter({}, sharedStorage);
    const adapters: BrowserAdapter[] = [worker1];
    subtest.after(async () => {
      // Assertion failures must not strand Chromium handles until CI times out.
      await Promise.allSettled(adapters.map(adapter => adapter.shutdown()));
    });
    await worker1.navigate(principalA, 'https://example.com');
    const storedSnapshot = await worker1.saveDurableSnapshot(principalA, secretKey, 60000);
    assert.ok(storedSnapshot);
    assert.equal(storedSnapshot.principalId, principalA.userId);
    assert.equal(storedSnapshot.workspaceId, principalA.workspaceId);

    // 7a. Worker restart simulation: Worker 1 terminates abruptly (without orderly close)
    await worker1.shutdown();

    // Worker 2 boots up sharing the same durable storage
    const worker2 = new BrowserAdapter({}, sharedStorage);
    adapters.push(worker2);

    // 7b. Tampered ciphertext rejection
    const tampered = await sharedStorage.getSession(`${principalA.userId}:${principalA.sessionId}`);
    assert.ok(tampered);
    const parsedEnv = JSON.parse(tampered.encryptedEnvelope);
    const originalData = parsedEnv.data;
    // Alter last character of base64 data to corrupt ciphertext
    // Alter a significant ciphertext byte; changing the final base64 character
    // can modify padding bits without changing decoded ciphertext bytes.
    parsedEnv.data = (originalData.startsWith('A') ? 'B' : 'A') + originalData.slice(1);
    tampered.encryptedEnvelope = JSON.stringify(parsedEnv);
    await sharedStorage.saveSession(tampered);

    await assert.rejects(
      async () => {
        await worker2.restoreDurableSnapshot(principalA, secretKey);
      },
      /SECURITY_VIOLATION: Decryption failed/,
      'Must reject tampered ciphertext with tag verification failure'
    );

    // Restore untampered envelope
    parsedEnv.data = originalData;
    tampered.encryptedEnvelope = JSON.stringify(parsedEnv);
    await sharedStorage.saveSession(tampered);

    // 7c. Wrong encryption key rejection
    await assert.rejects(
      async () => {
        await worker2.restoreDurableSnapshot(principalA, wrongKey);
      },
      /SECURITY_VIOLATION: Decryption failed/,
      'Must reject decryption with incorrect key'
    );

    // 7d. Cross-principal rejection
    await assert.rejects(
      async () => {
        await worker2.restoreDurableSnapshot(principalB, secretKey);
      },
      /SESSION_NOT_FOUND|SECURITY_VIOLATION: Principal mismatch/,
      'Principal B must not be able to restore Principal A durable session'
    );

    // 7e. Cross-workspace rejection
    const wrongWorkspacePrincipal: ExecutionPrincipal = {
      ...principalA,
      workspaceId: 'ws_other_rogue'
    };
    await assert.rejects(
      async () => {
        await worker2.restoreDurableSnapshot(wrongWorkspacePrincipal, secretKey);
      },
      /SECURITY_VIOLATION: Workspace mismatch/,
      'Principal from different workspace must be rejected'
    );

    // 7f. Missing workspace attribute on workspace-bound session
    const noWorkspacePrincipal: ExecutionPrincipal = {
      ...principalA,
      workspaceId: undefined
    };
    await assert.rejects(
      async () => {
        await worker2.restoreDurableSnapshot(noWorkspacePrincipal, secretKey);
      },
      /SECURITY_VIOLATION: Missing workspace attribute/,
      'Missing workspace attribute on caller must be rejected for workspace-bound session'
    );

    // 7g. Successful durable restoration on Worker 2
    const restoredInfo = await worker2.restoreDurableSnapshot(principalA, secretKey);
    assert.ok(restoredInfo);
    assert.equal(restoredInfo.principalId, principalA.userId);
    assert.ok(restoredInfo.activePage.url().includes('example.com'));

    // 7h. Clean session termination deletes durable snapshot
    await worker2.closeSession(principalA); // closes local Playwright session AND deletes durable snapshot
    const postTerminationRecord = await sharedStorage.getSession(`${principalA.userId}:${principalA.sessionId}`);
    assert.equal(postTerminationRecord, null, 'Session termination must purge durable snapshot from storage');

    await assert.rejects(
      async () => {
        await worker2.restoreDurableSnapshot(principalA, secretKey);
      },
      /SESSION_NOT_FOUND/,
      'Restoring terminated session must fail with SESSION_NOT_FOUND'
    );

    // 7i. Expiration test
    const expiredWorker = new BrowserAdapter({}, sharedStorage);
    adapters.push(expiredWorker);
    await expiredWorker.navigate(principalA, 'https://example.com');
    await expiredWorker.saveDurableSnapshot(principalA, secretKey, -5000); // already expired

    await assert.rejects(
      async () => {
        await expiredWorker.restoreDurableSnapshot(principalA, secretKey);
      },
      /SECURITY_VIOLATION: Persisted browser session ".*" has expired/,
      'Expired session must be rejected and purged'
    );

  });

  await t.test('8. Fail-Closed Security on PostgresBrowserSessionStorage Outage (Zero Silent Memory Downgrading)', async () => {
    // Construct a failing knex mock that simulates database unreachable / connection failure
    const failingDbMock: any = {
      schema: {
        hasTable: async () => {
          const err: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
          err.code = 'ECONNREFUSED';
          throw err;
        }
      }
    };

    const failingStorage = new PostgresBrowserSessionStorage(failingDbMock);

    // 8a. saveSession must reject with BrowserPersistenceUnavailableError
    await assert.rejects(
      async () => {
        await failingStorage.saveSession({
          sessionKey: 'test:key',
          principalId: 'test',
          sessionId: 'key',
          encryptedEnvelope: '{}',
          expiresAt: Date.now() + 10000,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      },
      (err: any) => {
        assert.ok(err instanceof BrowserPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.ok(err.message.includes('saveSession'));
        return true;
      },
      'saveSession must reject with BrowserPersistenceUnavailableError on outage'
    );

    // 8b. getSession must reject with BrowserPersistenceUnavailableError
    await assert.rejects(
      async () => {
        await failingStorage.getSession('test:key');
      },
      (err: any) => {
        assert.ok(err instanceof BrowserPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.ok(err.message.includes('getSession'));
        return true;
      },
      'getSession must reject with BrowserPersistenceUnavailableError on outage'
    );

    // 8c. deleteSession must reject with BrowserPersistenceUnavailableError
    await assert.rejects(
      async () => {
        await failingStorage.deleteSession('test:key');
      },
      (err: any) => {
        assert.ok(err instanceof BrowserPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.ok(err.message.includes('deleteSession'));
        return true;
      },
      'deleteSession must reject with BrowserPersistenceUnavailableError on outage'
    );

    // 8d. listSessions must reject with BrowserPersistenceUnavailableError
    await assert.rejects(
      async () => {
        await failingStorage.listSessions('test');
      },
      (err: any) => {
        assert.ok(err instanceof BrowserPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.ok(err.message.includes('listSessions'));
        return true;
      },
      'listSessions must reject with BrowserPersistenceUnavailableError on outage'
    );

    // 8e. purgeExpired must reject with BrowserPersistenceUnavailableError
    await assert.rejects(
      async () => {
        await failingStorage.purgeExpired();
      },
      (err: any) => {
        assert.ok(err instanceof BrowserPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.ok(err.message.includes('purgeExpired'));
        return true;
      },
      'purgeExpired must reject with BrowserPersistenceUnavailableError on outage'
    );

    // 8f. Session closure must not falsely report successful durable deletion when DB is unavailable
    const adapterWithFailingStorage = new BrowserAdapter({}, failingStorage);
    await assert.rejects(
      async () => {
        await adapterWithFailingStorage.closeSession(principalA, { deleteDurable: true });
      },
      (err: any) => {
        assert.ok(err instanceof BrowserPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.ok(err.message.includes('deleteSession'));
        return true;
      },
      'closeSession({ deleteDurable: true }) must throw persistence error and not falsely report success'
    );
  });
});
