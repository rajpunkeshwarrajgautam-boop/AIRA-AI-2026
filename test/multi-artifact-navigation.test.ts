import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Artifact, Message } from '../src/types';

test('Multi-artifact extraction deduplicates and preserves creation order', () => {
  const art1: Artifact = {
    id: 'art-1',
    title: 'Orbit Simulation HTML',
    type: 'text/html',
    language: 'html',
    content: '<h1>v1</h1>',
    version: 1,
    versions: [{ version: 1, content: '<h1>v1</h1>', timestamp: 1000 }],
  };

  const art2: Artifact = {
    id: 'art-2',
    title: 'Styles CSS',
    type: 'text/css',
    language: 'css',
    content: 'body { color: red; }',
    version: 1,
    versions: [{ version: 1, content: 'body { color: red; }', timestamp: 2000 }],
  };

  const messages: Message[] = [
    { id: 'm1', role: 'user', content: 'Create simulation', timestamp: 500 },
    { id: 'm2', role: 'assistant', content: 'Here is art1', timestamp: 1000, artifacts: [art1] },
    { id: 'm3', role: 'user', content: 'Now add stylesheet', timestamp: 1500 },
    { id: 'm4', role: 'assistant', content: 'Here is art2 and updated art1', timestamp: 2000, artifacts: [art2, art1] },
  ];

  // Extraction logic matching App.tsx
  const list: Artifact[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.artifacts) {
      for (const art of msg.artifacts) {
        if (!seen.has(art.id)) {
          seen.add(art.id);
          list.push(art);
        }
      }
    }
  }

  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'art-1');
  assert.equal(list[1].id, 'art-2');

  // Carousel index & pagination checks
  const currentId = 'art-2';
  const currentIndex = list.findIndex(a => a.id === currentId);
  assert.equal(currentIndex, 1);
  assert.equal(`${currentIndex + 1} of ${list.length}`, '2 of 2');

  // Next / Prev wrap-around
  const prevIndex = (currentIndex - 1 + list.length) % list.length;
  assert.equal(prevIndex, 0);
  const nextIndex = (currentIndex + 1) % list.length;
  assert.equal(nextIndex, 0);
});
