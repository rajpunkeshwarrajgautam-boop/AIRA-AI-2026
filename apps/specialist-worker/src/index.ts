import http from 'node:http';
import { db, closeDb } from '../../../packages/db/src/index.js';
import {
  classifyDatabaseUrl,
  PRODUCTION_NEON_PROJECT_ID,
  PRODUCTION_NEON_ENDPOINT_ID,
  STAGING_NEON_PROJECT_ID,
  COMMERCIAL_PR92_BRANCH_ID
} from '../../../packages/db/src/security/database-isolation-guard.js';
import {
  SpecialistWorkerHost,
  WorkerHostHealth
} from '../../../packages/agent-runtime/src/durable/worker-host.js';
import { PostgresSpecialistTaskRepository } from '../../../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { SpecialistRegistry } from '../../../packages/agent-runtime/src/specialists/specialist-registry.js';
import {
  MathematicalSpecialistAgent,
  AnalysisSpecialistAgent,
  VerificationSpecialistAgent
} from '../../../packages/agent-runtime/src/specialists/index.js';
import {
  ToolGateway,
  PostgresToolCallRepository
} from '../../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../../packages/approvals/src/index.js';
import {
  PostgresApprovalRepository,
  PostgresSessionGrantRepository
} from '../../../packages/approvals/src/repositories.js';

const workerId = process.env.WORKER_ID || `worker_${process.env.HOSTNAME || 'docker'}_${process.pid}`;
const port = parseInt(process.env.PORT || process.env.WORKER_PORT || '8080', 10);
const bindHost = process.env.WORKER_BIND_HOST || '0.0.0.0';
const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '500', 10);
const maxPollIntervalMs = parseInt(process.env.MAX_POLL_INTERVAL_MS || '2000', 10);
const idleBackoffMultiplier = parseFloat(process.env.IDLE_BACKOFF_MULTIPLIER || '1.5');
const leaseDurationMs = parseInt(process.env.LEASE_DURATION_MS || '15000', 10);
const heartbeatIntervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '3000', 10);

import {
  evaluateWorkerActivationPolicy,
  assertWorkerActivationAuthorized,
  ActivationSecurityError,
  WorkerActivationConfig,
  CANONICAL_PRODUCTION_NEON_PROJECT_ID,
  CANONICAL_PRODUCTION_NEON_ENDPOINT_ID
} from '../../../packages/agent-runtime/src/durable/worker-activation-policy.js';

console.log(`[SpecialistWorker] Bootstrapping worker ${workerId}...`);

// 1. Environment-Bound Database Security Policy Preflight
const rawConnStr = process.env.DATABASE_URL || '';
if (!rawConnStr) {
  console.error('[SECURITY FATAL] DATABASE_URL is not set. Specialist worker must fail closed.');
  process.exit(1);
}

const classification = classifyDatabaseUrl(rawConnStr);

const activationConfig: WorkerActivationConfig = {
  airaEnv: process.env.AIRA_ENV,
  productionWorkerEnabled: process.env.AIRA_PRODUCTION_WORKER_ENABLED,
  expectedNeonProjectId: process.env.EXPECTED_NEON_PROJECT_ID,
  expectedNeonEndpointId: process.env.EXPECTED_NEON_ENDPOINT_ID
};

const staticPolicyResult = evaluateWorkerActivationPolicy(activationConfig);
if (!staticPolicyResult.authorized) {
  console.error(
    `[SECURITY FATAL] Specialist worker activation denied: ${staticPolicyResult.message} (code: ${staticPolicyResult.code})`
  );
  process.exit(1);
}

// Crossover check against database URL classification
if (classification.isProduction && !staticPolicyResult.isProduction) {
  console.error(
    `[SECURITY FATAL] Aborting: Non-production worker cannot connect to production Neon database (${PRODUCTION_NEON_PROJECT_ID})!`
  );
  process.exit(1);
}

if (!classification.isProduction && staticPolicyResult.isProduction) {
  console.error(
    `[SECURITY FATAL] Aborting: Production worker cannot connect to non-production database (${classification.sanitizedTarget})!`
  );
  process.exit(1);
}

if (classification.isCommercialPr92) {
  console.error(
    `[SECURITY FATAL] Aborting: Commercial PR #92 branch (${COMMERCIAL_PR92_BRANCH_ID}) access strictly denied.`
  );
  process.exit(1);
}

// 2. Wire ToolGateway & Repositories (Strictly fail-closed, NO in-memory fallback)
const toolCallRepo = new PostgresToolCallRepository();
const approvalRepo = new PostgresApprovalRepository();
const grantRepo = new PostgresSessionGrantRepository();
const approvalKernel = new ApprovalKernel(approvalRepo, grantRepo);
const toolGateway = new ToolGateway(toolCallRepo, approvalKernel, process.cwd());

import {
  ISpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from '../../../packages/agent-runtime/src/specialists/specialist-interface.js';
import {
  SpecialistRole,
  CapabilityCategory
} from '../../../packages/contracts/src/index.js';

class CompositeAnalystSpecialistAgent implements ISpecialistAgent {
  public readonly role: SpecialistRole = 'analyst';
  public readonly name = 'AIRA Unified Analyst Specialist';
  public readonly description = 'Executes deterministic mathematical calculations or structured data analysis based on mission input contract.';
  public readonly requiredCapabilities = Object.freeze(['tool_execution', 'data_analysis'] as CapabilityCategory[]);

  constructor(
    private mathAgent: MathematicalSpecialistAgent,
    private dataAgent: AnalysisSpecialistAgent
  ) {}

  canExecute(context: SpecialistExecutionContext): { authorized: boolean; reason?: string } {
    if (context.inputPayload?.expression || context.inputPayload?.formula || context.inputPayload?.input) {
      return this.mathAgent.canExecute(context);
    }
    return this.dataAgent.canExecute(context);
  }

  async execute(context: SpecialistExecutionContext): Promise<SpecialistExecutionResult> {
    if (context.inputPayload?.expression || context.inputPayload?.formula || context.inputPayload?.input) {
      return await this.mathAgent.execute(context);
    }
    return await this.dataAgent.execute(context);
  }
}

// 3. Register Specialists
const registry = new SpecialistRegistry();
const mathSpecialist = new MathematicalSpecialistAgent(toolGateway);
const analysisSpecialist = new AnalysisSpecialistAgent();
const verificationSpecialist = new VerificationSpecialistAgent();

const compositeAnalyst = new CompositeAnalystSpecialistAgent(mathSpecialist, analysisSpecialist);
registry.registerSpecialist(compositeAnalyst, 'LIVE_STAGING_CERTIFIED');
registry.registerSpecialist(verificationSpecialist, 'LIVE_STAGING_CERTIFIED');

// 4. Initialize Host
const repository = new PostgresSpecialistTaskRepository();
const host = new SpecialistWorkerHost(repository, registry, {
  workerId,
  pollIntervalMs,
  maxPollIntervalMs,
  idleBackoffMultiplier,
  leaseDurationMs,
  heartbeatIntervalMs,
  concurrency
});

let isShuttingDown = false;
let dbConnected = false;
let isActivated = false;

// 5. Health Check & HTTP Management Server
const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0];

  if (url === '/health') {
    const health = host.getHealth();
    const payload = {
      ...health,
      db: dbConnected ? 'CONNECTED' : 'DISCONNECTED',
      isActivated,
      isShuttingDown,
      nodeVersion: process.version,
      timestamp: Date.now()
    };

    res.writeHead(isShuttingDown ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (url === '/ready') {
    if (isShuttingDown || !dbConnected || !isActivated) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, isShuttingDown, dbConnected, isActivated }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true, workerId, status: 'READY', isActivated: true }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// 6. Graceful Shutdown Handlers
async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SpecialistWorker] Received ${signal}. Initiating graceful shutdown for worker ${workerId}...`);

  try {
    // Stop accepting new HTTP requests
    server.close();

    // Drain and stop worker host
    await host.stop();

    // Close database connection
    await closeDb();

    console.log(`[SpecialistWorker] Worker ${workerId} shutdown complete.`);
    process.exit(0);
  } catch (err) {
    console.error(`[SpecialistWorker] Error during shutdown:`, err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 7. Start Worker Process
async function main() {
  try {
    // 1. Authoritative runtime database identity & activation policy validation
    const runtimeActivation = await assertWorkerActivationAuthorized(activationConfig, db);
    isActivated = true;
    console.log(
      `[SpecialistWorker] Worker activation policy verified: ${runtimeActivation.code} (${runtimeActivation.message})`
    );

    // 2. Verify all required durable persistence tables are available (fail closed if schema missing)
    await db.raw('SELECT 1 FROM specialist_tasks LIMIT 0');
    await db.raw('SELECT 1 FROM specialist_task_events LIMIT 0');
    await db.raw('SELECT 1 FROM tool_calls LIMIT 0');
    await db.raw('SELECT 1 FROM approvals LIMIT 0');
    await db.raw('SELECT 1 FROM session_grants LIMIT 0');

    dbConnected = true;
    console.log(`[SpecialistWorker] Database connection & fail-closed persistence verified.`);

    // 3. Start HTTP server
    server.listen(port, bindHost, () => {
      console.log(`[SpecialistWorker] Health endpoint listening on http://${bindHost}:${port}/health`);
    });

    // 4. Start Worker Polling Loop
    await host.start();
    console.log(
      `[SpecialistWorker] Worker ${workerId} is now actively polling (backoff: ${pollIntervalMs}ms-${maxPollIntervalMs}ms).`
    );
  } catch (err: any) {
    isActivated = false;
    dbConnected = false;
    console.error(`[SpecialistWorker] Failed to start worker (fail-closed):`, err.message || err);
    process.exit(1);
  }
}

main();
