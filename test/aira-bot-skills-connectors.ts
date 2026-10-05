import assert from 'node:assert/strict';
import { createTestDatabase } from './postgres-fixture.js';

process.env.NODE_ENV = 'test';
const cleanupDatabase = await createTestDatabase();
const { db, runMigrations, closeDb } = await import('../packages/db/src/index.js');
await runMigrations();
const { BotRepository } = await import('../packages/aira-bot/src/repository.js');
const { BotSkillRepository } = await import('../packages/aira-bot/src/skills.js');
const { BotConnectorRuntime } = await import('../packages/aira-bot/src/connectors.js');
const { ModelRouter } = await import('../packages/model-router/src/index.js');
const { ToolRegistry } = await import('../packages/tool-runtime/src/index.js');
const { AgentRuntime } = await import('../packages/agent-runtime/src/index.js');
const { PostgresRunRepository } = await import('../packages/agent-runtime/src/repositories.js');
const { ApprovalKernel } = await import('../packages/approvals/src/index.js');
const { PostgresApprovalRepository, PostgresSessionGrantRepository } = await import('../packages/approvals/src/repositories.js');
const { BrainV2KnowledgeEngine } = await import('../packages/knowledge/src/index.js');

const owner = 'skill-owner';
const other = 'other-owner';
const bots = new BotRepository();
const skills = new BotSkillRepository();

async function waitTerminal(runtime: InstanceType<typeof AgentRuntime>, id: string) {
  for (let i = 0; i < 120; i++) {
    const run = await runtime.getRun(id);
    if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${id} did not become terminal.`);
}

try {
  const now = Date.now();
  await db('aira_bots').insert({
    id: 'bot_legacy', owner_id: owner,
    definition: JSON.stringify({ name: 'Legacy', description: '', instructions: 'Legacy instructions', model: 'gpt-4o', tools: [], approvalPolicy: 'risky_only', memory: '', skills: [], maxSteps: 8 }),
    created_at: now, updated_at: now
  });
  const legacy = await bots.get(owner, 'bot_legacy');
  assert.deepEqual(legacy?.skillIds, []);
  assert.deepEqual(legacy?.connectorIds, []);

  const skill = await skills.create(owner, { name: 'Evidence brief', description: 'Evidence-first reporting', instructions: 'Cite the evidence behind every conclusion.' });
  assert.equal((await skills.list(owner)).length, 1);
  assert.equal((await skills.list(other)).length, 0);
  await assert.rejects(() => skills.requireOwned(other, [skill.id]), /unavailable/i);
  await assert.rejects(() => skills.create(owner, { name: 'Evidence brief', description: '', instructions: 'Duplicate' }), /already exists/i);

  const bot = await bots.create(owner, {
    name: 'Skill Bot', description: '', instructions: 'Complete the task.', model: 'gpt-4o', tools: [], connectorIds: [],
    approvalPolicy: 'risky_only', memory: '', skills: [], skillIds: [skill.id], maxSteps: 8
  });
  await assert.rejects(() => skills.remove(owner, skill.id), /attached/i);

  const runs = new PostgresRunRepository();
  const models = new ModelRouter();
  const tools = new ToolRegistry();
  const approvals = new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository());
  const knowledge = new BrainV2KnowledgeEngine();
  const runtime = new AgentRuntime(models, tools, approvals, knowledge, runs);
  let observedSystem = '';
  const adapter = {
    async complete(messages: Array<{ role: string; content: string }>) {
      observedSystem = messages.find(message => message.role === 'system')?.content || '';
      return { text: JSON.stringify({ type: 'final', content: 'skill snapshot result' }), model: 'fixture', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    async stream() { /* not used by Bot loop */ }
  };
  models.getAdapter = () => adapter as any;
  models.listProviders = () => ['openai'];

  const started = await runtime.createAndExecuteRun(
    { prompt: 'Prepare the report.', intent: 'AGENT_MISSION', modelPolicy: { model: 'gpt-4o' } },
    { userId: owner, sessionId: 'skills-test' }, bot,
    async created => { await bots.recordTask(owner, bot.id, created.id, created.prompt); }
  );
  const completed = await waitTerminal(runtime, started.id);
  assert.equal(completed.state, 'COMPLETED');
  assert.match(observedSystem, /Cite the evidence behind every conclusion/);
  const snapshot = completed.context.reusableSkillSnapshot as Array<{ id: string; instructions: string }>;
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, skill.id);
  assert.equal(snapshot[0].instructions, 'Cite the evidence behind every conclusion.');

  await skills.update(owner, skill.id, { name: skill.name, description: skill.description, instructions: 'Changed after the run.' });
  const persisted = await runtime.getRun(completed.id);
  assert.equal((persisted!.context.reusableSkillSnapshot as Array<{ instructions: string }>)[0].instructions, 'Cite the evidence behind every conclusion.', 'completed run skill snapshot must remain immutable');

  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...botInput } = bot;
  await bots.update(owner, bot.id, { ...botInput, skillIds: [] });
  assert.equal(await skills.remove(owner, skill.id), true);

  const connector = new BotConnectorRuntime([{
    id: 'local-test', name: 'Local Test MCP', url: 'http://127.0.0.1:65530/mcp', transport: 'streamable_http', allowedTools: ['lookup']
  }]);
  const summaries = connector.summaries();
  assert.deepEqual(summaries[0], { id: 'local-test', name: 'Local Test MCP', connected: false, allowedTools: ['lookup'] });
  assert.equal('url' in summaries[0], false, 'connector endpoint must not be exposed by summary');
  const defs = connector.toolDefinitions(['local-test']);
  assert.equal(defs.find(def => def.name === 'connector_list')?.permissionLevel, 'READ');
  assert.equal(defs.find(def => def.name === 'connector_call')?.permissionLevel, 'EXTERNAL_COMMUNICATION');
  assert.equal(defs.find(def => def.name === 'connector_call')?.idempotencyClass, 'EXTERNAL_SIDE_EFFECT');
  await assert.rejects(() => connector.listTools(['local-test']), /localhost|private|reserved/i);
  await assert.rejects(() => connector.call([], 'local-test', 'lookup', {}), /outside.*allowlist/i);
  await connector.close();

  console.log('Aira Bot skills/connectors: PASS — schema normalization, owner isolation, deletion fence, immutable run snapshot, sanitized connector catalog, approval class, SSRF rejection');
} finally {
  await closeDb();
  await cleanupDatabase();
}
