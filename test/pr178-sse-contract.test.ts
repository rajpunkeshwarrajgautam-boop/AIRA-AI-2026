import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompletedSse } from './helpers/pr178-sse-contract.js';
import { assertPr178StagingDestination } from './helpers/pr178-staging-host-guard.js';

const success = [
  'event: run_started\ndata: {"runId":"safe"}',
  'event: model_provenance\ndata: {"provider":"test"}',
  'event: content_delta\ndata: {"text":"42"}',
  'event: done\ndata: [DONE]'
].join('\n\n') + '\n\n';

test('accepts completed SSE with useful answer', () => {
  assert.equal(assertCompletedSse(success, 'fixture'), '42');
});

test('rejects disconnected stream before done', () => {
  assert.throws(() => assertCompletedSse(success.replace('event: done\ndata: [DONE]', ''), 'truncated'), /missing terminal done/);
});

test('rejects a failure event even with a final done marker', () => {
  const failed = success.replace('event: done\ndata: [DONE]', 'event: run_failed\ndata: {"error":"failed"}\n\nevent: done\ndata: [DONE]');
  assert.throws(() => assertCompletedSse(failed, 'failed'), /failure or incomplete run/);
});

test('rejects SSE without model routing evidence', () => {
  assert.throws(() => assertCompletedSse(success.replace('event: model_provenance\ndata: {"provider":"test"}\n\n', ''), 'no route'), /missing routing metadata/);
});

test('rejects empty model content', () => {
  assert.throws(() => assertCompletedSse(success.replace('{"text":"42"}', '{"text":""}'), 'empty'), /empty answer/);
});

test('rejects malformed content payload', () => {
  assert.throws(() => assertCompletedSse(success.replace('{"text":"42"}', '{"delta":42}'), 'bad payload'), /invalid content delta/);
});

test('parses CRLF-delimited streams', () => {
  assert.equal(assertCompletedSse(success.replace(/\n/g, '\r\n'), 'crlf'), '42');
});

test('certification guard accepts the exact staging destination', () => {
  assert.doesNotThrow(() => assertPr178StagingDestination('https://staging.virexaaiventures.com'));
});
test('certification guard rejects production or altered staging origin', () => {
  assert.throws(() => assertPr178StagingDestination('https://aira-ai-2026.vercel.app'), /DESTINATION_REJECTED/);
  assert.throws(() => assertPr178StagingDestination('http://staging.virexaaiventures.com'), /DESTINATION_REJECTED/);
  assert.throws(() => assertPr178StagingDestination('https://staging.virexaaiventures.com/api/version'), /DESTINATION_REJECTED/);
});
