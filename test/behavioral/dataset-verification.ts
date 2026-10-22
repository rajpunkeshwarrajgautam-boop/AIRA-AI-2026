import assert from 'node:assert/strict';
import {
  allBenchmarkScenarios,
  devBenchmarkScenarios,
  heldOutBenchmarkScenarios,
  naturalConversationScenarios,
  semanticReasoningScenarios,
  instructionHierarchyScenarios,
  memoryRelevanceScenarios,
  toolSelectionRecoveryScenarios,
  adaptiveWritingScenarios
} from './benchmark-dataset.js';

console.log('=== VERIFYING 240-SCENARIO BENCHMARK DATASET INTEGRITY ===');

// Total scenarios
console.log(`Total scenarios: ${allBenchmarkScenarios.length}`);
assert.strictEqual(allBenchmarkScenarios.length, 240, 'Must have exactly 240 scenarios');

// Category counts
assert.strictEqual(naturalConversationScenarios.length, 40, 'natural_conversation must have 40');
assert.strictEqual(semanticReasoningScenarios.length, 40, 'semantic_reasoning must have 40');
assert.strictEqual(instructionHierarchyScenarios.length, 40, 'instruction_hierarchy must have 40');
assert.strictEqual(memoryRelevanceScenarios.length, 40, 'memory_intelligence must have 40');
assert.strictEqual(toolSelectionRecoveryScenarios.length, 40, 'tool_selection_recovery must have 40');
assert.strictEqual(adaptiveWritingScenarios.length, 40, 'adaptive_writing must have 40');

// Splits
console.log(`Dev split scenarios: ${devBenchmarkScenarios.length} (target: 168 = 70%)`);
console.log(`Held-out split scenarios: ${heldOutBenchmarkScenarios.length} (target: 72 = 30%)`);
assert.strictEqual(devBenchmarkScenarios.length, 168, 'Dev split must be exactly 168 scenarios');
assert.strictEqual(heldOutBenchmarkScenarios.length, 72, 'Held-out split must be exactly 72 scenarios');

// Unique IDs
const idSet = new Set<string>();
for (const sc of allBenchmarkScenarios) {
  assert(!idSet.has(sc.id), `Duplicate scenario ID: ${sc.id}`);
  idSet.add(sc.id);
}
assert.strictEqual(idSet.size, 240, 'All 240 IDs must be strictly unique');

// Specialized coverage checks
const adversarialCount = allBenchmarkScenarios.filter(s => s.isAdversarial).length;
const multiTurnCount = allBenchmarkScenarios.filter(s => s.isMultiTurn).length;
const isolationCount = allBenchmarkScenarios.filter(s => s.isIsolationTest).length;

console.log(`Adversarial scenarios: ${adversarialCount} (minimum required: 30)`);
console.log(`Multi-turn scenarios: ${multiTurnCount} (minimum required: 20)`);
console.log(`Isolation scenarios: ${isolationCount} (minimum required: 20)`);

assert(adversarialCount >= 30, `Adversarial scenarios must be >= 30, got ${adversarialCount}`);
assert(multiTurnCount >= 20, `Multi-turn scenarios must be >= 20, got ${multiTurnCount}`);
assert(isolationCount >= 20, `Isolation scenarios must be >= 20, got ${isolationCount}`);

console.log('✅ ALL 240 BENCHMARK DATASET INTEGRITY CHECKS PASSED!');
