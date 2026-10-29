import { SpecialistWorkerHost } from '../../packages/agent-runtime/src/durable/worker-host.js';
import { PostgresSpecialistTaskRepository } from '../../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { SpecialistRegistry } from '../../packages/agent-runtime/src/specialists/specialist-registry.js';
import { MathematicalSpecialistAgent } from '../../packages/agent-runtime/src/specialists/mathematical-specialist.js';
import { ToolGateway, InMemoryToolCallRepository } from '../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../packages/approvals/src/index.js';
import { execFileSync } from 'node:child_process';

if (process.env.AIRA_POSTGRES_CERTIFICATION !== '1') {
  throw new Error('Refusing standalone worker certification outside the disposable PostgreSQL workflow.');
}
execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });

const workerId = process.env.WORKER_ID || `worker_proc_${process.pid}`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || '200');
const leaseDurationMs = Number(process.env.LEASE_DURATION_MS || '3000');
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || '500');

const toolCallRepo = new InMemoryToolCallRepository();
const approvalKernel = new ApprovalKernel();
const toolGateway = new ToolGateway(toolCallRepo, approvalKernel, process.cwd());

const registry = new SpecialistRegistry();
const mathSpecialist = new MathematicalSpecialistAgent(toolGateway);
registry.registerSpecialist(mathSpecialist, 'LIVE_STAGING_CERTIFIED');

const repository = new PostgresSpecialistTaskRepository();
const host = new SpecialistWorkerHost(repository, registry, {
  workerId,
  pollIntervalMs,
  leaseDurationMs,
  heartbeatIntervalMs,
  concurrency: Number(process.env.WORKER_CONCURRENCY || '4')
});

let started = false;

process.on('message', async (msg: any) => {
  if (msg?.action === 'START') {
    await host.start();
    started = true;
    if (process.send) process.send({ status: 'READY', workerId, pid: process.pid });
  } else if (msg?.action === 'CRASH_ABRUPT') {
    // Abrupt termination simulation: process is killed immediately without DB cleanup or graceful drain
    process.exit(137);
  } else if (msg?.action === 'STOP_GRACEFUL') {
    await host.stop();
    if (process.send) process.send({ status: 'STOPPED', workerId });
    process.exit(0);
  }
});

process.on('SIGTERM', async () => {
  await host.stop();
  process.exit(0);
});

// Auto-start if requested via env
if (process.env.AUTO_START === 'true') {
  host.start().then(() => {
    if (process.send) process.send({ status: 'READY', workerId, pid: process.pid });
  });
}
