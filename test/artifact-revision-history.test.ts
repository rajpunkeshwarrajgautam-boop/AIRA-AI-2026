import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollbackRevision, diffArtifactLines, reconcileArtifactRevision } from '../src/utils/artifactRevisions';
import type { Artifact } from '../src/types';

const v1: Artifact = {
  id: 'same-artifact', title: 'Counter', type: 'text/html', content: '<b>one</b>', version: 1,
  versions: [{ version: 1, content: '<b>one</b>', timestamp: 1 }],
};

test('reconciliation creates non-destructive versions from later agent turns', () => {
  const partial = reconcileArtifactRevision(v1, { ...v1, content: '<b>two', versions: [] });
  assert.equal(partial.version, 2);
  assert.deepEqual(partial.versions.map(version => version.version), [1]);
  const finalized = reconcileArtifactRevision(partial, {
    ...v1, content: '<b>two</b>', versions: [{ version: 1, content: '<b>two</b>', timestamp: 2 }],
  });
  assert.equal(finalized.version, 2);
  assert.deepEqual(finalized.versions.map(version => version.version), [1, 2]);
  assert.equal(finalized.versions[0].content, '<b>one</b>');
  assert.equal(finalized.versions[1].content, '<b>two</b>');
  assert.equal(reconcileArtifactRevision(finalized, { ...v1, content: '<b>two</b>' }).version, 2);
});

test('rollback creates a new revision and leaves all earlier snapshots intact', () => {
  const v2 = reconcileArtifactRevision(v1, { ...v1, content: '<b>two</b>' });
  const restored = createRollbackRevision(v2, 1)!;
  assert.equal(restored.version, 3);
  assert.equal(restored.content, v1.content);
  assert.deepEqual(restored.versions.map(version => version.version), [1, 2, 3]);
  assert.equal(createRollbackRevision(restored, 3), null);
});

test('diff identifies insertions and removals and limits quadratic work', () => {
  const rows = diffArtifactLines('a\nb\nc', 'a\nx\nc')!;
  assert.deepEqual(rows.filter(row => row.kind !== 'same'), [
    { kind: 'removed', text: 'b' }, { kind: 'added', text: 'x' },
  ]);
  assert.equal(diffArtifactLines('x\n'.repeat(500), 'y\n'.repeat(500)), null);
});
