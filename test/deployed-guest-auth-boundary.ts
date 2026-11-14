import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { request } from 'playwright';

const url=new URL(process.env.AIRA_RESPONSIVE_URL||'http://127.0.0.1:5173/');
assert(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)));
const expected=process.env.AIRA_EXPECTED_SHA||'';
assert.match(expected,/^[a-f0-9]{40}$/);
const bypass=process.env.VERCEL_AUTOMATION_BYPASS_SECRET||'';
const dir=path.resolve(process.env.AIRA_AUTH_EVIDENCE_DIR||'artifacts/guest-auth');
mkdirSync(dir,{recursive:true});
const headers=bypass?{'x-vercel-protection-bypass':bypass}:{};
const cases=[
  ['/api/account/profile',401],
  ['/api/account/security',401],
  ['/api/account/onboarding',401],
  ['/api/billing/entitlements',401],
  ['/api/billing/summary',401],
  ['/api/billing/invoices',401],
] as const;
const results:Array<{route:string,expected:number,actual:number,result:'PASS'|'FAIL',message:string}>=[];
const ctx=await request.newContext({extraHTTPHeaders:headers,ignoreHTTPSErrors:false});
try{
  const version=await ctx.get(new URL('/api/version',url).toString());
  assert.equal(version.status(),200);
  assert.equal((await version.json()).commitSha,expected);
  const session=await ctx.get(new URL('/api/auth/session',url).toString());
  const info=session.ok()?await session.json():{};
  const valid=session.status()===200&&info.status==='ANONYMOUS'&&info.user==null;
  results.push({route:'/api/auth/session',expected:200,actual:session.status(),
    result:valid?'PASS':'FAIL',message:valid?'Anonymous session confirmed':'Session response was not anonymous'});
  for(const [route,expectedStatus] of cases){
    try{
      const res=await ctx.get(new URL(route,url).toString());
      // Body is deliberately not retained because account endpoints may expose PII
      // if incorrectly authorized. Only status and generic result are logged.
      results.push({route,expected:expectedStatus,actual:res.status(),
        result:res.status()===expectedStatus?'PASS':'FAIL',
        message:res.status()===expectedStatus?'Access denied':'Unexpected HTTP status'});
    }catch(error){
      results.push({route,expected:expectedStatus,actual:0,result:'FAIL',message:String(error)});
    }
  }
}finally{
  await ctx.dispose();
  writeFileSync(path.join(dir,'results.json'),JSON.stringify({
    preview:url.origin,expectedSha:expected,identity:'anonymous; no credentials or cookies',
    checks:results},null,2)+'\n');
}
for(const item of results)console.log(item.result+' '+item.route+' HTTP '+item.actual+' expected '+item.expected);
if(results.some(item=>item.result==='FAIL'))throw Error('Protected guest API boundary certification failed');
console.log('PASS anonymous access restrictions: '+results.length+' cases');
