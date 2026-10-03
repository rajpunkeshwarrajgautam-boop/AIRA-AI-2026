import { db, runMigrations, closeDb } from '../index.js';
import { PostgresAgentRepository, PostgresRunRepository } from '../../../agent-runtime/src/repositories.js';
import { PostgresAutomationRepository } from '../../../automation/src/repositories.js';

async function main() {
  console.log('Dropping tables...');
  await db.raw('DROP TABLE IF EXISTS mcp_servers CASCADE');
  await db.raw('DROP TABLE IF EXISTS run_events CASCADE');
  await db.raw('DROP TABLE IF EXISTS runs CASCADE');
  await db.raw('DROP TABLE IF EXISTS automations CASCADE');
  await db.raw('DROP TABLE IF EXISTS agents CASCADE');
  await db.raw('DROP TABLE IF EXISTS knex_migrations CASCADE');
  await db.raw('DROP TABLE IF EXISTS knex_migrations_lock CASCADE');
  
  console.log('Running migrations...');
  await runMigrations();

  const agentRepo = new PostgresAgentRepository();
  const runRepo = new PostgresRunRepository();
  const automationRepo = new PostgresAutomationRepository();

  console.log('Testing AgentRepo...');
  await agentRepo.saveAgent({
    id: 'agent_1',
    name: 'Test Agent',
    description: 'A test agent',
    instructions: 'Do test things',
    modelPolicy: { model: 'mock-deterministic' } as any,
    tools: [],
    memoryScopes: ['workspace'],
    approvalPolicy: 'autonomous',
    maxSteps: 5,
    timeoutMs: 10000,
    createdAt: Date.now(),
    updatedAt: Date.now()
  } as any);

  console.log('Testing RunRepo...');
  await runRepo.saveRun({
    id: 'run_1',
    userId: 'agent_1',
    intent: 'ANSWER',
    state: 'QUEUED',
    modelPolicy: { model: 'mock-deterministic' } as any,
    prompt: 'Hello',
    systemPrompt: 'Sys',
    context: {},
    content: '',
    thinking: '',
    toolsUsed: [],
    toolCalls: [],
    toolResults: [],
    artifacts: [],
    citations: [],
    stepCount: 0,
    maxSteps: 10,
    createdAt: Date.now(),
    updatedAt: Date.now()
  } as any);

  console.log('Testing AutomationRepo...');
  await automationRepo.saveAutomation({
    id: 'auto_1',
    name: 'Test Auto',
    agentId: 'agent_1',
    cronExpression: '*/5 * * * *',
    enabled: true,
    trigger: 'CRON',
    conditions: {},
    objective: 'Test',
    approvalPolicy: 'autonomous'
  } as any);

  console.log('Test successful. Cleaning up...');
  await closeDb();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
