# Aira Bot Isolated Computer — Phase 3

Phase 3 introduces a provider boundary above the existing bounded local computer runtime.

## Provider model

`AIRA_COMPUTER_PROVIDER=local` keeps the Phase 2 host-process runner for development and controlled single-user environments.

`AIRA_COMPUTER_PROVIDER=docker` provisions one persistent Docker computer per authenticated AIRA user. All of that user's Aira Bots share the same browser profile and computer lifecycle, while each Bot receives a separate workspace directory inside the persistent `/data` volume.

This mirrors the product requirement that a user owns a durable computer while Bots retain independent identities and task histories.

## Docker isolation contract

The Docker provider creates containers with:

- non-root runner user
- read-only container root filesystem
- `--cap-drop ALL`
- `no-new-privileges`
- CPU, RAM, and PID limits
- ephemeral bounded tmpfs mounts
- a named persistent volume mounted at `/data`
- runner control port published only to `127.0.0.1` on a dynamic host port
- per-user HMAC bearer authentication between the AIRA API and runner
- no model/provider/API secrets forwarded to the runner container

Build the runner image on the API/runtime host:

```bash
docker build -t aira-computer:local docker/aira-computer
```

Then configure:

```bash
AIRA_COMPUTER_PROVIDER=docker
AIRA_COMPUTER_DOCKER_IMAGE=aira-computer:local
AIRA_COMPUTER_RUNNER_SECRET=<long-random-server-secret>
AIRA_COMPUTER_TERMINAL_ENABLED=true
AIRA_COMPUTER_PROGRAMS=node,npm,npx,python3,git
```

Docker must be available to the long-lived API/runtime host. A static Vercel frontend alone cannot host this provider.

## Persistent state

The named per-user Docker volume contains:

```text
/data/
  profile/              # shared persistent Chromium profile for this AIRA user
  bots/
    <hashed-bot-key>/   # private workspace for one Aira Bot
      screenshots/
      ...generated files
```

Raw user IDs and Bot IDs are not used as filesystem or Docker resource names.

## Browser control

The Docker runner supports:

- public HTTP(S) navigation
- click by CSS selector
- text entry by CSS selector
- optional Enter submission
- vertical scrolling
- wait-for-visible selector
- viewport screenshots

Browser requests reject localhost, loopback, private, link-local, documentation/reserved, and other non-public destinations. Subrequests are checked as well as top-level navigation.

Interactive browser actions are `WRITE` permission tools. Under the normal `risky_only` Aira Bot policy they therefore require an approval before autonomous execution.

The system prompt explicitly reserves passwords, payment secrets, OTP/2FA codes, and CAPTCHA completion for human control.

## Computer leases

The lease manager fences the shared per-user computer:

- only one Bot run can hold the computer at a time
- another Bot receives `COMPUTER_BUSY`
- human takeover preempts a Bot lease only at a safe checkpoint
- takeover is rejected while a computer action is actively executing
- while human control is active Bot computer actions receive `COMPUTER_TAKEN_OVER`
- returning control releases the human lease and resumes Bot runs from their persisted checkpoint
- leases expire so abandoned sessions cannot hold a computer forever

The current lease/event manager is process-local. Horizontal API scaling still requires a distributed lease store (PostgreSQL/Redis) and transactional fencing before more than one worker may execute computer tasks for the same user.

## Human takeover API

Owned Bot computer routes include:

```text
POST /api/aira-bot/bots/:id/computer/takeover
POST /api/aira-bot/bots/:id/computer/release
GET  /api/aira-bot/bots/:id/computer/events
GET  /api/aira-bot/bots/:id/computer/events/stream
```

Takeover returns a short-lived lease token. Manual browser interaction, terminal execution, file writes, stop, and suspend operations require that token in `x-aira-computer-lease`.

Read-only status, event inspection, file listing, and file reading remain available inside the authenticated Bot ownership boundary without taking control.

## Realtime state

Computer actions emit bounded in-memory events for browser navigation/actions, files, terminal execution, lifecycle changes, takeover/release, and lease contention. The API exposes replay-by-cursor and SSE streaming.

These events are not yet durable. A production multi-worker architecture should persist them through the same transactional outbox/event system used for durable run state.

## Security boundary

Docker materially isolates browser and terminal processes from the AIRA API host, but this implementation does **not** claim the security equivalence of Firecracker or another microVM boundary.

Before enabling arbitrary untrusted multi-tenant workloads, the next isolation tier should add a microVM/managed sandbox provider, stronger egress enforcement outside the browser process, disposable execution snapshots, resource accounting, and distributed leases.

## Certification

Repository CI runs:

```bash
npm run build
npm run typecheck:api
npm run lint
node --check docker/aira-computer/runner.mjs
npm run test:bot:isolation
npx playwright install --with-deps chromium
npm run test:bot:computer
npm run test:bot:browser
```

`test:bot:isolation` certifies lease fencing and the Docker creation contract without requiring Docker-in-Docker. Building and running the actual Docker image remains a deployment-host certification gate.
