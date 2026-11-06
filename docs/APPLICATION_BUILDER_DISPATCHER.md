# AIRA Application Builder — Durable Dispatcher Integration

**Status:** experimental PR #43, stacked on PR #42 and PR #40. **Not deployed or production certified.**

## Architecture

The existing \`PostgresApplicationBuildQueue\` is the authoritative queue. The new \`ApplicationBuildDispatcher\` is a standalone, long-lived process that does not run inside Vercel functions.

\`\`\`text
Chat APPLICATION_BUILD → server routing → authenticated projects.write approval
→ AgentRuntime (AIRA_BUILDER_DISPATCHER_ENABLED=true)
→ idempotent queue.enqueue(owner, objective, "run:"+runId, projectId=runId)
→ HTTP request completes
→ independent dispatcher claim via FOR UPDATE SKIP LOCKED
→ verify persisted run identity, scopes, routing decision, approved checkpoint
→ provider-driven multi-file generation → isolated worker install/build/test
→ worker result in queue with fencing generation, heartbeat renewal
→ PostgresRunRepository persisted run events/artifact and terminal state
→ API /api/runs/:id/events polls persisted sequences across processes
→ React reconnects after approval and shows real results
\`\`\`

Queue \`COMPLETED\` means the worker's **BUILD_PASSED** scripts ran successfully. It is **not** independent app/gameplay acceptance. The emitted project artifact says "not product certified".

## Files

- \`packages/app-builder/src/dispatcher.ts\`: one-at-a-time lease-fenced queue dispatch, cancellation polling, heartbeat, shutdown abort, bounded error handling.
- \`packages/app-builder/src/dispatcher-execution.ts\`: verified stored run authorization, actual ModelRouter / ApplicationBuildClient, maximum two model/code attempts, safe cancellation, persistent run events and terminal reconciliation.
- \`packages/app-builder/src/dispatcher-service.ts\`: standalone opt-in supervisor and periodic terminal-run reconciliation.
- \`packages/agent-runtime/src/index.ts\`: approved builder run enqueues idempotently under dispatcher flag, legacy execution path remains when flag disabled.
- \`apps/api/src/index.ts\`: principal-scoped durable queue inspection/cancellation and SSE event polling across process boundaries.
- \`packages/app-builder/src/queue.ts\`: expired lease recovery limited to three execution attempts; old fencing generations cannot commit.
- \`test/app-builder-dispatcher.ts\`: PostgreSQL concurrent claims, completion fencing, cancellation abort, lease expiry/reclaim, shutdown abort, retry cap.

## Required services and configuration

**Only in authorized isolated development or staging environments:**

1. Apply reviewed additive migration \`016_app_build_durable_queue.ts\` using \`npm run db:migrate\` against an isolated database.
2. Configure \`AIRA_BUILDER_ENABLED=true\`, \`AIRA_BUILDER_DISPATCHER_ENABLED=true\` on the app API and dispatcher. These flags must remain **unset** on current production.
3. Run a separately hardened and authenticated app-build Docker worker (existing \`npm run worker:build\`). Configure \`AIRA_BUILD_WORKER_URL\` and \`AIRA_BUILD_WORKER_TOKEN\` in API and dispatcher secret stores; do not expose to browser.
4. Configure an actual model provider on dispatcher through approved secret store (\`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\`, or \`NVIDIA_API_KEY\`). No mock provider is acceptable for live acceptance.
5. Run \`npm run worker:dispatcher\` on an authorized **long-running** host/service, **not** a Vercel serverless API function.
6. Restrict worker API and database access to the dispatcher/control plane. Expose preview only behind independently reviewed gateway, separate HTTPS origin and user authorization.

\`\`\`bash
npm run test:app-builder-queue
npm run test:app-builder-dispatcher
npm run worker:dispatcher
\`\`\`

Requests emitted by the AIRA UI contain a \`runId\`. After approval, an \`tool.requested\` event includes \`queueJobId\`, enabling owner-scoped status/cancellation:

- \`GET /api/app-builder/queue/:id\`
- \`POST /api/app-builder/queue/:id/cancel\`

The dispatcher writes durable events to \`run_events\`; the API relays them through \`GET /api/runs/:id/events\` even across separate processes.

## Known safety and reliability limitations

- Standalone worker hosting, live provider, durable artifact object storage and external sandbox security are **not provisioned/certified**.
- The queue is a durable coordinator; generated files still live on the worker. Losing that worker's storage may prevent full project reopening.
- Lease fencing protects database success status but does not instantly kill a container from a crashed worker; orphan reconciliation and privileged daemon hardening are unfinished.
- A process crash between model generation and worker submission can cause a new attempt and possible duplicate provider calls. Submission is idempotent by Run ID, but worker job creation itself does not yet have a durable idempotency key.
- Queue terminal reconciliation runs periodically and at startup, but high-volume retention, historical pagination, complete event replay tests and isolated cross-replica acceptance need more work.
- A queue build ending BUILD_PASSED has no independent generated-calculator or playable-pinball acceptance.
- The rootless production-worker startup guard in PR #42 is not proof of an audited multitenant sandbox.
- Remote preview HTTPS, user-level authorization/revocation, WebGL gameplay verification and full Vite/React/physics-library install are still blocked.
- Vercel project lookup succeeds without explicit teamId, but scoped lookup 404s; some preview deployments fail with BUILD_UTILS_SPAWN_1 during \`npm run db:verify:deploy && npm run build\`. Logs require corrected authorization. **No new project, deployment or domain cutover has been initiated by this work.**

## Release decision

**APPLICATION BUILDER NOT CERTIFIED — BLOCKERS REMAIN.** Preserve \`aira-ai-live\`, \`aira-ai.in\`, \`www.aira-ai.in\`, production Neon and main/staging as-is. Keep PR #43 draft until current exact-HEAD CI passes and security review is complete.
