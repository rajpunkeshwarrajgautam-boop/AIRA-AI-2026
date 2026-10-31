import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAdapter, isModelMatch } from '../../packages/model-router/src/index.js';

const model = 'nvidia/llama-3.1-nemotron-70b-instruct';
const policy = { model, maxTokens: 100, temperature: 0.2, extendedThinking: false } as any;
const messages = [{ role: 'user' as const, content: 'Hi' }];
const encoder = new TextEncoder();

async function withProvider(chunks: (string | Uint8Array)[], run: (adapter: OpenAIAdapter) => Promise<void>, status = 200) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach(chunk => {
          if (typeof chunk === 'string') {
            controller.enqueue(encoder.encode(chunk));
          } else {
            controller.enqueue(chunk);
          }
        });
        controller.close();
      }
    }), { status });
  }) as typeof fetch;
  try { await run(new OpenAIAdapter('unit-test-only', 'https://integrate.api.nvidia.com/v1', model as any)); }
  finally { globalThis.fetch = originalFetch; }
}

describe('NVIDIA stream regression & edge-case suite', () => {
  it('streams split CRLF frames and preserves upstream model identity', async () => {
    const chunks = [
      'data: {"model":"nvidia/llama-3.1-nemotron-70b-instruct","choices":[{"delta":{"content":"Hel"}}]}\r',
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

  it('handles LF-only boundaries and multiple SSE events in a single network chunk', async () => {
    const singleChunk = 
      'data: {"choices":[{"delta":{"content":"One "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Two "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Three"}}]}\n\n' +
      'data: [DONE]\n\n';

    const deltas: string[] = [];
    await withProvider([singleChunk], async adapter => {
      const result = await adapter.stream(messages, policy, d => { if (d.text) deltas.push(d.text); });
      assert.deepEqual(deltas, ['One ', 'Two ', 'Three']);
      assert.equal(result.text, 'One Two Three');
      assert.equal(deltas.join(''), result.text, 'Accumulated text must exactly equal joined deltas');
    });
  });

  it('handles UTF-8 multibyte characters split across network chunks', async () => {
    // "✨" is 3 bytes: 0xE2 0x9C 0xA8
    const rawPrefix = encoder.encode('data: {"choices":[{"delta":{"content":"');
    const sparkleBytes = new Uint8Array([0xE2, 0x9C, 0xA8]);
    const rawSuffix = encoder.encode('"}}]}\n\ndata: [DONE]\n\n');

    // Split the 3-byte sparkle into 2 chunks
    const chunk1 = new Uint8Array(rawPrefix.length + 2);
    chunk1.set(rawPrefix, 0);
    chunk1.set(sparkleBytes.subarray(0, 2), rawPrefix.length);

    const chunk2 = new Uint8Array(1 + rawSuffix.length);
    chunk2.set(sparkleBytes.subarray(2, 3), 0);
    chunk2.set(rawSuffix, 1);

    const deltas: string[] = [];
    await withProvider([chunk1, chunk2], async adapter => {
      const result = await adapter.stream(messages, policy, d => { if (d.text) deltas.push(d.text); });
      assert.equal(result.text, '✨');
      assert.equal(deltas.join(''), '✨');
    });
  });

  it('preserves unconfirmed status if provider gives no model identity', async () => {
    await withProvider(['data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'], async adapter => {
      const result = await adapter.stream(messages, policy, () => {});
      assert.equal(result.model, undefined);
      assert.equal(isModelMatch(result.outboundModel, result.model), false);
    });
  });

  it('handles usage-only frame and ignores empty text chunks', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Result"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n'
    ];
    await withProvider(chunks, async adapter => {
      const result = await adapter.stream(messages, policy, () => {});
      assert.equal(result.text, 'Result');
      assert.equal(result.usage.totalTokens, 15);
      assert.equal(result.usage.promptTokens, 10);
      assert.equal(result.usage.completionTokens, 5);
    });
  });

  it('rejects interrupted provider responses without [DONE]', async () => {
    await withProvider(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], async adapter => {
      await assert.rejects(adapter.stream(messages, policy, () => {}), /closed before its terminal event/);
    });
  });

  it('rejects malformed event JSON safely', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {INVALID_JSON_HERE\n\n'
    ];
    await withProvider(chunks, async adapter => {
      await assert.rejects(adapter.stream(messages, policy, () => {}), (err: unknown) => {
        return err instanceof Error;
      });
    });
  });

  it('does not leak upstream error-body contents on HTTP 500', async () => {
    await withProvider(['private-user-content'], async adapter => {
      await assert.rejects(adapter.stream(messages, policy, () => {}), (err: unknown) => {
        assert.equal(String(err).includes('private-user-content'), false);
        assert.match(String(err), /HTTP 500/);
        return true;
      });
    }, 500);
  });
});
