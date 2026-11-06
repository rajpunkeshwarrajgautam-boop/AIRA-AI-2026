import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, lstat, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { DurableBrowserSessions, type BrowserLease } from './browser-sessions.js';

type Active = { ownerId:string; context:BrowserContext; page:Page; profile:string };
export type BrowserObservation = {
  url:string; title:string; text:string; heading:string; workerVerified:true;
};
function privateIp(address:string):boolean {
  const a=address.toLowerCase();
  if(isIP(a)===4){
    const n=a.split('.').map(Number);
    return n[0]===0||n[0]===10||n[0]===127||n[0]>=224||
      (n[0]===169&&n[1]===254)||(n[0]===100&&n[1]>=64&&n[1]<=127)||
      (n[0]===172&&n[1]>=16&&n[1]<=31)||(n[0]===192&&[0,168].includes(n[1]))||
      (n[0]===198&&[18,19,51].includes(n[1]))||(n[0]===203&&n[1]===0);
  }
  if(isIP(a)===6){
    if(a==='::'||a==='::1'||a.startsWith('ff')||a.startsWith('fc')||
       a.startsWith('fd')||a.startsWith('fe')||a.startsWith('2001:db8'))return true;
    if(a.startsWith('::ffff:')){
      const v4=a.slice('::ffff:'.length);
      return isIP(v4)===4?privateIp(v4):true;
    }
    return false;
  }
  return true;
}
export async function enforceBrowserEgress(raw:string, localTest=false):Promise<URL> {
  let url:URL;
  try{url=new URL(raw);}catch{throw new Error('BROWSER_INVALID_URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)
    throw new Error('BROWSER_FORBIDDEN_URL');
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const controlled=localTest && process.env.NODE_ENV==='test' &&
    (host==='localhost'||host==='127.0.0.1'||host==='::1');
  if(/(^|\.)(localhost|local|internal)$/.test(host)&&!controlled)
    throw new Error('BROWSER_PRIVATE_HOST_DENIED');
  let addresses:string[];
  try{
    addresses=isIP(host)?[host]:(await lookup(host,{all:true,verbatim:true})).map(r=>r.address);
  }catch{throw new Error('BROWSER_DNS_LOOKUP_FAILED');}
  if(!addresses.length||(!controlled&&addresses.some(privateIp)))
    throw new Error('BROWSER_PRIVATE_IP_DENIED');
  return url;
}
/**
 * Real Chromium persistent context intended exclusively for a separately
 * isolated browser-worker process. The public API MUST NOT instantiate this.
 * Profile bytes never flow to task run JSON, events or artifact endpoints.
 *
 * DNS checks are defense in depth, not a replacement for production host
 * egress firewall/DNS pinning; absence of that attestation blocks rollout.
 */
export class PersistentChromiumWorker {
  private readonly active=new Map<string,Active>();
  constructor(
    private readonly sessions:DurableBrowserSessions,
    private readonly profileRoot:string,
    private readonly allowControlledLocalTest=false
  ){
    if(process.env.AIRA_BROWSER_WORKER_PROCESS!=='true'||process.env.VERCEL==='1')
      throw new Error('BROWSER_DEDICATED_WORKER_REQUIRED');
    if(process.env.NODE_ENV==='production' &&
       process.env.AIRA_BROWSER_NETWORK_SANDBOX_CERTIFIED!=='true')
      throw new Error('BROWSER_NETWORK_SANDBOX_NOT_CERTIFIED');
  }
  private profile(ownerId:string,sessionId:string):string{
    const digest=createHash('sha256').update(ownerId).update('\0').update(sessionId).digest('hex');
    const root=resolve(this.profileRoot);
    const target=resolve(root,digest);
    if(!target.startsWith(root+sep))throw new Error('BROWSER_INVALID_PROFILE');
    return target;
  }
  private async get(lease:BrowserLease):Promise<Active>{
    await this.sessions.assertLease(lease,'BOT');
    const existing=this.active.get(lease.sessionId);
    if(existing){
      if(existing.ownerId!==lease.ownerId)throw new Error('BROWSER_OWNER_MISMATCH');
      if(!existing.page.isClosed())return existing;
      await existing.context.close().catch(()=>{});
      this.active.delete(lease.sessionId);
    }
    const root=resolve(this.profileRoot);
    await mkdir(root,{recursive:true,mode:0o700});
    if((await lstat(root)).isSymbolicLink())throw new Error('BROWSER_PROFILE_ROOT_SYMLINK');
    const profile=this.profile(lease.ownerId,lease.sessionId);
    if((await lstat(profile).catch(()=>null))?.isSymbolicLink())
      throw new Error('BROWSER_PROFILE_SYMLINK');
    await mkdir(profile,{recursive:true,mode:0o700});
    const ctx=await chromium.launchPersistentContext(profile,{
      headless:true,
      ...(process.env.AIRA_CHROMIUM_PATH?{executablePath:process.env.AIRA_CHROMIUM_PATH}:{}),
      viewport:{width:1280,height:800},
      ignoreHTTPSErrors:false,
      acceptDownloads:true
    });
    try{
      await ctx.route('**/*',async route=>{
        const target=route.request().url();
        if(!/^https?:\/\//i.test(target)){
          await route.abort('blockedbyclient');return;
        }
        try{
          await enforceBrowserEgress(target,this.allowControlledLocalTest);
          await route.continue();
        }catch{
          await route.abort('blockedbyclient');
        }
      });
      const page=ctx.pages()[0]||await ctx.newPage();
      const result={ownerId:lease.ownerId,context:ctx,page,profile};
      this.active.set(lease.sessionId,result);
      return result;
    }catch(e){await ctx.close();throw e;}
  }
  async navigate(lease:BrowserLease,url:string):Promise<BrowserObservation>{
    await enforceBrowserEgress(url,this.allowControlledLocalTest);
    const session=await this.get(lease);
    await this.sessions.assertLease(lease,'BOT');
    await session.page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
    return this.inspect(lease);
  }
  async inspect(lease:BrowserLease):Promise<BrowserObservation>{
    const session=await this.get(lease);
    await this.sessions.assertLease(lease,'BOT');
    const p=session.page;
    const [url,title,text,heading]=await Promise.all([
      Promise.resolve(p.url()),
      p.title(),p.locator('body').innerText({timeout:8000}).then(t=>t.slice(0,12000)),
      p.locator('h1').first().innerText({timeout:2000}).catch(()=>'')
    ]);
    await this.sessions.assertLease(lease,'BOT');
    if(/^https?:\/\//.test(url))await this.sessions.recordObservation(lease,url);
    return {url,title,text,heading,workerVerified:true};
  }
  async screenshotDigest(lease:BrowserLease):Promise<{url:string;sha256:string;bytes:number}>{
    const session=await this.get(lease);
    await this.sessions.assertLease(lease,'BOT');
    const bytes=await session.page.screenshot({fullPage:false});
    await this.sessions.assertLease(lease,'BOT');
    return {
      url:session.page.url(),
      sha256:createHash('sha256').update(bytes).digest('hex'),
      bytes:bytes.length
    };
  }
  async closeContext(sessionId:string):Promise<void>{
    const active=this.active.get(sessionId);
    if(active){
      await active.context.close();
      this.active.delete(sessionId);
    }
  }
  async deleteProfile(lease:BrowserLease):Promise<void>{
    await this.closeContext(lease.sessionId);
    await rm(this.profile(lease.ownerId,lease.sessionId),{recursive:true,force:true});
  }
  async shutdown():Promise<void>{
    for(const session of [...this.active.keys()])await this.closeContext(session);
  }
}
