# Aira Bot

Aira Bot replaces the user-facing Agents shell with a dedicated bot workspace at `/bots`, `/bots/:botId`, and `/bots/:botId/runs/:runId`.

## Delivered behavior

- Create, configure, list and delete owned bots. Bots with task history cannot be deleted.
- Store instructions, model choice, enabled tools, approval policy, explicit memory and reusable instruction-based skills in PostgreSQL.
- Create separate durable task and run identities. Configuration is snapshotted for each run; editing a bot does not rewrite in-flight work.
- Execute a bounded model-driven loop. The model chooses validated arguments for the enabled calculator and web search tools. Bot runs bypass the legacy example/keyword tool selector.
- Pause before every tool under `always_ask`; otherwise allow only enabled read tools. Approve once or reject. No persistent permissions are granted by this surface.
- Resume approved runs, cancel active runs, replay durable events, and download Markdown results. Background work continues when the browser leaves the page, while the API worker is alive.
- Reject missing model providers, invalid model output, tool failures and unavailable capabilities explicitly. Bot runs never use the deterministic mock adapter.
- Authenticate with verified Firebase ID tokens, using the existing Firebase project. The local test identity is explicit, localhost-only in the browser, and rejected by the API in production.

## Local setup

Use Node 24.11 or newer. Install with `npm ci`.

Create `.env` from `.env.example`. For local testing set `NODE_ENV=development`, `VITE_AIRA_DEV_IDENTITY=true`, a PostgreSQL `DATABASE_URL`, and either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Configure `BRAVE_SEARCH_API_KEY` to enable web search. Keep provider keys on the API server.

Run `npm run db:up` if you use the repository's Docker database, then `npm run db:migrate`. Start `npm run server` and `npm run dev` in separate terminals. Open `http://localhost:5173/bots`.

For shared authentication, set the existing `VITE_FIREBASE_*` values and the same `FIREBASE_PROJECT_ID` on the API. Enable Google sign-in in that Firebase project and authorize the deployment domain. The browser sends its current user's ID token; the API verifies the signature, audience, issuer, expiry and subject. API user identity does not come from request bodies. This Firebase rollout authenticates the owned Bot API only; legacy shared endpoints retain their existing host authentication boundary. Live Firebase verification is not certified without real project configuration.

## Hosting

The Vite build is static. Deploy the long-lived Node API separately with PostgreSQL and server-side provider configuration. The existing Vite proxy is local-only. The production host must proxy `/api/*` to that API on the same origin, including the Authorization header. `/bots/*` has a SPA rewrite in `vercel.json`.

A static frontend deployment alone does not deploy the API worker or database. Do not run database migrations against an unreviewed production database. This branch does not deploy infrastructure or modify the live application.

## Boundaries and remaining work

This is the first executable service slice, not the complete originally proposed computer-agent platform.

| Capability | Current status |
|---|---|
| Persistent owned bots, explicit memory, instruction-based skills | Implemented |
| Task/run persistence, model-driven read tools, human approval, activity/results | Implemented |
| Model integrations | Existing OpenAI and Anthropic adapters; live credentials require deployment validation |
| Browser/terminal/cloud filesystem | Not implemented; computer tab reports disconnected |
| General connector catalog/OAuth/MCP tools for bots | Not implemented; no shared unowned connector state is exposed |
| Bot routines and schedules | Not implemented; existing Automations surface remains separate |
| Multi-bot delegation, shared computer scheduling | Not implemented |
| Push notifications, desktop/mobile clients | Not implemented; responsive web UI is available |
| Autonomous learned memory | Not implemented; memory is explicitly configured by the user |
| Multi-worker execution leases and queue | Not implemented; deploy one API worker for this slice |

The loop checkpoints reuse the existing run recovery mechanism. Waiting approvals remain paused across a worker restart. Non-idempotent interrupted tools fail closed in the existing recovery path. Provider requests may be repeated after a crash before checkpoint persistence; model invocations can incur duplicate cost. A production queue, distributed run lease, cancellation fencing and transactional outbox remain required before horizontal scaling.

## Verification

`npm run build`, `npm run typecheck:api`, `npm run lint`, `npm run test:bot`, and `npm run test:bot:browser`.

Bot tests run migrations and repositories against isolated PGlite PostgreSQL through its wire protocol. Tests use a controlled model fixture and the real calculator. No production credentials, paid model calls or external actions are required. The browser suite exercises the actual local API and Vite app, not mocked browser responses. For normal Playwright setup run `npx playwright install chromium` first.

Local verification covers 18 backend gates plus browser creation/configuration persistence, approval acceptance, task results, downloads, route/back behavior, a 390px viewport, keyboard dialog behavior, panel navigation, reduced motion and page errors. The existing identity A–R regression suite also passes against the isolated database. Live model provider compatibility, Firebase sign-in, real web search and production hosting are not certified here.

The feature also repairs shared approval row ID collisions and supplies the approving user's identity; conditional approval writes reject repeated decisions. Terminal run persistence rejects stale active-state writes after cancellation/completion. Shared type corrections align the API with Express 5, cron-parser and the current tool contracts.
