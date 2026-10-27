import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpecialistRoleSchema,
  SpecialistTaskContractSchema,
  TaskDAGSchema,
  validateTaskDAG,
  ALL_SPECIALIST_ROLES
} from '../packages/contracts/src/agent-specialists.js';

test('Specialist Role Taxonomy: contains exactly 9 canonical roles', () => {
  assert.equal(ALL_SPECIALIST_ROLES.length, 9);
  const expectedRoles = [
    'planner',
    'researcher',
    'coder',
    'analyst',
    'document',
    'browser',
    'automation',
    'verifier',
    'synthesizer'
  ];
  for (const role of expectedRoles) {
    assert.ok(ALL_SPECIALIST_ROLES.includes(role as any), `Missing expected role: ${role}`);
    const parseRes = SpecialistRoleSchema.safeParse(role);
    assert.equal(parseRes.success, true);
  }
});

// ==========================================
// TEST 01: Valid single-task DAG
// ==========================================
test('TEST 01: Valid single-task DAG compiles and validates successfully', () => {
  const dag = {
    dagId: 'dag_single_01',
    runId: 'run_single_01',
    tasks: [
      {
        taskId: 'task_plan',
        runId: 'run_single_01',
        role: 'planner',
        objective: 'Construct mission execution plan',
        requiredCapabilities: ['agent_planning'],
        dependencies: []
      }
    ]
  };

  const result = validateTaskDAG(dag);
  assert.equal(result.valid, true, `Validation failed: ${result.error}`);
  assert.deepEqual(result.topologicalOrder, ['task_plan']);
  assert.deepEqual(result.executionWaves, [['task_plan']]);
  assert.equal(result.stats?.totalTasks, 1);
  assert.equal(result.stats?.rootTasks, 1);
  assert.equal(result.stats?.leafTasks, 1);
  assert.equal(result.stats?.maxDepth, 1);
});

// ==========================================
// TEST 02: Valid sequential dependency DAG
// ==========================================
test('TEST 02: Valid sequential dependency DAG compiles waves in strict order', () => {
  const dag = {
    dagId: 'dag_seq_02',
    runId: 'run_seq_02',
    tasks: [
      {
        taskId: 'task_1_plan',
        runId: 'run_seq_02',
        role: 'planner',
        objective: 'Plan the architecture',
        dependencies: []
      },
      {
        taskId: 'task_2_research',
        runId: 'run_seq_02',
        role: 'researcher',
        objective: 'Research state of art',
        dependencies: ['task_1_plan']
      },
      {
        taskId: 'task_3_code',
        runId: 'run_seq_02',
        role: 'coder',
        objective: 'Implement contracts',
        dependencies: ['task_2_research']
      },
      {
        taskId: 'task_4_verify',
        runId: 'run_seq_02',
        role: 'verifier',
        objective: 'Verify implementation',
        dependencies: ['task_3_code']
      }
    ]
  };

  const result = validateTaskDAG(dag);
  assert.equal(result.valid, true, `Validation failed: ${result.error}`);
  assert.deepEqual(result.topologicalOrder, ['task_1_plan', 'task_2_research', 'task_3_code', 'task_4_verify']);
  assert.deepEqual(result.executionWaves, [
    ['task_1_plan'],
    ['task_2_research'],
    ['task_3_code'],
    ['task_4_verify']
  ]);
  assert.equal(result.stats?.totalTasks, 4);
  assert.equal(result.stats?.maxDepth, 4);
  assert.equal(result.stats?.rootTasks, 1);
  assert.equal(result.stats?.leafTasks, 1);
});

// ==========================================
// TEST 03: Valid parallel DAG
// ==========================================
test('TEST 03: Valid parallel DAG groups independent tasks in identical wave', () => {
  const dag = {
    dagId: 'dag_par_03',
    runId: 'run_par_03',
    tasks: [
      {
        taskId: 'task_plan',
        runId: 'run_par_03',
        role: 'planner',
        objective: 'Coordinate mission',
        dependencies: []
      },
      {
        taskId: 'task_research_a',
        runId: 'run_par_03',
        role: 'researcher',
        objective: 'Research domain A',
        dependencies: ['task_plan']
      },
      {
        taskId: 'task_research_b',
        runId: 'run_par_03',
        role: 'researcher',
        objective: 'Research domain B',
        dependencies: ['task_plan']
      },
      {
        taskId: 'task_synthesize',
        runId: 'run_par_03',
        role: 'synthesizer',
        objective: 'Combine findings',
        dependencies: ['task_research_a', 'task_research_b']
      }
    ]
  };

  const result = validateTaskDAG(dag);
  assert.equal(result.valid, true, `Validation failed: ${result.error}`);
  assert.equal(result.executionWaves?.length, 3);
  assert.deepEqual(result.executionWaves?.[0], ['task_plan']);
  // Parallel wave tasks are deterministically sorted alphabetically
  assert.deepEqual(result.executionWaves?.[1], ['task_research_a', 'task_research_b']);
  assert.deepEqual(result.executionWaves?.[2], ['task_synthesize']);
  assert.equal(result.stats?.totalTasks, 4);
  assert.equal(result.stats?.rootTasks, 1);
  assert.equal(result.stats?.leafTasks, 1);
  assert.equal(result.stats?.maxDepth, 3);
});

// ==========================================
// TEST 04: Circular dependency rejected
// ==========================================
test('TEST 04: Circular dependency is rejected with cycleNodes detected', () => {
  const cyclicDag = {
    dagId: 'dag_cycle_04',
    runId: 'run_cycle_04',
    tasks: [
      {
        taskId: 'task_a',
        runId: 'run_cycle_04',
        role: 'planner',
        objective: 'A depends on B',
        dependencies: ['task_b']
      },
      {
        taskId: 'task_b',
        runId: 'run_cycle_04',
        role: 'coder',
        objective: 'B depends on A',
        dependencies: ['task_a']
      }
    ]
  };

  const result = validateTaskDAG(cyclicDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('Cycle detected'));
  assert.deepEqual(result.cycleNodes, ['task_a', 'task_b']);
});

// ==========================================
// TEST 05: Self-dependency rejected
// ==========================================
test('TEST 05: Self-dependency is rejected explicitly', () => {
  const selfDepDag = {
    dagId: 'dag_self_05',
    runId: 'run_self_05',
    tasks: [
      {
        taskId: 'task_self',
        runId: 'run_self_05',
        role: 'analyst',
        objective: 'Self referring task',
        dependencies: ['task_self']
      }
    ]
  };

  const result = validateTaskDAG(selfDepDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('cannot depend on itself'));
});

// ==========================================
// TEST 06: Unknown dependency rejected
// ==========================================
test('TEST 06: Unknown / dangling dependency is rejected with details', () => {
  const danglingDag = {
    dagId: 'dag_dangle_06',
    runId: 'run_dangle_06',
    tasks: [
      {
        taskId: 'task_ready',
        runId: 'run_dangle_06',
        role: 'document',
        objective: 'Parse docs',
        dependencies: ['task_missing_404']
      }
    ]
  };

  const result = validateTaskDAG(danglingDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('Unresolved dependencies detected'));
  assert.equal(result.unresolvedDependencies?.[0]?.taskId, 'task_ready');
  assert.equal(result.unresolvedDependencies?.[0]?.missingDepId, 'task_missing_404');
});

// ==========================================
// TEST 07: Duplicate task ID rejected
// ==========================================
test('TEST 07: Duplicate task ID is detected and rejected', () => {
  const duplicateDag = {
    dagId: 'dag_dup_07',
    runId: 'run_dup_07',
    tasks: [
      {
        taskId: 'task_dup',
        runId: 'run_dup_07',
        role: 'coder',
        objective: 'First copy',
        dependencies: []
      },
      {
        taskId: 'task_dup',
        runId: 'run_dup_07',
        role: 'verifier',
        objective: 'Duplicate copy',
        dependencies: []
      }
    ]
  };

  const result = validateTaskDAG(duplicateDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('Duplicate task IDs detected'));
  assert.deepEqual(result.duplicateTaskIds, ['task_dup']);
});

// ==========================================
// TEST 08: Unknown specialist role rejected
// ==========================================
test('TEST 08: Unknown specialist role is rejected by schema validation', () => {
  const invalidRoleDag = {
    dagId: 'dag_role_08',
    runId: 'run_role_08',
    tasks: [
      {
        taskId: 'task_invalid_role',
        runId: 'run_role_08',
        role: 'rogue_hacker_agent',
        objective: 'Invalid role',
        dependencies: []
      }
    ]
  };

  const result = validateTaskDAG(invalidRoleDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('Invalid enum value') || result.error?.includes('role'));
});

// ==========================================
// TEST 09: Oversized DAG rejected (>50 tasks)
// ==========================================
test('TEST 09: Oversized DAG with >50 tasks is rejected', () => {
  const tasks = [];
  for (let i = 1; i <= 51; i++) {
    tasks.push({
      taskId: `task_${i}`,
      runId: 'run_large_09',
      role: 'coder' as const,
      objective: `Task ${i}`,
      dependencies: []
    });
  }

  const oversizedDag = {
    dagId: 'dag_oversized_09',
    runId: 'run_large_09',
    tasks
  };

  const result = validateTaskDAG(oversizedDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('50 tasks'));
});

// ==========================================
// TEST 10: Invalid execution budget rejected
// ==========================================
test('TEST 10: Invalid execution budget (negative tokens or negative spend) is rejected', () => {
  const invalidBudgetDag = {
    dagId: 'dag_budget_10',
    runId: 'run_budget_10',
    tasks: [
      {
        taskId: 'task_negative_budget',
        runId: 'run_budget_10',
        role: 'analyst',
        objective: 'Calculate figures',
        dependencies: [],
        budgetLimits: {
          maxTokens: -500 // Negative token budget
        }
      }
    ]
  };

  const result = validateTaskDAG(invalidBudgetDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('budgetLimits.maxTokens') || result.error?.includes('positive'));
});

// ==========================================
// TEST 11: Invalid timeout rejected
// ==========================================
test('TEST 11: Invalid timeout (<1000ms or >300000ms) is rejected', () => {
  const invalidTimeoutDag = {
    dagId: 'dag_timeout_11',
    runId: 'run_timeout_11',
    tasks: [
      {
        taskId: 'task_tiny_timeout',
        runId: 'run_timeout_11',
        role: 'browser',
        objective: 'Browse web page',
        dependencies: [],
        timeoutConfig: {
          stepTimeoutMs: 50 // Too small (min is 1000ms)
        }
      }
    ]
  };

  const result = validateTaskDAG(invalidTimeoutDag);
  assert.equal(result.valid, false);
  assert.ok(result.error?.includes('timeoutConfig.stepTimeoutMs') || result.error?.includes('Number must be greater than or equal to 1000'));
});
