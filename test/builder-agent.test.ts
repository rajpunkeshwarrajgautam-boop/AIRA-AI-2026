import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { BuilderService } from '../packages/builder-runtime/src/index.js';
import { BuilderActionSchema, BuilderRequestSchema } from '../packages/builder-runtime/src/contracts.js';
import { signTicket,verifyTicket,safeRelativePath,builderAccess,publicBuilderError,type WorkspaceTicket } from '../packages/builder-runtime/src/security.js';
import type { BuilderSandbox,SandboxFactory } from '../packages/builder-runtime/src/sandbox.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';
import type { ModelRouter } from '../packages/model-router/src/index.js';
import { createBuilderRoutes } from '../apps/api/src/builder-routes.js';
import { streamBuilder } from '../src/utils/builderClient.js';

const owner:ExecutionPrincipal={userId:'owner',sessionId:'session',roles:[],scopes:[]};
function configure(){process.env.AIRA_BUILDER_ENABLED='true';process.env.AIRA_BUILDER_ALLOWED_USER_IDS='owner';process.env.E2B_API_KEY='test-key-not-a-real-key';process.env.AIRA_BUILDER_SIGNING_SECRET='test-builder-signing-secret-minimum-32-characters';}
function ticket(extra:Partial<WorkspaceTicket>={}):WorkspaceTicket{return {version:1,purpose:'workspace',userId:'owner',sessionId:'session',sandboxId:'sandbox_test',expiresAt:Date.now()+60000,allowInternet:false,allowPreview:false,...extra};}
class FakeSandbox implements BuilderSandbox {
 id='sandbox_test';files=new Map<string,Uint8Array>();killed=false;previewed=false;
 async write(path:string,content:string){this.files.set(path,Buffer.from(content));return {path};}
 async read(path:string){const bytes=this.files.get(path);if(!bytes)throw new Error('File not found');return bytes;}
 async list(){return [...this.files.keys()];}
 async command(){return {exitCode:0,stdout:'verified',stderr:''};}
 async preview(){this.previewed=true;return 'https://3000-sandbox-test.e2b.app/';}
 async kill(){this.killed=true;}
}
function fixture(actions:unknown[]){
 configure();const sandbox=new FakeSandbox();let calls=0;
 const router={listProviders:()=>['openai'],resolveExecution:()=>({provider:'openai',executedModel:'test-model',plannedModel:'test-model',fallbackOccurred:false,policy:{model:'gpt-4o',maxTokens:8192},adapter:{complete:async()=>({text:JSON.stringify(actions[Math.min(calls++,actions.length-1)]),usage:{totalTokens:500},model:'test-model',outboundModel:'test-model'})}})} as unknown as ModelRouter;
 const factory:SandboxFactory={create:async()=>sandbox,connect:async()=>sandbox};
 const service=new BuilderService(router,factory);return {sandbox,router,service,events:[] as any[],factory};
}
const request=()=>BuilderRequestSchema.parse({prompt:'Build an HTML website',allowExecution:true});
const actions=[{tool:'write_file',path:'index.html',content:'<!doctype html><h1>Built</h1>'},{tool:'run_command',command:'python3 --version'},{tool:'publish_file',path:'index.html',title:'Website'},{tool:'finish',summary:'Built and tested the website.'}];

test('strict consent, action schemas and supported legacy model IDs',()=>{
 assert.equal(BuilderRequestSchema.safeParse({prompt:'Build',allowExecution:false}).success,false);
 assert.equal(BuilderRequestSchema.safeParse({prompt:'Build',allowExecution:true,model:'claude-3-opus'}).success,true);
 assert.equal(BuilderActionSchema.safeParse({tool:'run_command',command:'x',timeoutMs:999999}).success,false);
 assert.equal(BuilderActionSchema.safeParse({tool:'send_email',to:'x'}).success,false);
 assert.equal(BuilderActionSchema.safeParse({tool:'write_file',path:'x',content:'x',admin:true}).success,false);
});
test('path traversal, Windows separators, nulls and absolute paths are rejected',()=>{
 for(const p of ['../secret','x/../../secret','/etc/passwd','x\\secret','x\0y'])assert.throws(()=>safeRelativePath(p));
 assert.equal(safeRelativePath('assets/image.png'),'assets/image.png');assert.equal(safeRelativePath('.',true),'.');assert.throws(()=>safeRelativePath('.'));
});
test('signed tickets are owner/session/purpose/expiry bound and resist tampering',()=>{
 configure();const t=signTicket(ticket());assert.equal(verifyTicket(t,owner,'workspace').sandboxId,'sandbox_test');
 assert.throws(()=>verifyTicket(t,{...owner,userId:'other'},'workspace'));
 assert.throws(()=>verifyTicket(t,{...owner,sessionId:'other'},'workspace'));
 assert.throws(()=>verifyTicket(t,owner,'file'));
 assert.throws(()=>verifyTicket(t+'broken',owner,'workspace'));
 assert.throws(()=>verifyTicket(signTicket(ticket({expiresAt:Date.now()-1})),owner,'workspace'));
});
test('builder is disabled by default and unauthorized users never acquire capability',()=>{
 configure();delete process.env.AIRA_BUILDER_ENABLED;assert.equal(builderAccess(owner).enabled,false);configure();assert.equal(builderAccess({...owner,userId:'unlisted'}).allowed,false);
 assert.equal(publicBuilderError(new Error(process.env.E2B_API_KEY!)).includes(process.env.E2B_API_KEY!),false);
});
test('tool receipts, published downloads and provenance are emitted; successful VM retains TTL',async()=>{
 const f=fixture(actions);await f.service.run(request(),owner,e=>f.events.push(e),new AbortController().signal);
 assert.ok(f.events.some(e=>e.type==='builder.completed'));assert.equal(f.sandbox.killed,false);
 assert.equal(f.events.filter(e=>e.type==='builder.tool.started').length,3);
 assert.equal(f.events.find(e=>e.type==='model.provenance').data.verified,true);
 const file=f.events.find(e=>e.type==='builder.file').data;const token=new URL('http://test'+file.url).searchParams.get('ticket')!;
 assert.equal(Buffer.from((await f.service.download(token,owner)).bytes).toString(),actions[0].content);
 await assert.rejects(f.service.download(token,{...owner,userId:'other'}));
 f.sandbox.files.set('index.html',Buffer.from('modified'));await assert.rejects(f.service.download(token,owner),/changed after publication/);
});
test('preview permission cannot be escalated by model output or a continuation',async()=>{
 const f=fixture([{tool:'start_preview'},...actions]);await f.service.run(request(),owner,e=>f.events.push(e),new AbortController().signal);
 assert.equal(f.sandbox.previewed,false);assert.ok(f.events.some(e=>e.type==='builder.tool.completed'&&e.data.isError));
 const signed=signTicket(ticket());await assert.rejects(f.service.run({...request(),workspaceTicket:signed,allowPreview:true},owner,()=>{},new AbortController().signal),/Permissions changed/);
});
test('explicit preview consent allows verified preview URL',async()=>{
 const f=fixture([{tool:'start_preview'},...actions]);await f.service.run({...request(),allowPreview:true},owner,e=>f.events.push(e),new AbortController().signal);
 assert.equal(f.sandbox.previewed,true);assert.ok(f.events.some(e=>e.type==='builder.preview'));
});
test('invalid model JSON cannot fabricate completion and kills resources',async()=>{
 const f=fixture([{bad:'schema'}]);await assert.rejects(f.service.run(request(),owner,()=>{},new AbortController().signal),/three attempts/);assert.equal(f.sandbox.killed,true);
});
test('finish without a published file reaches limit, not success',async()=>{
 const f=fixture([{tool:'finish',summary:'I built everything'}]);await assert.rejects(f.service.run(request(),owner,e=>f.events.push(e),new AbortController().signal),/12-action limit/);assert.ok(!f.events.some(e=>e.type==='builder.completed'));assert.equal(f.sandbox.killed,true);
});
test('disconnect cancellation aborts upstream and kills the VM',async()=>{
 const f=fixture(actions),controller=new AbortController();
 await assert.rejects(f.service.run(request(),owner,e=>{if(e.type==='builder.tool.started')controller.abort(new Error('Disconnected'));},controller.signal),/Disconnected/);assert.equal(f.sandbox.killed,true);
});
test('cancellation requires owned workspace ticket; file tickets cannot cancel',async()=>{
 const f=fixture(actions);await assert.rejects(f.service.cancel(signTicket(ticket()),{...owner,userId:'other'}));assert.equal(f.sandbox.killed,false);
 await assert.rejects(f.service.cancel(signTicket(ticket({purpose:'file',path:'a',sha256:createHash('sha256').update('a').digest('hex')})),owner));
 await f.service.cancel(signTicket(ticket()),owner);assert.equal(f.sandbox.killed,true);
});
test('API validates consent, streams completion, and forces attachment downloads',async()=>{
 const f=fixture(actions),app=express();app.use(express.json());app.use((req,_res,next)=>{req.principal=owner;next();});app.use('/api/builder',createBuilderRoutes(f.router,f.service));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address() as any,base=`http://127.0.0.1:${address.port}`;
 try{
  const bad=await fetch(base+'/api/builder/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'x'})});assert.equal(bad.status,400);
  const stream=await fetch(base+'/api/builder/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request())});const body=await stream.text();assert.ok(body.includes('event: builder.completed'));
  const file=JSON.parse(body.split('event: builder.file\ndata: ')[1].split('\n')[0]);const download=await fetch(base+file.url);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition')!,/^attachment;/);assert.equal(await download.text(),actions[0].content);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('SSE client tolerates split multibyte text and frame boundaries, and rejects premature EOF',async()=>{
 const original=globalThis.fetch;const bytes=new TextEncoder().encode('event: builder.completed\r\ndata: {"summary":"Built ✓"}\r\n\r\n');const events:any[]=[];
 try{
  globalThis.fetch=async(url:any)=>url==='/api/auth/session'?new Response('{}',{status:200}):new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i++)c.enqueue(bytes.slice(i,i+1));c.close();}}));
  await streamBuilder({},new AbortController().signal,e=>events.push(e));assert.equal(events[0].data.summary,'Built ✓');
  globalThis.fetch=async(url:any)=>url==='/api/auth/session'?new Response('{}',{status:200}):new Response('event: builder.status\ndata: {"text":"Working"}\n\n');
  await assert.rejects(streamBuilder({},new AbortController().signal,()=>{}),/disconnected before completion/);
 }finally{globalThis.fetch=original;}
});

test('deadline reaches the model AbortSignal and cleans up a created VM',async()=>{
 const f=fixture(actions);process.env.AIRA_BUILDER_RUN_TIMEOUT_MS='1000';
 (f.router as any).resolveExecution=()=>({provider:'openai',policy:{model:'gpt-4o'},adapter:{complete:async(_m:unknown,_p:unknown,signal:AbortSignal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}});
 try{await assert.rejects(f.service.run(request(),owner,()=>{},new AbortController().signal),/time limit/);assert.equal(f.sandbox.killed,true);}finally{delete process.env.AIRA_BUILDER_RUN_TIMEOUT_MS;}
});
test('token budget terminates without fabricated completion',async()=>{
 const f=fixture(actions);(f.router as any).resolveExecution=()=>({provider:'openai',policy:{model:'gpt-4o'},adapter:{complete:async()=>({text:JSON.stringify(actions[0]),usage:{totalTokens:40000}})}});
 await assert.rejects(f.service.run(request(),owner,e=>f.events.push(e),new AbortController().signal),/token budget/);assert.equal(f.sandbox.killed,true);assert.ok(!f.events.some(e=>e.type==='builder.completed'));
});
test('nonzero command exits are surfaced as tool errors',async()=>{
 const f=fixture(actions);f.sandbox.command=async()=>({exitCode:1,stdout:'',stderr:'test failure'});
 await f.service.run(request(),owner,e=>f.events.push(e),new AbortController().signal);
 assert.ok(f.events.some(e=>e.type==='builder.tool.completed'&&e.data.name==='run_command'&&e.data.isError===true));
});
