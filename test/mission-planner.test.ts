import assert from 'node:assert/strict';
import {
  compileSupportedMission, validateDurableMission, verifyMissionEvidence,
  type DurableMissionProgress
} from '../packages/agent-runtime/src/mission-plan.js';
import type { ToolResult } from '../packages/contracts/src/index.js';

const auditPrompt = 'Inspect workspace files, check git status, and summarize repo history.';
const audit = compileSupportedMission(auditPrompt);
assert.ok(audit, 'Repository audit must compile');
assert.deepEqual(audit.steps.map(step => step.toolName),
  ['file_system_list', 'repo_git_status', 'repo_git_log']);
assert.deepEqual(audit.steps[0].arguments, { path: '.' });

const comparePrompt = 'Read package.json and README.md and compare both files.';
const comparison = compileSupportedMission(comparePrompt);
assert.ok(comparison, 'Multi-file inspection must compile');
assert.deepEqual(comparison.steps.map(step => step.arguments),
  [{ filePath: 'package.json' }, { filePath: 'README.md' }]);
assert.equal(compileSupportedMission('Inspect workspace files'), null, 'Never add arbitrary repo actions');
assert.equal(compileSupportedMission('Build me a production website and deploy it'), null, 'Mutation needs a capable executor');
assert.equal(compileSupportedMission('Read ../private.json and README.md and compare'), null,
  'Do not include traversal paths in mission plan');
assert.equal(compileSupportedMission('Read package.json and README.md, update the config, and compare'), null,
  'Never interpret a write request as a read-only success');
assert.deepEqual(compileSupportedMission('Read package.json and README.md, README.md, and compare')?.steps, comparison.steps,
  'Duplicate explicit paths must not generate duplicate steps');
assert.equal(compileSupportedMission('Read README.md and file1.ts and file2.ts and file3.ts and file4.ts and file5.ts and file6.ts and compare'), null,
  'Bounded mission must reject more than six file operations');

const progress: DurableMissionProgress = {
  version: 1, plan: comparison, dispatched: 1, verified: [], currentCallId: 'call_1'
};
assert.equal(validateDurableMission(comparePrompt, progress), true);
function reorderKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).reverse();
    return Object.fromEntries(entries.map(([key, child]) => [key, reorderKeys(child)]));
  }
  return value;
}
assert.equal(validateDurableMission(comparePrompt, reorderKeys(progress)), true,
  'JSONB key reordering must not fail an otherwise authentic persisted plan');

const mutated = structuredClone(progress);
mutated.plan.steps[0].arguments = { filePath: 'secrets.txt' };
assert.equal(validateDurableMission(comparePrompt, mutated), false,
  'Persisted plan must match original request');
const forgedCursor = { ...progress, dispatched: 3 };
assert.equal(validateDurableMission(comparePrompt, forgedCursor), false);
const forgedVerification = { ...progress, verified: ['file_2'] };
assert.equal(validateDurableMission(comparePrompt, forgedVerification), false);

function result(output: unknown, isError = false): ToolResult {
  return {
    toolCallId: 'call_1', output, isError, durationMs: 1, timestamp: Date.now(), artifacts: []
  };
}
assert.equal(verifyMissionEvidence(comparison.steps[0],
  result({ filePath: 'package.json', content: '{}', sizeBytes: 2 })).verified, true);
assert.equal(verifyMissionEvidence(comparison.steps[0],
  result({ filePath: 'another.json', content: '{}', sizeBytes: 2 })).verified, false,
  'File evidence for a different target must fail');
assert.equal(verifyMissionEvidence(comparison.steps[0], result(null)).verified, false);
assert.equal(verifyMissionEvidence(comparison.steps[0],
  result({ filePath: 'package.json', content: '{}', sizeBytes: 2 }, true)).verified, false);
assert.equal(verifyMissionEvidence(audit.steps[0],
  result({ directory: '.', entries: [] })).verified, true);
assert.equal(verifyMissionEvidence(audit.steps[1],
  result({ branch: 'main', headSha: 'abc1234', modified: [], untracked: [] })).verified, true);
assert.equal(verifyMissionEvidence(audit.steps[1],
  result({ branch: 'unknown', headSha: 'unknown', modified: [], untracked: [] })).verified, false);
assert.equal(verifyMissionEvidence(audit.steps[2],
  result([{ sha: 'abc1234', message: 'Commit summary' }])).verified, true);
assert.equal(verifyMissionEvidence(audit.steps[2], result([])).verified, false);

console.log('PASS: grounded compilation, bounded plans, mutation rejection, persisted-plan integrity and tool evidence');
