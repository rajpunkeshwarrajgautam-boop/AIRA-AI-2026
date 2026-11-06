import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, runMigrations, closeDb } from '../packages/db/src/index.js';
import { DurableBrowserSessions } from '../packages/agent-runtime/src/browser-sessions.js';
import {
  DurableDelegations, delegatedScopes, delegationKey, specialistRegistry
} from '../packages/agent-runtime/src/specialist-delegation.js';
import type { Run } from '../packages/contracts/src/index.js';

await runMigrations();
const id=()=> 'v2_'+randomUUID().replaceAll('-','');
const owner=id(),other=id(),session=id(),workspace=id();
const root=id(),child=id(),grandchild=id(),greatGrandchild=id(),leaf=id();
const scopes=['repo.read','files.read','web.search','browser.read'];
const run=(runId:string,user=owner,runScopes=scopes):Run=>({
  id:runId,principalId:user,sessionId:session,workspaceId:workspace,
  principalScopes:runScopes,state:'RUNNING'
} as Run);
for(const [runId,user,state] of [
  [root,owner,'RUNNING'],[child,owner,'QUEUED'],
  [grandchild,owner,'QUEUED'],[greatGrandchild,owner,'QUEUED'],
  [leaf,owner,'QUEUED'],[id(),other,'RUNNING']
]) {
  const now=Date.now();
  await db('runs').insert({
    id:runId,principal_id:user,session_id:session,workspace_id:workspace,
    prompt:'V2 integration test',state,status:state,createdAt:now,updatedAt:now
  });
}
try{
  const bs=new DurableBrowserSessions();
  const browser=await bs.create(owner,root,workspace);
  assert.equal((await bs.read(owner,browser))?.state,'STOPPED');
  assert.equal(await bs.read(other,browser),undefined);
  await assert.rejects(bs.create(other,root,workspace),/RUN_OWNER_MISMATCH/);
  const a=await bs.claimBot(owner,browser,'worker-a');
  assert.equal(a.mode,'BOT');
  await assert.rejects(bs.claimBot(owner,browser,'worker-b'),/LEASE_HELD/);
  await bs.recordObservation(a,'https://example.org/a');
  assert.equal((await bs.read(owner,browser))?.observedUrl,'https://example.org/a');
  const human=await bs.takeover(owner,browser,owner);
  assert.ok(human.fence>a.fence);
  await assert.rejects(bs.assertLease(a),/STALE/);
  await assert.rejects(bs.recordObservation(a,'https://example.org/stale'),/STALE/);
  await assert.rejects(bs.claimBot(owner,browser,'worker-b'),/LEASE_HELD/);
  await assert.rejects(bs.takeover(owner,browser,other),/HUMAN_OWNER_REQUIRED/);
  const renewed=await bs.renew(human);
  await bs.release(renewed);
  const b=await bs.claimBot(owner,browser,'worker-b');
  assert.ok(b.fence>human.fence);
  await bs.close(owner,browser);
  await assert.rejects(bs.assertLease(b),/STALE/);
  await assert.rejects(bs.claimBot(owner,browser,'worker-a'),/LEASE_HELD/);
  const recorded=await bs.read(owner,browser);
  assert.equal(recorded?.state,'CLOSED');

  const repo=new DurableDelegations();
  assert.deepEqual(delegatedScopes(scopes,['repo.read'],'repository'),['repo.read']);
  assert.throws(()=>delegatedScopes(scopes,['files.write'],'repository'),/SCOPE_ESCALATION/);
  assert.throws(()=>delegatedScopes(['repo.read'],['browser.read'],'research'),/SCOPE_ESCALATION/);
  assert.equal(specialistRegistry(scopes).find(s=>s.id==='repository')?.available,true);
  const objective='Inspect the actual Git history and list findings';
  const key=delegationKey(root,'repository',objective);
  const d1=await repo.register(run(root),run(child,owner,['repo.read']),
    'repository',objective,['repo.read'],key);
  assert.equal(d1.depth,1);
  assert.equal((await repo.assertChildAuthorized(
    run(child,owner,['repo.read']),root,'repository','repo_git_status'
  )).childRunId,child);
  await assert.rejects(repo.assertChildAuthorized(
    run(child,owner,['repo.read']),root,'repository','file_system_write'
  ),/DELEGATED_TOOL_NOT_ALLOWED/);
  await assert.rejects(repo.assertChildAuthorized(
    run(child,owner,['repo.read','files.write']),root,'repository','repo_git_status'
  ),/DELEGATED_CHILD_SCOPE_TAMPERED/);
  await assert.rejects(repo.assertChildAuthorized(
    run(child,owner,['repo.read']),root,'research','repo_git_status'
  ),/DELEGATED_CHILD_NOT_AUTHORIZED/);
  assert.equal((await repo.list(owner,root)).length,1);
  assert.equal(await repo.get(other,d1.id),undefined);
  await assert.rejects(repo.claim(other,d1.id,'worker-other'),/NOT_CLAIMABLE/);
  const claimed=await repo.claim(owner,d1.id,'worker-1');
  await assert.rejects(repo.claim(owner,d1.id,'worker-2'),/NOT_CLAIMABLE/);
  await assert.rejects(repo.finalize(owner,d1.id,'worker-2',claimed.fence),/STALE_WORKER/);
  await assert.rejects(repo.finalize(owner,d1.id,'worker-1',claimed.fence),/CHILD_NOT_TERMINAL/);
  await db('runs').where({id:child}).update({state:'COMPLETED',status:'COMPLETED'});
  const terminal=await repo.finalize(owner,d1.id,'worker-1',claimed.fence);
  assert.equal(terminal.status,'COMPLETED');
  const unverified=await repo.verification(owner,d1.id);
  assert.equal(unverified.status,'NOT_VERIFIED','Completed model response cannot claim independent verification');
  await db('runs').where({id:child}).update({context_data:JSON.stringify({
    __airaOutcomeVerificationV2:{
      status:'COMPLETED_VERIFIED',
      evidence:[{toolCallId:'actual-certified-read',verified:true}]
    }
  })});
  assert.equal((await repo.verification(owner,d1.id)).status,'COMPLETED_VERIFIED');
  await assert.rejects(repo.verification(other,d1.id),/DELEGATION_NOT_FOUND/);

  await assert.rejects(repo.claim(owner,d1.id,'worker-late'),/NOT_CLAIMABLE/);

  // A completed parent cannot delegate again. A child run may still become a
  // parent, but only once a separate real run is active and verified.
  await db('runs').where({id:child}).update({state:'RUNNING',status:'RUNNING'});
  const d2=await repo.register(run(child),run(grandchild,owner,['repo.read']),
    'repository','Inspect a second real module',['repo.read'],'key_'+id());
  assert.equal(d2.depth,2);
  const d3=await repo.register(run(grandchild),run(greatGrandchild,owner,['repo.read']),
    'repository','Inspect a third real module',['repo.read'],'key_'+id());
  assert.equal(d3.depth,3);
  await assert.rejects(repo.register(run(greatGrandchild),run(leaf,owner,['repo.read']),
    'repository','Attempt an unauthorized fourth level',['repo.read'],'key_'+id()),/DEPTH_EXCEEDED/);
  await assert.rejects(repo.register(run(root),run(leaf,other,['repo.read']),
    'repository','Cross-tenant delegated task',['repo.read'],'key_'+id()),/OWNER_OR_SCOPE_MISMATCH/);
  await assert.rejects(repo.register(run(root),run(root),
    'repository','Self-delegation attempt',['repo.read'],'key_'+id()),/CYCLE/);
  // A completed intermediate delegation must NOT hide its active descendants.
  const canceled=await repo.cancelTree(owner,root);
  assert.ok(canceled>=2);
  assert.equal((await db('runs').where({id:grandchild}).first()).state,'CANCELLED');
  assert.equal((await repo.get(owner,d3.id))?.status,'CANCELLED');
  console.log('PASS: real PostgreSQL V2 browser fencing, takeover, ownership and durable delegated task constraints');
} finally{
  await db('v2_delegations').where({owner_id:owner}).delete();
  await db('v2_browser_sessions').where({owner_id:owner}).delete();
  await db('runs').whereIn('id',[root,child,grandchild,greatGrandchild,leaf]).delete();
  await closeDb();
}
