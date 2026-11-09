import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousAgentEngine } from '../packages/agent-runtime/src/autonomous/autonomous-engine.js';
import { InMemoryAutonomousTaskRepository } from '../packages/agent-runtime/src/autonomous/repository.js';
import { isExplicitAutonomousApprovalDecision } from '../apps/api/src/auth/explicit-autonomous-approval.js';

const principal = { userId: 'approval_test_user', sessionId: 'approval_session', scopes: ['*'] };

test('autonomous approval API accepts only an explicit boolean decision', () => {
  assert.equal(isExplicitAutonomousApprovalDecision(true), true);
  assert.equal(isExplicitAutonomousApprovalDecision(false), true);
  for (const malformed of [undefined, null, '', 'true', 'false', 0, 1, {}, []]) {
    assert.equal(isExplicitAutonomousApprovalDecision(malformed), false);
  }
});

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

async function createRunningTask(
  levels: Array<'NONE' | 'WRITE' | 'DESTRUCTIVE'>,
  options?: { requireVerification?: boolean }
) {
  const repository = new InMemoryAutonomousTaskRepository();
  let specialistExecutions = 0;
  let verificationExecutions = 0;
  let specialistOutcome: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'UNAVAILABLE' = 'COMPLETED';
  let verifierOutcome: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'UNAVAILABLE' = 'COMPLETED';
  let verifierEnabled = true;
  let coderEnabled = true;
  let onVerifierExecution: (() => Promise<void> | void) | undefined;
  const specialistRegistry = {
    hasSpecialist: (role: string) => (coderEnabled && role === 'coder') || (verifierEnabled && role === 'verifier'),
    getSpecialist: (role: string) => role === 'coder' && coderEnabled ? {
      requiredCapabilities: [],
      execute: async () => {
        specialistExecutions++;
        return specialistOutcome === 'COMPLETED'
          ? { outcome: specialistOutcome, output: { summary: 'Authorized synthetic execution' } }
          : { outcome: specialistOutcome, error: { message: 'Synthetic specialist non-success' } };
      }
    } : role === 'verifier' && verifierEnabled ? {
      requiredCapabilities: [],
      execute: async () => {
        verificationExecutions++;
        if (onVerifierExecution) {
          await onVerifierExecution();
        }
        return verifierOutcome === 'COMPLETED'
          ? { outcome: verifierOutcome, output: { summary: 'Verified synthetic result' } }
          : { outcome: verifierOutcome, error: { message: `Synthetic verification ${verifierOutcome.toLowerCase()}` } };
      }
    } : undefined
  } as any;
  const engine = new AutonomousAgentEngine({
    repository,
    specialistRegistry,
    ...(options?.requireVerification !== undefined ? { requireVerification: options.requireVerification } : {})
  } as any);
  const task = await engine.createTask('Verify safe recovery', principal, makePlan(levels));
  if (options?.requireVerification !== undefined) {
    (task as any).requireVerification = options.requireVerification;
    await repository.updateTask(task);
  }
  await repository.updateState(task.taskId, 'PLANNING');
  await repository.updateState(task.taskId, 'READY');
  await repository.updateState(task.taskId, 'RUNNING');
  return {
    repository,
    engine,
    taskId: task.taskId,
    getSpecialistExecutions: () => specialistExecutions,
    getVerificationExecutions: () => verificationExecutions,
    setSpecialistFailure: () => { specialistOutcome = 'FAILED'; },
    setSpecialistOutcome: (outcome: typeof specialistOutcome) => { specialistOutcome = outcome; },
    enableVerifier: (outcome: typeof verifierOutcome = 'COMPLETED') => {
      verifierEnabled = true;
      verifierOutcome = outcome;
    },
    disableVerifier: () => { verifierEnabled = false; },
    setVerifierOutcome: (outcome: typeof verifierOutcome) => { verifierOutcome = outcome; },
    disableCoder: () => { coderEnabled = false; },
    setOnVerifierExecution: (fn: () => Promise<void> | void) => { onVerifierExecution = fn; }
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
  assert.equal(completed.observations.length, 2, 'Must contain step observation and verification gate observation');
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

test('resumed execution invokes its verifier and rejects failed verification', async () => {
  const { engine, taskId, enableVerifier, getVerificationExecutions } = await createRunningTask(['NONE']);
  enableVerifier('FAILED');
  await engine.recoverTask(taskId);
  const failed = await waitForState(engine, taskId, 'FAILED');
  assert.equal(failed.plan?.steps[0].status, 'COMPLETED');
  assert.equal(getVerificationExecutions(), 1, 'Recovery must actually invoke verification');
  assert.equal(failed.deliverableSummary, undefined, 'Failed verification cannot yield a completed deliverable');
  assert.match(failed.executionHistory.at(-1)?.reason || '', /VERIFICATION_FAILED/);
});

test('approval-resumed execution verifies successful results before reporting completion', async () => {
  const { engine, taskId, enableVerifier, getVerificationExecutions } = await createRunningTask(['WRITE']);
  enableVerifier('COMPLETED');
  await engine.recoverTask(taskId);
  const pending = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  await engine.approveStep(taskId, pending.approvalRequestId!, true);
  const completed = await waitForState(engine, taskId, 'COMPLETED');
  assert.equal(getVerificationExecutions(), 1);
  assert.match(completed.deliverableSummary || '', /Verified: true/);
});

test('non-success specialist outcomes are never reported as successful steps', async () => {
  for (const outcome of ['CANCELLED', 'TIMED_OUT', 'UNAVAILABLE'] as const) {
    const { engine, taskId, setSpecialistOutcome } = await createRunningTask(['NONE']);
    setSpecialistOutcome(outcome);
    await engine.recoverTask(taskId);
    const failed = await waitForState(engine, taskId, 'FAILED');
    assert.equal(failed.plan?.steps[0].status, 'FAILED', outcome);
    assert.equal(failed.observations[0].isError, true, outcome);
    assert.equal(failed.deliverableSummary, undefined, outcome);
  }
});

test('initial execution also rejects failed final verification', async () => {
  const { engine, taskId, enableVerifier, getVerificationExecutions } = await createRunningTask(['NONE']);
  enableVerifier('FAILED');
  const result = await engine.executeAutonomousTask(taskId);
  assert.equal(result.state, 'FAILED');
  assert.equal(getVerificationExecutions(), 1);
  assert.equal(result.deliverableSummary, undefined);
});

test('an unavailable specialist fails its step instead of fabricating success', async () => {
  const { engine, taskId, disableCoder, getSpecialistExecutions } = await createRunningTask(['NONE']);
  disableCoder();
  await engine.recoverTask(taskId);
  const failed = await waitForState(engine, taskId, 'FAILED');
  assert.equal(failed.plan?.steps[0].status, 'FAILED');
  assert.equal(failed.observations[0].isError, true);
  assert.match(failed.observations[0].summary, /UNAVAILABLE/);
  assert.equal(getSpecialistExecutions(), 0);
});

test('absence of a verifier fails closed when verification is mandatory', async () => {
  const { engine, taskId, disableVerifier } = await createRunningTask(['NONE']);
  disableVerifier();
  await engine.recoverTask(taskId);
  const failed = await waitForState(engine, taskId, 'FAILED');
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.deliverableSummary, undefined);
  assert.match(failed.executionHistory.at(-1)?.reason || '', /VERIFICATION_UNAVAILABLE/);
  const errorObs = failed.observations.find(obs => obs.isError && /VERIFICATION_UNAVAILABLE/.test(obs.summary));
  assert.ok(errorObs, 'Expected error observation with summary matching VERIFICATION_UNAVAILABLE');
  assert.equal(errorObs.isError, true);
  assert.match(errorObs.summary, /VERIFICATION_UNAVAILABLE/);
});

test('absence of a verifier on an explicitly optional task completes with unverified disclosure', async () => {
  const { engine, taskId, disableVerifier } = await createRunningTask(['NONE'], { requireVerification: false });
  disableVerifier();
  await engine.recoverTask(taskId);
  const completed = await waitForState(engine, taskId, 'COMPLETED');
  assert.equal(completed.state, 'COMPLETED');
  assert.match(completed.deliverableSummary || '', /Verified: false/);
});

test('verification non-success outcomes (CANCELLED, TIMED_OUT, UNAVAILABLE) fail closed', async () => {
  for (const outcome of ['CANCELLED', 'TIMED_OUT', 'UNAVAILABLE'] as const) {
    const { engine, taskId, setVerifierOutcome, getVerificationExecutions } = await createRunningTask(['NONE']);
    setVerifierOutcome(outcome);
    await engine.recoverTask(taskId);
    const failed = await waitForState(engine, taskId, 'FAILED');
    assert.equal(failed.state, 'FAILED', `Outcome ${outcome} must fail task`);
    assert.equal(failed.deliverableSummary, undefined, `Outcome ${outcome} must not set deliverableSummary`);
    assert.equal(getVerificationExecutions(), 1, `Outcome ${outcome} must invoke verifier`);
    assert.match(failed.executionHistory.at(-1)?.reason || '', /VERIFICATION_FAILED/);
  }
});

test('cancellation during verification aborts cleanly without state corruption', async () => {
  const { engine, taskId, setOnVerifierExecution, getVerificationExecutions } = await createRunningTask(['NONE']);
  setOnVerifierExecution(async () => {
    await engine.cancelTask(taskId, 'User cancelled during verification');
  });
  await engine.recoverTask(taskId);

  for (let tries = 0; tries < 50; tries++) {
    const current = await engine.getTask(taskId);
    if (current?.state === 'CANCELLED') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const cancelled = (await engine.getTask(taskId))!;
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.deliverableSummary, undefined, 'Cancelled task must not set deliverable summary');
  assert.equal(getVerificationExecutions(), 1, 'Verifier must have been invoked');
});

test('fencing token mismatch during verification prevents duplicate completion', async () => {
  const { repository, engine, taskId, setOnVerifierExecution, getVerificationExecutions } = await createRunningTask(['NONE']);
  setOnVerifierExecution(async () => {
    const raw = (repository as any).tasks.get(taskId);
    if (raw) raw.leaseExpiresAt = 0;
    const claim = await repository.claimTask!(taskId, 'competing_worker', 60_000);
    assert.equal(claim.success, true);
  });
  await engine.recoverTask(taskId);
  await new Promise(resolve => setTimeout(resolve, 50));

  const afterTask = (await repository.getTask(taskId))!;
  assert.equal(afterTask.leaseOwner, 'competing_worker');
  assert.equal(afterTask.deliverableSummary, undefined, 'Stale worker must not record deliverable summary');
  assert.notEqual(afterTask.state, 'COMPLETED', 'Stale worker must not complete task');
  assert.equal(getVerificationExecutions(), 1, 'Verifier was invoked before token mismatch was detected');
});

test('crash recovery reexecutes an unfinished RUNNING read step', async () => {
  const { repository, engine, taskId, getSpecialistExecutions } = await createRunningTask(['NONE']);
  const checkpoint = (await repository.getTask(taskId))!;
  checkpoint.plan!.steps[0].status = 'RUNNING';
  await repository.updateTask(checkpoint);

  await engine.recoverTask(taskId);
  const completed = await waitForState(engine, taskId, 'COMPLETED');
  assert.equal(completed.plan?.steps[0].status, 'COMPLETED');
  assert.equal(getSpecialistExecutions(), 1, 'An unfinished read cannot be silently skipped');
});

test('crash recovery requires fresh approval for an unfinished RUNNING write', async () => {
  const { repository, engine, taskId, getSpecialistExecutions } = await createRunningTask(['WRITE']);
  const checkpoint = (await repository.getTask(taskId))!;
  checkpoint.plan!.steps[0].status = 'RUNNING';
  await repository.updateTask(checkpoint);

  await engine.recoverTask(taskId);
  const waiting = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  assert.equal(waiting.plan?.steps[0].status, 'WAITING_FOR_APPROVAL');
  assert.ok(waiting.approvalRequestId);
  assert.equal(getSpecialistExecutions(), 0, 'A possibly partially executed write must not auto-repeat');
});

test('concurrent approval requests consume one approval only once', async () => {
  const { engine, taskId, getSpecialistExecutions } = await createRunningTask(['WRITE']);
  await engine.recoverTask(taskId);
  const pending = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
  const decisions = await Promise.allSettled([
    engine.approveStep(taskId, pending.approvalRequestId!, true),
    engine.approveStep(taskId, pending.approvalRequestId!, true)
  ]);
  assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(decisions.filter(result => result.status === 'rejected').length, 1);
  await waitForState(engine, taskId, 'COMPLETED');
  assert.equal(getSpecialistExecutions(), 1, 'An approval must never launch two write operations');
});

test('concurrent pause-resume calls cannot launch duplicate specialist executions', async () => {
  const { repository, engine, taskId, getSpecialistExecutions } = await createRunningTask(['NONE']);
  await repository.updateState(taskId, 'PAUSED');
  const resumes = await Promise.allSettled([engine.resumeTask(taskId), engine.resumeTask(taskId)]);
  assert.equal(resumes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(resumes.filter(result => result.status === 'rejected').length, 1);
  await waitForState(engine, taskId, 'COMPLETED');
  assert.equal(getSpecialistExecutions(), 1);
});

test('a persisted failed step is not skipped and promoted to mission success during recovery', async () => {
  const { repository, engine, taskId, getSpecialistExecutions } = await createRunningTask(['NONE', 'NONE']);
  const checkpoint = (await repository.getTask(taskId))!;
  checkpoint.plan!.steps[0].status = 'FAILED';
  checkpoint.plan!.steps[0].resultSummary = 'Worker recorded failure before crash';
  await repository.updateTask(checkpoint);

  await engine.recoverTask(taskId);
  const failed = await waitForState(engine, taskId, 'FAILED');
  assert.equal(getSpecialistExecutions(), 0);
  assert.equal(failed.plan?.steps[1].status, 'PENDING');
  assert.equal(failed.deliverableSummary, undefined);
  assert.match(failed.executionHistory.at(-1)?.reason || '', /Persisted step/);
});
