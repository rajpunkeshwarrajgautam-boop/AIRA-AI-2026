import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { IsolatedBuildBridge, isolatedBuildConfig, validateSourceFiles,
  stableIsolatedBuildJobId, verifyBuildArchive
} from '../packages/tool-runtime/src/adapters/isolated-build-bridge.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import type { ToolCall } from '../packages/contracts/src/index.js';

const h = (str: string) => createHash('sha256').update(str).digest('hex');
const source={files:[
  {path:'index.html',content:'<main>Integration test</main>'},
  {path:'app.js',content:'console.log("verified")'},
  {path:'package.json',content:'{"scripts":{"build":"node app.js","test":"node app.js"}}'}
],steps:['syntax','build','test'] as ['syntax','build','test']};
const owner='verified_principal_alpha', run='run_alpha';
const idempotency='aira_'+h(run+'\0'+JSON.stringify(source)).slice(0,48);
const id=stableIsolatedBuildJobId(owner,idempotency);
const manifest=source.files.map(f=>({path:f.path,sha256:h(f.content)}));
const token='test-only-staging-worker-credential-not-real';
const tar=()=>{
  const chunks:Buffer[]=[];
  for(const f of source.files){
    const bytes=Buffer.from(f.content),hdr=Buffer.alloc(512);
    const at=(text:string,pos:number)=>hdr.write(text,pos,'ascii');
    at(f.path,0); at('0000644\0',100);at('0000000\0',108);at('0000000\0',116);
    at(bytes.length.toString(8).padStart(11,'0')+'\0',124);
    at('00000000000\0',136);hdr.fill(32,148,156);hdr[156]=48;
    at('ustar\0',257);at('00',263);
    at(hdr.reduce((sum,n)=>sum+n,0).toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(hdr,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
};
const goodArchive=tar();
assert.equal(verifyBuildArchive(goodArchive,manifest,source).fileCount,3);
assert.throws(()=>verifyBuildArchive(goodArchive,[{path:'app.js',sha256:'0'.repeat(64)}],source),/MANIFEST_MISMATCH/);
assert.throws(()=>verifyBuildArchive(Buffer.from('notgzip'),manifest,source));
assert.throws(()=>validateSourceFiles({...source,files:[{path:'../secret.js',content:'unsafe'}]}),/UNSAFE/);
assert.throws(()=>validateSourceFiles({...source,files:[source.files[0],source.files[0]]}),/UNSAFE/);
assert.throws(()=>isolatedBuildConfig({AIRA_ISOLATED_BUILD_ENABLED:'true',
  AIRA_BUILD_WORKER_TOKEN:token,AIRA_BUILD_WORKER_URL:'http://169.254.169.254/'} as NodeJS.ProcessEnv),
  /ENDPOINT_REJECTED/);
assert.throws(()=>isolatedBuildConfig({AIRA_ISOLATED_BUILD_ENABLED:'true',
  AIRA_BUILD_WORKER_TOKEN:token,AIRA_BUILD_WORKER_URL:'http://127.0.0.1:4000/',NODE_ENV:'production'} as NodeJS.ProcessEnv),
  /ENDPOINT_REJECTED/);
assert.throws(()=>isolatedBuildConfig({AIRA_ISOLATED_BUILD_ENABLED:'false'} as NodeJS.ProcessEnv),
  /DISABLED/);

let failIntegrity=false;let submits=0,observations=0;let badOwner=false;
const server=createServer(async(req,res)=>{
  const headers=req.headers;
  if(headers.authorization!=='Bearer '+token || headers['x-aira-owner']!==owner){
    badOwner=true;res.writeHead(403).end();return;
  }
  if(req.method==='POST'&&req.url==='/v1/jobs'){
    submits++;
    const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(body.ownerId!==owner||body.idempotencyKey!==idempotency){
      res.writeHead(409).end();return;
    }
    res.writeHead(202,{'Content-Type':'application/json'}).end(JSON.stringify({jobId:id,state:'QUEUED'}));
    return;
  }
  if(req.method==='GET'&&req.url==='/v1/jobs/'+id){
    observations++;
    if(!submits){res.writeHead(404).end();return;}
    const job={
      id,ownerId:owner,idempotencyKey:idempotency,state:'BUILD_PASSED',
      manifest:failIntegrity ? manifest.map((f,i)=>i===0?{...f,sha256:'f'.repeat(64)}:f):manifest,
      steps:['syntax','build','test'].map(name=>({name,exitCode:0,output:'Actual recorded worker step'}))
    };
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(job));
    return;
  }
  if(req.method==='GET'&&req.url==='/v1/jobs/'+id+'/source'){
    res.writeHead(200,{'Content-Type':'application/gzip'}).end(goodArchive);return;
  }
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
try{
  const addr=server.address();
  if(!addr||typeof addr==='string')throw Error('No test listener');
  const client=new IsolatedBuildBridge({origin:'http://127.0.0.1:'+addr.port,token});
  const result=await client.execute(owner,run,source,1000);
  assert.equal(result.status,'BUILD_VERIFIED');
  assert.equal(result.jobId,id);assert.equal(result.fileCount,3);
  assert.equal(submits,1);assert.equal(badOwner,false);
  const twice=await client.execute(owner,run,source,1000);
  assert.equal(twice.status,'BUILD_VERIFIED');
  assert.equal(submits,1,'Retry must reuse existing worker identity rather than resubmit');
  failIntegrity=true;
  await assert.rejects(client.execute(owner,run,source,1000),/MANIFEST_MISMATCH/);
  assert.ok(observations>=2,'Actual HTTP worker status readback required');
}finally{server.close();}

const call:ToolCall={id:'call_approved',toolId:'tool_isolated_application_build',
  name:'isolated_application_build',arguments:source,timestamp:Date.now()};
const approved={
  id:'approval_unique',runId:run,toolCall:call,risk:'medium' as const,
  title:'Authorize',reason:'Build',sanitizedPreview:source,
  requestedAt:Date.now(),decision:'ALLOW_ONCE' as const,
  resolvedBy:owner,resolvedAt:Date.now()
};
const repo={
  async getApprovedForToolCall(runId:string,callId:string){
    return runId===run&&callId===call.id?approved:undefined;
  }
};
const grantRepo={
  hasAlwaysGrant:async()=>true,hasSessionGrant:async()=>true,
  grantSession:async()=>{},grantAlways:async()=>{},clearSession:async()=>{}
};
const kernel=new ApprovalKernel(repo as any,grantRepo as any);
assert.equal(await kernel.isExactToolCallApproved(run,call,owner),true);
assert.equal(await kernel.isExactToolCallApproved(run,{...call,arguments:{...source,files:[]}},owner),false);
assert.equal(await kernel.isExactToolCallApproved(run,call,'other_principal'),false);
assert.equal(await kernel.isExactToolCallApproved('other_run',call,owner),false);
assert.equal(await kernel.isExactToolCallApproved(run,{...call,id:'new_call'},owner),false);
// Fail closed before any persisted tool call when a mutating gateway has no kernel.
const gateway=new ToolGateway(undefined,undefined,process.cwd());
const denied=await gateway.execute({toolName:'file_system_write',
  arguments:{filePath:'should-never-exist.txt',content:'no'},
  context:{runId:'gate_test',principal:{userId:owner,sessionId:'sess',
    role:'user',scopes:['files.write']}}});
assert.equal(denied.isError,true);
assert.match(String(denied.error),/APPROVAL_KERNEL_REQUIRED/);
await gateway.shutdown();
console.log('PASS: strict isolated worker transport, durable job reconciliation, source readback, owner-scoped exact approval');
