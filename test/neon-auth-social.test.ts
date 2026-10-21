import assert from 'node:assert/strict';
import test from 'node:test';
import { NeonAuthClient } from '../src/lib/neonAuth.js';

test('NeonAuthClient: signInWithSocial method contract', async (t) => {
  const client = new NeonAuthClient();
  client.setBaseUrl('https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth');

  await t.test('initiates Google OAuth redirect via Neon Auth', async () => {
    // Staging Neon Auth has Google shared provider enabled
    const res = await client.signInWithSocial({
      provider: 'google',
      callbackURL: 'https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app'
    });

    assert.ok(res.url, 'Must return OAuth initialization URL');
    assert.ok(res.url.includes('/sign-in/social/init'), 'URL must point to social init endpoint');
    assert.equal(res.redirect, true, 'Redirect must be true');
  });

  await t.test('fails closed with descriptive error for unconfigured provider (GitHub)', async () => {
    // GitHub is not enabled on staging Neon Auth without owner credentials
    await assert.rejects(
      async () => {
        await client.signInWithSocial({
          provider: 'github',
          callbackURL: 'https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app'
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('not supported') || err.message.includes('400') || err.message.includes('PROVIDER_NOT_SUPPORTED'));
        return true;
      }
    );
  });
});
