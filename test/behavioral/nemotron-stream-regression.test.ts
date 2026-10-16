import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAdapter, isModelMatch } from '../../packages/model-router/src/index.js';

const model = 'nvidia/nemotron-3-super-120b-a12b';
const policy = { model, maxTokens: 100, temperature: 0.2, extendedThinking: false } as any;
const messages = [{ role: 'user' as const, content: 'Hi' }];
const encoder = new TextEncoder();

async function withProvider(chunks: string[], run: (adapter: OpenAIAdapter) => Promise<void>, status = 200) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      }
    }), { status });
  }) as typeof fetch;
  try { await run(new OpenAIAdapter('unit-test-only', 'https://integrate.api.nvidia.com/v1', model as any)); }
  finally { globalThis.fetch = originalFetch; }
}

describe('NVIDIA stream regression', () => {
  it('streams split CRLF frames and preserves upstream model identity', async () => {
    const chunks = [
      'data: {"model":"nvidia/nemotron-3-super-120b-a12b","choices":[{"delta":{"content":"Hel"}}]}\r',
      '\n\r\ndata: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n',
      'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6},"choices":[]}\n\ndata: [DONE]\n\n'
    ];
    const deltas: string[] = [];
    await withProvider(chunks, async adapter => {
      const result = await adapter.stream(messages, policy, d => { if (d.text) deltas.push(d.text); });
      assert.deepEqual(deltas, ['Hel', 'lo']);
      assert.equal(result.text, 'Hello');
      assert.equal(result.model, model);
      assert.equal(isModelMatch(result.outboundModel, result.model), true);
      assert.equal(result.usage.totalTokens, 6);
    });
  });

  it('preserves unconfirmed status if provider gives no model identity', async () => {
    await withProvider(['data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'], async adapter => {
      const result = await adapter.stream(messages, policy, () => {});
      assert.equal(result.model, undefined);
      assert.equal(isModelMatch(result.outboundModel, result.model), false);
    });
  });

  it('rejects interrupted provider responses', async () => {
    await withProvider(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], async adapter => {
      await assert.rejects(adapter.stream(messages, policy, () => {}), /closed before its terminal event/);
    });
  });

  it('does not leak upstream error-body contents', async () => {
    await withProvider(['private-user-content'], async adapter => {
      await assert.rejects(adapter.stream(messages, policy, () => {}), (err: unknown) => {
        assert.equal(String(err).includes('private-user-content'), false);
        assert.match(String(err), /HTTP 500/);
        return true;
      });
    }, 500);
  });
});
