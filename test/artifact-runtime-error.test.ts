import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactRepairPrompt, normalizeArtifactRuntimeError } from '../src/utils/artifactRuntimeError';
import { generateArtifactSandboxHtml } from '../src/utils/artifactSandbox';

test('runtime error payloads enforce type, size, and position limits', () => {
  assert.equal(normalizeArtifactRuntimeError({ message: 14 }), null);
  assert.equal(normalizeArtifactRuntimeError(['broken']), null);
  const error = normalizeArtifactRuntimeError({ message: 'broken\nframe', line: 12, column: -2, stack: 'x'.repeat(9000), injected: 'IGNORED' });
  assert.equal(error?.message, 'broken frame');
  assert.equal(error?.line, 12);
  assert.equal(error?.column, undefined);
  assert.equal(error?.stack?.length, 2000);
  assert.doesNotMatch(JSON.stringify(error), /IGNORED/);
});

test('repair prompt is a reviewable draft and never auto-executes or auto-approves', () => {
  const prompt = createArtifactRepairPrompt('Orbit demo', { message: 'Cannot read properties of undefined', line: 4 });
  assert.match(prompt, /reported by its isolated preview frame/);
  assert.match(prompt, /Orbit demo/);
  assert.match(prompt, /Line: 4/);
  assert.match(prompt, /wait for approval before destructive actions/);
});

test('sandbox bridge emits nonce-tagged structured errors on exceptions and promise rejections', () => {
  const html = generateArtifactSandboxHtml({ id: '1', title: 'Test', type: 'text/html', content: '<div>Hello</div>', version: 1, versions: [] }, '<div>Hello</div>', false, 'test-nonce');
  assert.match(html, /AIRA_ARTIFACT_RUNTIME_ERROR/);
  assert.match(html, /test-nonce/);
  assert.match(html, /unhandledrejection/);
});
