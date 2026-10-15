# AIRA Runtime V2 — Dedicated Worker Certification Runbook (15 October 2026)

**Status:** Phase 4 PR #72 is a review branch only. No production or public
worker deployment is certified. Protected `prod-release` remains unchanged.

## What has to be certified before go-live

This branch implements a real DB-leased specialist worker and a real
Docker/Chromium isolation test. They remain distinct:

1. **Repository CI:** real PostgreSQL concurrent claims, a separately killed
   worker OS process, expired lease takeover, monotonic fencing, and browser
   state recovery in a Docker container with `--network none`, dropped Linux
   capabilities, read-only root filesystem and a non-root browser user.
2. **Staging hosted service:** still requires an authorized isolated worker
   host, private network to staging Neon, bound compute/memory, supervisor,
   observability, secure secrets, encrypted persistent profile volumes and
   verified principal integration from PR #65.
3. **External browser action security:** an isolated, trusted outbound
   proxy/firewall must prevent private/metadata traffic and DNS rebinding
   across all navigations and redirects. The current no-network Docker
   certification cannot prove general website browsing works.
4. **Real end-to-end mission:** an authorized account, genuine provider model,
   actual child agent run, independent resulting artifact and recovery evidence
   are required before an unrestricted autonomous claim.

## Operator prerequisites (do NOT paste secrets into ChatGPT or CI logs)

- Authorized Linux Docker host (staging, not the Vercel function runtime).
- Worker OS account without root or Docker-host-socket access.
- TCP access to an isolated staging PostgreSQL database, preferably only on
  a private network; least-privilege database credential.
- Real model-provider key in a protected server-side secret manager.
- Stable 32+ character `AIRA_AGENT_PLAN_SIGNING_KEY`.
- `AIRA_SPECIALIST_WORKER_PROCESS=true`
- `AIRA_SPECIALIST_WORKER_ENABLED=true`
- `AIRA_SPECIALIST_DELEGATION_ENABLED=true`
- `AIRA_MODEL_MISSIONS_ENABLED=true` only after live staging acceptance.
- Migrations including `017_v2_browser_delegation.ts` applied to **staging
  only**, after verifying migration history.
- Verified user-principal integration (PR #65); the current production API
  feature gate returns HTTP 503 until this is certified.

Launch the specialist worker through `npm run specialist-worker:start`
under a process supervisor (e.g., a dedicated container or systemd service).
The worker must be restarted on fatal lease loss. Do not turn the worker on in
production before exact-SHA release authorization.

## What the user can check on Windows

Run read-only PowerShell checks in Antigravity / Windows Terminal:

```powershell
wsl --status
wsl --list --verbose
docker version
docker info --format 'OSType={{.OSType}}; ServerVersion={{.ServerVersion}}'
```

If Docker is not installed or the daemon is unavailable, do not assume it is
already usable. The user must install Docker Desktop, select the WSL 2 Linux
engine (on a compatible Windows version), or choose a dedicated remote Linux
host. Local Docker is useful for development but only available while the PC
is running; it is not evidence of an always-on hosted service.

## Safety / operational recovery

- A freshly created specialist child stays QUEUED in PostgreSQL. API calls do
  not execute children by `setImmediate`.
- Only one dedicated dispatcher may claim a child at once; a reclaimed expired
  lease gets a higher fencing token. WAITING approvals never automatically
  replay; user approval enqueues via `wakeApprovedChild`.
- A worker maintains its lease with an independent heartbeat; loss triggers a
  fatal worker shutdown in the actual specialist-worker entry point.
- Generic API startup recovery skips delegated children. Stale workers are
  prevented from selecting new tools and persisting tool results after losing
  authority.
- Existing runtime crash classifier blocks non-idempotent replay; only
  authorized read-only checkpoint continuation is allowed.
- `COMPLETED` child state alone is **not** `COMPLETED_VERIFIED`.
  Final objective verification needs independent evidence.
- Do not assume the current run repository's generic updates are all protected
  by a database execution-fence predicate; this must be audited and certified
  before consequential delegated writes are enabled.
- Reconcile actual external state before retrying an ambiguous mutation.
- Human approval and browser profile takeover are separate controls; the
  production worker must enforce human takeover at browser action time.

## Release decision

**NOT READY — BLOCKED** until the authorized live staging worker, PR #65
verified principal, network and profile isolation, end-to-end real missions,
and complete live security/recovery acceptance are documented and reviewed.

No service purchase, production migration or go-live approval is requested
just to run the repository CI tests.
