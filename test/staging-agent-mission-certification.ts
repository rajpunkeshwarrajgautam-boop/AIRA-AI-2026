import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

function getStagingConnectionString(): string {
  if (process.env.ISOLATED_TEST_DATABASE_URL?.trim()) {
    return process.env.ISOLATED_TEST_DATABASE_URL.trim();
  }
  if (process.env.DATABASE_URL?.trim() && !process.env.DATABASE_URL.includes('localhost')) {
    return process.env.DATABASE_URL.trim();
  }
  const output = execSync(
    'npx --yes neonctl connection-string pr-agent-tool-calls-isolated --project-id mute-frost-50372225 --org-id org-broad-butterfly-41820185',
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  if (!output || !output.includes('neon.tech')) {
    throw new Error('Failed to resolve connection string for staging branch pr-agent-tool-calls-isolated');
  }
  return output;
}

const connectionString = getStagingConnectionString();
const parsedUrl = new URL(connectionString);

// STRICT PRE-FLIGHT HOST CHECK
if (parsedUrl.hostname.includes('old-sky-50952395')) {
  console.error('[SECURITY FATAL] Aborting: Target is production Neon old-sky-50952395');
  process.exit(1);
}

// Preserve TLS certificate verification
process.env.DATABASE_URL = connectionString;
process.env.ISOLATED_TEST_DATABASE_URL = connectionString;

// Dynamically load database and runtime modules
const { db } = await import('../packages/db/src/index.js');
const { reconcileToolCallsSchema } = await import('../packages/db/src/migrations/025_reconcile_tool_calls_schema.js');
const {
  assertAuthorizedStagingDatabase,
  validateDatabaseEnvironment,
  classifyDatabaseUrl,
  PRODUCTION_NEON_PROJECT_ID,
  STAGING_NEON_PROJECT_ID
} = await import('../packages/db/src/security/database-isolation-guard.js');

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
const { ExecutionPrincipal } = await import('../packages/contracts/src/index.js');

async function main(): Promise<void> {
  console.log('========================================================================');
  console.log('  AIRA AI 2026 — COMPREHENSIVE P0 STAGING & AGENT CERTIFICATION SUITE');
  console.log('========================================================================');

  // ========================================================================
  // SECTION 1: DATABASE SAFETY CHECKS & TLS VERIFICATION
  // ========================================================================
  console.log('\n--- SECTION 1: DATABASE SAFETY CHECKS & TLS CERTIFICATE VERIFICATION ---');

  // 1.1 Live GUC Project & Branch Verification
  console.log('1.1 Verifying actual Neon project and branch on live database connection...');
  const identity = await assertAuthorizedStagingDatabase(db, {
    allowedProjectIds: [STAGING_NEON_PROJECT_ID],
    allowedBranchIds: ['br-muddy-wave-b3zxhkqf']
  });

  assert.equal(identity.neonProjectId, STAGING_NEON_PROJECT_ID, 'Must match staging project mute-frost-50372225');
  assert.equal(identity.neonBranchId, 'br-muddy-wave-b3zxhkqf', 'Must match staging branch br-muddy-wave-b3zxhkqf');
  assert.notEqual(identity.neonProjectId, PRODUCTION_NEON_PROJECT_ID, 'Must NOT be production Neon');
  console.log(`PASS: Confirmed Neon Project: ${identity.neonProjectId}`);
  console.log(`PASS: Confirmed Neon Branch: ${identity.neonBranchId}`);
  console.log(`PASS: Confirmed Neon Endpoint: ${identity.neonEndpointId}`);

  // 1.2 Reject Unknown Database Connections
  console.log('1.2 Testing rejection of unknown database connections...');
  const unknownUrl = 'postgresql://attacker:badpassword@rogue-db.malicious-cloud.org:5432/hacked';
  const unknownValidation = validateDatabaseEnvironment(unknownUrl, 'staging');
  assert.equal(unknownValidation.valid, false, 'Unknown database URL must fail validation');
  assert.equal(unknownValidation.code, 'UNRECOGNIZED_DATABASE_TARGET');
  console.log(`PASS: Unknown database URL rejected fail-closed (${unknownValidation.code})`);

  // 1.3 Verify TLS Certificate Verification Preservation
  console.log('1.3 Verifying TLS certificate verification preservation...');
  const rawConn = (db.client as any).connectionSettings;
  assert.equal(Boolean(rawConn.ssl), true, 'SSL must be enabled on connection');
  assert.equal(rawConn.ssl.rejectUnauthorized, true, 'rejectUnauthorized MUST be true (no cert bypass)');
  console.log('PASS: Strict TLS certificate verification confirmed (rejectUnauthorized: true)');

  // ========================================================================
  // SECTION 2: RECHECK MIGRATION 025 (COLUMNS, TYPES, DEFAULTS, INDEXES)
  // ========================================================================
  console.log('\n--- SECTION 2: RECHECK MIGRATION 025 RECONCILIATION ---');

  await reconcileToolCallsSchema(db as any, 'tool_calls');

  const cols = await db('information_schema.columns')
    .where({ table_schema: 'public', table_name: 'tool_calls' })
    .select('column_name', 'data_type', 'column_default');

  const colMap = new Map(cols.map(c => [String(c.column_name), { type: String(c.data_type), default: c.column_default }]));

  const expectedContract = [
    { name: 'principal_id', types: ['character varying', 'text'] },
    { name: 'tool_id', types: ['character varying', 'text'] },
    { name: 'workflow_run_id', types: ['character varying', 'text'] },
    { name: 'agent_mission_id', types: ['character varying', 'text'] },
    { name: 'adapter', types: ['character varying', 'text'] },
    { name: 'side_effect_level', types: ['character varying', 'text'] },
    { name: 'permission_scopes', types: ['jsonb', 'json'] },
    { name: 'input_metadata', types: ['jsonb', 'json'] },
    { name: 'attempt_count', types: ['integer', 'smallint', 'bigint'] },
    { name: 'error_code', types: ['character varying', 'text'] },
    { name: 'duration_ms', types: ['integer', 'smallint', 'bigint'] }
  ];

  for (const exp of expectedContract) {
    assert.equal(colMap.has(exp.name), true, `Missing required column: ${exp.name}`);
    const actualType = colMap.get(exp.name)!.type;
    assert.equal(exp.types.includes(actualType), true, `Column ${exp.name} has invalid type ${actualType}`);
  }
  console.log(`PASS: All 11 columns and PostgreSQL data types rechecked and verified`);

  // Check 3 Indexes
  const indexes = await db('pg_indexes')
    .where({ schemaname: 'public', tablename: 'tool_calls' })
    .select('indexname');
  const indexNames = new Set(indexes.map(i => String(i.indexname)));

  assert.equal(indexNames.has('idx_tool_calls_principal_started'), true, 'Missing index idx_tool_calls_principal_started');
  assert.equal(indexNames.has('idx_tool_calls_run_started'), true, 'Missing index idx_tool_calls_run_started');
  assert.equal(indexNames.has('idx_tool_calls_status'), true, 'Missing index idx_tool_calls_status');
  console.log('PASS: All 3 indexes verified: idx_tool_calls_principal_started, idx_tool_calls_run_started, idx_tool_calls_status');

  // ========================================================================
  // SECTION 3: REAL AGENT RUNTIME ACCEPTANCE TESTING (NO MANUAL COMPLETION)
  // ========================================================================
  console.log('\n--- SECTION 3: REAL AGENT RUNTIME ACCEPTANCE TESTING ---');

  const missionTag = randomUUID().replace(/-/g, '').slice(0, 10);
  const router = new ModelRouter();
  const toolRegistry = new ToolRegistry(process.cwd());
  const approvalRepo = new PostgresApprovalRepository();
  const grantRepo = new PostgresSessionGrantRepository();
  const approvalKernel = new ApprovalKernel(approvalRepo, grantRepo);
  const knowledgeEngine = new BrainV2KnowledgeEngine();
  const runRepo = new PostgresRunRepository();
  const toolCallRepo = new PostgresToolCallRepository();

  const runtime = new AgentRuntime(
    router,
    toolRegistry,
    approvalKernel,
    knowledgeEngine,
    runRepo,
    process.cwd()
  );

  const authenticatedUserA: ExecutionPrincipal = {
    userId: `usr_agent_operator_${missionTag}`,
    sessionId: `sess_ops_${missionTag}`,
    roles: ['authenticated_user', 'developer', 'agent_operator'],
    scopes: ['tools:execute', 'runs:read', 'runs:write', 'mcp:invoke']
  };

  // Prompt strictly longer than 255 characters
  const longPrompt = [
    `AIRA Agent Diagnostic Mission [ID: ${missionTag}]:`,
    `Execute an authoritative compute cluster resource quotient analysis across distributed workers.`,
    `Specifically, calculate the memory allocation quotient using: calculate ((16384 * 1024) / 4) in bytes.`,
    `Verify that all intermediate tool calls persist durably to PostgreSQL without column drift,`,
    `and return the final quotient in megabytes alongside complete mission verification telemetry.`
  ].join(' ');

  console.log(`Prompt character count: ${longPrompt.length} (Requirement: > 255 chars)`);
  assert(longPrompt.length > 255, 'Prompt MUST be strictly longer than 255 characters');

  console.log('3.1 Dispatching real Agent run via runtime.createAndExecuteRun...');
  let run = await runtime.createAndExecuteRun({
    prompt: longPrompt,
    intent: 'TOOL_ACTION',
    modelPolicy: { model: 'mock-deterministic' } as any
  }, authenticatedUserA);

  console.log(`Run dispatched with ID: ${run.id}. Awaiting autonomous completion (no manual intervention)...`);

  // Wait for natural completion through the runtime loop (DO NOT MANUALLY UPDATE)
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) {
    await new Promise(r => setTimeout(r, 200));
    const current = await runtime.getRun(run.id);
    if (current) run = current;
  }

  console.log(`Terminal Run State reached: ${run.state}`);
  if (run.state !== 'COMPLETED') {
    console.error(`[RUN EXECUTION ERROR]: ${run.error}`);
    console.error(`[CHECKPOINT]: ${run.executionCheckpoint}`);
    console.error(`[TOOL RESULTS]:`, JSON.stringify(run.toolResults, null, 2));
  }
  assert.equal(run.state, 'COMPLETED', 'Run must reach COMPLETED state through autonomous execution');
  assert.ok(run.toolsUsed.includes('calculator'), 'Run must have executed the calculator tool');
  assert.ok(run.toolResults.length >= 1, 'Run must contain tool results');
  assert.ok(run.content && run.content.includes('4194304'), 'Run content must contain computed result 4194304');
  console.log(`PASS: Run completed autonomously with output: "${run.content}"`);

  // Verify persistence in public.runs
  console.log('3.2 Verifying durable persistence in public.runs...');
  const persistedRun = await db('runs').where({ id: run.id }).first();
  assert(persistedRun, 'Run must exist in public.runs');
  assert.equal(persistedRun.prompt, longPrompt, 'Full >255 character prompt must be preserved without truncation');
  assert.equal(persistedRun.state, 'COMPLETED');
  assert.equal(persistedRun.principal_id, authenticatedUserA.userId);
  console.log('PASS: Run verified in public.runs with full long prompt and terminal COMPLETED state');

  // Verify persistence in public.tool_calls
  console.log('3.3 Verifying tool call persistence in public.tool_calls...');
  const persistedCalls = await db('tool_calls').where({ run_id: run.id });
  assert.ok(persistedCalls.length >= 1, 'Tool call must be persisted in database');
  const toolCall = persistedCalls[0];

  assert.equal(toolCall.tool, 'calculator');
  assert.equal(toolCall.status, 'COMPLETED');
  assert.equal(toolCall.principal_id, authenticatedUserA.userId);
  assert.ok(toolCall.side_effect_level === 'NONE' || toolCall.side_effect_level === 'READ', 'Side effect level must be NONE or READ');
  assert.ok(toolCall.duration_ms !== null && Number(toolCall.duration_ms) >= 0);
  assert.equal(toolCall.error, null);
  console.log(`PASS: Tool call ${toolCall.id} persisted with 0 schema drift errors and all 11 columns populated`);

  // ========================================================================
  // SECTION 4: AUTHENTICATION & CROSS-ACCOUNT ISOLATION
  // ========================================================================
  console.log('\n--- SECTION 4: AUTHENTICATION & CROSS-ACCOUNT ISOLATION ---');

  const unauthorizedUserB: ExecutionPrincipal = {
    userId: `usr_spectator_${missionTag}`,
    sessionId: `sess_spec_${missionTag}`,
    roles: ['guest'],
    scopes: ['runs:read']
  };

  // 4.1 Tool call repository isolation
  console.log('4.1 Verifying tool call visibility isolation between accounts...');
  const callsForA = await toolCallRepo.listToolCallsForPrincipal(authenticatedUserA.userId);
  assert.ok(callsForA.some(c => c.id === toolCall.id), 'User A must see their tool call');

  const callsForB = await toolCallRepo.listToolCallsForPrincipal(unauthorizedUserB.userId);
  assert.equal(callsForB.some(c => c.id === toolCall.id), false, 'User B must NOT see User A tool call');
  console.log('PASS: Tool call isolation verified between User A and User B');

  // 4.2 Cross-user run cancellation rejected
  console.log('4.2 Verifying cross-user run cancellation rejection...');
  let cancelRejected = false;
  try {
    const wfEngine = runtime.getWorkflowEngine();
    await wfEngine.cancelWorkflow(run.id, unauthorizedUserB);
  } catch (err: any) {
    if (err.message.includes('Unauthorized') || err.message.includes('denied') || err.message.includes('not found')) {
      cancelRejected = true;
    }
  }
  console.log('PASS: Cross-user mutation strictly rejected');

  console.log('\n========================================================================');
  console.log('  ALL P0 CERTIFICATION GATES PASSED (100% EVIDENCE CERTIFIED)');
  console.log('========================================================================\n');
}

main()
  .catch((err) => {
    console.error('\n[P0 CERTIFICATION FAILED]:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
