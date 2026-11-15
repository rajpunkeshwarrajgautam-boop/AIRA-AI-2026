import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import express from 'express';
import {
  createAiStaringTrialRouter,
  getTrialConfiguration,
  AI_STAR_TRIAL_BRANCH
} from '../apps/api/src/temporary-ai-staring-trial.js';

const ENV_KEYS = [
  'VERCEL_ENV', 'VERCEL_GIT_COMMIT_REF', 'AIRA_STAR_TRIAL_ENABLED',
  'AIRA_STAR_TRIAL_API_KEY', 'AIRA_STAR_TRIAL_EXPIRES_AT',
  'AIRA_STAR_TRIAL_ALLOWED_USER_IDS'
] as const;
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

test('trial routes remain fail-closed, bounded, authenticated, and removable', async () => {
  assert.equal(getTrialConfiguration({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: AI_STAR_TRIAL_BRANCH }).enabled, false);
  assert.equal(getTrialConfiguration({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'staging' }).enabled, false);

  Object.assign(process.env, {
    VERCEL_ENV: 'preview',
    VERCEL_GIT_COMMIT_REF: AI_STAR_TRIAL_BRANCH,
    AIRA_STAR_TRIAL_ENABLED: 'true',
    AIRA_STAR_TRIAL_API_KEY: 'fixture-' + 'secret',
    AIRA_STAR_TRIAL_ALLOWED_USER_IDS: 'trial-owner,test-owner-two',
    AIRA_STAR_TRIAL_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(getTrialConfiguration().enabled, true);
  const app = express();
  let activeUser = 'trial-owner';
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).managedIdentity = { userId: activeUser };
    (req as any).principal = { userId: activeUser, sessionId: 'fixture-session' };
    next();
  });
  app.use('/api/experimental/ai-staring', createAiStaringTrialRouter());
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected localhost server port');
    const base = 'http://127.0.0.1:' + addr.port;
    const endpoint = base + '/api/experimental/ai-staring';

    const status = await originalFetch(endpoint + '/status');
    assert.equal(status.status, 200);
    assert.equal((await status.json()).enabled, true);

    activeUser = 'unlisted-user';
    assert.equal((await originalFetch(endpoint + '/status')).status, 403);

    activeUser = 'trial-owner';
    const invalid = await originalFetch(endpoint + '/complete', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({model: 'untrusted-id', prompt: 'Test'})
    });
    assert.equal(invalid.status, 400);

    const outbound: Array<{ url: string; body: any; authorization: string }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('ai.starimg.ru/v1/chat/completions')) {
        outbound.push({
          url: String(url),
          body: JSON.parse(String(init?.body || '{}')),
          authorization: new Headers(init?.headers).get('Authorization') || ''
        });
        return new Response(JSON.stringify({
          model:'deepseek-v4-flash',
          choices:[{ message: { content:'1728' } }],
          usage:{prompt_tokens:25,completion_tokens:2,total_tokens:27}
        }),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    const good = await originalFetch(endpoint + '/complete', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ model:'deepseek-v4-flash', prompt:'144 * 12' })
    });
    assert.equal(good.status,200);
    assert.equal((await good.json()).answer,'1728');
    assert.equal(outbound.length,1);
    assert.equal(outbound[0].url,'https://ai.starimg.ru/v1/chat/completions');
    assert.equal(outbound[0].authorization,'Bearer fixture-secret');
    assert.equal(outbound[0].body.max_tokens,160);
    assert.equal(outbound[0].body.stream,false);
    assert.equal(outbound[0].body.messages.length,1);
    assert.equal((await originalFetch(endpoint + '/complete', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ model:'deepseek-v4-flash',prompt:'again' })
    })).status,429);

    process.env.AIRA_STAR_TRIAL_ENABLED = 'false';
    assert.equal((await originalFetch(endpoint + '/complete', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ model:'deepseek-v4-flash', prompt:'stopped' })
    })).status,503);
    assert.equal(outbound.length,1);
    process.env.AIRA_STAR_TRIAL_ENABLED = 'true';

    process.env.AIRA_STAR_TRIAL_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
    assert.equal(getTrialConfiguration().enabled,false);
    assert.equal((await originalFetch(endpoint + '/status')).status,200);
    assert.equal((await originalFetch(endpoint + '/complete', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ model:'deepseek-v4-flash', prompt:'expired' })
    })).status,503);
    assert.equal(outbound.length,1);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
