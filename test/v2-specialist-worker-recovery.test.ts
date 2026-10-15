import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { db,runMigrations,closeDb } from '../packages/db/src/index.js';
import { DurableDelegations } from '../packages/agent-runtime/src/specialist-delegation.js';
import { DurableSpecialistDispatcher } from '../packages/agent-runtime/src/specialist-dispatcher.js';
import type { Run } from '../packages/contracts/src/index.js';

await runMigrations();
const id=(prefix:string)=>prefix+randomUUID();
const owner=id('owner-'),session=id('sess-'),root=id('parent-');
const childA=id('child-'),childB=id('child-');
const run=(rid:string,scopes=['repo.read']):Run=>({
  id:rid,principalId:owner,sessionId:session,
  principalScopes:scopes,state:rid===root?'RUNNING':'QUEUED'
} as Run);
const now=Date.now();
for(const rid of [root,childA,childB]){
  const state=rid===root?'RUNNING':'QUEUED';
  await db('runs').insert({
    id:rid,principal_id:owner,session_id:session,prompt:'Durable real worker integration',
    state,status:state,createdAt:now,updatedAt:now
  });
}
const store=new DurableDelegations();
try {
  const first=await store.register(run(root),run(childA),'repository',
    'Inspect owner repository files',['repo.read'],id('request_'));
  const contenders=await Promise.all(
    Array.from({length:12},(_,i)=>new DurableDelegations().claimNext('competitor-'+i,5000))
  );
  const winners=contenders.filter(Boolean);
  assert.equal(winners.length,1,'Exactly one PostgreSQL worker may claim a child');
  const initial=winners[0]!.delegation;
  assert.equal(initial.id,first.id);
  assert.equal(initial.fence,1);
  await assert.rejects(store.renewClaim(owner,initial.id,'wrong-owner',initial.fence,5000),
    /STALE_WORKER/);
  await store.renewClaim(owner,initial.id,
    (await db('v2_delegations').where({id:initial.id}).first()).worker_owner,
    initial.fence,5000);
  const incumbent=(await db('v2_delegations').where({id:initial.id}).first()).worker_owner;
  await store.releaseClaim(owner,initial.id,incumbent,initial.fence,'WAITING');
  assert.equal(await store.claimNext('accidental-replayer',5000),undefined,
    'Approvals waiting must not automatically execute');
  assert.equal(await store.wakeApprovedChild('wrong-owner',childA),false);
  assert.equal(await store.wakeApprovedChild(owner,childA),true);
  assert.equal(await store.wakeApprovedChild(owner,childA),false,
    'Approval wakeup must be once only');

  let executions=0;
  const dispatcher=new DurableSpecialistDispatcher({
    async executeClaimedSpecialist(job,jobOwner,worker,fence,recovered){
      executions++;
      assert.equal(job,first.id);
      assert.equal(jobOwner,owner);
      assert.equal(recovered,false,'Approved pending child should be a fresh queue item');
      await store.assertClaim(owner,job,worker,fence);
      await new Promise(resolve=>setTimeout(resolve,250));
      await db('runs').where({id:childA,principal_id:owner})
        .update({state:'COMPLETED',status:'COMPLETED'});
      return 'TERMINAL';
    }
  },{leaseMs:5000,heartbeatMs:100});
  assert.equal(await dispatcher.tick(),'DONE');
  assert.equal(executions,1);
  assert.equal((await store.get(owner,first.id))?.status,'COMPLETED');
  assert.equal(await dispatcher.tick(),'IDLE');
  dispatcher.stop();

  const second=await store.register(run(root),run(childB),'repository',
    'Inspect recovery after unexpected worker death',['repo.read'],id('request_'));
  // The competing claimant is a REAL separate OS process using the same
  // PostgreSQL service, not a mock runtime or an in-memory claim.
  const subprocess=String.raw`
const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL || 'postgres://aira:aira@localhost:5432/aira_db'});
await c.connect();const until=Date.now()+10000;
const r=await c.query(
"UPDATE v2_delegations SET worker_owner=$1,lease_until=$2, fence=fence+1,status='RUNNING' WHERE id=$3 AND status='QUEUED' RETURNING id,fence",
['killed-os-worker',until,process.env.TEST_DELEGATION_ID]);
if(r.rowCount!==1)process.exit(3);
console.log('REAL_DB_CLAIM:'+r.rows[0].fence);
setInterval(()=>{},1000);
})().catch(e=>{console.error(e);process.exit(2)});
`;
  const processChild=spawn(process.execPath,['-e',subprocess],{
    env:{...process.env,TEST_DELEGATION_ID:second.id,DATABASE_URL:process.env.DATABASE_URL||'postgres://aira:aira@localhost:5432/aira_db'},
    stdio:['ignore','pipe','pipe']
  });
  let output='',err='';
  processChild.stdout.on('data',part=>{output+=part.toString()});
  processChild.stderr.on('data',part=>{err+=part.toString()});
  const deadline=Date.now()+10000;
  while(!output.includes('REAL_DB_CLAIM:')&&processChild.exitCode===null&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(output,/REAL_DB_CLAIM:/,'Separate live OS worker must have claimed PostgreSQL task; '+err);
  const oldFence=Number(output.match(/REAL_DB_CLAIM:(\d+)/)?.[1]||0);
  processChild.kill('SIGKILL');
  await once(processChild,'exit');
  const persisted=await db('v2_delegations').where({id:second.id}).first();
  assert.equal(persisted.status,'RUNNING');
  assert.equal(persisted.worker_owner,'killed-os-worker');
  // Accelerated test clock: expire the dead process lease in PostgreSQL.
  await db('v2_delegations').where({id:second.id})
    .update({lease_until:Date.now()-1});
  const recovered=await store.claimNext('replacement-worker',5000);
  assert.ok(recovered,'Another worker must recover the abandoned durable child');
  assert.equal(recovered!.delegation.id,second.id);
  assert.equal(recovered!.recovered,true);
  assert.ok(recovered!.delegation.fence>oldFence);
  await assert.rejects(store.assertClaim(owner,second.id,'killed-os-worker',oldFence),
    /STALE_WORKER/);
  await assert.rejects(store.releaseClaim(owner,second.id,'killed-os-worker',oldFence),
    /STALE_WORKER/);
  await store.renewClaim(owner,second.id,'replacement-worker',recovered!.delegation.fence,5000);
  await db('runs').where({id:childB}).update({state:'FAILED',status:'FAILED'});
  assert.equal((await store.finalize(owner,second.id,'replacement-worker',
    recovered!.delegation.fence)).status,'FAILED');
  assert.equal((await store.get(owner,second.id))?.status,'FAILED');
  console.log('PASS: real PostgreSQL multiworker claims, no duplicate approval replay, forced SIGKILL recovery and stale-fence rejection');
} finally {
  await db('v2_delegations').where({owner_id:owner}).delete();
  await db('runs').whereIn('id',[root,childA,childB]).delete();
  await closeDb();
}
