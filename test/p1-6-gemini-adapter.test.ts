import { test } from 'node:test';
import assert from 'node:assert';
import { GeminiAdapter } from '../packages/model-router/src/gemini-adapter.js';

test('GeminiAdapter - basic initialization and provider identification', () => {
  const adapter = new GeminiAdapter('dummy-key', 'gemini-2.5-flash');
  assert.strictEqual(adapter.provider, 'gemini');
  assert.strictEqual(adapter.modelName, 'gemini-2.5-flash');
});

test('GeminiAdapter - formatMessages converts system, user, and assistant roles correctly', () => {
  const adapter = new GeminiAdapter('dummy-key', 'gemini-2.5-flash');
  const messages = [
    { role: 'system' as const, content: 'You are AIRA Fast assistant.' },
    { role: 'user' as const, content: 'Hello' },
    { role: 'assistant' as const, content: 'Hi there!' },
    { role: 'user' as const, content: 'How are you?' }
  ];

  const payload = adapter.formatRequestPayload(messages, {
    model: 'gemini-2.5-flash',
    temperature: 0.7,
    maxTokens: 256
  });

  assert.strictEqual(payload.systemInstruction?.parts[0]?.text, 'You are AIRA Fast assistant.');
  assert.strictEqual(payload.contents.length, 3);
  assert.strictEqual(payload.contents[0].role, 'user');
  assert.strictEqual(payload.contents[0].parts[0].text, 'Hello');
  assert.strictEqual(payload.contents[1].role, 'model');
  assert.strictEqual(payload.contents[1].parts[0].text, 'Hi there!');
  assert.strictEqual(payload.contents[2].role, 'user');
  assert.strictEqual(payload.contents[2].parts[0].text, 'How are you?');
  assert.strictEqual(payload.generationConfig.temperature, 0.7);
  assert.strictEqual(payload.generationConfig.maxOutputTokens, 256);
});

test('GeminiAdapter - parseSSEChunk extracts text deltas and usage metadata correctly', () => {
  const adapter = new GeminiAdapter('dummy-key', 'gemini-2.5-flash');
  const sampleSSE = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text: 'Hello, world!' }],
          role: 'model'
        },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 3,
      totalTokenCount: 8
    }
  });

  const parsed = adapter.parseSSELine(`data: ${sampleSSE}`);
  assert.ok(parsed);
  assert.strictEqual(parsed.text, 'Hello, world!');
  assert.strictEqual(parsed.usage?.promptTokens, 5);
  assert.strictEqual(parsed.usage?.completionTokens, 3);
});

test('GeminiAdapter - error sanitization hides API key if present in error message', () => {
  const adapter = new GeminiAdapter('AIzaSySecretKey12345', 'gemini-2.5-flash');
  const sanitized = adapter.sanitizeErrorMessage(
    'Error fetching https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSySecretKey12345: 403 Forbidden'
  );
  assert.ok(!sanitized.includes('AIzaSySecretKey12345'));
  assert.ok(sanitized.includes('[REDACTED]'));
});
