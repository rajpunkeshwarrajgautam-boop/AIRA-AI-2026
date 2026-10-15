import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db,runMigrations,closeDb } from '../packages/db/src/index.js';
import { DurableBrowserSessions } from '../packages/agent-runtime/src/browser-sessions.js';
import { PersistentChromiumWorker,enforceBrowserEgress } from '../packages/agent-runtime/src/persistent-browser-worker.js';
import { BrowserWorkerHttp,BrowserWorkerClient } from '../packages/agent-runtime/src/browser-worker-transport.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import { verifyFinalMissionOutcome } from '../packages/agent-runtime/src/independent-outcome.js';
import type { ToolCall,ToolResult } from '../packages/contracts/src/index.js';

process.env.AIRA_BROWSER_WORKER_PROCESS='true';
const root=await mkdtemp(join(tmpdir(),'aira-v2-browser-'));
const owner='browser-ci-'+randomUUID(),other='other-'+randomUUID(),run='run_'+randomUUID();
const http=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/start'){
    res.setHeader('Set-Cookie','persisted=AIRA_V2; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600');
    res.end('<!doctype html><html><title>Start</title><body><h1>Real Chromium Session</h1>Browser is running</body></html>');
  }else if(req.url==='/continue'){
    const value=String(req.headers.cookie||'').includes('persisted=AIRA_V2')?'Cookie persisted':'Cookie missing';
    res.end('<!doctype html><html><title>Continue</title><body><h1>'+value+'</h1><p>Actual server response</p></body></html>');
  }else{res.writeHead(404).end('Not found');}
});
http.listen(0,'127.0.0.1');await once(http,'listening');
const address=http.address();
if(!address||typeof address==='string')throw Error('TEST_HTTP_SERVER_NOT_AVAILABLE');
const url='http://127.0.0.1:'+address.port;
await runMigrations();
await db('runs').insert({
  id:run,principal_id:owner,session_id:'verified-ci-session',
  prompt:'Real Chromium CI acceptance',state:'RUNNING',status:'RUNNING',
  createdAt:Date.now(),updatedAt:Date.now()
});
let browserA:PersistentChromiumWorker|undefined, browserB:PersistentChromiumWorker|undefined;
try{
  await assert.rejects(enforceBrowserEgress('http://169.254.169.254/'),/PRIVATE_IP_DENIED/);
  await assert.rejects(enforceBrowserEgress('file:///etc/passwd'),/FORBIDDEN_URL/);
  await assert.rejects(enforceBrowserEgress('http://127.0.0.1/'),/PRIVATE_IP_DENIED/);
  const sessions=new DurableBrowserSessions();
  const sessionId=await sessions.create(owner,run);
  const lease=await sessions.claimBot(owner,sessionId,'live-chromium-worker',60000);
  browserA=new PersistentChromiumWorker(sessions,root,true);
  const started=await browserA.navigate(lease,url+'/start');
  assert.equal(started.heading,'Real Chromium Session');
  assert.equal(started.workerVerified,true);
  const first=await browserA.screenshotDigest(lease);
  assert.match(first.sha256,/^[a-f0-9]{64}$/);
  assert.ok(first.bytes>100);
  const inProcess=await browserA.navigate(lease,url+'/continue');
  assert.equal(inProcess.heading,'Cookie persisted','Real HTTP cookie must exist before restarting Chromium');
  await browserA.closeContext(sessionId);
  // Closing Chromium and creating an entirely fresh worker must still
  // preserve the HttpOnly cookie inside the encrypted-at-rest operator volume.
  // Local ephemeral test filesystem is NOT a production encryption attestation.
  browserB=new PersistentChromiumWorker(sessions,root,true);
  const continued=await browserB.navigate(lease,url+'/continue');
  assert.equal(continued.heading,'Cookie persisted','Real persistent browser profile must survive Chromium restart');
  assert.equal((await sessions.read(owner,sessionId))?.observedUrl,url+'/continue');
  assert.equal(await sessions.read(other,sessionId),undefined);
  const taken=await sessions.takeover(owner,sessionId,owner);
  assert.equal(taken.mode,'HUMAN');
  await assert.rejects(browserB.inspect(lease),/STALE/);
  await sessions.release(taken);
  const resumed=await sessions.claimBot(owner,sessionId,'recovered-chromium-worker',60000);
  assert.ok(resumed.fence>lease.fence);
  assert.equal((await browserB.inspect(resumed)).heading,'Cookie persisted');
  await sessions.release(resumed);
  const token='browser-worker-test-only-secret-min-length';
  const workerHttp=new BrowserWorkerHttp(browserB,sessions,token);
  const control=workerHttp.server();
  control.listen(0,'127.0.0.1');
  await once(control,'listening');
  try{
    const socket=control.address();
    if(!socket||typeof socket==='string')throw Error('BROWSER_CONTROL_NOT_LISTENING');
    const client=new BrowserWorkerClient({
      origin:'http://127.0.0.1:'+socket.port,token
    });
    const observed=await client.observe(owner,sessionId,'inspect') as any;
    assert.equal(observed.heading,'Cookie persisted');
    assert.equal(observed.workerVerified,true);
    const captured=await client.observe(owner,sessionId,'screenshotDigest') as any;
    assert.match(captured.sha256,/^[a-f0-9]{64}$/);
    await assert.rejects(client.observe(other,sessionId,'inspect'),/BROWSER_WORKER_409/);
    const invalid=new BrowserWorkerClient({
      origin:'http://127.0.0.1:'+socket.port,token:'not-the-real-worker-token'
    });
    await assert.rejects(invalid.observe(owner,sessionId,'inspect'),/BROWSER_WORKER_401/);
    // Exercise the real AIRA ToolGateway path, not merely the transport
    // client. This is the same gateway Runtime V2 dispatches through.
    process.env.AIRA_DURABLE_BROWSER_ENABLED='true';
    process.env.AIRA_BROWSER_WORKER_TOKEN=token;
    process.env.AIRA_BROWSER_WORKER_URL='http://127.0.0.1:'+socket.port+'/';
    const gateway=new ToolGateway();
    try{
      const call:ToolCall={
        id:'call_v2_browser_'+randomUUID(),toolId:'tool_browser_session_inspect',
        name:'browser_session_inspect',arguments:{sessionId},timestamp:Date.now()
      };
      const result:ToolResult=await gateway.execute({
        toolName:call.name,arguments:call.arguments,callId:call.id,
        context:{runId:run,principal:{
          userId:owner,sessionId:'verified-ci-session',role:'user',scopes:['browser.read']
        }}
      });
      assert.equal(result.isError,false, 'Actual browser worker tool call must succeed');
      assert.equal((result.output as any).heading,'Cookie persisted');
      const step={id:'browser',purpose:'Inspect exact requested browser session',
        toolName:'browser_session_inspect' as const,arguments:{sessionId}};
      const verified=await verifyFinalMissionOutcome([step],[call],[result],root,owner);
      assert.equal(verified.status,'COMPLETED_VERIFIED',
        'Second independent browser HTTP readback required');
      const altered:ToolResult={
        ...result,output:{...(result.output as Record<string,unknown>),text:'Fabricated DOM'}
      };
      assert.equal((await verifyFinalMissionOutcome([step],[call],[altered],root,owner)).status,
        'FAILED_VERIFICATION','Invented browser text must fail independently');
      const crossCall:ToolResult={...result,toolCallId:'another-user-tool-call'};
      assert.equal((await verifyFinalMissionOutcome([step],[call],[crossCall],root,owner)).status,
        'FAILED_VERIFICATION','Evidence correlation must reject a different call ID');
      const wrongOwner=await gateway.execute({
        toolName:call.name,arguments:call.arguments,
        context:{runId:run,principal:{
          userId:other,sessionId:'verified-ci-session',role:'user',scopes:['browser.read']
        }}
      });
      assert.equal(wrongOwner.isError,true);
    }finally{
      await gateway.shutdown();
    }
  }finally{
    await new Promise<void>(resolve=>control.close(()=>resolve()));
  }
  await browserB.closeContext(sessionId);
  await sessions.close(owner,sessionId);
  await assert.rejects(browserB.inspect(resumed),/STALE/);
  console.log('PASS: actual Playwright Chromium, DOM, screenshot, HttpOnly cookie persistence after process restart, durable takeover fencing and cross-owner isolation');
}finally{
  if(browserA)await browserA.shutdown();
  if(browserB)await browserB.shutdown();
  await db('v2_browser_sessions').where({owner_id:owner}).delete();
  await db('runs').where({id:run}).delete();
  await closeDb();
  await new Promise<void>(resolve=>http.close(()=>resolve()));
  await rm(root,{recursive:true,force:true});
}
