# Temporary AI Staring trial — disposable preview experiment

**Scope:** branch trial/ai-staring-preview-20261115, Vercel Preview only.

This is a disposable API tester, not an AIRA model-router integration. Normal chat streaming, AIRA model registry, billing, durable workers, production, staging alias, and databases remain unchanged.

## Activation

Set these Vercel variables with target **Preview**, restricted to Git branch trial/ai-staring-preview-20261115 only:

- AIRA_STAR_TRIAL_ENABLED=true
- AIRA_STAR_TRIAL_API_KEY=(fresh rotated trial key; sensitive or encrypted)
- AIRA_STAR_TRIAL_ALLOWED_USER_IDS=(comma-separated verified BFF user IDs)
- AIRA_STAR_TRIAL_EXPIRES_AT=(UTC ISO timestamp within next 7 days)
- AIRA_STAR_TRIAL_ACCESS_CODE=(40+ character random access code, stored as Sensitive, separate from provider key)

Never set unscoped Preview or Production variables for this experiment. Do not commit credentials.

The static tester is /ai-staring-trial.html on that branch's Vercel Preview URL. The tester offers a separate ephemeral access-code unlock because this isolated Preview has no branch-specific staging OAuth or DB credentials. Existing BFF and CSRF protections still apply. AIRA regular login is an optional link but should not be relied upon in this preview. Never paste the provider API key into the tester.

## Safety properties

- Disabled unless VERCEL_ENV=preview and the exact experiment branch matches.
- Requires either verified managed identity from the existing AIRA BFF user-ID allowlist or a 40+ character separate branch-scoped trial access code. No fake AIRA principal or client-supplied identity header is trusted.
- Existing CSRF and origin middleware executes before experimental router.
- Provider API key stays on the backend; never sent to browser, logs, URL or responses. Trial access code is entered by the user in the preview and sent only as a same-origin request header, held in memory while the page is open, never stored in localStorage.
- Fixed upstream URL and five allowlisted ADVERTISED model IDs; identity not verified.
- Max prompt 600 chars, max output 160 tokens, 30-second timeout; no tools, streaming, attachments or persistence.
- Cooldown 10 seconds per allowed user per warm instance. This is NOT a distributed quota.
- Feature flag and expiry disable new requests; upstream exhaustion disables that warm instance.
- Serverless instances are independent: exhaustion detection is NOT global or durable. The upstream must enforce actual remaining credits. The hard expiry bounds the experiment.
- Provider usage is not reliable evidence of weighted token deductions; check provider dashboard.

## Complete removal when trial ends

1. Disable or delete AIRA_STAR_TRIAL_ENABLED in the branch-scoped Preview environment.
2. Delete all five branch-specific AIRA_STAR_TRIAL_* Vercel environment variables.
3. Delete apps/api/src/temporary-ai-staring-trial.ts.
4. Delete public/ai-staring-trial.html.
5. Delete test/ai-staring-trial.test.ts and this document.
6. Revert the trial import and route registration in apps/api/src/index.ts, and the trial sign-in deep link in src/App.tsx.
7. Close the experiment PR unmerged, delete experiment Git branch, remove its Vercel Preview deployment where supported.
8. Verify the test page and trial route are unavailable and normal chat still works. Ensure the temporary sign-in query parameter behavior is reverted from src/App.tsx.
9. Revoke the trial API key in the provider dashboard.

No DB migrations or test conversation records are introduced by this module. Deleting the isolated branch and its environment variables removes all AIRA-side functionality. Provider-side billing/usage records remain outside AIRA control.
