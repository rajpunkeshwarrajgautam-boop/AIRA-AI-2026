import assert from 'node:assert/strict';
import {
  buildDurableHistorySystemMessage,
  isExplicitMemoryRecallPrompt
} from '../packages/agent-runtime/src/memory-policy.js';

const history = [
  '[Prior Run]:',
  'User: We discussed paneer bhurjee.',
  'Aira: Use onions and tomatoes.'
].join('\n');

assert.equal(isExplicitMemoryRecallPrompt('Did we discuss paneer bhurjee?'), true);
assert.equal(isExplicitMemoryRecallPrompt('Do you remember what we decided last time?'), true);
assert.equal(isExplicitMemoryRecallPrompt('Who is Salman Khan?'), false);
assert.equal(isExplicitMemoryRecallPrompt('What is the highest grossing Bollywood movie?'), false);

const recall = buildDurableHistorySystemMessage('user-test', history, 'Did we discuss paneer bhurjee?');
assert.match(recall, /EXPLICIT MEMORY RECALL/);
assert.match(recall, /I did not find a record of that in our recent conversation history/);

const ordinary = buildDurableHistorySystemMessage('user-test', history, 'Who is Salman Khan?');
assert.match(ordinary, /INSTRUCTIONS FOR CONTINUITY/);
assert.match(ordinary, /answer the user's actual request normally/);
assert.match(ordinary, /Never say a fact or topic is unavailable merely because it does not appear/);
assert.doesNotMatch(
  ordinary,
  /If the topic is NOT present in this retrieved history, state: "I did not find a record/
);

console.log('PASS: explicit recall prompts retain bounded memory-miss behavior');
console.log('PASS: ordinary factual prompts are not constrained by conversation history');
