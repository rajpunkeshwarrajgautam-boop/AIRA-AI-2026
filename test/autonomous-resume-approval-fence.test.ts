import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousAgentEngine } from '../packages/agent-runtime/src/autonomous/autonomous-engine.js';
import { InMemoryAutonomousTaskRepository } from '../packages/agent-runtime/src/autonomous/repository.js';

const principal = { userId: 'approval_test_user', sessionId: 'approval_session', scopes: ['*'] };

function makePlan(levels: Array<'NONE' | 'WRITE' | 'DESTRUCTIVE'>) {
  const now = Date.now();
  return {
    planId: 'approval_resume_plan',
    objective: 'Verify approval remains mandatory across resume paths',
    steps: levels.map((level, i) => ({
      stepId: `step_${i + 1}`,
      title: `Operation ${i + 1}`,
      description: 'Synthetic test step; no real external tools',
      role: 'coder' as const,
      dependencies: [],
      suggestedTools: [],
      sideEffectLevel: level,
      status: 'PENDING' as const
    })),
    estimatedWaves: 1,
    maxBudgetTokens: 1000,
    createdAt: now,
    updatedAt: now
  };
}

async function waitForState(engine: AutonomousAgentEngine, taskId: string, state: string) {
  for (let tries = 0; tries < 50; tries++) {
    const current = await engine.getTask(taskId);
    if (current?.state === state) return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const current = await engine.getTask(taskId);
  assert.fail(`Expected ${state} but found ${current?.state}`);
}

async function createRunningTask(levels: Array<'NONE' | 'WRITE' | 'DESTRUCTIVE'>) {
  const repository = new InMemoryAutonomousTaskRepository();
  let specialistExecutions = 0;
  let failSpecialist = false;
  const specialistRegistry = {
    hasSpecialist: (role: string) => role === 'coder',
    getSpecialist: (role: string) => role === 'coder' ? {
      requiredCapabilities: [],
      execute: async () => {
        specialistExecutions++;
        return failSpecialist
          ? { outcome: 'FAILED', error: { message: 'Synthetic specialist failure' } }
          : { outcome: 'COMPLETED', output: { summary: 'Authorized synthetic execution' } };
      }
    } : undefined
  } as any;
  const engine = new AutonomousAgentEngine({ repository, specialistRegistry });
  const task = await engine.createTask('Verify safe recovery', principal, makePlan(levels));
  await repository.updateState(task.taskId, 'PLANNING');
  await repository.updateState(task.taskId, 'READY');
  await repository.updateState(task.taskId, 'RUNNING');
  return {
    repository,
    engine,
    taskId: task.taskId,
    getSpecialistExecutions: () => specialistExecutions,
    setSpecialistFailure: () => { failSpecialist = true; }
  };
}

test('crash recovery requests approval before executing a pending write', async () => {
  const { engine, taskId, getSpecialistExecutions } = await createRunningTask(['WRITE']);
  await engine.recoverTask(taskId);
  const pending = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  assert.ok(pending.approvalRequestId);
  assert.equal(pending.activeStepId, 'step_1');
  assert.equal(pending.plan?.steps[0].status, 'WAITING_FOR_APPROVAL');
  assert.equal(pending.observations.length, 0, 'Unapproved step must not execute');
  assert.equal(getSpecialistExecutions(), 0, 'Unapproved step must never invoke specialist');

  await engine.approveStep(taskId, pending.approvalRequestId!, true);
  const completed = await waitForState(engine, taskId, 'COMPLETED');
  assert.equal(completed.observations.length, 1);
  assert.equal(completed.plan?.steps[0].status, 'COMPLETED');
  assert.equal(getSpecialistExecutions(), 1);
});

test('resuming a paused task does not implicitly approve a pending destructive step', async () => {
  const { repository, engine, taskId, getSpecialistExecutions } = await createRunningTask(['DESTRUCTIVE']);
  await repository.updateState(taskId, 'PAUSED');
  await engine.resumeTask(taskId);
  const pending = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  assert.ok(pending.approvalRequestId);
  assert.equal(pending.observations.length, 0);
  assert.equal(pending.plan?.steps[0].status, 'WAITING_FOR_APPROVAL');
  assert.equal(getSpecialistExecutions(), 0);
});

test('approval for one write does not authorize the next write', async () => {
  const { engine, taskId, getSpecialistExecutions } = await createRunningTask(['WRITE', 'WRITE']);
  await engine.recoverTask(taskId);
  const first = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  assert.equal(first.activeStepId, 'step_1');
  await engine.approveStep(taskId, first.approvalRequestId!, true);

  let second = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  // The first state was WAITING too; poll for the next step's new approval.
  for (let tries = 0; tries < 50 && second.activeStepId !== 'step_2'; tries++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    second = (await engine.getTask(taskId))!;
  }
  assert.equal(second.activeStepId, 'step_2');
  assert.notEqual(second.approvalRequestId, first.approvalRequestId);
  assert.equal(second.observations.length, 1);
  assert.equal(second.plan?.steps[1].status, 'WAITING_FOR_APPROVAL');
  assert.equal(getSpecialistExecutions(), 1, 'Only the first approved write invokes specialist');
});

test('a failed specialist on resumed execution never completes the task', async () => {
  const { engine, taskId, setSpecialistFailure, getSpecialistExecutions } = await createRunningTask(['WRITE']);
  setSpecialistFailure();
  await engine.recoverTask(taskId);
  const pending = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  await engine.approveStep(taskId, pending.approvalRequestId!, true);
  const failed = await waitForState(engine, taskId, 'FAILED');
  assert.equal(failed.plan?.steps[0].status, 'FAILED');
  assert.equal(getSpecialistExecutions(), 1);
  assert.equal(failed.deliverableSummary, undefined);
});
