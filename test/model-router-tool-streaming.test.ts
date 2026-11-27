import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIAdapter,
  AnthropicAdapter,
  DeterministicMockAdapter,
  ResilientModelAdapter,
  ProviderHealthTracker,
  protectInferenceAdapter,
  withInferencePrincipal,
  PrivateBetaCapacityGuard,
  type ModelAdapter,
  type ModelStreamDelta,
  type ModelToolDefinition,
  type ChatMessageInput,
} from '../packages/model-router/src/index.js';
import { GeminiAdapter } from '../packages/model-router/src/gemini-adapter.js';
import type { ModelPolicy } from '../packages/contracts/src/index.js';

const WEATHER_TOOL: ModelToolDefinition = {
  name: 'get_weather',
  description: 'Get current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      units: { type: 'string', enum: ['c', 'f'] },
    },
    required: ['city'],
  },
};

const CHART_TOOL: ModelToolDefinition = {
  name: 'render_chart',
  description: 'Render a structured chart configuration.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      title: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['kind', 'title'],
  },
};

function createSseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function withMockedFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const basePolicy: ModelPolicy = {
  model: 'gpt-4o',
  maxTokens: 1024,
  temperature: 0,
  extendedThinking: false,
  timeoutMs: 10000,
  tools: [WEATHER_TOOL, CHART_TOOL],
  toolChoice: 'auto',
};

describe('ModelRouter Normalized Tool-Call Streaming (Phase 0 TDD)', () => {
  it('1. preserves pure text streaming without tools', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    let sentBody: any = null;
    const chunks: ModelStreamDelta[] = [];

    const result = await withMockedFetch(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body || '{}'));
      return createSseResponse([
        'data: {"model":"gpt-4o","choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"model":"gpt-4o","choices":[{"delta":{"content":"AIRA"}}]}\n\n',
        'data: {"model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }, () => adapter.stream(
      [{ role: 'user', content: 'Say hello' }],
      { model: 'gpt-4o', maxTokens: 256, temperature: 0, extendedThinking: false, timeoutMs: 5000 },
      delta => chunks.push(delta)
    ));

    assert.equal(sentBody.tools, undefined);
    assert.equal(result.text, 'Hello AIRA');
    assert.equal(result.toolCalls, undefined);
    assert.deepEqual(
      chunks.filter(c => typeof c.text === 'string').map(c => c.text),
      ['Hello ', 'AIRA']
    );
  });

  it('2. normalizes single fragmented OpenAI tool call with zero visible text', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    let sentBody: any = null;
    const deltas: ModelStreamDelta[] = [];

    const result = await withMockedFetch(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body || '{}'));
      return createSseResponse([
        'data: {"model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
        'data: {"model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Mum"}}]}}]}\n\n',
        'data: {"model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"bai\\",\\"units\\":\\"c\\"}"}}]}}]}\n\n',
        'data: {"model":"gpt-4o","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":25,"completion_tokens":14,"total_tokens":39}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }, () => adapter.stream([{ role: 'user', content: 'Weather in Mumbai?' }], basePolicy, d => deltas.push(d)));

    assert.equal(Array.isArray(sentBody.tools), true);
    assert.equal(sentBody.tools.length, 2);
    assert.equal(sentBody.tool_choice, 'auto');
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls, [
      { id: 'call_1', name: 'get_weather', arguments: { city: 'Mumbai', units: 'c' } },
    ]);

    const types = deltas.map(d => d.type);
    assert.ok(types.includes('tool_call_start'));
    assert.ok(types.includes('tool_call_delta'));
    assert.ok(types.includes('tool_call_end'));
    assert.ok(types.includes('done'));
    const endEvt = deltas.find(d => d.type === 'tool_call_end');
    assert.deepEqual(endEvt?.arguments, { city: 'Mumbai', units: 'c' });
    assert.equal(endEvt?.toolCallId, 'call_1');
    assert.equal(endEvt?.toolName, 'get_weather');
  });

  it('3. handles multiple concurrent interleaved tool calls by index without cross-contamination', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    const deltas: ModelStreamDelta[] = [];

    const result = await withMockedFetch(async () => createSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","type":"function","function":{"name":"render_chart","arguments":"{\\"ki"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Delhi\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"nd\\":\\"bar\\",\\"title\\":\\"Rev\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]), () => adapter.stream([{ role: 'user', content: 'Delhi weather and chart' }], basePolicy, d => deltas.push(d)));

    assert.equal(result.toolCalls?.length, 2);
    assert.deepEqual(result.toolCalls?.[0], { id: 'c0', name: 'get_weather', arguments: { city: 'Delhi' } });
    assert.deepEqual(result.toolCalls?.[1], { id: 'c1', name: 'render_chart', arguments: { kind: 'bar', title: 'Rev' } });
    assert.equal(deltas.filter(d => d.type === 'tool_call_start').length, 2);
    assert.equal(deltas.filter(d => d.type === 'tool_call_end').length, 2);
  });

  it('4. rejects malformed JSON tool arguments and never exposes them in executable toolCalls', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    const deltas: ModelStreamDelta[] = [];

    const result = await withMockedFetch(async () => createSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"bad_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Pune"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"good_2","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Goa\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]), () => adapter.stream([{ role: 'user', content: 'Pune and Goa weather' }], basePolicy, d => deltas.push(d)));

    assert.deepEqual(result.toolCalls, [
      { id: 'good_2', name: 'get_weather', arguments: { city: 'Goa' } },
    ]);
    assert.equal(result.invalidToolCalls?.length, 1);
    assert.equal(result.invalidToolCalls?.[0].code, 'MALFORMED_TOOL_ARGUMENTS');
    assert.equal(result.invalidToolCalls?.[0].id, 'bad_1');
    const errEvt = deltas.find(d => d.type === 'tool_call_validation_error');
    assert.equal(errEvt?.validationError?.id, 'bad_1');
    assert.equal(deltas.some(d => d.type === 'tool_call_end' && d.toolCallId === 'bad_1'), false);
  });

  it('5. rejects array/non-object tool arguments and missing tool names', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    const deltas: ModelStreamDelta[] = [];

    const result = await withMockedFetch(async () => createSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"arr_1","type":"function","function":{"name":"get_weather","arguments":"[1,2,3]"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"noname_2","type":"function","function":{"arguments":"{\\"city\\":\\"Leh\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Fallback answer."},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]), () => adapter.stream([{ role: 'user', content: 'test' }], basePolicy, d => deltas.push(d)));

    assert.equal(result.toolCalls, undefined);
    assert.equal(result.invalidToolCalls?.length, 2);
    assert.equal(result.invalidToolCalls?.[0].code, 'MALFORMED_TOOL_ARGUMENTS');
    assert.equal(result.invalidToolCalls?.[1].code, 'MISSING_TOOL_NAME');
    assert.equal(result.text, 'Fallback answer.');
  });

  it('6. assigns deterministic synthetic IDs when provider omits tool call IDs and tolerates duplicate frames', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    const deltas: ModelStreamDelta[] = [];

    const result = await withMockedFetch(async () => createSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Kochi\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      // Duplicate terminal finish_reason frame before [DONE] must not double-emit tool_call_end
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]), () => adapter.stream([{ role: 'user', content: 'Kochi' }], basePolicy, d => deltas.push(d)));

    assert.equal(result.toolCalls?.length, 1);
    assert.ok(result.toolCalls![0].id.startsWith('call_'));
    assert.deepEqual(result.toolCalls![0].arguments, { city: 'Kochi' });
    assert.equal(deltas.filter(d => d.type === 'tool_call_end').length, 1);
  });

  it('7. fails explicitly on interrupted/truncated stream with partial tool call', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    const deltas: ModelStreamDelta[] = [];

    await assert.rejects(
      () => withMockedFetch(async () => createSseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"cut_1","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Chen"}}]}}]}\n\n',
      ]), () => adapter.stream([{ role: 'user', content: 'Chennai' }], basePolicy, d => deltas.push(d))),
      /closed before its terminal event/i
    );
    assert.equal(deltas.some(d => d.type === 'tool_call_end'), false);
  });

  it('8. GeminiAdapter streams and completes normalized functionCall parts with synthetic IDs', async () => {
    const adapter = new GeminiAdapter('AIza-test', 'gemini-2.5-pro');
    let sentBody: any = null;
    const deltas: ModelStreamDelta[] = [];

    const res = await withMockedFetch(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body || '{}'));
      return createSseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Jaipur","units":"c"}}}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"totalTokenCount":20}}\n\n',
      ]);
    }, () => adapter.stream(
      [{ role: 'user', content: 'Weather in Jaipur' }],
      { ...basePolicy, model: 'gemini-2.5-pro', toolChoice: { type: 'function', name: 'get_weather' } },
      d => deltas.push(d)
    ));

    assert.equal(sentBody.tools[0].functionDeclarations.length, 2);
    assert.equal(sentBody.toolConfig.functionCallingConfig.mode, 'ANY');
    assert.deepEqual(sentBody.toolConfig.functionCallingConfig.allowedFunctionNames, ['get_weather']);
    assert.equal(res.toolCalls?.length, 1);
    assert.equal(res.toolCalls?.[0].name, 'get_weather');
    assert.deepEqual(res.toolCalls?.[0].arguments, { city: 'Jaipur', units: 'c' });
    assert.ok(deltas.some(d => d.type === 'tool_call_start'));
    assert.ok(deltas.some(d => d.type === 'tool_call_end'));
    assert.ok(deltas.some(d => d.type === 'done'));
  });

  it('9. AnthropicAdapter streams SSE content_block_start/input_json_delta/content_block_stop into normalized tool calls', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', 'https://api.anthropic.com/v1');
    let sentBody: any = null;
    const deltas: ModelStreamDelta[] = [];

    const res = await withMockedFetch(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body || '{}'));
      return createSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-5-haiku-20241022","usage":{"input_tokens":30,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"get_weather"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Ind"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ore\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":19}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    }, () => adapter.stream(
      [{ role: 'user', content: 'Indore weather' }],
      { ...basePolicy, model: 'aira-fast' },
      d => deltas.push(d)
    ));

    assert.equal(sentBody.stream, true);
    assert.equal(sentBody.tools[0].name, 'get_weather');
    assert.ok(sentBody.tools[0].input_schema);
    assert.equal(res.toolCalls?.length, 1);
    assert.deepEqual(res.toolCalls?.[0], { id: 'toolu_01', name: 'get_weather', arguments: { city: 'Indore' } });
    assert.equal(res.usage.promptTokens, 30);
    assert.equal(res.usage.completionTokens, 19);
    assert.ok(deltas.some(d => d.type === 'tool_call_end' && d.toolCallId === 'toolu_01'));
  });

  it('10. ResilientModelAdapter falls back before first tool/text event and locks stickiness after tool_call_start', async () => {
    const tracker = new ProviderHealthTracker();
    const failingPrimary: ModelAdapter = {
      provider: 'groq',
      async complete() { throw new Error('down'); },
      async stream() {
        const err: any = new Error('503 Service Unavailable');
        err.status = 503;
        throw err;
      },
    };
    const healthyFallback: ModelAdapter = {
      provider: 'gemini',
      async complete() { throw new Error('unused'); },
      async stream(_m, _p, onChunk) {
        onChunk({ type: 'tool_call_start', toolCallId: 'fb_1', toolCallIndex: 0, toolName: 'get_weather' });
        onChunk({ type: 'tool_call_delta', toolCallId: 'fb_1', toolCallIndex: 0, argumentsDelta: '{"city":"Surat"}' });
        onChunk({ type: 'tool_call_end', toolCallId: 'fb_1', toolCallIndex: 0, toolName: 'get_weather', arguments: { city: 'Surat' } });
        return {
          text: '',
          toolCalls: [{ id: 'fb_1', name: 'get_weather', arguments: { city: 'Surat' } }],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          model: 'gemini-3.5-flash-lite',
          outboundModel: 'gemini-3.5-flash-lite',
        };
      },
    };

    const provenanceEvents: any[] = [];
    const resilient = new ResilientModelAdapter(failingPrimary, healthyFallback, tracker);
    const result = await resilient.stream(
      [{ role: 'user', content: 'Surat weather' }],
      basePolicy,
      () => {},
      { onProvenance: p => provenanceEvents.push(p), firstTokenTimeoutMs: 500 }
    );
    assert.equal(result.toolCalls?.[0].arguments.city, 'Surat');
    assert.equal(provenanceEvents.some(p => p.fallbackOccurred === true && p.executedProvider === 'gemini'), true);

    // Mid-stream failure AFTER tool_call_start must NOT trigger fallback replay
    let fallbackCalled = false;
    const midStreamFailPrimary: ModelAdapter = {
      provider: 'groq',
      async complete() { throw new Error('unused'); },
      async stream(_m, _p, onChunk) {
        onChunk({ type: 'tool_call_start', toolCallId: 'mid_1', toolCallIndex: 0, toolName: 'get_weather' });
        throw new Error('MIDSTREAM_RESET');
      },
    };
    const shouldNotBeCalledFallback: ModelAdapter = {
      provider: 'gemini',
      async complete() { throw new Error('unused'); },
      async stream() {
        fallbackCalled = true;
        return { text: 'bad duplicate', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    const stickyAdapter = new ResilientModelAdapter(midStreamFailPrimary, shouldNotBeCalledFallback, new ProviderHealthTracker());
    await assert.rejects(
      () => stickyAdapter.stream([{ role: 'user', content: 'fail mid' }], basePolicy, () => {}),
      /MIDSTREAM_RESET/
    );
    assert.equal(fallbackCalled, false);
  });

  it('11. supports AbortSignal cancellation and DeterministicMockAdapter native toolCalls without breaking protectInferenceAdapter', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    const controller = new AbortController();
    controller.abort(new Error('USER_CANCELLED'));

    await assert.rejects(
      () => adapter.stream([{ role: 'user', content: 'hi' }], basePolicy, () => {}, { signal: controller.signal }),
      /USER_CANCELLED/
    );

    const mockAdapter = new DeterministicMockAdapter();
    const guard = new PrivateBetaCapacityGuard({ maxConcurrentFastRequests: 5 });
    const protectedMock = protectInferenceAdapter(mockAdapter, guard);
    const deltas: ModelStreamDelta[] = [];
    const messages: ChatMessageInput[] = [{ role: 'user', content: 'run command echo hello' }];

    const mockResult = await withInferencePrincipal('user_phase0_test', () =>
      protectedMock.stream(
        messages,
        { ...basePolicy, model: 'aira-fast', tools: [{ name: 'system_shell', description: 'Run shell', parameters: { type: 'object' } }] },
        d => deltas.push(d)
      )
    );
    assert.equal(mockResult.toolCalls?.[0].name, 'system_shell');
    assert.deepEqual(mockResult.toolCalls?.[0].arguments, { command: 'echo hello' });
    assert.ok(deltas.some(d => d.type === 'tool_call_end' && d.toolName === 'system_shell'));
  });

  it('12. degrades gracefully when provider ignores tools (unsupported tool calling) or emits mixed text + tool_calls', async () => {
    const adapter = new OpenAIAdapter('sk-test', 'https://integrate.api.nvidia.com/v1', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia');
    const deltas: ModelStreamDelta[] = [];

    const plainFallback = await withMockedFetch(async () => createSseResponse([
      'data: {"model":"nvidia/nemotron-3.5-lightning-30b-a3b","choices":[{"delta":{"content":"Unable to call tools directly; answer in text."},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]), () => adapter.stream([{ role: 'user', content: 'Weather?' }], basePolicy, d => deltas.push(d)));

    assert.equal(plainFallback.text, 'Unable to call tools directly; answer in text.');
    assert.equal(plainFallback.toolCalls, undefined);

    // Mixed text + tool_calls in same stream
    const mixedDeltas: ModelStreamDelta[] = [];
    const mixedResult = await withMockedFetch(async () => createSseResponse([
      'data: {"choices":[{"delta":{"content":"Checking weather now. "}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"mix_1","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Pune\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]), () => adapter.stream([{ role: 'user', content: 'Pune weather' }], basePolicy, d => mixedDeltas.push(d)));

    assert.equal(mixedResult.text, 'Checking weather now. ');
    assert.deepEqual(mixedResult.toolCalls, [{ id: 'mix_1', name: 'get_weather', arguments: { city: 'Pune' } }]);
  });

  it('13. enforces first-token timeout cleanly and preserves ToolGateway idempotency safety by excluding invalid tool calls', async () => {
    const slowAdapter = new OpenAIAdapter('sk-test', 'https://api.openai.com/v1', 'gpt-4o', 'openai');
    await assert.rejects(
      () => withMockedFetch((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('Aborted')), { once: true });
      }), () => slowAdapter.stream(
        [{ role: 'user', content: 'slow' }],
        basePolicy,
        () => {},
        { firstTokenTimeoutMs: 40 }
      )),
      /FIRST_TOKEN_TIMEOUT/
    );

    // Malformed tool JSON in complete() also stays isolated in invalidToolCalls and never populates toolCalls
    const badComplete = await withMockedFetch(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{ id: 'bad_cmp', type: 'function', function: { name: 'get_weather', arguments: '{bad_json' } }],
        },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }), () => slowAdapter.complete([{ role: 'user', content: 'bad' }], basePolicy));

    assert.equal(badComplete.toolCalls, undefined);
    assert.equal(badComplete.invalidToolCalls?.[0].id, 'bad_cmp');
    assert.equal(badComplete.invalidToolCalls?.[0].code, 'MALFORMED_TOOL_ARGUMENTS');
  });

  it('14. AnthropicAdapter preserves extendedThinking, merges consecutive tool results, enforces firstTokenTimeoutMs, and surfaces SSE errors', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', 'https://api.anthropic.com/v1');
    let sentBody: any = null;
    await withMockedFetch(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body || '{}'));
      return createSseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Planning..."}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Merged ok"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    }, () => adapter.stream(
      [
        { role: 'user', content: 'Check weather and chart' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'get_weather', arguments: { city: 'Goa' } },
            { id: 't2', name: 'render_chart', arguments: { kind: 'bar', title: 'R' } },
          ],
        },
        { role: 'tool', toolCallId: 't1', content: '{"temp":30}' },
        { role: 'tool', toolCallId: 't2', content: '{"ok":true}' },
      ],
      { model: 'aira-auto', maxTokens: 4096, temperature: 0.2, extendedThinking: true, reasoningBudget: 1500, timeoutMs: 5000 },
      () => {}
    ));

    assert.equal(sentBody.thinking.type, 'enabled');
    assert.equal(sentBody.temperature, 1);
    assert.equal(sentBody.messages.length, 3); // user -> assistant -> single merged user with 2 tool_results
    assert.equal(sentBody.messages[2].role, 'user');
    assert.equal(sentBody.messages[2].content.length, 2);

    // Timeout enforcement on stalled Anthropic stream
    await assert.rejects(
      () => withMockedFetch((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('Aborted')), { once: true });
      }), () => adapter.stream([{ role: 'user', content: 'hang' }], { ...basePolicy, model: 'aira-fast' }, () => {}, { firstTokenTimeoutMs: 35 })),
      /FIRST_TOKEN_TIMEOUT/
    );

    // Explicit SSE error frame handling
    await assert.rejects(
      () => withMockedFetch(async () => createSseResponse([
        'event: error\ndata: {"type":"error","error":{"message":"overloaded_error"}}\n\n',
      ]), () => adapter.stream([{ role: 'user', content: 'err' }], { ...basePolicy, model: 'aira-fast' }, () => {})),
      /overloaded_error/
    );
  });

  it('15. GeminiAdapter rejects truncated mid-frame SSE streams and isolates invalid functionCall objects', async () => {
    const adapter = new GeminiAdapter('AIza-test', 'gemini-2.5-pro');
    const deltas: ModelStreamDelta[] = [];

    await assert.rejects(
      () => withMockedFetch(async () => createSseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Jaipur"}}}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"cut_mid_json',
      ]), () => adapter.stream([{ role: 'user', content: 'truncated' }], basePolicy, d => deltas.push(d))),
      /truncated before completing SSE frame/i
    );
    assert.ok(deltas.some(d => d.type === 'tool_call_validation_error' && d.validationError?.code === 'INCOMPLETE_TOOL_CALL'));

    const invalidResult = await withMockedFetch(async () => createSseResponse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":[1,2]}},{"text":"Safe text."}]}}]}\n\n',
    ]), () => adapter.stream([{ role: 'user', content: 'invalid fc' }], basePolicy, () => {}));

    assert.equal(invalidResult.toolCalls, undefined);
    assert.equal(invalidResult.invalidToolCalls?.[0].code, 'MALFORMED_TOOL_ARGUMENTS');
    assert.equal(invalidResult.text, 'Safe text.');
  });
});
