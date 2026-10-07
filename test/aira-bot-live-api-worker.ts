import express from 'express';
import { closeDb } from '../packages/db/src/index.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository } from '../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { ManagedComputerRuntime } from '../packages/computer-runtime/src/managed.js';
import { DockerComputerProvider } from '../packages/computer-runtime/src/docker.js';
import { LiveRuntimeService } from '../packages/computer-runtime/src/live.js';
import { createBotRouter } from '../apps/api/src/aira-bot.js';
import { createPrincipalMiddleware } from '../apps/api/src/middleware/principal.js';
import { BotRoutineEngine, BotOrchestrationRepository } from '../packages/aira-bot/src/orchestration.js';

let loseResponse = false;
const provider = new DockerComputerProvider({
  runnerSecret: 'phase7-test-secret',
  addressResolver: async () => process.env.AIRA_TEST_RUNNER_URL!,
  fetcher: async (input, init) => {
    const response = await fetch(input, init);
    if (loseResponse && String(input).endsWith('/terminal')) {
      loseResponse = false;
      await response.clone().json();
      process.send?.({ effectObserved: true });
      await new Promise<void>(() => {});
    }
    return response;
  }
});
const computer = new ManagedComputerRuntime(provider);
const models = new ModelRouter();
// Controlled test adapter, not a production fallback. Recovery still uses the
// actual AgentRuntime, repositories, approvals and computer dispatch.
models.listProviders = () => ['openai'];
models.getAdapter = () => ({
  async complete(messages: any[]) {
    const prompt = messages.find(message => message.role === 'user')?.content || '';
    if (prompt === 'hold-model' && process.env.AIRA_INSTANCE_ID === 'phase7-api-C') {
      process.send?.({ modelHeld: true });
      await new Promise<void>(() => {});
    }
    return { text: JSON.stringify({ type: 'final', content: 'Recovered by a live worker.' }), usage: { inputTokens: 1, outputTokens: 1 } };
  }
} as any);
const runs = new PostgresRunRepository();
const runtime = new AgentRuntime(models, new ToolRegistry(), new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository()), new BrainV2KnowledgeEngine(), runs, process.cwd(), computer);
const live = new LiveRuntimeService(runtime, computer);
const app = express();
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ live: true }));
app.get('/api/ready', async (_req, res) => {
  const health = await live.readiness();
  res.status(health.ready ? 200 : 503).json(health);
});
app.use(createPrincipalMiddleware());
const router = createBotRouter(runtime, runs, models, { computer, routineLeader: () => live.reliability.isSchedulerLeader(), manageScheduling: false });
app.use('/api/aira-bot', router);
app.use((error: Error, _req: any, res: any, _next: any) => res.status(500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', () => resolve()));
await live.start();
process.send?.({ ready: true, port: (server.address() as any).port, workerId: runtime.getWorkerId(), instanceId: live.reliability.instanceId });
process.on('message', async (message: any) => {
  try {
    if (message.action === 'lose-response') loseResponse = true;
    if (message.action === 'recover') await live.recover();
    if (message.action === 'publish') await live.publisher.tick();
    if (message.action === 'routine-tick') await new BotRoutineEngine(runtime, undefined, undefined, () => live.reliability.isSchedulerLeader()).tick(message.now);
    if (message.action === 'heartbeat') await live.reliability.heartbeat();
    if (message.action === 'pause-heartbeat') live.reliability.stop();
    if (message.action === 'resume-heartbeat') await live.reliability.start();
    if (message.action === 'claim-routine') {
      const repository = new BotOrchestrationRepository();
      const routine = await repository.getRoutine(message.owner, message.routineId);
      const claim = await repository.claimRoutineSlot(routine!, message.scheduledFor);
      process.send?.({ id: message.id, claim }); return;
    }
    process.send?.({ id: message.id, ok: true });
  } catch (error) { process.send?.({ id: message.id, error: (error as Error).message }); }
});
process.on('SIGTERM', () => {
  router.stop(); live.stop();
  server.close(() => { void closeDb().finally(() => process.exit(0)); });
});
