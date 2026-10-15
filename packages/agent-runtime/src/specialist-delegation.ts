import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../db/src/index.js';
import type { Run } from '../../contracts/src/index.js';

export type Specialist = 'repository' | 'research' | 'verification';
export type DelegationState = 'QUEUED' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type Delegation = {
  id: string; ownerId: string; parentRunId: string; childRunId: string;
  specialist: Specialist; objective: string; scopes: string[]; depth: number;
  status: DelegationState; fence: number;
};

const specialistScopes: Record<Specialist, readonly string[]> = {
  repository: ['repo.read', 'files.read'],
  research: ['web.search', 'browser.read'],
  verification: ['repo.read', 'files.read', 'web.search']
};
export function specialistRegistry(scopes: readonly string[]): Array<{id:Specialist; scopes:string[]; available:boolean}> {
  return (Object.keys(specialistScopes) as Specialist[]).map(id => ({
    id, scopes: specialistScopes[id].filter(s=>scopes.includes(s)),
    available: specialistScopes[id].some(s=>scopes.includes(s))
  }));
}
export function delegatedScopes(parent: readonly string[], requested: readonly string[], specialist: Specialist): string[] {
  const catalog=specialistScopes[specialist];
  if(!catalog)throw new Error('DELEGATION_UNKNOWN_SPECIALIST');
  if(requested.length===0 || requested.length>catalog.length ||
     requested.some(s=>!parent.includes(s)||!catalog.includes(s))) {
    throw new Error('DELEGATION_SCOPE_ESCALATION');
  }
  return Array.from(new Set(requested));
}
const executableSpecialistTools: Record<Specialist, readonly string[]> = {
  repository: ['file_system_list','file_system_read','repo_git_status','repo_git_log'],
  research: ['browser_session_inspect'],
  verification: ['file_system_list','file_system_read','repo_git_status','repo_git_log','browser_session_inspect']
};
export function specialistMayExecute(specialist: Specialist, toolName: string): boolean {
  return (executableSpecialistTools[specialist] || []).includes(toolName);
}
export function delegationKey(parentId: string, specialist: Specialist, objective: string): string {
  return createHash('sha256').update(parentId).update('\0').update(specialist).update('\0').update(objective).digest('hex');
}
const asDelegation=(r:any):Delegation=>({
  id:r.id, ownerId:r.owner_id,parentRunId:r.parent_run_id,childRunId:r.child_run_id,
  specialist:r.specialist,objective:r.objective,
  scopes:typeof r.scopes==='string'?JSON.parse(r.scopes):r.scopes,depth:r.depth,
  status:r.status,fence:Number(r.fence)
});

/**
 * All reads, claims and outcomes are scoped to the verified parent principal.
 * Work is launched separately by AgentRuntime only after the DB record commits.
 */
export class DurableDelegations {
  /**
   * A child context or requested tool name is NEVER authority. Every checkpoint
   * must match the immutable DB delegation, real owner and scope intersection.
   */
  async assertChildAuthorized(
    child:Run, parentRunId:string, specialist:Specialist, toolName?:string
  ):Promise<Delegation>{
    const row=await db('v2_delegations')
      .where({owner_id:child.principalId,child_run_id:child.id,parent_run_id:parentRunId})
      .whereIn('status',['QUEUED','RUNNING','WAITING']).first();
    if(!row || row.specialist!==specialist)throw new Error('DELEGATED_CHILD_NOT_AUTHORIZED');
    const saved=asDelegation(row);
    const expected=[...saved.scopes].sort(),actual=[...child.principalScopes].sort();
    if(expected.length!==actual.length||expected.some((s,i)=>s!==actual[i]))
      throw new Error('DELEGATED_CHILD_SCOPE_TAMPERED');
    if(!saved.scopes.every(s=>specialistScopes[specialist]?.includes(s)))
      throw new Error('DELEGATED_SPECIALIST_SCOPE_INVALID');
    const parent=await db('runs').select('principal_id','state').where({id:parentRunId}).first();
    if(!parent || parent.principal_id!==child.principalId ||
       ['FAILED','CANCELLED'].includes(parent.state))
      throw new Error('DELEGATED_PARENT_NOT_ACTIVE');
    if(toolName && !specialistMayExecute(specialist,toolName))
      throw new Error('DELEGATED_TOOL_NOT_ALLOWED');
    return saved;
  }

  async get(ownerId:string, delegationId:string):Promise<Delegation|undefined>{
    const row=await db('v2_delegations').where({id:delegationId,owner_id:ownerId}).first();
    return row?asDelegation(row):undefined;
  }
  async findByKey(ownerId:string,parentId:string,key:string):Promise<Delegation|undefined>{
    const row=await db('v2_delegations').where({owner_id:ownerId,parent_run_id:parentId,idempotency_key:key}).first();
    return row?asDelegation(row):undefined;
  }
  async list(ownerId:string,parentId:string):Promise<Delegation[]>{
    return (await db('v2_delegations').where({owner_id:ownerId,parent_run_id:parentId}).orderBy('created_at','asc')).map(asDelegation);
  }

  async register(
    parent:Run,child:Run,specialist:Specialist,objective:string,scopes:string[],key:string
  ):Promise<Delegation>{
    if(parent.id===child.id)throw new Error('DELEGATION_CYCLE');
    if(parent.principalId!==child.principalId ||
       child.sessionId!==parent.sessionId ||
       !child.principalScopes.every(s=>scopes.includes(s)) ||
       !scopes.every(s=>parent.principalScopes.includes(s))) throw new Error('DELEGATION_OWNER_OR_SCOPE_MISMATCH');
    if(objective.length<5||objective.length>16000||key.length<8||key.length>180)
      throw new Error('DELEGATION_INVALID_INPUT');
    delegatedScopes(parent.principalScopes,scopes,specialist);
    const now=Date.now();
    return db.transaction(async trx=>{
      const parentRow=await trx('runs').select('id','principal_id','state').where({id:parent.id}).first();
      const childRow=await trx('runs').select('id','principal_id','state').where({id:child.id}).first();
      if(!parentRow||!childRow||parentRow.principal_id!==parent.principalId||
         childRow.principal_id!==parent.principalId||!['QUEUED','RUNNING','WAITING_FOR_TOOL','WAITING_FOR_APPROVAL'].includes(parentRow.state)){
        throw new Error('DELEGATION_PARENT_OR_CHILD_UNAVAILABLE');
      }
      // Parent runs form an acyclic forest; child is newly created and must
      // not already be referenced. A bounded ancestor walk also enforces depth.
      let ancestor=parent.id,depth=1;
      const visited=new Set<string>();
      while(ancestor){
        if(visited.has(ancestor)||ancestor===child.id)throw new Error('DELEGATION_CYCLE');
        visited.add(ancestor);
        const upstream=await trx('v2_delegations')
          .where({owner_id:parent.principalId,child_run_id:ancestor}).first();
        if(!upstream)break;
        ancestor=upstream.parent_run_id;
        depth++;
        if(depth>3)throw new Error('DELEGATION_DEPTH_EXCEEDED');
      }
      if(depth>3)throw new Error('DELEGATION_DEPTH_EXCEEDED');
      const siblings=await trx('v2_delegations').where({owner_id:parent.principalId,parent_run_id:parent.id}).count('* as count').first();
      if(Number(siblings?.count||0)>=6)throw new Error('DELEGATION_CHILD_LIMIT');
      const id='dlg_'+randomUUID();
      await trx('v2_delegations').insert({
        id,owner_id:parent.principalId,parent_run_id:parent.id,child_run_id:child.id,
        specialist,objective,scopes:JSON.stringify(scopes),
        idempotency_key:key,depth,status:'QUEUED',fence:0,created_at:now,updated_at:now
      });
      return {id,ownerId:parent.principalId,parentRunId:parent.id,childRunId:child.id,
        specialist,objective,scopes,depth,status:'QUEUED',fence:0};
    });
  }

  async claim(ownerId:string,id:string,worker:string,ttlMs=30000):Promise<Delegation>{
    if(!worker||ttlMs<1000||ttlMs>120000)throw new Error('DELEGATION_LEASE_INVALID');
    const now=Date.now();
    const rows=await db('v2_delegations').where({id,owner_id:ownerId}).whereIn('status',['QUEUED','RUNNING','WAITING'])
      .andWhere(q=>q.whereNull('lease_until').orWhere('lease_until','<',now))
      .update({worker_owner:worker,lease_until:now+ttlMs,
        fence:db.raw('fence + 1'),status:'RUNNING',updated_at:now}).returning('*');
    if(rows.length!==1)throw new Error('DELEGATION_NOT_CLAIMABLE');
    return asDelegation(rows[0]);
  }

  async finalize(ownerId:string,id:string,worker:string,fence:number):Promise<Delegation>{
    const row=await db('v2_delegations').where({id,owner_id:ownerId,worker_owner:worker,fence})
      .where('lease_until','>',Date.now()).first();
    if(!row)throw new Error('DELEGATION_STALE_WORKER');
    const child=await db('runs').select('state','principal_id','context_data').where({id:row.child_run_id}).first();
    if(!child||child.principal_id!==ownerId)throw new Error('DELEGATION_CHILD_OWNER_MISMATCH');
    if(!['COMPLETED','FAILED','CANCELLED'].includes(child.state))throw new Error('DELEGATION_CHILD_NOT_TERMINAL');
    const status:DelegationState=child.state;
    const updated=await db('v2_delegations').where({id,owner_id:ownerId,worker_owner:worker,fence})
      .where('lease_until','>',Date.now())
      .update({status,worker_owner:null,lease_until:null,updated_at:Date.now()}).returning('*');
    if(updated.length!==1)throw new Error('DELEGATION_STALE_WORKER');
    // COMPLETED mirrors actual Run state only; it is NOT independently verified.
    return asDelegation(updated[0]);
  }

  /**
   * Separate from child state: a child saying COMPLETED is not independent
   * evidence that its assigned objective happened. Never return VERIFIED
   * unless Runtime V2 recorded complete readback for every mission step.
   */
  async verification(ownerId:string,delegationId:string):Promise<{
    status:'COMPLETED_VERIFIED'|'NOT_VERIFIED'|'NOT_TERMINAL';
    childRunId:string; verifiedSteps:number
  }> {
    const record=await this.get(ownerId,delegationId);
    if(!record)throw new Error('DELEGATION_NOT_FOUND');
    const row=await db('runs').select('principal_id','state','context_data')
      .where({id:record.childRunId,principal_id:ownerId}).first();
    if(!row || row.principal_id!==ownerId)throw new Error('DELEGATION_CHILD_NOT_FOUND');
    if(row.state!=='COMPLETED')
      return {status:'NOT_TERMINAL',childRunId:record.childRunId,verifiedSteps:0};
    const context=typeof row.context_data==='string'
      ? JSON.parse(row.context_data):row.context_data;
    const outcome=context?.__airaOutcomeVerificationV2;
    const evidence=outcome?.evidence;
    const verified=outcome?.status==='COMPLETED_VERIFIED' &&
      Array.isArray(evidence)&&evidence.length>0&&evidence.every((v:any)=>
        v && v.verified===true && typeof v.toolCallId==='string');
    return {
      status:verified?'COMPLETED_VERIFIED':'NOT_VERIFIED',
      childRunId:record.childRunId,verifiedSteps:verified?evidence.length:0
    };
  }

  async cancelTree(ownerId:string,parentRunId:string):Promise<number>{
    // Traverse ALL lineage edges, including previously COMPLETED children:
    // their descendants may still be running. Never skip a subtree simply
    // because an intermediate child completed earlier.
    const seen=new Set<string>([parentRunId]);
    let frontier=[parentRunId],total=0;
    for(let depth=0;depth<4 && frontier.length;depth++){
      const children=await db('v2_delegations').where({owner_id:ownerId})
        .whereIn('parent_run_id',frontier).orderBy('created_at','asc');
      const next:string[]=[];
      for(const record of children){
        if(!seen.has(record.child_run_id)){
          seen.add(record.child_run_id);
          next.push(record.child_run_id);
        }
        if(seen.size>100)throw new Error('DELEGATION_CANCEL_TREE_TOO_LARGE');
        if(['FAILED','CANCELLED','COMPLETED'].includes(record.status))continue;
        const count=await db('v2_delegations')
          .where({id:record.id,owner_id:ownerId})
          .whereNotIn('status',['FAILED','CANCELLED','COMPLETED'])
          .update({status:'CANCELLED',fence:db.raw('fence + 1'),
            worker_owner:null,lease_until:null,updated_at:Date.now()});
        if(count!==1)continue;
        await db('runs').where({id:record.child_run_id,principal_id:ownerId})
          .whereNotIn('state',['COMPLETED','FAILED','CANCELLED'])
          .update({state:'CANCELLED',status:'CANCELLED',updatedAt:Date.now()});
        total++;
      }
      frontier=next;
    }
    return total;
  }}
