import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Artifact } from '../src/types';
import { createStreamingArtifactDetector } from '../src/utils/artifactParser';
import {
  createStreamingArtifactReconciler,
  createStreamingFenceArtifactDetector,
} from '../src/utils/streamingArtifactParser';

const artifact = (content: string, complete = false, id = 'art-1'): Artifact => ({
  id,
  title: 'Test Artifact',
  type: 'text/html',
  language: 'html',
  content,
  version: 1,
  versions: complete ? [{ version: 1, content, timestamp: Date.now() }] : [],
});

test('both tagged envelope names survive partial opening and closing delimiters', () => {
  for (const label of ['antArtifact', 'airaArtifact']) {
    const detector = createStreamingArtifactDetector();
    const first = detector.processChunk(`Before <${label.slice(0, 6)}`);
    assert.equal(first.textToEmit, 'Before ');
    const second = detector.processChunk(`${label.slice(6)} identifier="solar" type="text/html" title="Solar">Hello`);
    assert.equal(second.textToEmit, '');
    assert.equal(second.artifactUpdate?.content, 'Hello');
    detector.processChunk(`</${label.slice(0, 5)}`);
    const last = detector.processChunk(`${label.slice(5)}>After`);
    assert.equal(last.artifactUpdate?.content, 'Hello');
    assert.equal(last.artifactUpdate?.versions.length, 1);
    assert.equal(last.textToEmit, 'After');
    assert.equal(detector.flush().remainingText, '');
  }
});

test('fenced HTML and SVG remain visible as chat text and also produce stable artifact versions', () => {
  const fences = createStreamingFenceArtifactDetector();
  assert.equal(fences.processChunk('Example:\n```ht').length, 0);
  const htmlUpdates = fences.processChunk('ml\n<section>ok</section>\n');
  assert.equal(htmlUpdates.at(-1)?.content, '<section>ok</section>\n');
  assert.equal(htmlUpdates.at(-1)?.versions.length, 0);
  const [completed] = fences.processChunk('```\n');
  assert.equal(completed.id, 'fenced-artifact-1');
  assert.equal(completed.type, 'text/html');
  assert.equal(completed.content, '<section>ok</section>');
  assert.equal(completed.versions[0].content, completed.content);

  fences.processChunk('```svg\n<svg />\n');
  const [svg] = fences.processChunk('```\n');
  assert.equal(svg.id, 'fenced-artifact-2');
  assert.equal(svg.type, 'image/svg+xml');
});

test('incomplete and unsupported code fences never fabricate a completed artifact', () => {
  const fences = createStreamingFenceArtifactDetector();
  assert.deepEqual(fences.processChunk('```js\nalert(1)\n```\n'), []);
  const partial = fences.processChunk('```tsx\nexport default function App() {');
  assert.deepEqual(partial, []);
  const end = fences.flush();
  assert.equal(end[0].type, 'application/vnd.ant.react');
  assert.equal(end[0].versions.length, 0);
});

test('reconciler opens promptly and batches rapid partial snapshots', async () => {
  const seen: Artifact[] = [];
  const reconciler = createStreamingArtifactReconciler(a => seen.push(a), 60);
  reconciler.publish(artifact(''));
  reconciler.publish(artifact('a'));
  reconciler.publish(artifact('ab'));
  assert.deepEqual(seen.map(a => a.content), ['']);
  await new Promise(resolve => setTimeout(resolve, 85));
  assert.deepEqual(seen.map(a => a.content), ['', 'ab']);
  reconciler.cancel();
});

test('completed versions deliver immediately and do not replay stale snapshots', async () => {
  const seen: Artifact[] = [];
  const reconciler = createStreamingArtifactReconciler(a => seen.push(a), 80);
  reconciler.publish(artifact(''));
  reconciler.publish(artifact('partial'));
  reconciler.publish(artifact('final', true));
  assert.deepEqual(seen.map(a => a.content), ['', 'final']);
  reconciler.publish(artifact('final', true));
  reconciler.flush();
  await new Promise(resolve => setTimeout(resolve, 105));
  assert.equal(seen.length, 2);
  assert.equal(seen[1].versions.length, 1);
});

test('cancellation discards pending updates and no delayed callback survives', async () => {
  const seen: Artifact[] = [];
  const reconciler = createStreamingArtifactReconciler(a => seen.push(a), 60);
  reconciler.publish(artifact(''));
  reconciler.publish(artifact('secret partial'));
  reconciler.cancel();
  reconciler.publish(artifact('after cancellation', true));
  await new Promise(resolve => setTimeout(resolve, 85));
  assert.deepEqual(seen.map(a => a.content), ['']);
});

test('switching artifact IDs delivers the last pending snapshot before the new artifact', () => {
  const seen: Artifact[] = [];
  const reconciler = createStreamingArtifactReconciler(a => seen.push(a), 100);
  reconciler.publish(artifact('', false, 'first'));
  reconciler.publish(artifact('latest first', false, 'first'));
  reconciler.publish(artifact('', false, 'second'));
  assert.deepEqual(seen.map(a => [a.id, a.content]), [
    ['first', ''], ['first', 'latest first'], ['second', ''],
  ]);
  reconciler.cancel();
});
