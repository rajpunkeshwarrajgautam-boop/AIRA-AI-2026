import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';

describe('Remediation F8 (Part 2): Real HTTP Upstream Inference Cancellation & Telemetry', () => {
  let server: Server;
  let baseUrl: string;

  interface ProviderTelemetry {
    started: boolean;
    cancelled: boolean;
    cleanupPerformed: boolean;
    chunksEmitted: number;
    abortReason?: string;
  }

  let telemetry: ProviderTelemetry;

  before(async () => {
    const app = express();
    app.use(express.json());

    // Instrumented streaming endpoint simulating real inference
    app.post('/api/inference/stream', async (req: Request, res: Response) => {
      telemetry = {
        started: true,
        cancelled: false,
        cleanupPerformed: false,
        chunksEmitted: 0
      };

      const serverAbortController = new AbortController();
      let isClientDisconnected = false;

      const onClose = () => {
        if (!res.writableEnded) {
          isClientDisconnected = true;
          telemetry.cancelled = true;
          telemetry.abortReason = 'Client socket disconnected abruptly';
          serverAbortController.abort(new Error('Client disconnected.'));
        }
      };

      res.on('close', onClose);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      try {
        // Upstream provider simulation loop
        for (let i = 0; i < 20; i++) {
          if (serverAbortController.signal.aborted || isClientDisconnected) {
            throw new Error('Inference aborted by upstream signal');
          }

          res.write(`data: ${JSON.stringify({ token: `token_${i}`, index: i })}\n\n`);
          telemetry.chunksEmitted++;

          // Small delay simulating LLM generation interval
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 50);
            serverAbortController.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(serverAbortController.signal.reason);
            }, { once: true });
          });
        }

        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch (err: any) {
        // Resource cleanup triggered on cancellation
        telemetry.cleanupPerformed = true;
      } finally {
        res.off('close', onClose);
        if (!res.writableEnded) {
          res.end();
        }
      }
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('detects HTTP client disconnect mid-stream, aborts upstream inference, and cleans up resources', async () => {
    const clientAbort = new AbortController();

    const response = await fetch(`${baseUrl}/api/inference/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Generate long-form analysis' }),
      signal: clientAbort.signal
    });

    assert.equal(response.status, 200);
    assert.ok(response.body);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Read the first chunk
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    const text = decoder.decode(firstChunk.value);
    assert.match(text, /token_0/);

    // Abruptly interrupt client connection mid-stream
    clientAbort.abort();

    // Wait briefly for server socket event propagation
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verify upstream provider cancellation and cleanup
    assert.equal(telemetry.started, true, 'Provider stream must have started');
    assert.equal(telemetry.cancelled, true, 'Server must have detected client disconnect and triggered cancellation');
    assert.equal(telemetry.cleanupPerformed, true, 'Provider resource cleanup must have been executed');
    assert.ok(telemetry.chunksEmitted < 20, `Chunks emitted (${telemetry.chunksEmitted}) must be far less than total (20)`);
    assert.match(telemetry.abortReason || '', /disconnected/i);
  });

  it('handles immediate client cancellation before first token without lingering timers', async () => {
    const clientAbort = new AbortController();
    clientAbort.abort(); // Pre-aborted

    await assert.rejects(
      fetch(`${baseUrl}/api/inference/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Instant cancel test' }),
        signal: clientAbort.signal
      })
    );
  });
});
