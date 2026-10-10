import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { db } from '../../db/src/index.js';
import { ModelRouter } from '../../model-router/src/index.js';
import { PostgresRunRepository } from '../../agent-runtime/src/repositories.js';
import type { Artifact, Run, StreamingEvent } from '../../contracts/src/index.js';
import { ApplicationBuildClient, generateApplicationDraft } from './client.js';
import type { QueuedBuild } from './queue.js';
import type { DispatchOutcome } from './dispatcher.js';

const runRepo = new PostgresRunRepository();
const modelRouter = new ModelRouter();

async function event(runId: string, type: StreamingEvent['type'], data: Record<string, unknown>): Promise<void> {
  await runRepo.appendRunEvent({
    eventId: 'evt_' + randomUUID().slice(0, 8), runId,
    type, data, timestamp: Date.now()
  });
}
function runForJob(job: QueuedBuild, run?: Run): Run {
  if (!run || !job.projectId || run.id !== job.projectId || run.principalId !== job.ownerId ||
      run.intent !== 'APPLICATION_BUILD' ||
      run.routingDecision?.executionTarget !== 'APPLICATION_BUILDER' ||
      !['TOOL_APPROVED', 'BUILD_QUEUED'].includes(run.executionCheckpoint || '') ||
      !run.principalScopes.some(x => x === '*' || x === 'projects.write')) {
    throw new Error('DISPATCHER_RUN_AUTHORIZATION_NOT_VERIFIED');
  }
  return run;
}

export async function executeQueuedBuild(job: QueuedBuild, signal: AbortSignal): Promise<DispatchOutcome> {
  const run = runForJob(job, await runRepo.getRun(job.projectId || ''));
  if (signal.aborted || job.cancelRequested) return { state: 'FAILED', result: { error: 'BUILD_CANCELLED' } };
  const client = new ApplicationBuildClient();
  const health = await client.health();
  const approvedPackages = health.dependencyInstall ? (health.approvedPackages || {}) : {};
  if (!modelRouter.listProviders().length) throw new Error('APPLICATION_BUILD_MODEL_NOT_CONFIGURED');
  let previousFailure = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal.aborted) throw new Error('BUILD_CANCELLED');
    const objective = previousFailure
      ? run.prompt + '\n\nRepair this previous real build failure:\n' + previousFailure.slice(-2500)
      : run.prompt;
    await event(run.id, 'tool.started', { name: 'project_build', attempt, queueJobId: job.id });
    const files = await generateApplicationDraft(objective, modelRouter, run.modelPolicy, approvedPackages);
    if (signal.aborted) throw new Error('BUILD_CANCELLED');
    const workerJobId = await client.create({ ownerId: run.principalId, ...files });
    const cancelRemote = () => { void client.cancel(workerJobId, run.principalId).catch(() => {}); };
    signal.addEventListener('abort', cancelRemote, { once: true });
    try {
      if (signal.aborted) { cancelRemote(); throw new Error('BUILD_CANCELLED'); }
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error('BUILD_CANCELLED');
        const result = await client.inspect(workerJobId, run.principalId);
        if (result.state === 'BUILD_PASSED') {
          const outcome: DispatchOutcome = {
            state: 'COMPLETED',
            result: {
              buildStatus: 'BUILD_PASSED',
              independentAcceptance: false,
              workerJobId,
              attempt,
              previewUrl: result.previewUrl,
              manifest: result.manifest,
              steps: result.steps.map(s => ({ name: s.name, exitCode: s.exitCode, output: s.output.slice(-1000) }))
            }
          };
          await event(run.id, 'tool.completed', { name: 'project_build', workerJobId, attempt, state: result.state });
          return outcome;
        }
        if (['FAILED', 'BLOCKED', 'CANCELLED'].includes(result.state)) {
          previousFailure = String(result.error || result.state) + '\n' +
            result.steps.map(s => s.output.slice(-700)).join('\n');
          await event(run.id, 'tool.completed', {
            name: 'project_build', workerJobId, attempt, state: result.state,
            error: String(result.error || result.state).slice(0, 300)
          });
          break;
        }
        await sleep(900, undefined, { signal });
      }
      if (!previousFailure) {
        cancelRemote();
        previousFailure = 'BUILD_WORKER_TIMEOUT';
      }
    } finally {
      signal.removeEventListener('abort', cancelRemote);
    }
  }
  return { state: 'FAILED', result: { error: 'APPLICATION_BUILD_FAILED', detail: previousFailure.slice(-1600) } };
}

async function resolveRun(job: QueuedBuild, state: 'COMPLETED' | 'FAILED' | 'CANCELLED',
  result: Record<string, unknown>): Promise<void> {
  const run = await runRepo.getRun(job.projectId || '');
  if (!run || run.principalId !== job.ownerId || run.intent !== 'APPLICATION_BUILD') return;
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state) || run.executionCheckpoint === 'COMPLETED') return;
  const passed = state === 'COMPLETED' && result.buildStatus === 'BUILD_PASSED';
  const message = passed
    ? 'AIRA isolated worker completed the generated project build and test scripts. ' +
      'This does not independently verify all requested functionality or gameplay.\n' +
      'Worker job: ' + String(result.workerJobId) + '\n' +
      'Preview: ' + String(result.previewUrl || 'not available')
    : state === 'CANCELLED' ? 'APPLICATION_BUILD_CANCELLED'
      : 'APPLICATION_BUILD_FAILED: ' + String(result.error || 'unknown').slice(0, 400);
  if (passed) {
    const artifactData = JSON.stringify({
      jobId: result.workerJobId, previewUrl: result.previewUrl,
      status: 'BUILD_PASSED', summary: message
    });
    const artifact: Artifact = {
      id: 'art_build_' + randomUUID(), runId: run.id,
      title: 'Built Project (not product certified)',
      type: 'application/vnd.ant.project', content: artifactData, version: 1,
      versions: [{ version: 1, content: artifactData, timestamp: Date.now() }]
    };
    run.artifacts.push(artifact);
    await runRepo.saveRun(run);
    await event(run.id, 'artifact.created', artifact as unknown as Record<string, unknown>);
  }
  run.content = message;
  run.executionCheckpoint = 'COMPLETED';
  run.state = state === 'CANCELLED' ? 'CANCELLED' : passed ? 'COMPLETED' : 'FAILED';
  run.updatedAt = Date.now();
  run.completedAt = Date.now();
  if (!passed) run.error = message;
  await runRepo.saveRun(run);
  await event(run.id, 'content.delta', { delta: message });
  await event(run.id, state === 'CANCELLED' ? 'run.cancelled' : passed ? 'run.completed' : 'run.failed',
    { state: run.state, error: passed ? undefined : message });
}

export async function applyQueuedBuildResult(job: QueuedBuild, state: 'COMPLETED' | 'FAILED',
  result: Record<string, unknown>): Promise<void> {
  await resolveRun(job, state, result);
}
export async function applyQueuedBuildCancellation(job: QueuedBuild): Promise<void> {
  await resolveRun(job, 'CANCELLED', { error: 'BUILD_CANCELLED' });
}

/** Reconcile a crash between durable queue completion and run event persistence. */
export async function reconcileTerminalBuildRuns(limit = 50): Promise<number> {
  const records = await db('aira_app_build_jobs')
    .whereIn('state', ['COMPLETED', 'FAILED', 'CANCELLED'])
    .whereNotNull('project_id')
    .orderBy('updated_at', 'desc').limit(limit);
  for (const record of records) {
    const run = await runRepo.getRun(record.project_id);
    if (!run || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) continue;
    const data = typeof record.result === 'string' ? JSON.parse(record.result) : (record.result || {});
    await resolveRun({ id: record.id, ownerId: record.owner_id, projectId: record.project_id,
      objective: record.objective, state: record.state, attempts: record.attempts,
      generation: record.fencing_generation, cancelRequested: record.cancel_requested },
      record.state, data);
  }
  return records.length;
}
