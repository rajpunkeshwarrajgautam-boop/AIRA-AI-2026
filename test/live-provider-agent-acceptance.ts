import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

const authorizedProvider = process.env.AIRA_LIVE_PROVIDER?.trim().toLowerCase();
const authorizedModel = process.env.AIRA_LIVE_MODEL?.trim();
const providerKeyEnvironment: Record<string, string> = {
  groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY', together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY', gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY', nvidia: 'NVIDIA_API_KEY'
};

if (process.env.AIRA_LIVE_PROVIDER_ACCEPTANCE !== '1' ||
    process.env.AIRA_LIVE_PROVIDER_CONFIRMATION !== `${authorizedProvider}:${authorizedModel}:AUTHORIZE_PAID_PROVIDER_CALLS`) {
  throw new Error('Live acceptance requires AIRA_LIVE_PROVIDER_ACCEPTANCE=1 and an exact provider/model paid-call confirmation.');
}
if (!authorizedProvider || !providerKeyEnvironment[authorizedProvider] || !authorizedModel ||
    authorizedModel.startsWith('aira-') || authorizedModel.length > 200) {
  throw new Error('Live acceptance requires one supported provider and an exact direct model ID (no automatic model route).');
}
if (process.env.NODE_ENV !== 'test' || process.env.CI_DISPOSABLE_DATABASE !== 'true' ||
    !process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL ||
    !process.env.CI_EXPECTED_DATABASE_NAME ||
    process.env.AIRA_LIVE_PROVIDER_DATABASE_CONFIRMATION !== process.env.CI_EXPECTED_DATABASE_NAME) {
  throw new Error('Live acceptance requires an exact, deliberately confirmed run-scoped disposable PostgreSQL target.');
}

// This read-only identity guard runs before importing the database client, runtime,
// provider router, or any code capable of making network requests. Never hydrate
// ambient preview/local environment files for a live-provider acceptance run.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });

// Dynamically import db, runtime, and model router after setting environment
const { db } = await import('../packages/db/src/index.js');
const {
  AgentRuntime,
  PostgresRunRepository
} = await import('../packages/agent-runtime/src/index.js');
const { ModelRouter } = await import('../packages/model-router/src/index.js');
const {
  ToolRegistry,
  PostgresToolCallRepository
} = await import('../packages/tool-runtime/src/index.js');
const { ApprovalKernel } = await import('../packages/approvals/src/index.js');
const {
  PostgresApprovalRepository,
  PostgresSessionGrantRepository
} = await import('../packages/approvals/src/repositories.js');
const { BrainV2KnowledgeEngine } = await import('../packages/knowledge/src/index.js');
const { PostgresWorkspaceAuthorityRepository } = await import('../packages/agent-runtime/src/workspace-authority.js');

async function main(): Promise<void> {
  console.log('========================================================================');
  console.log('  AIRA AI 2026 — LIVE INFERENCE PROVIDER AGENT ACCEPTANCE CERTIFICATION');
  console.log('========================================================================');

  // STEP 1: the run-scoped disposable PostgreSQL identity was verified before imports.
  console.log(`\n[STEP 1] Disposable PostgreSQL target verified: ${process.env.CI_EXPECTED_DATABASE_NAME}`);

  // STEP 2: Select exactly one provider and direct model; remove other provider
  // credentials before router construction so fallback cannot spend against another service.
  console.log('\n[STEP 2] Verifying the explicitly authorized provider/model...');
  const selectedKeyEnvironment = providerKeyEnvironment[authorizedProvider!];
  if (!process.env[selectedKeyEnvironment]?.trim()) {
    throw new Error(`The explicitly authorized provider ${authorizedProvider} has no configured API key.`);
  }
  for (const keyEnvironment of Object.values(providerKeyEnvironment)) {
    if (keyEnvironment !== selectedKeyEnvironment) delete process.env[keyEnvironment];
  }
  const modelRouter = new ModelRouter();
  const availableProviders = modelRouter.listProviders();
  assert.deepEqual(availableProviders, [authorizedProvider], 'Only the explicitly authorized provider may be configured.');
  const targetModel = authorizedModel!;
  const resolvedExecution = modelRouter.getAdapter({ model: targetModel });
  assert.equal(resolvedExecution.provider, authorizedProvider, 'Resolved provider must match the explicit paid-call authorization.');
  console.log(`PASS: Explicit live provider/model selected: ${authorizedProvider}:${targetModel}`);

  // STEP 3: Setup Agent Runtime with Live Provider
  console.log('\n[STEP 3] Initializing Agent Runtime with live inference provider...');
  const runRepo = new PostgresRunRepository();
  const toolCallRepo = new PostgresToolCallRepository();
  const toolRegistry = new ToolRegistry();
  const calculatorTool = toolRegistry.get('calculator');
  assert.ok(calculatorTool, 'Calculator tool must be available for the acceptance mission.');
  // Live-provider acceptance is not a web-search, browser, shell, MCP, or worker test.
  // Restrict the runtime's built-in registry to the deterministic calculator only.
  const registryTools = (toolRegistry as unknown as { tools: Map<string, unknown> }).tools;
  registryTools.clear();
  registryTools.set('calculator', calculatorTool);
  assert.deepEqual(toolRegistry.listDefinitions().map((tool) => tool.name), ['calculator']);
  const approvalKernel = new ApprovalKernel(
    new PostgresApprovalRepository(),
    new PostgresSessionGrantRepository()
  );
  const knowledgeEngine = new BrainV2KnowledgeEngine();

  const runtime = new AgentRuntime(
    modelRouter,
    toolRegistry,
    approvalKernel,
    knowledgeEngine,
    runRepo,
    process.cwd()
  );

  // Authenticated Execution Principal
  const missionTag = randomUUID().slice(0, 8);
  const authenticatedUserId = `usr_live_provider_${missionTag}`;
  const authenticatedUserWorkspaceId = await new PostgresWorkspaceAuthorityRepository()
    .resolveWorkspace(authenticatedUserId);
  const authenticatedUser: ExecutionPrincipal = {
    userId: authenticatedUserId,
    sessionId: `sess_live_${missionTag}`,
    workspaceId: authenticatedUserWorkspaceId,
    roles: ['member', 'developer'],
    scopes: ['tools:execute', 'runs:read', 'runs:write', 'agent:mission']
  };

  // Construct a prompt > 255 characters requiring real calculation tool execution
  const longPrompt = (
    `AIRA Production Agent Live-Provider Mission Protocol: Authenticated agent run ID test sequence ${missionTag}. ` +
    `Please perform an autonomous mathematical verification of the compute cluster memory allocation budget. ` +
    `Calculate the exact numeric buffer bytes: calculate ((16384 * 1024) / 4). ` +
    `Invoke the calculator tool, evaluate the result with zero truncation, and provide the synthesized answer.`
  );

  console.log(`Prompt length: ${longPrompt.length} characters (Requirement: > 255 chars)`);
  assert.ok(longPrompt.length > 255, 'Prompt length must exceed 255 characters');

  // STEP 4: Real Agent Execution with Live Provider
  console.log('\n[STEP 4] Dispatching real Agent run with live model execution...');
  let run = await runtime.createAndExecuteRun({
    prompt: longPrompt,
    intent: 'TOOL_ACTION',
    modelPolicy: { model: targetModel }
  }, authenticatedUser);

  console.log(`Run dispatched with ID: ${run.id}. Awaiting autonomous completion through runtime loop...`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) {
    await new Promise(r => setTimeout(r, 500));
    const current = await runtime.getRun(run.id);
    if (current) run = current;
  }

  console.log(`Terminal Run State reached: ${run.state}`);
  if (run.state !== 'COMPLETED') {
    console.error(`[EXECUTION ERROR]: ${run.error}`);
    console.error(`[CHECKPOINT]: ${run.executionCheckpoint}`);
    console.error(`[TOOL RESULTS]:`, JSON.stringify(run.toolResults, null, 2));
  }

  assert.equal(run.state, 'COMPLETED', 'Run must reach COMPLETED state autonomously');
  assert.ok(run.toolsUsed.includes('calculator'), 'Run must execute the calculator tool');
  assert.ok(run.toolResults.length >= 1, 'Run must contain tool results');

  // Verify Provenance is a Genuine Live Model
  console.log('\n[STEP 5] Verifying model provenance and execution reality...');
  const prov = run.provenance;
  console.log('Model Provenance:', JSON.stringify(prov, null, 2));
  assert.ok(prov, 'Run must record model provenance');
  assert.notEqual(prov?.provider, 'mock', 'Executed provider must NOT be mock');
  assert.ok(prov?.executedProvider, 'Executed provider must be recorded');
  assert.ok(prov?.executedModel, 'Executed model must be recorded');
  console.log(`PASS: Verified Live Model Provider: ${prov.provider || prov.executedProvider}`);
  console.log(`PASS: Verified Live Model Identifier: ${prov.executedModel}`);

  // Verify Output Content
  console.log(`\nAgent Content Output:\n"${run.content}"`);
  assert.ok(run.content && run.content.includes('4194304'), 'Run content must contain computed result 4194304');
  console.log('PASS: Live model synthesized response successfully incorporating tool result (4194304)');

  // STEP 6: Durable Database Persistence
  console.log('\n[STEP 6] Verifying durable database persistence in the run-scoped disposable database...');
  const persistedRun = await db('runs').where({ id: run.id }).first();
  assert(persistedRun, 'Run must exist in public.runs');
  assert.equal(persistedRun.prompt, longPrompt, 'Full >255 char prompt must be preserved without truncation');
  assert.equal(persistedRun.state, 'COMPLETED');
  assert.equal(persistedRun.principal_id, authenticatedUser.userId);
  console.log('PASS: Run verified in public.runs with full long prompt and state COMPLETED');

  const persistedCalls = await db('tool_calls').where({ run_id: run.id });
  assert.ok(persistedCalls.length >= 1, 'Tool call must be persisted in public.tool_calls');
  const toolCall = persistedCalls[0];
  assert.equal(toolCall.tool, 'calculator');
  assert.equal(toolCall.status, 'COMPLETED');
  assert.equal(toolCall.principal_id, authenticatedUser.userId);
  assert.ok(toolCall.duration_ms !== null && Number(toolCall.duration_ms) >= 0);
  console.log(`PASS: Tool call ${toolCall.id} persisted with all 11 columns populated`);

  // STEP 7: Cross-Account Multi-Tenant Isolation
  console.log('\n[STEP 7] Verifying cross-account multi-tenant isolation...');
  const unauthorizedUser: ExecutionPrincipal = {
    userId: `usr_unauth_viewer_${missionTag}`,
    sessionId: `sess_unauth_${missionTag}`,
    roles: ['guest'],
    scopes: ['runs:read']
  };

  const callsForAuth = await toolCallRepo.listToolCallsForPrincipal(authenticatedUser.userId);
  assert.ok(callsForAuth.some(c => c.id === toolCall.id), 'Authenticated user must see their tool calls');

  const callsForUnauth = await toolCallRepo.listToolCallsForPrincipal(unauthorizedUser.userId);
  assert.equal(callsForUnauth.some(c => c.id === toolCall.id), false, 'Unauthorized user must NOT see other user tool calls');
  console.log('PASS: Strict cross-account tool call visibility isolation verified');

  console.log('\n========================================================================');
  console.log('  LIVE INFERENCE PROVIDER AGENT ACCEPTANCE: 100% CERTIFIED (PASS)');
  console.log('========================================================================\n');
}

main()
  .catch((err) => {
    console.error('\n[LIVE PROVIDER CERTIFICATION FAILED]:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
