import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ModelRouter } from '../../../packages/model-router/src/index.js';
import { ToolRegistry,ToolGateway,PostgresToolCallRepository } from '../../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../../packages/approvals/src/index.js';
import { PostgresApprovalRepository,PostgresSessionGrantRepository } from '../../../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../../../packages/knowledge/src/index.js';
import { PostgresRunRepository } from '../../../packages/agent-runtime/src/repositories.js';
import { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import { DurableSpecialistDispatcher } from '../../../packages/agent-runtime/src/specialist-dispatcher.js';
import { db, closeDb } from '../../../packages/db/src/index.js';

if(process.env.AIRA_SPECIALIST_WORKER_PROCESS!=='true'||
   process.env.AIRA_SPECIALIST_WORKER_ENABLED!=='true' ||
   process.env.AIRA_SPECIALIST_DELEGATION_ENABLED!=='true' ||
   process.env.VERCEL==='1')throw new Error('SPECIALIST_DEDICATED_WORKER_REQUIRED');
if(process.env.NODE_ENV==='production' && process.getuid?.()===0)
  throw new Error('SPECIALIST_WORKER_MUST_NOT_RUN_AS_ROOT');
if(!process.env.DATABASE_URL)throw new Error('SPECIALIST_POSTGRES_URL_REQUIRED');
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
const healthPort=parseInt(process.env.PORT||process.env.HEALTH_PORT||'8080',10);
const healthServer=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
  if(req.method==='GET'&&(req.url==='/health'||req.url==='/live'||req.url==='/')){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({
      status:'HEALTHY',
      kind:'specialist-worker',
      workerId:dispatcher.id,
      uptime:process.uptime(),
      timestamp:new Date().toISOString()
    }));
    return;
  }
  if(req.method==='GET'&&req.url==='/ready'){
    try{
      await db.raw('SELECT 1');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        status:'READY',
        kind:'specialist-worker',
        workerId:dispatcher.id,
        leaseMs:30000,
        heartbeatMs:5000,
        database:'CONNECTED',
        timestamp:new Date().toISOString()
      }));
    }catch(err:any){
      res.writeHead(503,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        status:'NOT_READY',
        error:'DATABASE_UNREACHABLE',
        message:err?.message||'Database health check failed'
      }));
    }
    return;
  }
  res.writeHead(404,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'NOT_FOUND'}));
});

healthServer.listen(healthPort,'0.0.0.0',()=>{
  console.log(JSON.stringify({
    level:'info',
    event:'HEALTH_PROBE_SERVER_LISTENING',
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

