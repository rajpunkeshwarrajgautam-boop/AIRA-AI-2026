import http from 'node:http';
import { db, closeDb } from '../../../packages/db/src/index.js';
import {
  classifyDatabaseUrl,
  assertAuthorizedStagingDatabase,
  STAGING_NEON_PROJECT_ID
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
  PostgresToolCallRepository,
  InMemoryToolCallRepository
} from '../../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../../packages/approvals/src/index.js';
import {
  PostgresApprovalRepository,
  PostgresSessionGrantRepository
} from '../../../packages/approvals/src/repositories.js';

const workerId = process.env.WORKER_ID || `worker_${process.env.HOSTNAME || 'docker'}_${process.pid}`;
const port = parseInt(process.env.PORT || process.env.WORKER_PORT || '8080', 10);
const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '500', 10);
const leaseDurationMs = parseInt(process.env.LEASE_DURATION_MS || '15000', 10);
const heartbeatIntervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '3000', 10);

console.log(`[SpecialistWorker] Bootstrapping worker ${workerId}...`);

// 1. Database Isolation & Preflight Verification
const rawConnStr = process.env.DATABASE_URL || '';
if (!rawConnStr || rawConnStr.includes('localhost')) {
  console.warn('[SpecialistWorker] Warning: Running against local/default database configuration');
} else {
  const classification = classifyDatabaseUrl(rawConnStr);
  if (classification.isProduction) {
    console.error('[SECURITY FATAL] Aborting: Worker cannot connect to production Neon database!');
    process.exit(1);
  }
}

// 2. Wire ToolGateway & Repositories
let toolCallRepo;
try {
  toolCallRepo = new PostgresToolCallRepository();
} catch {
  console.warn('[SpecialistWorker] Falling back to in-memory tool call repository');
  toolCallRepo = new InMemoryToolCallRepository();
}

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
  leaseDurationMs,
  heartbeatIntervalMs,
  concurrency
});

let isShuttingDown = false;
let dbConnected = false;

// 5. Health Check & HTTP Management Server
const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0];

  if (url === '/health') {
    const health = host.getHealth();
    const payload = {
      ...health,
      db: dbConnected ? 'CONNECTED' : 'DISCONNECTED',
      isShuttingDown,
      nodeVersion: process.version,
      timestamp: Date.now()
    };

    res.writeHead(isShuttingDown ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (url === '/ready') {
    if (isShuttingDown || !dbConnected) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, isShuttingDown, dbConnected }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true, workerId, status: 'READY' }));
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
    // Verify database connectivity
    await db.raw('SELECT 1');
    dbConnected = true;
    console.log(`[SpecialistWorker] Database connection verified.`);

    // Start HTTP server
    server.listen(port, '0.0.0.0', () => {
      console.log(`[SpecialistWorker] Health endpoint listening on http://0.0.0.0:${port}/health`);
    });

    // Start Worker Polling Loop
    await host.start();
    console.log(`[SpecialistWorker] Worker ${workerId} is now actively polling for specialist tasks.`);
  } catch (err: any) {
    console.error(`[SpecialistWorker] Failed to start worker:`, err);
    process.exit(1);
  }
}

main();
