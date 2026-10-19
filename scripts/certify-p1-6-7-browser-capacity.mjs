/** Live Preview-only certification. Never prints cookies, passwords or tokens. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const origin = process.argv[2];
assert.ok(/^https:\/\/aira-ai-2026-[a-z0-9]+-rajpunkeshwarrajgautam-boops-projects\.vercel\.app$/.test(origin || ''), 'An immutable AIRA Preview URL is required; production is forbidden.');
const observations = [];
const headers = { Origin: origin, 'Content-Type': 'application/json', 'x-aira-csrf-protection': '1' };
const jar = () => ({ cookies: new Map(), csrf: undefined });
function remember(session, response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]; const i = pair.indexOf('=');
    session.cookies.set(pair.slice(0,i), pair.slice(i+1));
  }
}
async function request(session, path, body, signal) {
  const h = { ...headers, Cookie: [...session.cookies].map(([k,v]) => `${k}=${v}`).join('; ') };
  if (session.csrf) h['x-csrf-token'] = session.csrf;
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: signal || AbortSignal.timeout(65000) });
  remember(session,response); return response;
}
async function guest() { const s=jar(); const r=await request(s,'/api/auth/session',{}); assert.equal(r.status,200,'Guest session'); return s; }
async function account(label) {
  const s=jar();
  const r=await request(s,'/api/auth/sign-up',{ email:`p167-${randomUUID()}@aira-certification.test`, password:randomBytes(24).toString('base64url')+'aA1!', name:`P167 isolated certification ${label}` });
  assert.equal(r.status,200,`Real staging BFF sign-up (${label}) returned ${r.status}`);
  const data=await r.json(); assert.equal(data.status,'AUTHENTICATED'); assert.ok(data.user?.id && data.csrfToken); s.csrf=data.csrfToken;
  const state=await (await request(s,'/api/auth/session')).json(); assert.equal(state.status,'AUTHENTICATED');
  return s;
}
async function chat(session, model, label) {
  const start=performance.now(); const response=await request(session,'/api/chat/stream',{ model, prompt:`Reply with exactly OK. Certification ${label}.` });
  assert.equal(response.status,200,`${label}: HTTP ${response.status}`);
  assert.match(response.headers.get('content-type')||'',/text\/event-stream/);
  let buffer='', content='', first=null, metrics, provenance, completed=false; const decoder=new TextDecoder();
  for await (const bytes of response.body) {
    buffer+=decoder.decode(bytes,{stream:true}).replace(/\r\n/g,'\n');
    let boundary;
    while ((boundary=buffer.indexOf('\n\n'))>=0) {
      const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
      const event=frame.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim();
      const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
      if(event==='done'){completed=true;continue;}
      if(!data)continue;
      let item;try{item=JSON.parse(data);}catch{continue;}
      if(event==='error')throw new Error(`${label}: SSE error ${item.code||item.error}`);
      if(event==='content_delta'&&item.text){if(first===null)first=Math.round(performance.now()-start);content+=item.text;}
      if(event==='latency_metrics')metrics=item;
      if(event==='model_provenance')provenance=item;
    }
  }
  assert.ok(completed && content.trim() && first!==null,`${label}: genuine completed content stream`);
  assert.ok(metrics?.capacityDbRoundTrips>=1 && metrics?.capacityAdmissionMs>0,`${label}: distributed admission metrics`);
  assert.ok(Number.isFinite(metrics?.ttftMs) && metrics.ttftMs>0,`${label}: real server TTFT`);
  assert.notEqual(provenance?.executedModel,'allam-2-7b');
  const sample={label,model,runId:metrics.requestId,clientTtftMs:first,serverTtftMs:metrics.ttftMs,capacityAdmissionMs:metrics.capacityAdmissionMs,capacityDbRoundTrips:metrics.capacityDbRoundTrips,executedModel:provenance?.executedModel||metrics.executedModel,executedProvider:metrics.executedProvider,completed};
  observations.push(sample); console.log(JSON.stringify(sample)); return sample;
}
async function run() {
  const g=await guest();
  for(const [i,model] of ['claude-3-7-sonnet','claude-3-5-haiku','aira-auto','aira-fast','openai/gpt-oss-120b'].entries())await chat(g,model,`guest-${i}`);
  const quota=await request(g,'/api/chat/stream',{model:'aira-fast',prompt:'Reply OK'});assert.equal(quota.status,429);assert.equal((await quota.json()).code,'USER_RATE_LIMIT');observations.push({gate:'real per-user quota',passed:true});
  for(const model of ['unknown-model','__proto__','allam-2-7b','gemini-2-5-flash',null,{}]) { const invalid=await request(g,'/api/chat/stream',{model,prompt:'Reply OK'});assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'UNSUPPORTED_MODEL_IDENTIFIER'); }
  const a=await account('A'),b=await account('B');
  for(const [i,model] of ['claude-3-7-sonnet','claude-3-5-haiku','aira-auto','aira-fast'].entries())await chat(a,model,`auth-${i}`);
  const direct=await request(b,'/api/runs',{prompt:'Reply with exactly OK.',modelPolicy:{model:'claude-3-5-haiku'}});assert.equal(direct.status,201);const created=await direct.json();
  assert.equal((await request(a,`/api/runs/${created.id}`)).status,404,'Cross-user run isolation');
  let terminal;for(let i=0;i<20;i++){const r=await (await request(b,`/api/runs/${created.id}`)).json();if(['COMPLETED','FAILED','CANCELLED'].includes(r.state)){terminal=r;break;}await new Promise(r=>setTimeout(r,500));}
  assert.equal(terminal?.state,'COMPLETED','Direct API run completes');assert.ok(terminal.content?.trim());observations.push({gate:'direct run and cross-user isolation',runId:created.id,passed:true});
  await chat(b,'gemini-3.5-flash-lite','direct-gemini');
  const concurrent=await guest();const controller=new AbortController();
  let responses=[];
  try {
    // Start together: waiting for the first response can let a fast provider
    // finish before the second request reaches admission.
    responses=await Promise.all([0,1].map(() => request(concurrent,'/api/chat/stream',{model:'claude-3-5-haiku',prompt:'Count from 1 to 2000, writing each number on its own line. Do not abbreviate.'},controller.signal)));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,429],'Overlapping same-principal requests must reserve only once');
    const rejected=responses.find(r=>r.status===429); assert.equal((await rejected.json()).code,'AIRA_PRIVATE_BETA_CAPACITY');
    observations.push({gate:'concurrent reservation and cancellation',passed:true});
  } finally { controller.abort(); await Promise.all(responses.map(r=>r.body?.cancel().catch(()=>{}))); }
  console.log('LIVE_HTTP_CERTIFICATION_PASS: PostgreSQL table evidence must be checked separately.');
}
try { await run(); } finally { writeFileSync(process.argv[3]||'/tmp/aira-p167-live-results.json',JSON.stringify({target:origin,recordedAt:new Date().toISOString(),observations},null,2)); }
