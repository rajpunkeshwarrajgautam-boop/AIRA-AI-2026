import { test } from 'node:test';
import assert from 'node:assert';
import { GeminiAdapter } from '../packages/model-router/src/gemini-adapter.js';

test('GeminiAdapter - basic initialization and provider identification', () => {
  const adapter = new GeminiAdapter('dummy-key');
  assert.strictEqual(adapter.provider, 'gemini');
  assert.strictEqual(adapter.modelName, 'gemini-3.5-flash-lite');
});

test('GeminiAdapter - formatMessages converts roles, merges consecutive roles, and includes safetySettings', () => {
  const adapter = new GeminiAdapter('dummy-key', 'gemini-3.5-flash-lite');
  const messages = [
    { role: 'system' as const, content: 'You are AIRA Fast assistant.' },
    { role: 'user' as const, content: 'Hello' },
    { role: 'user' as const, content: 'And another thing' },
    { role: 'assistant' as const, content: 'Hi there!' },
    { role: 'user' as const, content: 'How are you?' }
  ];

  const payload = adapter.formatRequestPayload(messages, {
    model: 'gemini-3.5-flash-lite',
    temperature: 0.7,
    maxTokens: 256
  });

  assert.strictEqual(payload.systemInstruction?.parts[0]?.text, 'You are AIRA Fast assistant.');
  // User messages 1 and 2 should be merged so contents alternate strictly
  assert.strictEqual(payload.contents.length, 3);
  assert.strictEqual(payload.contents[0].role, 'user');
  assert.strictEqual(payload.contents[0].parts.length, 2);
  assert.strictEqual(payload.contents[0].parts[0].text, 'Hello');
  assert.strictEqual(payload.contents[0].parts[1].text, 'And another thing');
  assert.strictEqual(payload.contents[1].role, 'model');
  assert.strictEqual(payload.contents[1].parts[0].text, 'Hi there!');
  assert.strictEqual(payload.contents[2].role, 'user');
  assert.strictEqual(payload.contents[2].parts[0].text, 'How are you?');
  assert.strictEqual(payload.generationConfig.temperature, 0.7);
  assert.strictEqual(payload.generationConfig.maxOutputTokens, 256);
  assert.ok(Array.isArray(payload.safetySettings));
  assert.strictEqual(payload.safetySettings?.length, 4);
});

test('GeminiAdapter - parseSSEChunk extracts text deltas, usage metadata, and safety refusals correctly', () => {
  const adapter = new GeminiAdapter('dummy-key', 'gemini-3.5-flash-lite');
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

  // Test safety block response
  const safetySSE = JSON.stringify({
    candidates: [
      {
        finishReason: 'SAFETY',
        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }]
      }
    ]
  });
  const safetyParsed = adapter.parseSSELine(`data: ${safetySSE}`);
  assert.ok(safetyParsed);
  assert.strictEqual(safetyParsed.isSafetyBlock, true);
  assert.ok(safetyParsed.text?.includes('safety content guidelines'));
});

test('GeminiAdapter - error sanitization hides API key if present in error message', () => {
  const adapter = new GeminiAdapter('AIzaSySecretKey12345', 'gemini-3.5-flash-lite');
  const sanitized = adapter.sanitizeErrorMessage(
    'Error fetching https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSySecretKey12345: 403 Forbidden'
  );
  assert.ok(!sanitized.includes('AIzaSySecretKey12345'));
  assert.ok(sanitized.includes('[REDACTED]'));
});
