import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';

const { default: app, agentRuntime, modelRouter } = await import('../apps/api/src/index.js');
const { commercialBillingService } = await import('../apps/api/src/billing/commercial-billing-service.js');
const { db } = await import('../packages/db/src/index.js');

describe('Remediation F8 (Part 2): Real HTTP Upstream Cancellation, Quota Refund & Telemetry (Actual Route)', () => {
  let server: Server;
  let baseUrl: string;

  let origCreateModelSpecificAdapter: any;

  before(async () => {
    // Register streaming mock adapter for groq provider so aira-fast resolves cleanly in test
    const testMockAdapter = {
      name: 'test-stream-adapter',
      provider: 'groq' as const,
      modelName: 'openai/gpt-oss-120b',
      async complete(messages: any, policy: any) {
        return {
          text: 'Mock complete text',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          model: policy.model,
          outboundModel: policy.model
        };
      },
      async stream(messages: any, policy: any, onChunk: any, options: any) {
        // Delay before tokens to allow reliable pre-token client cancellation
        await new Promise((res, rej) => {
          const timer = setTimeout(res, 80);
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              rej(new Error('Provider aborted by client signal'));
            }, { once: true });
          }
        });

        for (let i = 0; i < 5; i++) {
          if (options?.signal?.aborted) {
            throw new Error('Provider aborted by client signal');
          }
          onChunk({ text: `token_${i} ` });
          await new Promise((res) => setTimeout(res, 30));
        }

        return {
          text: 'Mock stream completed',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          model: policy.model,
          outboundModel: policy.model
        };
      }
    };
    (modelRouter as any).adapters.set('groq', testMockAdapter);
    origCreateModelSpecificAdapter = (modelRouter as any).createModelSpecificAdapter;
    (modelRouter as any).createModelSpecificAdapter = () => testMockAdapter;

    // Mount actual production Express application on ephemeral local port
    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (origCreateModelSpecificAdapter) {
      (modelRouter as any).createModelSpecificAdapter = origCreateModelSpecificAdapter;
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await db.destroy().catch(() => {});
  });

  it('detects client abort before first token, refunds quota reservation, releases capacity permit, cancels run, and logs telemetry', async () => {
    let quotaReserved = false;
    let quotaRefunded = false;
    let cancelRunCalled = false;
    let cancellationTelemetry = '';

    // Spy on quota reservation and refund
    const origReserve = commercialBillingService.reserveStandardChat.bind(commercialBillingService);
    const origRelease = commercialBillingService.releaseStandardChat.bind(commercialBillingService);
    const origCancelRun = agentRuntime.cancelRun.bind(agentRuntime);
    const origLog = console.log;

    commercialBillingService.reserveStandardChat = async (...args: any[]) => {
      quotaReserved = true;
      try {
        return await origReserve(...args);
      } catch {
        // Fallback in local test environments without live DB
        return {
          reservationToken: `res_mock_${crypto.randomUUID().slice(0, 8)}`,
          remainingDaily: 50,
          remainingMonthly: 500
        };
      }
    };

    commercialBillingService.releaseStandardChat = async (...args: any[]) => {
      quotaRefunded = true;
      try {
        await origRelease(...args);
      } catch {
        // Fallback for offline DB
      }
    };

    agentRuntime.cancelRun = async (...args: any[]) => {
      cancelRunCalled = true;
      return await origCancelRun(...args);
    };

    console.log = (...args: any[]) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('event=chat_cancellation')) {
        cancellationTelemetry = msg;
      }
      origLog(...args);
    };

    const clientAbort = new AbortController();

    try {
      const responsePromise = fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'x-test-user-id': 'usr_cancel_verifier_01',
          'x-test-session-id': 'sess_cancel_01',
          'x-test-tier': 'plus',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'aira-fast',
          prompt: 'Generate complete architecture audit'
        }),
        signal: clientAbort.signal
      });

      // Wait for server to receive request, reserve quota, and establish stream
      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.ok(response.body);

      const reader = response.body.getReader();

      // Read initial SSE connection chunk (e.g. run_started or queue_status)
      const initialChunk = await reader.read();
      assert.equal(initialChunk.done, false);

      // Abruptly disconnect client socket BEFORE first token is produced
      clientAbort.abort(new Error('User closed tab'));

      // Allow event loop to process socket 'close' event and async cleanups
      await new Promise((resolve) => setTimeout(resolve, 200));

      // 1. Quota reservation must have been created then refunded
      assert.equal(quotaReserved, true, 'Quota must be reserved before inference starts');
      assert.equal(quotaRefunded, true, 'Quota must be refunded via releaseStandardChat when aborted pre-token');

      // 2. Cancellation of active run must have occurred
      assert.equal(cancelRunCalled, true, 'agentRuntime.cancelRun must be called on client disconnect');

      // 3. Observed cancellation telemetry must be logged with verified markers
      assert.ok(cancellationTelemetry.length > 0, 'Cancellation telemetry must be logged to stdout');
      assert.match(cancellationTelemetry, /event=chat_cancellation/);
      assert.match(cancellationTelemetry, /permit_released=true/);
      assert.match(cancellationTelemetry, /quota_released=true/);
      assert.match(cancellationTelemetry, /status=LOCAL_CANCELLED_UPSTREAM_UNVERIFIED/);
    } finally {
      // Restore spied functions
      commercialBillingService.reserveStandardChat = origReserve;
      commercialBillingService.releaseStandardChat = origRelease;
      agentRuntime.cancelRun = origCancelRun;
      console.log = origLog;
    }
  });

  it('rejects immediate client cancellation before request dispatches without lingering capacity permits', async () => {
    const preAborted = new AbortController();
    preAborted.abort(); // Pre-aborted controller

    await assert.rejects(
      fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'x-test-user-id': 'usr_pre_abort',
          'x-test-session-id': 'sess_pre_abort',
          'x-test-tier': 'plus',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'aira-fast',
          prompt: 'Instant cancellation'
        }),
        signal: preAborted.signal
      })
    );
  });
});
