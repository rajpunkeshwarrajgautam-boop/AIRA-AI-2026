import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DurableBrowserSessions } from './browser-sessions.js';
import { PersistentChromiumWorker } from './persistent-browser-worker.js';

const Command=z.object({
  ownerId:z.string().min(1).max(160),
  sessionId:z.string().regex(/^bs_[0-9a-f-]{36}$/),
  operation:z.enum(['navigate','inspect','screenshotDigest']),
  url:z.string().max(2048).optional()
}).strict();
type Command=z.infer<typeof Command>;
type Config={origin:string;token:string};
const equal=(a:string,b:string)=>{
  const one=Buffer.from(a),two=Buffer.from(b);
  return one.length===two.length && timingSafeEqual(one,two);
};
export function browserWorkerConfig(env:NodeJS.ProcessEnv=process.env):Config{
  if(env.AIRA_DURABLE_BROWSER_ENABLED!=='true')
    throw new Error('BROWSER_WORKER_DISABLED');
  const token=env.AIRA_BROWSER_WORKER_TOKEN||'';
  if(token.length<32)throw new Error('BROWSER_WORKER_TOKEN_NOT_CONFIGURED');
  let url:URL;try{url=new URL(env.AIRA_BROWSER_WORKER_URL||'');}
  catch{throw new Error('BROWSER_WORKER_URL_NOT_CONFIGURED');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:' &&
      !(url.protocol==='http:'&&env.NODE_ENV==='test'&&loopback)) ||
     url.pathname!=='/'||url.search||url.hash||url.username||url.password)
    throw new Error('BROWSER_WORKER_INSECURE_OR_INVALID_ENDPOINT');
  return {origin:url.origin,token};
}
/** The API speaks to a dedicated browser worker, never directly to Chromium. */
export class BrowserWorkerClient {
  constructor(private readonly config:Config=browserWorkerConfig()){}
  async observe(ownerId:string,sessionId:string,operation:Command['operation'],url?:string):Promise<unknown>{
    const input=Command.parse({ownerId,sessionId,operation,...(url?{url}:{})});
    const response=await fetch(this.config.origin+'/v1/observe',{
      method:'POST',headers:{Authorization:'Bearer '+this.config.token,
        'Content-Type':'application/json'},
      body:JSON.stringify(input),signal:AbortSignal.timeout(25000)
    });
    const bytes=await response.text();
    if(bytes.length>60000)throw new Error('BROWSER_WORKER_RESPONSE_TOO_LARGE');
    let payload:any;try{payload=JSON.parse(bytes);}catch{throw new Error('BROWSER_WORKER_INVALID_RESPONSE');}
    if(!response.ok)throw new Error('BROWSER_WORKER_'+response.status+': '+String(payload.error||'BLOCKED').slice(0,200));
    if(payload.verified!==true||!payload.evidence||payload.evidence.sessionId!==sessionId)
      throw new Error('BROWSER_WORKER_EVIDENCE_MISSING');
    return payload.evidence;
  }
}
/**
 * Dedicated trusted control-plane service. The bearer authenticates a backend
 * component, not a user; user identity is rechecked against Postgres sessions.
 * All returned data is a direct observation, never an invented success flag.
 * No clicks, typing, uploads, terminal, credentials or secret profile bytes.
 */
export class BrowserWorkerHttp {
  private readonly identity='browser_worker_'+randomUUID();
  constructor(
    private readonly browser:PersistentChromiumWorker,
    private readonly sessions:DurableBrowserSessions,
    private readonly token:string
  ){
    if(process.env.AIRA_BROWSER_WORKER_PROCESS!=='true'||token.length<32)
      throw new Error('BROWSER_TRUSTED_WORKER_REQUIRED');
  }
  private respond(res:ServerResponse,code:number,body:unknown){
    res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff'});
    res.end(JSON.stringify(body));
  }
  private async receive(req:IncomingMessage):Promise<Command>{
    let size=0;const chunks:Buffer[]=[];
    for await(const piece of req){
      const chunk=Buffer.from(piece);size+=chunk.length;
      if(size>5000)throw new Error('BROWSER_WORKER_REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }
    return Command.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  server(){
    return createServer(async(req,res)=>{
      if(req.url!=='/v1/observe'||req.method!=='POST')
        return this.respond(res,404,{error:'NOT_FOUND'});
      const auth=req.headers.authorization;
      if(!auth?.startsWith('Bearer ')||!equal(auth.slice(7),this.token))
        return this.respond(res,401,{error:'UNAUTHORIZED'});
      let lease:Awaited<ReturnType<DurableBrowserSessions['claimBot']>>|undefined;
      try{
        const input=await this.receive(req);
        if(input.operation==='navigate'&&!input.url)throw new Error('BROWSER_URL_REQUIRED');
        if(input.operation!=='navigate'&&input.url)throw new Error('BROWSER_UNEXPECTED_URL');
        if(!await this.sessions.read(input.ownerId,input.sessionId))
          throw new Error('BROWSER_SESSION_NOT_FOUND');
        lease=await this.sessions.claimBot(input.ownerId,input.sessionId,this.identity,30000);
        const observation=input.operation==='navigate'
          ?await this.browser.navigate(lease,input.url!)
          :input.operation==='inspect'
            ?await this.browser.inspect(lease)
            :await this.browser.screenshotDigest(lease);
        await this.sessions.assertLease(lease,'BOT');
        // The browser's returned observation must survive a separate lease
        // readback before it can be acknowledged as verified.
        await this.sessions.release(lease);
        lease=undefined;
        return this.respond(res,200,{verified:true,evidence:{
          ...observation,sessionId:input.sessionId,operation:input.operation
        }});
      }catch(err:any){
        return this.respond(res,409,{error:String(err?.message||err).slice(0,200)});
      }finally{
        if(lease)await this.sessions.release(lease).catch(()=>{});
      }
    });
  }
}
