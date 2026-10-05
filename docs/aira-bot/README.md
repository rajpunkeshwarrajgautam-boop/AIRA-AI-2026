# Aira Bot

Aira Bot replaces the user-facing Agents shell with a dedicated bot workspace at `/bots`, `/bots/:botId`, and `/bots/:botId/runs/:runId`.

## Delivered behavior

- Create, configure, list and delete owned bots. Bots with task history cannot be deleted.
- Store instructions, model choice, enabled tools, approval policy, explicit memory and reusable instruction-based skills in PostgreSQL.
- Create separate durable task and run identities. Configuration is snapshotted for each run; editing a bot does not rewrite in-flight work.
- Execute a bounded model-driven loop. The model chooses validated arguments for the bot's enabled tools rather than a keyword/example selector.
- Pause before every tool under `always_ask`; under `risky_only`, only READ tools run without a human decision. Browser interaction, file writes and terminal programs therefore pause for approval.
- Resume approved runs, cancel active runs, replay durable events, and download Markdown results. Background work continues when the browser leaves the page while the API worker is alive.
- Reject missing model providers, invalid model output, tool failures and unavailable capabilities explicitly. Bot runs never use the deterministic mock adapter.
- Authenticate with verified Firebase ID tokens, using the existing Firebase project. The local test identity is explicit, localhost-only in the browser, and rejected by the API in production.

## Computer runtime

Aira Bot has a provider-based persistent computer runtime separate from ordinary Chat.

Two providers exist:

- `local`: the Phase 2 bounded host-process Playwright/`execFile` runner for development and controlled deployments.
- `docker`: one persistent isolated Docker computer per authenticated AIRA user. Bots belonging to that user share the persistent Chromium profile/computer lifecycle while retaining separate Bot workspace directories.

See [`ISOLATED_COMPUTER.md`](./ISOLATED_COMPUTER.md) for the Phase 3 isolation, lease, takeover and deployment contract.

Available computer tools depend on the selected provider:

| Tool | Permission | Behavior |
|---|---|---|
| `browser_open` | READ | Opens public HTTP(S) destinations in the persistent browser. |
| `browser_click` | WRITE | Docker provider: clicks a CSS-selected element; approval-gated under `risky_only`. |
| `browser_type` | WRITE | Docker provider: fills a CSS-selected field and can optionally submit; approval-gated. |
| `browser_scroll` | READ | Docker provider: bounded viewport scrolling. |
| `browser_wait` | READ | Docker provider: waits for a CSS-selected element. |
| `file_read` | READ | Reads UTF-8 files inside the Bot workspace. |
| `file_write` | WRITE | Writes UTF-8 files inside the Bot workspace; approval-gated. |
| `terminal_exec` | DESTRUCTIVE | Direct allowlisted program execution without a command shell; approval-gated. |

Browser navigation rejects credentials in URLs, localhost, loopback, private, link-local and reserved network destinations. Bot workspace paths reject traversal and symlinks. Text reads/writes are bounded.

### Human takeover

A per-user computer lease fences control of the shared persistent computer. Only one Bot run owns the computer at a time. A user can **Take control** at a safe checkpoint; Aira Bot is paused and manual mutations require the returned takeover token. **Return control** releases the human lease and resumes paused Bot runs from the persisted checkpoint.

Takeover is refused while a computer tool is actively executing, preventing non-idempotent terminal/browser actions from being interrupted and accidentally replayed.

Passwords, payment secrets, OTP/2FA codes, CAPTCHA completion and payment confirmation remain human-controlled by policy.

### Docker computer deployment

Build the isolated runner on the long-lived API/runtime host:

```bash
docker build -t aira-computer:local docker/aira-computer
```

Configure:

```bash
AIRA_COMPUTER_PROVIDER=docker
AIRA_COMPUTER_DOCKER_IMAGE=aira-computer:local
AIRA_COMPUTER_RUNNER_SECRET=<long-random-server-secret>
AIRA_COMPUTER_TERMINAL_ENABLED=true
AIRA_COMPUTER_PROGRAMS=node,npm,npx,python3,git
```

The Docker provider runs as a non-root user with a read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, CPU/RAM/PID limits, bounded tmpfs mounts, a persistent named `/data` volume, and a loopback-only authenticated runner control port.

This is a materially stronger isolation boundary than the local runner, but it is **not claimed to be equivalent to a Firecracker or other microVM boundary**. Public arbitrary untrusted multi-tenant execution still benefits from a future managed sandbox/microVM provider and network-policy enforcement outside the browser process.

## Local setup

Use Node 24.11 or newer. Install with `npm ci`.

Create `.env` from `.env.example`. For local testing set `NODE_ENV=development`, `VITE_AIRA_DEV_IDENTITY=true`, a PostgreSQL `DATABASE_URL`, and either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Configure `BRAVE_SEARCH_API_KEY` to enable web search. Keep provider keys on the API server.

Run `npm run db:up` if you use the repository's Docker database, then `npm run db:migrate`. Install Chromium with `npx playwright install chromium`, then start `npm run server` and `npm run dev` in separate terminals. Open `http://localhost:5173/bots`.

For shared authentication, set the existing `VITE_FIREBASE_*` values and the same `FIREBASE_PROJECT_ID` on the API. Enable Google sign-in in that Firebase project and authorize the deployment domain. The browser sends its current user's ID token; the API verifies the signature, audience, issuer, expiry and subject. API user identity does not come from request bodies. This Firebase rollout authenticates the owned Bot API only; legacy shared endpoints retain their existing host authentication boundary. Live Firebase verification is not certified without real project configuration.

## Hosting

The Vite build is static. Deploy the long-lived Node API separately with PostgreSQL and the selected computer provider. Docker mode requires Docker access on that runtime host and cannot run inside the static Vercel frontend deployment. The production host must proxy `/api/*` to the API on the same origin, including Authorization and Aira computer lease headers. `/bots/*` has a SPA rewrite in `vercel.json`.

A static frontend deployment alone does not deploy the API worker, database, Docker computer containers or persistent volumes. This branch does not deploy infrastructure or modify the live application.

## Boundaries and remaining work

| Capability | Current status |
|---|---|
| Persistent owned bots, memory, instruction-based skills | Implemented |
| Task/run persistence, model-driven tools, approvals, activity/results | Implemented |
| Local bounded computer provider | Implemented and regression-certified |
| Docker isolated persistent computer provider | Implemented; repository contract certified, live deployment-host Docker smoke remains required |
| Persistent shared user browser profile + separate Bot workspaces | Implemented in Docker provider |
| Interactive browser click/type/scroll/wait | Implemented in Docker provider |
| Human takeover / return control | Implemented with safe checkpoint fencing |
| Per-user computer lease | Implemented in-process |
| Live computer events | Implemented in-process with cursor replay and SSE |
| Distributed computer lease/event store | Not implemented; required before horizontal API-worker scaling |
| MicroVM/managed sandbox provider | Not implemented |
| General connector catalog/OAuth/MCP tools for bots | Not implemented |
| Bot routines and schedules | Not implemented; Automations remains separate |
| Multi-bot delegation | Not implemented |
| Push notifications, desktop/mobile clients | Not implemented; responsive web UI is available |

The loop checkpoints reuse the existing run recovery mechanism. Waiting approvals and human takeover are suspended states. Non-idempotent interrupted tools fail closed in recovery. A production horizontally scaled runtime still requires a distributed queue, durable computer leases, cancellation fencing, durable computer events and a transactional outbox.

## Verification

```bash
npm run build
npm run typecheck:api
npm run lint
node --check docker/aira-computer/runner.mjs
npm run test:bot:isolation
npx playwright install --with-deps chromium
npm run test:bot:computer
npm run test:bot
npm run test:bot:browser
```

`test:bot:isolation` certifies lease fencing, takeover blocking and Docker creation hardening without requiring Docker-in-Docker. `test:bot:computer` continues to verify the real local filesystem boundary, traversal/symlink rejection, terminal allowlisting, private-network browser rejection and Chromium lifecycle. Browser tests exercise the real local API and Vite UI.

Live model providers, Firebase sign-in, Brave web search and actual deployment-host Docker image execution remain deployment certifications rather than repository-only claims.
