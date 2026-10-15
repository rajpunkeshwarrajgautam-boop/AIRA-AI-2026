# Aira website/file builder — owner-only beta

This is a code integration, **not a production deployment**. It extends the existing React/Vite + Express application. It does not replace Aira's chat, research, approval or saved-agent runtime.

## What is included

- Agents → Builder, with the existing agent registry under **Saved agents**.
- An actual model → validated action → remote tool-result loop (up to 12 actions).
- E2B isolated VM creation, remote file operations, remote commands and port-3000 previews.
- Explicit execution consent; separate internet and **public-preview** consent.
- File/ZIP downloads with owner/session-bound signed tickets and SHA-256 publication checks.
- Streaming tool receipts, errors, stop controls, follow-up editing within the same live workspace.
- Disabled/unconfigured states; no mock execution in the real builder service.

## Important first-release limits

This beta is **not the full Arena platform**. It does not include image/video/voice generation, arbitrary connected apps, permanent artifact storage, a durable job queue, resumable runs after process death, or multi-user production quotas. It uses bounded streaming HTTP requests; keep it owner-allowlisted. A stopped/failed/disconnected run attempts to kill its VM; the provider deadline remains the cleanup fallback if a worker dies or creation is interrupted. A successful VM lasts up to **15 minutes from creation**, not from the last message. Follow-ups do not renew the deadline. Leaving the Agents workspace triggers a best-effort cleanup; the provider TTL is the fallback. Refreshing loses this view's in-memory workspace state. Download before leaving.

Buffered downloads are limited to **3 MiB per file** to leave room under typical serverless response limits. Larger artifacts need private object storage and signed object-download URLs, which are not included. A public preview exposes the generated server to anyone who knows its URL. Do not put private data in previewed files.

## 1. Apply locally or to a staging branch

Base inspected: `863d279` on `prod-release` (the package manifest records the full SHA).

Do not copy `node_modules`, `.git` or `.env` from another project. The supplied ZIP contains source only. To apply the patch to a clean checkout of the same base in PowerShell:

```powershell
git switch -c feat/isolated-builder-agent
git apply --check ..\aira-builder-integration.patch
git apply ..\aira-builder-integration.patch
npm ci
npm run test:builder
npm run typecheck:builder
npm run build
```

If `git apply --check` fails, stop and merge the changes against your current code in an editor; do not overwrite newer work. Use Node **24** as in the repository's CI (the installed E2B package's CLI dependency requires Node 22.12+).

## 2. Review the UI without any keys or database

In terminal one:

```powershell
npx tsx scripts/preview-builder.ts
```

In terminal two:

```powershell
npm run dev
```

Open the Vite URL → **Agents**. This special review API is deliberately disabled: it can show configuration status but cannot create paid resources or execute code. Do **not** deploy this review server. Real deployment still uses the existing `api/index.ts` → `apps/api/src/index.ts` API and its normal startup/database gates.

## 3. Configure a sandbox privately, in staging first

1. Create an E2B account at https://e2b.dev and create a server API key. Set account spending/usage limits before enabling runs.
2. In your staging deployment's server environment settings, add the following. **Never paste keys into chat, commit them, or prefix them with `VITE_`.**

| Environment variable | Value |
| --- | --- |
| `E2B_API_KEY` | Your private E2B API key |
| `AIRA_BUILDER_ENABLED` | `false` initially |
| `AIRA_BUILDER_SIGNING_SECRET` | A private, random secret of at least 32 characters |
| `AIRA_BUILDER_ALLOWED_USER_IDS` | Leave empty until you copy your staging Aira user ID |
| `AIRA_BUILDER_RUN_TIMEOUT_MS` | `120000` by default; must be **shorter than your function's actual configured duration**, with cleanup headroom |

Keep your existing server-side model key(s): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and/or `NVIDIA_API_KEY`. No additional model account is required if an existing supported provider is configured. E2B and model usage are separate costs. Never enable `AIRA_ALLOW_SHELL` on the web server for this feature.

Generate the signing secret locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The signing secret can fall back to the existing `AIRA_SESSION_SECRET`, but a separate builder secret is recommended. Keep it stable while workspaces are alive.

3. Deploy the code to a **staging/preview** environment using your existing release process, leaving the feature disabled. No new database migration is required by this integration. Your existing database startup and deployment checks still apply.
4. Open staging in your own browser → Agents. Copy the **Your user ID** value from the setup panel into `AIRA_BUILDER_ALLOWED_USER_IDS`. This is an Aira signed-session user ID, **not your GitHub username**. There is intentionally no wildcard/public enablement. A new browser, cleared cookies or a different staging hostname produces another ID.
5. Set `AIRA_BUILDER_ENABLED=true` in staging and redeploy that environment through your normal process. Refresh → Check setup again. The UI must report ready before you start.

Optional owner settings:

- `AIRA_BUILDER_TEMPLATE`: E2B template name/ID, default `base`. Verify it has Python 3; Node/npm are needed for framework builds.
- `AIRA_BUILDER_EGRESS_ALLOWLIST`: comma-separated outbound hosts, default `registry.npmjs.org,pypi.org,files.pythonhosted.org`. Internet consent does not open arbitrary destinations: the VM's egress remains restricted to these hosts. Add only required trusted package/CDN hosts. With internet consent off, outbound internet access is disabled.

SDK references: https://docs.e2b.dev/sdk-reference/js-sdk and https://e2b.dev/docs/quickstart/upload-download-files . The dependency is pinned to the SDK version recorded in `package.json` and the lockfile.

## 4. Perform the real staging acceptance test

Use this task with execution + public-preview consent on, internet off:

> Create a polished self-contained index.html for a fictional coffee shop. Use inline CSS and no external resources. Test the file in the sandbox, start a static preview, then publish index.html and a ZIP of the source. Report only verified results.

Check all of the following **against real E2B and real model credentials**:

- Tool receipts show successful file writes and test commands, not just generated prose.
- The preview opens through its HTTPS sandbox hostname, including on your phone.
- Downloaded HTML and ZIP contain the generated files.
- Follow up with “Change the accent to teal, test it and republish.” The files should update in the same live VM.
- A different browser/user cannot download using someone else's signed file ticket.
- Stop interrupts a run; VM termination can be checked in your E2B dashboard.
- The preview and download links expire. Failure/disconnect/close cleanup works.
- No app credentials appear in the VM environment or generated files.
- Long tasks abort before your hosting platform's timeout. The default run deadline is 120 seconds, capped at 240 seconds. If your plan cannot support this, lower it or move execution to a separate worker service before expanding usage.

A VM deadline is a cleanup backstop, **not a dollar-cost guarantee**. The token budget (40,000 reported total tokens per run) and action limit help bound usage, but provider billing, multiple processes and repeated runs can still incur charges. The in-process “one active run per user” guard is not a global distributed quota. Do not remove the owner allowlist without adding durable per-account quotas, concurrency admission, billing enforcement, persistent storage and background jobs.

## 5. Production is a separate decision

No code has been pushed, no PR has been merged, no production environment variables have been changed, and no live deployment is included. Follow this repository's existing PR/CI/staging/release-authorization protocol. A merge to `prod-release` can trigger production deployment. It requires fresh explicit **GO LIVE** authorization for the exact SHA and environment; do not infer it from these instructions or local test results.

## Local verification supplied

- `npm run test:builder`: service/API/security/parser tests with an injected **fake sandbox and fake model**, no paid calls.
- `npm run typecheck:builder`: checks the new backend module and router against the pinned SDK types.
- `npm run build`: frontend TypeScript and production bundle.
- `npm run test:model-routing`, `npm run test:session-auth`: existing regressions.
- `npm run test:builder:ui`: Playwright browser acceptance at desktop, tablet, narrow phone and short landscape. These tests **mock API/SSE receipts**, explicitly label their results as simulated, and do not validate E2B connectivity.

To run the browser checks, start the local UI review servers above, then:

```powershell
npx playwright install chromium
npm run test:builder:ui
```

Live E2B connectivity, real paid-model task quality, network-policy behavior at the provider, deployment function limits and production activation are **not verified** here because your private credentials were not provided. The source also has an existing Tailwind-related npm audit chain reporting five high-severity dependency findings; it should be remediated in a separate dependency review before broader release. No unrelated automatic `npm audit fix --force` was applied.
