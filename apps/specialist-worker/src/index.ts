import 'dotenv/config';
import { ModelRouter } from '../../../packages/model-router/src/index.js';
import { ToolRegistry,ToolGateway,PostgresToolCallRepository } from '../../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../../packages/approvals/src/index.js';
import { PostgresApprovalRepository,PostgresSessionGrantRepository } from '../../../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../../../packages/knowledge/src/index.js';
import { PostgresRunRepository } from '../../../packages/agent-runtime/src/repositories.js';
import { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import { DurableSpecialistDispatcher } from '../../../packages/agent-runtime/src/specialist-dispatcher.js';
import { db, closeDb } from '../../../packages/db/src/index.js';

import { resolveWorkerHealthHost, createWorkerHealthServer } from './health.js';

if(process.env.AIRA_SPECIALIST_WORKER_PROCESS!=='true'||
   process.env.AIRA_SPECIALIST_WORKER_ENABLED!=='true' ||
   process.env.AIRA_SPECIALIST_DELEGATION_ENABLED!=='true' ||
   process.env.VERCEL==='1')throw new Error('SPECIALIST_DEDICATED_WORKER_REQUIRED');
if(process.env.NODE_ENV==='production' && process.getuid?.()===0)
  throw new Error('SPECIALIST_WORKER_MUST_NOT_RUN_AS_ROOT');
if(!process.env.DATABASE_URL)throw new Error('SPECIALIST_POSTGRES_URL_REQUIRED');
if((process.env.AIRA_ENVIRONMENT==='staging'||process.env.AIRA_STAGING==='true') &&
   process.env.DATABASE_URL.includes('prod-release'))
  throw new Error('SPECIALIST_STAGING_PRODUCTION_CREDENTIAL_COLLISION: Staging worker must not connect to production database');
if(!process.env.AIRA_AGENT_PLAN_SIGNING_KEY ||
   process.env.AIRA_AGENT_PLAN_SIGNING_KEY.length<32)
  throw new Error('SPECIALIST_SIGNING_KEY_REQUIRED');
if(![process.env.ANTHROPIC_API_KEY,process.env.OPENAI_API_KEY,process.env.NVIDIA_API_KEY]
  .some(s=>Boolean(s)))throw new Error('SPECIALIST_LIVE_MODEL_PROVIDER_REQUIRED');

// Reuse exactly AIRA's model, approval, tool and run repositories.
const policy=new ApprovalKernel(new PostgresApprovalRepository(),new PostgresSessionGrantRepository());
const tools=new ToolRegistry(process.cwd());
const gateway=new ToolGateway(new PostgresToolCallRepository(),policy,process.cwd());
const runtime=new AgentRuntime(
  new ModelRouter(),tools,policy,new BrainV2KnowledgeEngine(),
  new PostgresRunRepository(),process.cwd(),
  undefined,undefined,undefined,undefined,undefined,gateway
);
const exitSignal=new AbortController();
const dispatcher=new DurableSpecialistDispatcher(runtime,{
  leaseMs:30000,
  heartbeatMs:5000,
  onLeaseLost:(error)=>{
    console.error(JSON.stringify({
      level:'error',
      event:'FATAL_SPECIALIST_LEASE_LOSS',
      workerId:dispatcher.id,
      error:error.message,
      timestamp:new Date().toISOString()
    }));
    // The safe response to losing a lease is to kill this process rather than
    // allow a stale model/tool computation to continue in the old worker.
    process.exit(71);
  }
});

// Production Liveness & Readiness HTTP Probe Server
// Defaults to 127.0.0.1 for native systemd host deployments to prevent accidental public network exposure.
const healthPort=parseInt(process.env.PORT||process.env.HEALTH_PORT||'8080',10);
const healthHost=resolveWorkerHealthHost(process.env);
const healthServer=createWorkerHealthServer({
  workerId:dispatcher.id,
  checkDatabase:async()=>{
    await db.raw('SELECT 1');
  },
  leaseMs:30000,
  heartbeatMs:5000
});

healthServer.listen(healthPort,healthHost,()=>{
  console.log(JSON.stringify({
    level:'info',
    event:'HEALTH_PROBE_SERVER_LISTENING',
    host:healthHost,
    port:healthPort,
    workerId:dispatcher.id,
    timestamp:new Date().toISOString()
  }));
});

function handleShutdown(signal:string){
  console.log(JSON.stringify({
    level:'info',
    event:'SHUTDOWN_SIGNAL_RECEIVED',
    signal,
    workerId:dispatcher.id,
    timestamp:new Date().toISOString()
  }));
  exitSignal.abort();
  dispatcher.stop();
  healthServer.close();
}

process.once('SIGTERM',()=>handleShutdown('SIGTERM'));
process.once('SIGINT',()=>handleShutdown('SIGINT'));

try{
  console.log(JSON.stringify({
    level:'info',
    status:'STARTED',
    kind:'specialist-worker',
    workerId:dispatcher.id,
    executeMode:'server-policy-read-only',
    healthPort,
    timestamp:new Date().toISOString()
  }));
  await dispatcher.run(exitSignal.signal,1000);
}finally{
  healthServer.close();
  await gateway.shutdown();
  await closeDb();
  console.log(JSON.stringify({
    level:'info',
    event:'WORKER_SHUTDOWN_CLEAN',
    workerId:dispatcher.id,
    timestamp:new Date().toISOString()
  }));
}

