# AIRA AI 2026 — Cloudflare Free Cron Dispatcher (STAGING ONLY)

This directory contains a deployment-ready, **disabled-by-default** Cloudflare
Worker. It is designed to trigger the AIRA Automation Engine every minute
without enabling Vercel Hobby Cron. This repository addition alone does **not**
change the existing Worker on the user's Cloudflare account.

## Existing resources and safety

- Existing Cloudflare Worker name: `aira-ai-scheduler`
- Cron expression: `* * * * *` (Cloudflare schedules in UTC)
- Source: `src/worker.mjs`
- Configuration: `wrangler.toml`
- Destination must be an exact-commit AIRA **Preview** URL at
  `/api/automations/cron/execute`. The hostname guard rejects the production
  alias, custom domains, unrelated hosts, and other paths.
- `DISPATCH_ENABLED = "false"` prevents network dispatch, even if the Cron
  Trigger is installed and ticking.
- Incoming HTTP requests to the Worker return 404 and cannot run automations.
- No secrets are embedded in code or logged.

## Current staging assessment (2026-10-14)

- PR #60 (`fix/automation-reminder-truth-20261014`) adds a durable in-app
  notification inbox. The latest PR CI **fails**, despite a READY Preview.
- PR #61 (`fix/automation-intent-timezone-idempotency-20261014`) corrects
  reminder parsing/claiming and currently has **passing PR CI**, but has no
  in-app notification delivery.
- These separate previews are **not equivalent** to a combined certified
  scheduler-and-notification release. Do not connect this Worker to either yet.
- The staging `staging` branch also has a READY Preview, but it has not been
  shown to contain the combined automation fixes and inbox.
- Cloudflare dashboard browser control is unavailable to the current ChatGPT
  session. It cannot read or mutate Cloudflare settings.
- Vercel `CRON_SECRET` and staging `DATABASE_URL` are present as
  branch-scoped secrets for PR #60. Never copy their values into GitHub.

## Testing

Run from repository root:

```bash
node --test test/cloudflare-scheduler.test.mjs
```

This suite verifies only the Worker contract using local controlled
responses. It does not certify a real Cloudflare trigger, real Neon inserts,
or notification delivery.

## Safe deployment sequence (requires Cloudflare account access)

1. Resolve PR #60 failures and integrate compatible fixes from #61 using a
   reviewable PR against a nonproduction release integration branch.
2. Run full GitHub CI and security isolation tests on the **combined SHA**.
3. Apply applicable migrations to disposable or isolated staging Neon.
4. Deploy the combined SHA to a branch-scoped Vercel Preview; verify that
   it has an appropriate staging `DATABASE_URL`, `CRON_SECRET`, and
   `AIRA_SCHEDULER_ACTIVE=true`. No production variables may be copied.
5. Test `GET /api/automations/cron/execute` from an unauthenticated client;
   it must return HTTP 401.
6. Make a fresh random 32+-character staging-only scheduler secret through
   a secure admin workflow. Store the **same** secret in the Vercel Preview
   environment and the Cloudflare Worker's encrypted variable named
   `CRON_SECRET`. Never print or commit the value. Redeploy the Preview
   after updating environment variables.
7. Set the Worker's encrypted `AIRA_STAGING_SCHEDULER_URL` binding to the
   *exact* verified Preview HTTPS endpoint, not `aira-ai-2026.vercel.app`.
8. Deploy with Wrangler or the existing Cloudflare dashboard:
   ```bash
   npx wrangler deploy --config infra/cloudflare/aira-ai-scheduler/wrangler.toml
   ```
   Confirm `DISPATCH_ENABLED=false`, trigger `* * * * *` installed.
   If using the Cloudflare dashboard editor instead of Wrangler, install
   identical code and configure the scheduled trigger manually.
9. Read Cloudflare Worker logs: `aira_scheduler_skipped` confirms the
   trigger is live but outbound requests are disabled.
10. Only after staging authentication and exact-commit readiness are proven,
    change the Worker variable `DISPATCH_ENABLED` to `true` in the dashboard
    (do not commit that value to `wrangler.toml`); then validate a real due
    run and a principal-scoped in-app notification.
11. Record timestamped logs from Cloudflare, exact response receipts from
    AIRA, persisted `automation_runs` and `automation_notifications` in
    staging Neon, and the same reminder visible in the rightful user's inbox.
    Test duplicate Cron invocations, bad credentials, 503 errors, and
    cross-principal access denial.
12. Disable dispatch again if any acceptance check fails. Keep production
    untouched. Merge/promotion to `prod-release` requires separate GO LIVE.

## Operational limitations

- Cron is a best-effort clock: scheduled Worker execution, AIRA HTTP processing,
  database updates, and notification creation are separate components.
- This Worker intentionally performs **one outbound attempt per tick**. Failed
  ticks are logged and thrown, with no automatic immediate retry to avoid
  unintended duplicate executions. AIRA's DB claims must enforce idempotency.
- AIRA must define missed-slot recovery if the external clock is unavailable.
- Cloudflare Cron and a durable in-app notification inbox do not deliver
  OS push, email, SMS, or notifications while the user is fully offline;
  those channels require additional verified delivery infrastructure.
- Every-minute operation uses around 1,440 Worker triggers/day and matching
  Vercel invocations/day. Verify current usage, limits, and expenses.
- Updating the Worker through Wrangler may replace dashboard-edited source;
  export/review any intervening user changes before deploying.
- Do not place scheduler credentials in query strings, URLs, issue comments,
  screenshots, logs, commits, or unsecured environment variables.
