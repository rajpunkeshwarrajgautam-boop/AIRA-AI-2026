import { randomUUID } from 'node:crypto';
import { DurableDelegations, type Delegation } from './specialist-delegation.js';

export type SpecialistClaim = { delegation: Delegation; recovered: boolean };
export interface SpecialistExecution {
  executeClaimedSpecialist(
    id:string,ownerId:string,worker:string,fence:number,recovered:boolean
  ):Promise<'TERMINAL'|'WAITING'|'STILL_RUNNING'>;
}
export interface DispatcherOptions {
  leaseMs?:number; heartbeatMs?:number;
  onLeaseLost?: (error:Error)=>void;
}

/** A real PostgreSQL-backed worker, one child at a time per process.
 * Reuses Runtime V2 AgentRuntime and Bot PR #6's monotonically fenced lease
 * pattern. It never substitutes canned specialist answers.
 */
export class DurableSpecialistDispatcher {
  private readonly workerId='specialist_'+randomUUID();
  private readonly store:DurableDelegations;
  private readonly leaseMs:number;
  private readonly heartbeatMs:number;
  private stopping=false;
  constructor(private readonly runtime:SpecialistExecution,options:DispatcherOptions={},
    store=new DurableDelegations()){
    this.store=store;
    this.leaseMs=options.leaseMs??30000;
    this.heartbeatMs=options.heartbeatMs??5000;
    if(this.leaseMs<5000||this.leaseMs>120000||
       this.heartbeatMs<100||this.heartbeatMs>=this.leaseMs/2)
      throw new Error('SPECIALIST_DISPATCHER_INVALID_TIMING');
    this.onLeaseLost=options.onLeaseLost;
  }
  private readonly onLeaseLost?: (error:Error)=>void;
  get id():string{return this.workerId;}
  stop(){this.stopping=true;}
  async tick():Promise<'IDLE'|'DONE'|'WAITING'|'PENDING'>{
    if(this.stopping)return 'IDLE';
    const claimed=await this.store.claimNext(this.workerId,this.leaseMs);
    if(!claimed)return 'IDLE';
    const {delegation:d,recovered}=claimed;
    let heartbeatFailure:Error|undefined,renewal:Promise<void>=Promise.resolve();
    let ended=false;
    const heartbeat=()=>{
      renewal=renewal.then(async()=>{
        if(ended)return;
        try{
          await this.store.renewClaim(d.ownerId,d.id,this.workerId,d.fence,this.leaseMs);
        }catch(err:any){
          heartbeatFailure=err instanceof Error?err:new Error(String(err));
          ended=true;
          this.onLeaseLost?.(heartbeatFailure);
        }
      });
    };
    const timer=setInterval(heartbeat,this.heartbeatMs);
    timer.unref?.();
    try{
      await this.store.assertClaim(d.ownerId,d.id,this.workerId,d.fence);
      const outcome=await this.runtime.executeClaimedSpecialist(
        d.id,d.ownerId,this.workerId,d.fence,recovered
      );
      await renewal;
      if(heartbeatFailure)throw heartbeatFailure;
      await this.store.assertClaim(d.ownerId,d.id,this.workerId,d.fence);
      if(outcome==='TERMINAL'){
        await this.store.finalize(d.ownerId,d.id,this.workerId,d.fence);
        return 'DONE';
      }
      if(outcome==='WAITING'){
        await this.store.releaseClaim(d.ownerId,d.id,this.workerId,d.fence,'WAITING');
        return 'WAITING';
      }
      // Neither an incomplete run nor a waiting approval may be called success.
      // Release for safe recovery from the original checkpoints.
      await this.store.releaseClaim(d.ownerId,d.id,this.workerId,d.fence,'QUEUED');
      return 'PENDING';
    } finally {
      ended=true;
      clearInterval(timer);
      await renewal.catch(()=>{});
      // On crash/error we intentionally leave the claim leased to expire.
      // Another worker can recover only with a higher fencing token.
    }
  }
  async run(signal?:AbortSignal,pollMs=1000):Promise<void>{
    if(pollMs<100||pollMs>30000)throw new Error('SPECIALIST_POLL_INTERVAL_INVALID');
    while(!this.stopping&&!signal?.aborted){
      const result=await this.tick();
      // An incomplete child is NOT grounds for a tight redispatch loop.
      if(result==='IDLE'||result==='WAITING'||result==='PENDING'){
        await new Promise<void>(resolve=>{
          const finish=()=>{
            clearTimeout(timer);
            signal?.removeEventListener('abort',finish);
            resolve();
          };
          const timer=setTimeout(finish,pollMs);
          if(signal?.aborted)finish();
          else signal?.addEventListener('abort',finish,{once:true});
        });
      }
    }
  }
}
