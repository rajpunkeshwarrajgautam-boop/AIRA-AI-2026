import assert from 'node:assert/strict';
import {
  hasMutationIntent,
  isMutatingGitIntent,
  isReadOnlyGitInspection
} from '../packages/agent-runtime/src/git-policy.js';
import { compileSupportedMission } from '../packages/agent-runtime/src/mission-plan.js';
import { validateModelMission } from '../packages/agent-runtime/src/model-mission.js';
import { selectExecutableTool } from '../packages/agent-runtime/src/tool-selector.js';
import type { ToolDefinition } from '../packages/contracts/src/index.js';

// ---------------------------------------------------------------------------
// POSITIVE REGRESSION CASES: Read-Only Git Inspection Operations
// Must NOT be classified as mutations, and must be permitted in missions.
// ---------------------------------------------------------------------------
const readOnlyCases = [
  'inspect the git repository status and identify the current branch and commit SHA',
  'Report the current Git branch and HEAD revision commit SHA',
  'Reading the HEAD revision',
  'Display commit metadata',
  'Query repository status',
  'Check git status and summarize recent commits',
  'Show latest commit SHA',
  'Get commit hash and branch of HEAD',
  'Show the last 5 commits',
  'Inspect workspace files, check git status, and summarize repo history.',
  'Inspect workspace files, check git status, and summarize commit history.',
  'Read the latest commit info and report commit author',
  'View commit details for HEAD',
  'Inspect the repository log and show recent commits'
];

for (const prompt of readOnlyCases) {
  assert.equal(
    hasMutationIntent(prompt),
    false,
    `Read-only prompt must NOT have mutation intent: "${prompt}"`
  );
  assert.equal(
    isMutatingGitIntent(prompt),
    false,
    `Read-only prompt must NOT be classified as Git mutation: "${prompt}"`
  );
}

// Check specific isReadOnlyGitInspection matches
assert.equal(isReadOnlyGitInspection('Report the current Git branch'), true);
assert.equal(isReadOnlyGitInspection('Display commit metadata'), true);
assert.equal(isReadOnlyGitInspection('Check git status and summarize recent commits'), true);
assert.equal(isReadOnlyGitInspection('Show latest commit SHA'), true);
assert.equal(isReadOnlyGitInspection('Query repository status'), true);

// ---------------------------------------------------------------------------
// NEGATIVE REGRESSION CASES: Unauthorized Git Mutations (Deny-by-default)
// Must be classified as mutations and rejected from read-only paths.
// ---------------------------------------------------------------------------
const mutatingCases = [
  'commit',
  'git commit -m "update files"',
  'commit changes and push to origin',
  'create a commit with the new file',
  'make a commit',
  'commit all staged files',
  'commit my work',
  'commit the fix',
  'git push origin main',
  'git push',
  'merge feature-branch into main',
  'git rebase main',
  'git reset --hard HEAD~1',
  'git cherry-pick abc1234',
  'fix the bug and commit the fix',
  'modify file and display commit SHA',
  'commit the changes and show git status',
  'write code and check commit hash'
];

for (const prompt of mutatingCases) {
  assert.equal(
    hasMutationIntent(prompt),
    true,
    `Mutating prompt MUST be classified as mutation: "${prompt}"`
  );
  assert.equal(
    compileSupportedMission(prompt),
    null,
    `Mutating prompt must compile to null in compileSupportedMission: "${prompt}"`
  );
  assert.throws(
    () => validateModelMission(prompt, { version: 2, objective: prompt, steps: [] }, []),
    /MODEL_MISSION_WRITE_NOT_CERTIFIED/,
    `Mutating prompt must throw MODEL_MISSION_WRITE_NOT_CERTIFIED: "${prompt}"`
  );
  const selection = selectExecutableTool(prompt, 'AGENT_MISSION');
  assert.equal(
    selection.ok,
    false,
    `Mutating prompt in AGENT_MISSION must be rejected: "${prompt}"`
  );
}

// ---------------------------------------------------------------------------
// MISSION COMPILATION REGRESSION TEST WITH COMMIT REFERENCES
// ---------------------------------------------------------------------------
const missionWithCommit = compileSupportedMission(
  'Inspect workspace files, check git status, and summarize commit history.'
);
assert.ok(missionWithCommit, 'Mission with "commit history" must compile successfully');
assert.deepEqual(
  missionWithCommit.steps.map(s => s.toolName),
  ['file_system_list', 'repo_git_status', 'repo_git_log']
);

// ---------------------------------------------------------------------------
// MODEL MISSION VALIDATION WITH READ-ONLY COMMIT SHA OBJECTIVE
// ---------------------------------------------------------------------------
const validReadDefinitions: ToolDefinition[] = [
  {
    id: 'tool_repo_status',
    name: 'repo_git_status',
    version: 1,
    description: 'Inspect git status and HEAD revision SHA',
    category: 'repo',
    source: 'native',
    parameters: { type: 'object', properties: {} },
    permissionLevel: 'READ',
    sideEffectLevel: 'READ',
    permissionScopes: ['repo.read'],
    approvalPolicy: 'autonomous',
    executionRuntime: 'LOCAL',
    availability: 'READY',
    adapter: 'repo',
    provider: 'aira-git'
  }
];

const readOnlyObjective = 'Inspect the git repository status and identify the current branch and commit SHA';
const validPlan = {
  version: 2,
  objective: readOnlyObjective,
  steps: [
    {
      id: 'step_status',
      purpose: 'Inspect git repository status and commit SHA',
      toolName: 'repo_git_status',
      arguments: {},
      dependsOn: [],
      specialist: 'repository'
    }
  ]
};

const validated = validateModelMission(
  readOnlyObjective,
  validPlan,
  validReadDefinitions,
  ['repo.read']
);
assert.equal(validated.objective, readOnlyObjective);
assert.equal(validated.steps.length, 1);
assert.equal(validated.steps[0].toolName, 'repo_git_status');

console.log('PASS: Git policy semantic classification positive & negative regression tests verified.');
