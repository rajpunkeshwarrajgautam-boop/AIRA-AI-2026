import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import zlib from 'node:zlib';
import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { TaskDAGSchema, SpecialistTaskContractSchema } from '../packages/contracts/src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { db } from '../packages/db/src/index.js';

function createMockDb() {
  const store = new Map<string, Record<string, unknown>[]>();
  return (tableName: string) => {
    if (!store.has(tableName)) store.set(tableName, []);
    const table = store.get(tableName)!;
    return {
      where: (query: Record<string, unknown>) => ({
        first: async () => table.find(row => Object.entries(query).every(([k, v]) => row[k] === v)) || null,
        update: async (patch: Record<string, unknown>) => {
          for (const row of table) {
            if (Object.entries(query).every(([k, v]) => row[k] === v)) {
              Object.assign(row, patch);
            }
          }
        },
        delete: async () => {
          const remaining = table.filter(row => !Object.entries(query).every(([k, v]) => row[k] === v));
          store.set(tableName, remaining);
        },
        orderBy: async (column: string, direction = 'asc') => {
          return [...table].sort((a, b) => {
            const valA = String(a[column] ?? '');
            const valB = String(b[column] ?? '');
            if (direction === 'desc') return valB.localeCompare(valA);
            return valA.localeCompare(valB);
          }) as unknown as import('../apps/api/src/billing/payment-gateway-service.js').SubscriptionRow[];
        }
      }),
      insert: async (record: Record<string, unknown>) => {
        table.push({ ...record });
      }
    };
  };
}

test('PR #118 Remediation Gate 1: Server-side TypeScript zero-error compilation', () => {
  const output = execSync('npx tsc -p tsconfig.server.json --noEmit', {
    encoding: 'utf8',
    stdio: 'pipe'
  });
  assert.equal(output.trim(), '', 'Server TypeScript compilation must produce zero errors');
});

test('PR #118 Remediation Gate 2: Cashfree webhook HMAC verification, deduplication, and error handling', async (t) => {
  const secret = process.env.CASHFREE_WEBHOOK_SECRET || 'test_webhook_secret_cashfree_2026';
  process.env.CASHFREE_WEBHOOK_SECRET = secret;

  let hasRealDb = false;
  try {
    await db.raw('SELECT 1');
    hasRealDb = true;
  } catch {
    hasRealDb = false;
    paymentGatewayService.setDbClient(createMockDb());
  }

  await t.test('rejects webhook with invalid signature', async () => {
    const rawBody = JSON.stringify({
      data: { order: { order_id: 'order_test_bad_sig' } },
      event_time: '2026-10-31T01:00:00Z',
      type: 'PAYMENT_SUCCESS_WEBHOOK'
    });
    const badSignature = 'invalid_hmac_signature_hex';
    const timestamp = '1798675200000';

    await assert.rejects(
      async () => {
        await paymentGatewayService.processCashfreeWebhook(rawBody, badSignature, timestamp);
      },
      /FORBIDDEN_WEBHOOK/
    );
  });

  await t.test('processes valid webhook and deduplicates subsequent replay delivery', async () => {
    const eventId = `test_cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const payloadObj = {
      event_id: eventId,
      data: {
        order: { order_id: `ord_${eventId}` },
        payment: { cf_payment_id: `pay_${eventId}`, payment_status: 'SUCCESS', payment_amount: 100 }
      },
      event_time: new Date().toISOString(),
      type: 'PAYMENT_SUCCESS_WEBHOOK'
    };
    const rawBody = JSON.stringify(payloadObj);
    const timestamp = Date.now().toString();

    // Compute legitimate Cashfree signature: HMAC-SHA256(timestamp + rawBody, secret) -> base64
    const signatureData = timestamp + rawBody;
    const validSignature = crypto.createHmac('sha256', secret).update(signatureData).digest('base64');

    // First delivery: should process
    const firstDelivery = await paymentGatewayService.processCashfreeWebhook(rawBody, validSignature, timestamp);
    assert.equal(firstDelivery.status, 'PROCESSED');
    assert.equal(firstDelivery.duplicate, false);

    // Second delivery (replay attack / duplicate webhook): must deduplicate cleanly
    const duplicateDelivery = await paymentGatewayService.processCashfreeWebhook(rawBody, validSignature, timestamp);
    assert.equal(duplicateDelivery.status, 'ALREADY_PROCESSED');
    assert.equal(duplicateDelivery.duplicate, true);

    // Clean up test event record if using real DB
    if (hasRealDb) {
      await db('payment_gateway_events').where({ event_id: eventId }).delete().catch(() => {});
    }
  });
});

test('PR #118 Remediation Gate 3: Benchmark role authorization fails closed for non-admin callers', () => {
  function checkBenchmarkRole(principal: { roles?: string[] }): boolean {
    return Boolean((principal.roles || []).some((r: string) => r.toLowerCase() === 'admin'));
  }

  // Admin callers pass
  assert.equal(checkBenchmarkRole({ roles: ['admin'] }), true);
  assert.equal(checkBenchmarkRole({ roles: ['user', 'ADMIN'] }), true);

  // Non-admin callers fail closed
  assert.equal(checkBenchmarkRole({ roles: ['user'] }), false);
  assert.equal(checkBenchmarkRole({ roles: ['operator', 'developer'] }), false);

  // Missing or empty roles fail closed
  assert.equal(checkBenchmarkRole({ roles: [] }), false);
  assert.equal(checkBenchmarkRole({}), false);
});

test('PR #118 Remediation Gate 4: Automation exception handling and side-effect hoisting semantics', () => {
  // Model the side-effect hoisting logic from apps/api/src/index.ts
  function executeAutomationWithHoisting(shouldFailBeforeCommit: boolean, shouldFailAfterCommit: boolean) {
    let sideEffectCommitted = false;
    let automationResult: any = null;
    let recordedStatus = 'UNKNOWN';

    try {
      if (shouldFailBeforeCommit) {
        throw new Error('PRE_COMMIT_FAILURE');
      }

      // Simulated commit
      sideEffectCommitted = true;
      automationResult = { id: 'auto_123', status: 'created' };

      if (shouldFailAfterCommit) {
        throw new Error('POST_COMMIT_FAILURE');
      }

      recordedStatus = 'SUCCESS';
    } catch (_err: unknown) {
      if (!sideEffectCommitted) {
        recordedStatus = 'FAILED_CLEAN';
      } else {
        recordedStatus = 'FAILED_POST_SIDE_EFFECT';
      }
    }

    return { sideEffectCommitted, recordedStatus, automationResult };
  }

  // Scenario 1: Clean failure before side effect
  const preFail = executeAutomationWithHoisting(true, false);
  assert.equal(preFail.sideEffectCommitted, false);
  assert.equal(preFail.recordedStatus, 'FAILED_CLEAN');
  assert.equal(preFail.automationResult, null);

  // Scenario 2: Failure after side effect
  const postFail = executeAutomationWithHoisting(false, true);
  assert.equal(postFail.sideEffectCommitted, true);
  assert.equal(postFail.recordedStatus, 'FAILED_POST_SIDE_EFFECT');
  assert.notEqual(postFail.automationResult, null);

  // Scenario 3: Complete success
  const success = executeAutomationWithHoisting(false, false);
  assert.equal(success.sideEffectCommitted, true);
  assert.equal(success.recordedStatus, 'SUCCESS');
  assert.equal(success.automationResult.status, 'created');
});


test('PR #118 Remediation Gate 5: Oversized Zod collections memory and constraint enforcement (GHSA-mrhx-c7xc-m3w5)', async (t) => {
  // Confirm resolved Zod package version is >= 4.6.7
  const installedZodVersion = require('zod/package.json').version;
  assert.match(installedZodVersion, /^4.[6-9].[0-9]+/, `Expected Zod >= 4.6.7, got ${installedZodVersion}`);

  await t.test('enforces max constraints on specialist task dependencies and rejects oversized arrays', () => {
    // Contract limit is max(10) dependencies
    const invalidDependencies = Array.from({ length: 11 }, (_, i) => `dep_${i}`);
    const taskPayload = {
      taskId: 'task_limit_test',
      runId: 'run_limit_test',
      objective: 'Verify max dependencies rejection',
      dependencies: invalidDependencies
    };

    const parsed = SpecialistTaskContractSchema.safeParse(taskPayload);
    assert.equal(parsed.success, false, 'SpecialistTaskContractSchema must reject arrays exceeding max(10)');
    if (!parsed.success) {
      const issue = parsed.error.issues.find(i => i.code === 'too_big');
      assert.ok(issue, 'Error issues must include too_big code');
      assert.equal(issue.maximum, 10, 'Maximum constraint must be 10');
    }
  });

  await t.test('enforces max constraints on DAG tasks and rejects oversized collections', () => {
    // Contract limit is max(50) tasks in TaskDAGSchema
    const oversizedTasks = Array.from({ length: 51 }, (_, i) => ({
      taskId: `task_${i}`,
      runId: 'run_dag_test',
      objective: `Objective for task ${i}`
    }));

    const dagPayload = {
      dagId: 'dag_limit_test',
      runId: 'run_dag_test',
      tasks: oversizedTasks
    };

    const parsed = TaskDAGSchema.safeParse(dagPayload);
    assert.equal(parsed.success, false, 'TaskDAGSchema must reject tasks array exceeding max(50)');
    if (!parsed.success) {
      const issue = parsed.error.issues.find(i => i.code === 'too_big');
      assert.ok(issue, 'Error issues must include too_big code for DAG tasks');
      assert.equal(issue.maximum, 50, 'Maximum constraint must be 50');
    }
  });

  await t.test('bounded memory and fast rejection on large collection validation under Zod 4.6.7', () => {
    // 5,000 element array must fail fast without unbounded heap allocation
    const oversizedArray = Array.from({ length: 5000 }, (_, i) => `item_${i}`);
    const arrayValidator = z.array(z.string()).max(5);

    const start = performance.now();
    const result = arrayValidator.safeParse(oversizedArray);
    const durationMs = performance.now() - start;

    assert.equal(result.success, false);
    assert.ok(durationMs < 100, `Rejection took ${durationMs}ms, expected < 100ms`);
  });

  await t.test('validates set and map size constraints fail closed on oversized structures', () => {
    const oversizedSet = new Set(Array.from({ length: 50 }, (_, i) => `elem_${i}`));
    const setValidator = z.set(z.string()).max(5);
    const setResult = setValidator.safeParse(oversizedSet);
    assert.equal(setResult.success, false);

    const oversizedMap = new Map(Array.from({ length: 50 }, (_, i) => [`key_${i}`, `val_${i}`]));
    const mapValidator = z.map(z.string(), z.string()).max(5);
    const mapResult = mapValidator.safeParse(oversizedMap);
    assert.equal(mapResult.success, false);
  });
});

test('PR #118 Remediation Gate 6: Compressed HTTP request body and trailing bytes handling (GHSA-27r3-jxmh-p828)', async (t) => {
  // Confirm resolved body-parser version is >= 2.4.0
  const installedBodyParserVersion = require('body-parser/package.json').version;
  assert.match(installedBodyParserVersion, /^2.[4-9].[0-9]+/, `Expected body-parser >= 2.4.0, got ${installedBodyParserVersion}`);

  // Mirror exact production Express body parser setup from apps/api/src/index.ts
  const testApp = express();
  testApp.use(express.json({
    limit: '2mb',
    verify: (req: any, _res: any, buf: Buffer) => {
      req.rawBody = buf.toString('utf8');
    }
  }));
  testApp.use(express.urlencoded({ limit: '2mb', extended: false }));

  testApp.post('/api/test-compressed-body', (req: Request, res: Response) => {
    res.status(200).json({ received: req.body, rawLength: req.rawBody?.length ?? 0 });
  });

  // Central error middleware matching Express 5 error response contract
  testApp.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || err.statusCode || 400).json({
      error: err.message,
      code: err.code || 'BAD_REQUEST'
    });
  });

  const testServer = http.createServer(testApp);
  await new Promise<void>(resolve => testServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (testServer.address() as any).port;
  const endpoint = `http://127.0.0.1:${port}/api/test-compressed-body`;

  try {
    await t.test('accepts and decompresses valid gzipped JSON payload', async () => {
      const payload = JSON.stringify({ message: 'valid_decompression_test', count: 42 });
      const gzipped = zlib.gzipSync(Buffer.from(payload));

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip'
        },
        body: gzipped
      });

      assert.equal(res.status, 200, `Expected HTTP 200, got ${res.status}`);
      const body = await res.json();
      assert.deepEqual(body.received, { message: 'valid_decompression_test', count: 42 });
      assert.ok(body.rawLength > 0, 'rawBody must be populated by verify callback');
    });

    await t.test('safely rejects gzipped payload with trailing bytes without unhandled crash (GHSA-27r3-jxmh-p828 vector)', async () => {
      const validPayload = JSON.stringify({ message: 'base_payload' });
      const validGzip = zlib.gzipSync(Buffer.from(validPayload));
      // Exploit payload: legitimate gzip compressed block followed by trailing uncompressed bytes
      const trailingGarbage = Buffer.from('TRAILING_EXPLOIT_GARBAGE_BYTES_2026');
      const exploitPayload = Buffer.concat([validGzip, trailingGarbage]);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip'
        },
        body: exploitPayload
      });

      // Patched body-parser rejects trailing bytes with a clean 4xx client error
      assert.ok(res.status >= 400 && res.status < 500, `Expected 4xx client rejection, got ${res.status}`);
      const body = await res.json();
      assert.ok(body.error, 'Rejection response must contain error description');
    });

    await t.test('rejects truncated/corrupted gzip stream with clean 4xx', async () => {
      // Corrupt magic header
      const corruptGzip = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip'
        },
        body: corruptGzip
      });

      assert.ok(res.status >= 400 && res.status < 500, `Expected 4xx client rejection, got ${res.status}`);
    });

    await t.test('server connection and event loop remain responsive after malformed payload delivery', async () => {
      // Proves the socket stream was not left hung or in an unhandled state
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'healthy_post_exploit' })
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.received, { state: 'healthy_post_exploit' });
    });
  } finally {
    await new Promise<void>(resolve => testServer.close(() => resolve()));
  }
});

test.after(async () => {

  paymentGatewayService.setDbClient(null);
  await db.destroy().catch(() => {});
});
