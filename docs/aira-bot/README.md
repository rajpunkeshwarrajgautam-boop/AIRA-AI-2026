# Aira Bot

Aira Bot replaces the user-facing Agents shell with a dedicated bot workspace at `/bots`, `/bots/:botId`, and `/bots/:botId/runs/:runId`.

## Delivered behavior

- Create, configure, list and delete owned bots. Bots with task history cannot be deleted.
- Store instructions, model choice, enabled tools, approval policy, explicit memory and reusable instruction-based skills in PostgreSQL.
- Create separate durable task and run identities. Configuration is snapshotted for each run; editing a bot does not rewrite in-flight work.
- Execute a bounded model-driven loop. The model chooses validated arguments for the bot's enabled tools rather than a keyword/example selector.
- Pause before every tool under `always_ask`; under `risky_only`, only READ tools run without a human decision. File writes and terminal programs therefore pause for approval.
- Resume approved runs, cancel active runs, replay durable events, and download Markdown results. Background work continues when the browser leaves the page while the API worker is alive.
- Reject missing model providers, invalid model output, tool failures and unavailable capabilities explicitly. Bot runs never use the deterministic mock adapter.
- Authenticate with verified Firebase ID tokens, using the existing Firebase project. The local test identity is explicit, localhost-only in the browser, and rejected by the API in production.

## Computer runtime

Aira Bot now includes a bounded persistent computer runtime that is separate from ordinary Chat.

Each authenticated user/bot pair receives a deterministic private workspace directory under `AIRA_COMPUTER_ROOT`. User and bot identifiers are hashed before becoming filesystem paths. Workspace file APIs reject absolute paths, traversal and symlink following. Text reads and writes are capped at 256 KiB and directory listings are bounded.

Available computer tools:

| Tool | Permission | Behavior |
|---|---|---|
| `browser_open` | READ | Persistent Playwright Chromium profile; public HTTP(S) navigation only; visible text, title, links and a viewport screenshot are returned/stored. |
| `file_read` | READ | Reads UTF-8 files inside the bot workspace only. |
| `file_write` | WRITE | Writes UTF-8 files inside the bot workspace; requires approval under `risky_only`. |
| `terminal_exec` | DESTRUCTIVE | Uses `execFile` directly with an explicit program allowlist; no shell interpolation, pipelines or redirection. Always requires approval under `risky_only`. |

The browser rejects credentials in URLs, localhost, loopback, private, link-local and reserved network destinations. Each HTTP(S) request made by the browser is checked before it is allowed to leave the browser context. The runtime keeps the browser profile on the persistent workspace disk so cookies/site state can survive browser restarts on the same host.

The Computer tab lets the owner start/stop the browser, navigate public pages, inspect/edit workspace files and run allowlisted terminal programs directly. Direct write/terminal API operations require an explicit confirmation bit in addition to normal bot ownership authentication.

### Computer runtime deployment

Development and test default to computer-enabled unless `AIRA_COMPUTER_ENABLED=false`. Production defaults to disabled and requires explicit `AIRA_COMPUTER_ENABLED=true`.

The browser runtime requires the Playwright package and a compatible Chromium installation. A deployment image should run:

```bash
npm ci
npx playwright install --with-deps chromium
```

Configure a persistent disk location:

```bash
AIRA_COMPUTER_ENABLED=true
AIRA_COMPUTER_ROOT=/persistent/aira-computers
```

Terminal execution is a separate production switch:

```bash
AIRA_COMPUTER_TERMINAL_ENABLED=true
AIRA_COMPUTER_PROGRAMS=node,npm,npx,python,python3,git
```

`terminal_exec` is a bounded local runner, **not a VM/container security boundary**. It does not expose a command shell, but an allowed executable can still exercise whatever operating-system access the API service account possesses. A public multi-tenant launch therefore still requires a real per-user container/microVM provider before arbitrary code execution should be enabled.

## Local setup

Use Node 24.11 or newer. Install with `npm ci`.

Create `.env` from `.env.example`. For local testing set `NODE_ENV=development`, `VITE_AIRA_DEV_IDENTITY=true`, a PostgreSQL `DATABASE_URL`, and either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Configure `BRAVE_SEARCH_API_KEY` to enable web search. Keep provider keys on the API server.

Run `npm run db:up` if you use the repository's Docker database, then `npm run db:migrate`. Install Chromium with `npx playwright install chromium`, then start `npm run server` and `npm run dev` in separate terminals. Open `http://localhost:5173/bots`.

For shared authentication, set the existing `VITE_FIREBASE_*` values and the same `FIREBASE_PROJECT_ID` on the API. Enable Google sign-in in that Firebase project and authorize the deployment domain. The browser sends its current user's ID token; the API verifies the signature, audience, issuer, expiry and subject. API user identity does not come from request bodies. This Firebase rollout authenticates the owned Bot API only; legacy shared endpoints retain their existing host authentication boundary. Live Firebase verification is not certified without real project configuration.

## Hosting

The Vite build is static. Deploy the long-lived Node API separately with PostgreSQL, server-side provider configuration, persistent computer storage, and Chromium when computer mode is enabled. The existing Vite proxy is local-only. The production host must proxy `/api/*` to that API on the same origin, including the Authorization header. `/bots/*` has a SPA rewrite in `vercel.json`.

A static frontend deployment alone does not deploy the API worker, database or computer runtime. Do not run database migrations against an unreviewed production database. This branch does not deploy infrastructure or modify the live application.

## Boundaries and remaining work

This is an executable computer-service slice, not the complete cloud-computer platform.

| Capability | Current status |
|---|---|
| Persistent owned bots, explicit memory, instruction-based skills | Implemented |
| Task/run persistence, model-driven tools, human approval, activity/results | Implemented |
| Persistent per-bot workspace files | Implemented on the runtime host |
| Browser | Implemented with persistent headless Playwright Chromium and public-network restrictions |
| Terminal | Implemented as approval-gated direct `execFile` allowlisted programs; no shell |
| Strong VM/container isolation | Not implemented; required before untrusted multi-tenant arbitrary code execution |
| General connector catalog/OAuth/MCP tools for bots | Not implemented; no shared unowned connector state is exposed |
| Bot routines and schedules | Not implemented; existing Automations surface remains separate |
| Multi-bot delegation and shared computer scheduling | Not implemented |
| Push notifications, desktop/mobile clients | Not implemented; responsive web UI is available |
| Autonomous learned memory | Not implemented; memory is explicitly configured by the user |
| Multi-worker execution leases and queue | Not implemented; deploy one API worker for this slice |

The loop checkpoints reuse the existing run recovery mechanism. Waiting approvals remain paused across a worker restart. Non-idempotent interrupted tools fail closed in the existing recovery path. Provider requests may be repeated after a crash before checkpoint persistence; model invocations can incur duplicate cost. Browser process state is in-memory while its profile/files are persistent. A production queue, distributed run lease, browser-session ownership lease, cancellation fencing and transactional outbox remain required before horizontal scaling.

## Verification

```bash
npm run build
npm run typecheck:api
npm run lint
npx playwright install chromium
npm run test:bot:computer
npm run test:bot
npm run test:bot:browser
```

`test:bot:computer` verifies the real filesystem boundary, traversal/symlink rejection, terminal program allowlist, localhost/private-network browser rejection and an actual Chromium start/stop cycle. Bot tests run migrations and repositories against isolated PGlite PostgreSQL through its wire protocol. Browser tests exercise the actual local API and Vite app rather than mocked browser responses.

Live model-provider compatibility, Firebase sign-in, real Brave web search and a production container/microVM computer provider remain deployment certifications rather than claims of this repository-only slice.
