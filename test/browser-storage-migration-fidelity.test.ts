import test from 'node:test';
import assert from 'node:assert/strict';
import { isVerifiedMigrationCopy } from '../src/utils/storage.js';

test('storage migration does not accept equal-length but corrupted conversations', () => {
  const original = [
    { id: 'a', messages: [{ id: '1', content: 'private original' }] },
    { id: 'b', messages: [{ id: '2', content: 'important attachment' }] }
  ];
  const corrupted = [
    { id: 'a', messages: [{ id: '1', content: 'private original' }] },
    { id: 'b', messages: [{ id: '2', content: 'attachment missing!' }] }
  ];

  assert.equal(isVerifiedMigrationCopy(original, corrupted), false);
  assert.equal(isVerifiedMigrationCopy(original, structuredClone(original)), true);
  assert.equal(isVerifiedMigrationCopy(original, null), false);
});

test('storage migration requires full project equality even when counts match', () => {
  const projects = [
    { id: 'project-a', name: 'Alpha', conversationIds: ['chat-a', 'chat-b'] },
    { id: 'project-b', name: 'Beta', conversationIds: ['chat-c'] }
  ];
  const truncated = structuredClone(projects);
  truncated[0].conversationIds.pop();

  assert.equal(isVerifiedMigrationCopy(projects, truncated), false);
  assert.equal(isVerifiedMigrationCopy(projects, structuredClone(projects)), true);
});
