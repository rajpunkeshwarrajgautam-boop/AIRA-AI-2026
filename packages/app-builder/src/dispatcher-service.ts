import 'dotenv/config';
import { db } from '../../db/src/index.js';
import { PostgresApplicationBuildQueue } from './queue.js';
import { ApplicationBuildDispatcher } from './dispatcher.js';
import {
  executeQueuedBuild, applyQueuedBuildResult,
  applyQueuedBuildCancellation, reconcileTerminalBuildRuns
} from './dispatcher-execution.js';

async function main(): Promise<void> {
  if (process.env.AIRA_BUILDER_DISPATCHER_ENABLED !== 'true') {
    throw new Error('DISPATCHER_DISABLED: AIRA_BUILDER_DISPATCHER_ENABLED=true is required');
  }
  if (process.env.AIRA_BUILDER_ENABLED !== 'true') {
    throw new Error('WORKER_NOT_ENABLED: AIRA_BUILDER_ENABLED=true is required');
  }
  const queue = new PostgresApplicationBuildQueue();
  await db.raw('select 1');
  const dispatcher = new ApplicationBuildDispatcher(
    queue, executeQueuedBuild, applyQueuedBuildResult, applyQueuedBuildCancellation,
    { leaseMs: 60_000, heartbeatMs: 5_000, pollMs: 1_000 }
  );
  const controller = new AbortController();
  const shutdown = () => {
    dispatcher.stop();
    controller.abort();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await reconcileTerminalBuildRuns();
    console.log('[aira-builder-dispatcher] ready (separate long-lived process)');
    await dispatcher.serve(controller.signal);
  } finally {
    await db.destroy();
  }
}
main().catch(err => {
  console.error('[aira-builder-dispatcher] startup failed:', err instanceof Error ? err.message : 'unknown');
  process.exitCode = 1;
});
