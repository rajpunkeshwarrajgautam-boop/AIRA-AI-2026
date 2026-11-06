import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeExecutionWaves,
  createExecutionGraph,
  applyExecutionGraphEvent,
  sanitizeUserFacingText
} from '../src/utils/executionGraphEngine.ts';

test('computeExecutionWaves computes accurate parallel waves for diamond DAG', () => {
  // A -> B, A -> C, B -> D, C -> D
  const nodes = {
    A: { id: 'A', dependsOn: [] },
    B: { id: 'B', dependsOn: ['A'] },
    C: { id: 'C', dependsOn: ['A'] },
    D: { id: 'D', dependsOn: ['B', 'C'] }
  };

  const waves = computeExecutionWaves(nodes);
  assert.equal(waves.length, 3, 'Should produce 3 execution waves');
  assert.deepEqual(waves[0], ['A'], 'Wave 0 should be root task [A]');
  assert.deepEqual(waves[1], ['B', 'C'], 'Wave 1 should have parallel tasks [B, C]');
  assert.deepEqual(waves[2], ['D'], 'Wave 2 should be final task [D]');
});

test('createExecutionGraph initializes task states and blocks dependent tasks', () => {
  const graph = createExecutionGraph({
    graphId: 'wf_demo_01',
    runId: 'run_123',
    title: 'Research and Code Pipeline',
    tasks: [
      { id: 't1', name: 'Plan & Research', role: 'planner', dependsOn: [] },
      { id: 't2', name: 'Write Code', role: 'coder', dependsOn: ['t1'] }
    ]
  });

  assert.equal(graph.totalTasks, 2);
  assert.equal(graph.nodes['t1'].state, 'QUEUED');
  assert.equal(graph.nodes['t2'].state, 'BLOCKED');
  assert.equal(graph.state, 'RUNNING');
});

test('applyExecutionGraphEvent transitions step to RUNNING and records active tool', () => {
  let graph = createExecutionGraph({
    graphId: 'wf_demo_02',
    runId: 'run_124',
    title: 'Automated Build',
    tasks: [
      { id: 'step_build', name: 'Compile Assets', role: 'automation', dependsOn: [] }
    ]
  });

  graph = applyExecutionGraphEvent(graph, 'workflow_step_started', {
    stepId: 'step_build',
    attempt: 1,
    toolName: 'system_shell'
  }, 1000);

  assert.equal(graph.nodes['step_build'].state, 'RUNNING');
  assert.equal(graph.nodes['step_build'].startedAt, 1000);
  assert.equal(graph.nodes['step_build'].activeTool?.name, 'system_shell');
  assert.equal(graph.nodes['step_build'].activeTool?.status, 'running');
});

test('applyExecutionGraphEvent unblocks downstream tasks upon completion', () => {
  let graph = createExecutionGraph({
    graphId: 'wf_demo_03',
    runId: 'run_125',
    title: 'Multi-Step Synthesis',
    tasks: [
      { id: 'step_1', name: 'Analyze', role: 'analyst', dependsOn: [] },
      { id: 'step_2', name: 'Verify', role: 'verifier', dependsOn: ['step_1'] }
    ]
  });

  assert.equal(graph.nodes['step_2'].state, 'BLOCKED');

  graph = applyExecutionGraphEvent(graph, 'workflow_step_started', { stepId: 'step_1' }, 1000);
  graph = applyExecutionGraphEvent(graph, 'workflow_step_completed', {
    stepId: 'step_1',
    output: 'Analysis complete with high confidence',
    artifactId: 'art_analysis_01',
    artifactTitle: 'Market Analysis Summary'
  }, 2500);

  assert.equal(graph.nodes['step_1'].state, 'COMPLETED');
  assert.equal(graph.nodes['step_1'].durationMs, 1500);
  assert.equal(graph.nodes['step_1'].associatedArtifactId, 'art_analysis_01');
  assert.equal(graph.nodes['step_1'].associatedArtifactTitle, 'Market Analysis Summary');
  // step_2 is unblocked
  assert.equal(graph.nodes['step_2'].state, 'QUEUED');
});

test('applyExecutionGraphEvent handles HITL approval flow cleanly', () => {
  let graph = createExecutionGraph({
    graphId: 'wf_demo_04',
    runId: 'run_126',
    title: 'Guarded Deployment',
    tasks: [
      { id: 'step_deploy', name: 'Deploy Service', role: 'automation', dependsOn: [], approvalRequired: true }
    ]
  });

  graph = applyExecutionGraphEvent(graph, 'workflow_step_started', { stepId: 'step_deploy' }, 1000);
  graph = applyExecutionGraphEvent(graph, 'approval.required', {
    stepId: 'step_deploy',
    approvalId: 'appr_789',
    reason: 'Production deployment requires human confirmation'
  }, 1200);

  assert.equal(graph.state, 'WAITING_FOR_APPROVAL');
  assert.equal(graph.nodes['step_deploy'].state, 'WAITING_FOR_APPROVAL');
  assert.equal(graph.nodes['step_deploy'].approvalId, 'appr_789');

  // Approval resolved: APPROVED
  graph = applyExecutionGraphEvent(graph, 'approval.resolved', {
    stepId: 'step_deploy',
    approvalId: 'appr_789',
    decision: 'APPROVED'
  }, 1800);

  assert.equal(graph.state, 'RUNNING');
  assert.equal(graph.nodes['step_deploy'].state, 'RUNNING');
});

test('applyExecutionGraphEvent handles step failure with retry policy vs permanent failure', () => {
  let graph = createExecutionGraph({
    graphId: 'wf_demo_05',
    runId: 'run_127',
    title: 'Resilient Fetch',
    tasks: [
      { id: 'fetch_data', name: 'Fetch Remote Data', role: 'browser', dependsOn: [], maxAttempts: 2 },
      { id: 'process_data', name: 'Process Data', role: 'synthesizer', dependsOn: ['fetch_data'] }
    ]
  });

  // Attempt 1 fails (retryable)
  graph = applyExecutionGraphEvent(graph, 'workflow_step_started', { stepId: 'fetch_data', attempt: 1 }, 1000);
  graph = applyExecutionGraphEvent(graph, 'workflow_step_failed', {
    stepId: 'fetch_data',
    error: 'Temporary 503 upstream',
    retryable: true
  }, 1500);

  assert.equal(graph.nodes['fetch_data'].state, 'RETRY_WAIT');
  assert.equal(graph.nodes['process_data'].state, 'BLOCKED');

  // Attempt 2 fails (permanent failure since attempt == maxAttempts)
  graph = applyExecutionGraphEvent(graph, 'workflow_step_started', { stepId: 'fetch_data', attempt: 2 }, 2000);
  graph = applyExecutionGraphEvent(graph, 'workflow_step_failed', {
    stepId: 'fetch_data',
    error: 'Host unreachable',
    retryable: true
  }, 2500);

  assert.equal(graph.nodes['fetch_data'].state, 'FAILED');
  assert.equal(graph.nodes['process_data'].state, 'BLOCKED');
  assert.match(graph.nodes['process_data'].error || '', /Blocked by failed dependency/);
  assert.equal(graph.state, 'FAILED');
});

test('applyExecutionGraphEvent handles run cancellation cleanly', () => {
  let graph = createExecutionGraph({
    graphId: 'wf_demo_06',
    runId: 'run_128',
    title: 'Long Running Task',
    tasks: [
      { id: 'step_a', name: 'Task A', dependsOn: [] },
      { id: 'step_b', name: 'Task B', dependsOn: ['step_a'] }
    ]
  });

  graph = applyExecutionGraphEvent(graph, 'workflow_step_started', { stepId: 'step_a' }, 1000);
  graph = applyExecutionGraphEvent(graph, 'run_cancelled', {}, 1400);

  assert.equal(graph.state, 'CANCELLED');
  assert.equal(graph.nodes['step_a'].state, 'CANCELLED');
  assert.equal(graph.nodes['step_b'].state, 'CANCELLED');
});

test('applyExecutionGraphEvent exhibits out-of-order event resilience and latching', () => {
  let graph = createExecutionGraph({
    graphId: 'wf_demo_07',
    runId: 'run_129',
    title: 'Out of Order Check',
    tasks: [
      { id: 'step_quick', name: 'Quick Task', dependsOn: [] }
    ]
  });

  // Completed event arrives BEFORE started event
  graph = applyExecutionGraphEvent(graph, 'workflow_step_completed', {
    stepId: 'step_quick',
    output: 'Fast result'
  }, 2000);

  assert.equal(graph.nodes['step_quick'].state, 'COMPLETED');
  assert.equal(graph.nodes['step_quick'].progress, 100);

  // Late progress tick must NOT revert completed node to running
  graph = applyExecutionGraphEvent(graph, 'workflow_step_progress', {
    stepId: 'step_quick',
    progress: 50
  }, 2500);

  assert.equal(graph.nodes['step_quick'].state, 'COMPLETED');
  assert.equal(graph.nodes['step_quick'].progress, 100);
});

test('sanitizeUserFacingText redacts credentials and tokens', () => {
  const sensitive1 = 'Here is the token: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz and api_key=secret_123456';
  const clean1 = sanitizeUserFacingText(sensitive1);
  assert.doesNotMatch(clean1, /secret_123456/);
  assert.doesNotMatch(clean1, /eyJhbG/);
  assert.match(clean1, /\[REDACTED_CREDENTIAL\]/);
});
