# AIRA AI 2026 — Change Impact Map

> **Source baseline:** `prod-release` at `478dd40d4000216c386d32e89422f2e5da1d0208` (inspected 2026-11-05). This document maps source-level relationships, **not** a certification of deployed services or a live database. Draft PR #127 (`0096e35d5aa9b283fe30aa2b06a49c2c3e95430a`) and PR #128 (`516e67779973e3ae797a43214cc58b3c61ec3f96`) are explicitly segregated in §3. Do not read their code as present in `prod-release`.

## 1. Purpose and reading rules

Use this file **before** editing a file, function, schema, route, environment variable, shared component, or operational script. It reduces regressions that escape an import-only search: API wire contracts, principal/workspace scope, database columns, queued work, SSE events, persisted browser state, provider billing, CI/release gates, and end-user workflows can depend on behavior without importing the implementation.

**Evidence standard.** `Verified` means the named relationship is established by a source declaration and an identifiable consumer/caller/query/mount/test in the specified commit; it does **not** mean a live integration test passed. `Potential` means an indirect consequence is credible but needs a caller/contract/runtime check. `Unknown` means the relationship or actual deployment state cannot be established from inspected source. In every entry, **Directly affected** and **Evidence** are source-verified; **Potentially affected** lists review targets, not claims of observed breakage. A `Confidence` label qualifies the **primary relationship**; uncertainty in individual fields is spelled out explicitly.

**How to use:** (1) identify the changed symbol and its upstream inputs; (2) follow both the import/call edges **and** the routes, events, tables, ownership keys, environment gates, data formats, and business-flow edges below; (3) search for current consumers and compare this map with the actual target branch; (4) select focused tests plus cross-boundary/E2E acceptance; (5) update this document when verified architecture changes. Never infer an absent dependency simply because an import search yields nothing. No code or live environment was modified to create this map.

**Coverage:** The complete 629-file tracked inventory of the baseline was enumerated; relevant implementations and registrations were inspected across `src/`, `apps/`, `api/`, `packages/`, `scripts/`, `test/`, `docs/`, `.github/`, Docker, Vite, Vercel, and migrations `001`–`030`. Paths below are relative to repository root. Lockfile, screenshots, archived reports, and individual regression-test internals are not treated as executable consumers without corroborating source. For `prod-release` topology, `api/index.ts` exports the Express app from `apps/api/src/index.ts`, `vercel.json` rewrites `/api/(.*)` to `/api`, and `src/main.tsx` mounts `src/App.tsx`.

### Verified cross-layer propagation overview

| Entry / change | Verified route through code and state | Consequences requiring independent verification |
| --- | --- | --- |
| Chat submit | `src/App.tsx` → `src/utils/aiEngine.ts:streamAIResponse` → `src/lib/neonAuth.ts:authenticatedApiFetch` → `POST /api/chat/stream` → capacity guard → `AgentRuntime` → model adapter / run events → SSE parser | Auth switch mid-stream, run-event schema, billing quota, state persistence, UI artifacts |
| OAuth/session | `AuthModal` / `AccountMenuDropdown` → `NeonAuthClient` → `/api/auth/*` → BFF/Direct OAuth → BFF session store → `req.user` → `DevPrincipalProvider` → workspace authority | Other tabs, local cache scope, client memory, data ownership, approval decisions |
| Agent tool | `/api/tools/execute`, `/api/runs` and runtime/workflow steps → `ToolGateway` → adapter + `ApprovalKernel` → tool-call record | Approval/outbox resume, filesystem/browser side effects, connector reachability |
| Durable specialist | `/api/missions`, `AgentRuntime` → durable coordinator/scheduler/repository → `apps/specialist-worker/src/index.ts` → specialist execution → `specialist_tasks`/events | Claim leases, fencing, worker startup policy, crash recovery and run status reflection |
| Conversation search | `App` → `conversationSearch` client → `/api/conversations/*` → `ConversationSearchRepository` → Postgres conversation tables → embedding index → `/api/search/conversations` | Principal isolation, version ordering, pgvector availability, search UI |
| Scheduled automation | UI/intent → `/api/automations/*` → `AutomationEngine` → automation repositories → agent run; cron endpoint → `runScheduledCronCycle` | Serverless cron attestation, inactive drafts, workspace ownership, duplicate execution |
| Credits / vision | chat or `/api/vision/*` → commercial credit/usage service → billing ledger; payment webhooks → signature checks → gateway event ledger | Quota, replay/idempotency, refunds, invoice/customer UX |
| Release | `AGENTS.md` → GH review/authorization workflows → `prod-release` merge → Vercel `buildCommand` → `db:verify:deploy` → build/deployment | Exact-SHA authorization, schema parity, live domain/rollback; do not infer approval from CI |

## 2. Impact map — production-branch source

### A. HTTP entry, middleware ordering, and route composition

- **Component:** `api/index.ts` → default export; `apps/api/src/index.ts` → Express `app`, route/middleware registrations.
- **Role:** Serves all first-party APIs, error envelopes, CORS, readiness and SSE; mounts account/billing/vision/builder routers.
- **Directly affected:** `api/index.ts` imports the app; `apps/api/src/index.ts` invokes `createSessionAuthMiddleware`, `createNeonAuthPrincipalMiddleware`, `createBffSessionMiddleware`, `createCsrfProtectionMiddleware`, `createPrincipalMiddleware`, and the four commercial route factories.
- **Potentially affected:** Every API caller, browser login/logout, webhook signature handling, stream startup, instrumentation, readiness and Vercel routing. **Ordering matters:** auth endpoints and public webhooks are registered before the general principal middleware; `/api` is gated by runtime readiness after early routes.
- **API impact:** `/api/auth/*`, `/api/health`, `/api/ready*`, `/api/chat/stream`, `/api/runs*`, `/api/missions*`, `/api/tools*`, `/api/conversations*`, `/api/knowledge*`, `/api/agents*`, `/api/automations*`, `/api/workflows*`, plus mounted `/api/account`, `/api/billing`, `/api/vision`, `/api/builder`.
- **Data impact:** Indirectly all repositories constructed here; no table modification implied by changing the mount alone.
- **Security impact:** CORS origin checks, CSRF, principal attachment, public/protected route boundary, body limits, error disclosure.
- **Runtime impact:** Agent/runtime singleton initialization, automation engine start, streaming cleanup, app health state.
- **Frontend impact:** Every same-origin API consumer; especially `src/App.tsx`, `src/utils/aiEngine.ts`, account, vision, builder, search, automation and agent views.
- **Tests to review:** `test/cors-origin-rejection.test.ts`, `test/auth-security-authorization.test.ts`, `test/aira-backend-correctness.test.ts`, `test/edge-agent-execution.ts`, `test/e2e-verification.ts`.
- **Infrastructure impact:** `vercel.json` API rewrite, `api/tsconfig.json`, `tsconfig.server.json`, `package.json` server script.
- **Confidence:** Verified for mounts/ordering; Potential for deployed rewrite/runtime behavior.
- **Evidence:** `api/index.ts:default app`; `apps/api/src/index.ts:createPrincipalMiddleware` and route registrations (`/api/chat/stream`, `/api/missions`, `/api/automations/cron/execute`); `vercel.json:rewrites`.

### B. Server-side authentication, OAuth and BFF sessions

- **Component:** `apps/api/src/auth/bff-session.ts` → `BffSessionStore`, `createBffSessionMiddleware`, `createCsrfProtectionMiddleware`, `handleBff*`; `apps/api/src/auth/direct-oauth.ts` → `DirectOAuthService`.
- **Role:** First-party cookie sessions, CSRF/origin validation, Google/GitHub OAuth flows, account linking/recovery and session restoration.
- **Directly affected:** `apps/api/src/index.ts` calls exported handlers/middleware; `direct-oauth.ts` is consumed by BFF OAuth handlers; `apps/api/src/account-routes.ts` consumes session/account storage.
- **Potentially affected:** Account switches during active SSE, guest linking, login loops, provider-link conflicts, multi-instance session consistency.
- **API impact:** `/api/auth/sign-in`, `/sign-up`, `/session`, `/sign-out`, `/oauth-*`, `/oauth/{google,github}/*`, `/providers*`, `/recovery/*`, `/link-guest` under `/api/auth`.
- **Data impact:** `bff_sessions` / legacy `durable_bff_sessions` usage must be reconciled against migrations; `users`, `oauth_accounts`, `account_recovery_requests` from migration `021`; see unknowns on live schema.
- **Security impact:** Secure cookie flags, session signature/expiry, state/PKCE, CSRF, origin matching, account identity binding.
- **Runtime impact:** Session database reads and revocation/cleanup, OAuth HTTP round trips.
- **Frontend impact:** `src/lib/neonAuth.ts`, `AuthModal`, `AccountMenuDropdown`, `AccountBillingModal`, `src/App.tsx` auth transition.
- **Tests to review:** `test/auth-bff-session-gateway.test.ts`, `test/auth-direct-oauth-lifecycle.test.ts`, `test/auth-cross-instance-durable-session.test.ts`, `test/auth-account-switching-isolation.test.ts`, `test/auth-fail-closed-policy.test.ts`, `test/auth-google-oauth-loop-remediation.test.ts`.
- **Infrastructure impact:** `AIRA_SESSION_SECRET`, OAuth provider credentials/redirect origins, `NEON_AUTH_*`, Vercel HTTPS/cookie domain.
- **Confidence:** Verified source edges; Unknown live OAuth provider configuration and DB session-table parity.
- **Evidence:** `bff-session.ts:BffSessionStore,verifyCsrfAndOrigin,createBffSessionMiddleware`; `direct-oauth.ts:DirectOAuthService`; `apps/api/src/index.ts` auth route registrations; `packages/db/src/migrations/017_durable_bff_sessions.ts`, `021_direct_oauth_identity_model.ts`.

### C. Principal derivation and workspace authority

- **Component:** `apps/api/src/auth/principal-provider.ts` → `DevPrincipalProvider.resolve`; `apps/api/src/middleware/principal.ts` → `createPrincipalMiddleware`; `packages/agent-runtime/src/workspace-authority.ts` → `workspaceAuthority`.
- **Role:** Resolve authenticated execution principal and server-owned personal workspace, enforcing active authority for privileged workflows.
- **Directly affected:** `apps/api/src/index.ts` attaches `req.principal`; `AgentRuntime.createRun` and `submitApproval`, automation and approval repositories use authority resolution/checks.
- **Potentially affected:** Cross-tenant access through agent runs, tools, scheduled automation, permissions, workspace revocation.
- **API impact:** Any protected `/api/*` route reading `req.principal`, particularly runs/missions, tools, knowledge, billing, automations.
- **Data impact:** `principal_workspace_authorities` migration `030`, `agents.principal_id` migration `018`, owner fields of persisted tasks/runs.
- **Security impact:** Source-of-truth `userId`/`workspaceId`, revocation tombstones and server-side authority, no client-asserted ownership.
- **Runtime impact:** Task eligibility and approval resume checks, scheduled execution principal.
- **Frontend impact:** All signed-in screens; apparent 401/403 behavior, ownership filtering and stale account data.
- **Tests to review:** `test/principal-provider-workspace.test.ts`, `test/workspace-authority-migration-guard.test.ts`, `test/agent-tenant-isolation.test.ts`, `test/automation-policy-b.test.ts`, `test/approval-once-consumption.test.ts`.
- **Infrastructure impact:** `AIRA_PERSISTENT_WORKSPACE_AUTHORITY`, Postgres availability and migration `030`.
- **Confidence:** Verified for source checks and persisted authority; Potential for every downstream business flow.
- **Evidence:** `principal-provider.ts:DevPrincipalProvider.resolve`; `middleware/principal.ts:createPrincipalMiddleware`; `workspace-authority.ts:derivePersonalWorkspaceId,PostgresWorkspaceAuthorityRepository`; `packages/db/src/migrations/030_principal_workspace_authority.ts`.

### D. Client session gateway and identity-bound network operations

- **Component:** `src/lib/neonAuth.ts` → `NeonAuthClient`, `authenticatedApiFetch`, `ensureGuestSession`.
- **Role:** BFF session restoration, auth listeners/epochs, cross-tab synchronization, CSRF headers and cancellation of in-flight requests upon identity change.
- **Directly affected:** `src/App.tsx`, `AuthModal`, `AccountMenuDropdown`, `Sidebar`, `AccountBillingModal`, `AgentsView`, `AutomationsView`, `LibraryView`, `src/utils/{aiEngine,conversationSearch,builderClient,capabilityDispatcher}.ts` import it.
- **Potentially affected:** Streaming response attribution after account switches, background hydration, cross-tab logout, old-session replays.
- **API impact:** Same-origin `/api/auth/*` and every endpoint used through `authenticatedApiFetch`.
- **Data impact:** Browser session marker and principal-bound client caches; no direct SQL queries in this client.
- **Security impact:** Account isolation, session refresh races, protected request gating, CSRF token handling.
- **Runtime impact:** Abort controllers, SSE stream cancellation, cross-tab `BroadcastChannel` messages.
- **Frontend impact:** All authenticated interactions, form submission and access-denied UI.
- **Tests to review:** `test/neon-auth-token-race.test.ts`, `test/auth-account-switching-isolation.test.ts`, `test/auth-identity-transition-lifecycle.test.ts`, `test/auth-builder-integration.test.ts`.
- **Infrastructure impact:** `VITE_NEON_AUTH_URL`, `AIRA_API_URL`, same-origin Vercel rewrite and cookie attributes.
- **Confidence:** Verified.
- **Evidence:** `src/lib/neonAuth.ts:NeonAuthClient.getAuthEpoch,abortActiveRequests,authenticatedApiFetch`; imports named above; `src/utils/aiEngine.ts:postChatStream`.

### E. Main React workspace and persisted browser state

- **Component:** `src/App.tsx` → `App`; `src/utils/storage.ts` → `loadConversations`, `saveConversations`, `loadProjects`, `saveSettings`.
- **Role:** Owns current user/chat/project, composer mode, stream lifecycle, views, settings, notifications and local conversation cache.
- **Directly affected:** `src/main.tsx` renders `App`; `App` calls storage helpers and renders `Sidebar`, `ChatInput`, `ChatMessage`, `AgentContextualPanel`, lazy `ArtifactStudio`, `ProjectsModal`, `SettingsModal`, and auth/account/privacy modals.
- **Potentially affected:** Conversation recovery, browser refresh, mobile navigation, project switching, search backfill, stale authorization events.
- **API impact:** Chat, conversations, agent/missions, approval, automation, vision and account flows via imported clients/direct calls.
- **Data impact:** `aira_*` localStorage/sessionStorage keys and server `conversations` sync; browser project/settings keys are distinct from SQL ownership.
- **Security impact:** `App` clears in-memory state and active stream on user transition; verify no old-user state leaks via asynchronous callbacks.
- **Runtime impact:** Active `AbortController`, run IDs, SSE callbacks, sync scheduling and cancellation.
- **Frontend impact:** Virtually all screens and navigation; shared UI props/events.
- **Tests to review:** `test/conversation-persistence.test.ts`, `test/long-prompt-persistence.ts`, `test/mobile-sidebar-responsive.ts`, `test/auth-account-switching-isolation.test.ts`, `test/account-settings-ecosystem.ts`.
- **Infrastructure impact:** Vite/React build, browser storage availability and `src/index.css`.
- **Confidence:** Verified for imports/state wiring; Potential for non-tested browser paths.
- **Evidence:** `src/main.tsx`; `src/App.tsx:App` imports and `onAuthStateChange`; `src/utils/storage.ts:getConversationsStorageKey,loadConversations,saveConversations`.

### F. Browser chat streaming and memory injection

- **Component:** `src/utils/aiEngine.ts` → `streamAIResponse`, `postChatStream`.
- **Role:** Builds chat request, adds local memory context, handles SSE events, detects artifacts and consolidates responses into client memory.
- **Directly affected:** `src/App.tsx` calls `streamAIResponse`; `aiEngine.ts` consumes `agentMemory`, `neonAuth`, `createStreamingArtifactDetector`, and `/api/chat/stream`.
- **Potentially affected:** Latency status, run start, approval UI, source citations, artifact previews, memory contamination and cancellation.
- **API impact:** `POST /api/chat/stream` request fields `prompt,history,model,attachments,contextSubgraph,conversationId,intent`; SSE event names and payloads.
- **Data impact:** Client memory vault via `assembleMemoryContext`/`consolidateFromTurn`; server run and event persistence occurs through API.
- **Security impact:** Captures auth epoch/user ID for SSE; local memory scope is a sensitive path (see draft PR #128).
- **Runtime impact:** Streaming parser, abort/cancel, callback timing, provider/model provenance events.
- **Frontend impact:** Composer, response rendering, thinking block, citations, artifact gallery, approval notices.
- **Tests to review:** `test/behavioral/nemotron-stream-regression.test.ts`, `test/long-prompt-persistence.ts`, `test/behavioral/memory-save-routing.test.ts`, `test/artifact-studio-m1.test.ts`, `test/auth-account-switching-isolation.test.ts`.
- **Infrastructure impact:** API rewrite, provider network, client fetch streaming support.
- **Confidence:** Verified.
- **Evidence:** `src/utils/aiEngine.ts:streamAIResponse,postChatStream`; `src/App.tsx` invocation; `apps/api/src/index.ts` `/api/chat/stream` and SSE event writer.

### G. Server chat stream, SSE contract and event persistence

- **Component:** `apps/api/src/index.ts` → `POST /api/chat/stream`, `AgentRuntime.getEventStream`; `packages/agent-runtime/src/repositories.ts` → `PostgresRunRepository`.
- **Role:** Normalize model/prompt, enforce quota and capacity, create/start run, relay runtime events to SSE, store runs/events and release permits.
- **Directly affected:** Client `streamAIResponse`; `ModelRouter`, `PrivateBetaCapacityGuard`, `commercialBillingService`, `agentRuntime`, `runRepo` are invoked here.
- **Potentially affected:** Chat vs agent mode, stalled streams, request disconnects, retry/idempotency, provider telemetry, durable output retrieval.
- **API impact:** `POST /api/chat/stream` and `GET /api/runs/:id/events`; `content_delta`, `thinking_delta`, `approval_required`, `model_provenance`, `done` and other SSE event names.
- **Data impact:** `runs`, `run_events`, `tool_calls`, billing usage/credit ledgers.
- **Security impact:** `req.principal` and `withInferencePrincipal` ownership; cancellation must not target another account.
- **Runtime impact:** Abort on socket close, capacity permit release, run recovery/event dispatch, queued requests.
- **Frontend impact:** Message text, reasoning/provenance, approval prompts, loading and error states.
- **Tests to review:** `test/edge-agent-execution.ts`, `test/p1-6-first-token-deadline-fallback.test.ts`, `test/p1-6-5-single-roundtrip-capacity.test.ts`, `test/run-prompt-schema-drift.ts`, `test/tool-calls-schema-drift.ts`.
- **Infrastructure impact:** SSE buffering/timeouts, Vercel request lifetime, external model credentials, `DATABASE_URL`.
- **Confidence:** Verified source chain; Unknown live streaming behavior and Vercel timeout parity.
- **Evidence:** `apps/api/src/index.ts` chat SSE handler and event switch; `packages/agent-runtime/src/index.ts:emitRunEvent,flushPendingEvents,startRun`; `packages/agent-runtime/src/repositories.ts:PostgresRunRepository.appendRunEvents`.

### H. Model selection, inference adapters, health and capacity

- **Component:** `packages/model-router/src/index.ts` → `ModelRouter.resolvePolicy`, `resolveExecution`; `capacity/capacity-guard.ts` → `PrivateBetaCapacityGuard`; `capacity/capacity-store.ts` → `DistributedPostgresCapacityStore`.
- **Role:** Select model/provider and fallback, regulate concurrency/RPM, record health/circuit-breaker signals.
- **Directly affected:** API initialization and chat endpoint; `AgentRuntime.createNormalizedRun`, `WorkflowEngine`, `BuilderService` consume router/adapter decisions.
- **Potentially affected:** Routing quality, first-token latency, provider cost, failure isolation, admission queue fairness.
- **API impact:** `/api/chat/stream`, `/api/ready/providers`, `/api/capacity/status`, model/provenance SSE fields; builder model use.
- **Data impact:** `capacity_permits`, `capacity_rate_log` from migration `019`; run provenance fields.
- **Security impact:** Principal-keyed limits and provider key handling (server-only).
- **Runtime impact:** Provider HTTP calls, circuit transitions, permit acquisition/release and queue timers.
- **Frontend impact:** Model selector modes, queue/provenance status, errors and stream latency.
- **Tests to review:** `test/model-router-provider-routing.ts`, `test/p1-6-routing-policy.test.ts`, `test/p1-6-provider-health-circuit-breaker.test.ts`, `test/p1-6-2-multi-instance.test.ts`, `test/nvidia-groq-fallback-cross-provider-regression.test.ts`.
- **Infrastructure impact:** `GROQ_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CEREBRAS_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, database pooling.
- **Confidence:** Verified wiring; Unknown currently enabled providers and entitlements.
- **Evidence:** `packages/model-router/src/index.ts:ModelRouter`; `capacity/capacity-store.ts:DistributedPostgresCapacityStore`; `apps/api/src/index.ts` constructor and chat admission; migration `019_capacity_guard_schema.ts`.

### I. AgentRuntime orchestration and prompt behavior

- **Component:** `packages/agent-runtime/src/index.ts` → `AgentRuntime.createRun`, `startRun`, `submitApproval`, `executeRunLoop`; `router.ts`, `prompt-composer/intelligent-prompt-composer.ts`.
- **Role:** Canonical run state machine that routes objectives to chat, specialist tasks or workflows; composes instructions; dispatches tools and emits durable events.
- **Directly affected:** `apps/api/src/index.ts` run/chat/missions APIs; `AutomationEngine`, `WorkflowEngine` and durable coordinator are constructed/used by runtime.
- **Potentially affected:** System-instruction precedence, planning, research grounding, artifact generation, multi-agent execution, tool retry and recovery.
- **API impact:** `/api/runs*`, `/api/missions*`, `/api/agents/:id/run`, chat streaming, workflow step actions.
- **Data impact:** `runs`, `run_events`, `workflow_*`, `specialist_tasks`, `approvals`, artifact records and knowledge query paths.
- **Security impact:** `ExecutionPrincipal` and `workspaceAuthority` checking, approval attribution and tool scopes.
- **Runtime impact:** In-flight run cache, recovery owner/lease, event stream, workflow and specialist scheduling.
- **Frontend impact:** Agent panel progress, planning/verification events, chat mode and provenance.
- **Tests to review:** `test/agent-specialists.test.ts`, `test/agent-tenant-isolation.test.ts`, `test/unified-intelligence-architecture.test.ts`, `test/aira-one-execution-safety.test.ts`, `test/behavioral/instruction-resolver.test.ts`.
- **Infrastructure impact:** Worker/database availability, provider credentials, feature toggles and sandbox backends.
- **Confidence:** Verified for source orchestration; Potential for every feature routed by a dynamic intent decision.
- **Evidence:** `AgentRuntime` constructor wires `ServerIntentRouter`, `WorkflowEngine`, `DurableExecutionCoordinator`, `ToolGateway`, `IntelligentPromptComposer`; `createNormalizedRun` calls `router.route`/`modelRouter.resolveExecution`; `apps/api/src/index.ts` run handlers.

### J. Durable specialist task lifecycle and worker activation

- **Component:** `packages/agent-runtime/src/durable/{specialist-task-repository,durable-task-scheduler,task-lease-manager,specialist-worker-runtime,durable-execution-coordinator,worker-host,worker-activation-policy}.ts`; `apps/specialist-worker/src/index.ts`.
- **Role:** Persist and claim specialist tasks, fence stale workers, renew leases, record checkpoints and gate worker activation by environment identity.
- **Directly affected:** `AgentRuntime` constructs coordinator/scheduler/repository; `apps/specialist-worker/src/index.ts` constructs `SpecialistWorkerHost` with Postgres repository and specialist registry; `/api/missions*` queries task status.
- **Potentially affected:** Duplicate side effects, crash recovery, queue starvation, lost work, misrouted tenant tasks, worker deploy/standby.
- **API impact:** `/api/missions`, `/api/missions/:id`, `/api/runs/:id` status reflection and run event streams.
- **Data impact:** `specialist_tasks`, `specialist_task_events` (migration `026`), `runs` state and lease/fencing columns.
- **Security impact:** Worker DB classification, principal/workspace binding, tool scopes, fencing tokens.
- **Runtime impact:** Polling, heartbeat, retry, concurrency, task claim, checkpoint, process shutdown.
- **Frontend impact:** Agent mission progress, cancellation and recovery status.
- **Tests to review:** `test/m2a-durable-specialist-execution.test.ts`, `test/m2a-worker-staging-e2e.test.ts`, `test/m2a-production-activation-security.test.ts`, `test/durable-worker-authorization.test.ts`, `test/m2a-real-postgres-verification.test.ts`.
- **Infrastructure impact:** `Dockerfile.worker`, `docker-compose.staging.yml`, `WORKER_*`, `DATABASE_URL`, `AIRA_ENV`, `EXPECTED_NEON_*`; PR #127 adds separate production compose/systemd (not baseline).
- **Confidence:** Verified for repository/worker linkage; Unknown actual worker process health and deployment.
- **Evidence:** `apps/specialist-worker/src/index.ts:main`; `durable/worker-host.ts:SpecialistWorkerHost`; `durable/specialist-task-repository.ts:PostgresSpecialistTaskRepository`; `durable/worker-activation-policy.ts:assertWorkerActivationAuthorized`; migration `026_specialist_durable_execution_schema.ts`.

### K. Workflow compiler/engine and step approval

- **Component:** `packages/agent-runtime/src/workflow-{compiler,engine,repositories}.ts` → `WorkflowCompiler`, `WorkflowEngine`, `PostgresWorkflowRepository`.
- **Role:** Validates/compiles DAGs, persists workflow state and steps, resumes approved steps, dispatches tools/research/model work.
- **Directly affected:** `AgentRuntime` constructs engine/compiler; `/api/workflows/runs*` and `/steps/:stepId/approve` call workflow engine/repository.
- **Potentially affected:** Step retries, idempotency, approval resumption, dependent DAG nodes, user-visible progress.
- **API impact:** `/api/workflows/runs`, `/:id`, `/:id/cancel`, `/:id/steps/:stepId/approve` and workflow SSE events.
- **Data impact:** `workflow_definitions`, `workflow_runs`, `workflow_steps` (migrations `009`, `010`) plus `runs`, `approvals`, outbox.
- **Security impact:** Principal/workspace checks and step-level permission decisions.
- **Runtime impact:** DAG scheduling, step state transitions, resume dispatcher, tool result interpolation.
- **Frontend impact:** Agent workflow timeline, status/error and approval action.
- **Tests to review:** `test/workflow-engine.ts`, `test/workflow-engine-preflight.test.ts`, `test/workflow-approval-authority.test.ts`, `test/approval-resumption-outbox-postgres.test.ts`.
- **Infrastructure impact:** DB migration parity and worker availability; no separate workflow service manifest located in baseline.
- **Confidence:** Verified.
- **Evidence:** `packages/agent-runtime/src/index.ts:AgentRuntime` constructor; `workflow-engine.ts:WorkflowEngine.setApprovalResumptionDispatcher`; `workflow-repositories.ts:PostgresWorkflowRepository`; `apps/api/src/index.ts` workflow handlers.

### L. Tool execution gateway, adapters and MCP surface

- **Component:** `packages/tool-runtime/src/{gateway,index,repository}.ts` → `ToolGateway`, `ToolRegistry`; `adapters/{browser,file,repo,connector}-adapter.ts`; `packages/mcp/src/index.ts` → `McpHost`.
- **Role:** Registry, input/schema and permission enforcement, approval policy, tool execution, auditing and browser/file/repo/connector adapters. MCP host wraps gateway/registry.
- **Directly affected:** API `/api/tools*` and `/api/mcp/servers`; `AgentRuntime`, `WorkflowEngine` and worker specialists consume gateway/registry.
- **Potentially affected:** Browser and filesystem boundaries, external connector calls, tool cancellation, approval prompts, sandbox safety.
- **API impact:** `/api/tools`, `/execute`, `/connectors`, `/calls*`, `/api/mcp/servers`; draft PR #127 extends MCP connect/status and browser/Python routes.
- **Data impact:** `tool_calls` and its reconciled columns (migrations `002`, `011`, `025`), `approvals`, `session_grants`; browser persisted sessions are draft-only in migration `031`.
- **Security impact:** `deriveToolApprovalPolicy`, `verifyPermissionScopes`, tool scopes, argument validation, workspace filesystem isolation.
- **Runtime impact:** Adapter network/process execution, idempotency/retries, tool call state.
- **Frontend impact:** Agent panel, tool status, approvals, generated outputs.
- **Tests to review:** `test/tool-gateway-certification.ts`, `test/tool-gateway-approval-fail-closed.test.ts`, `test/browser-authorization.test.ts`, `test/repo-roundtrip.ts`, `test/mcp-integration.ts`.
- **Infrastructure impact:** Browser executable/container availability, connector/search keys, MCP transport, local workspace permissions.
- **Confidence:** Verified baseline adapters and API; Potential for remote MCP/external integration behavior.
- **Evidence:** `ToolGateway` and `ToolRegistry` declarations; `packages/tool-runtime/src/gateway.ts:registerBuiltInTools,verifyPermissionScopes`; `packages/mcp/src/index.ts:McpHost`; `apps/api/src/index.ts` gateway construction and API routes.

### M. Approval decisions, grants, and resumption outbox

- **Component:** `packages/approvals/src/index.ts` → `ApprovalKernel`; `repositories.ts` → `PostgresApprovalRepository`, `PostgresSessionGrantRepository`.
- **Role:** Creates and atomically resolves approvals, checks one-time/session grants, queues/resumes approved actions with owner/lease protections.
- **Directly affected:** `ToolGateway`, `AgentRuntime.submitApproval`, `WorkflowEngine.resolveStepApproval`, run approval API.
- **Potentially affected:** Duplicate external side effects, stale approvals, cross-account consent, resumed worker actions.
- **API impact:** `/api/runs/:id/approve`, workflow step approval, tool execute results, SSE `approval_required` and `approval.resolved` mapping.
- **Data impact:** `approvals`, `session_grants`, `approval_resumption_outbox` (migrations `027`–`029`), `tool_calls`.
- **Security impact:** Request owner, argument/tool policy fingerprint, one-time consumption and principal/workspace matching.
- **Runtime impact:** Pending/success/failure transitions, outbox claim/lease, delayed resumption.
- **Frontend impact:** Approval prompts and grant/reject UX.
- **Tests to review:** `test/approval-atomic-resolution.test.ts`, `test/approval-once-consumption.test.ts`, `test/approval-resumption-outbox-postgres.test.ts`, `test/approval-lifecycle-stage-1-2a.test.ts`, `test/tool-gateway-approval-fail-closed.test.ts`.
- **Infrastructure impact:** Migration sequence `027`–`029`, Postgres transaction/recovery guarantees.
- **Confidence:** Verified.
- **Evidence:** `approvals/src/index.ts:ApprovalKernel`; `repositories.ts:resolvePendingRequest,claimApprovalResumption,applyApprovalResumption,claimOnceAuthorization`; `AgentRuntime.submitApproval`; migration `028_approval_resumption_outbox.ts`.

### N. Automation scheduler and durable automation records

- **Component:** `packages/automation/src/{index,repositories}.ts` → `AutomationEngine`, `PostgresAutomationRepository`, `PostgresAutomationRunRepository`.
- **Role:** Save/enable schedules, enforce Policy B when scheduler is unavailable, evaluate cron/one-time triggers and create agent runs.
- **Directly affected:** `apps/api/src/index.ts` initializes engine and exposes `/api/automations*`; `src/components/AutomationsView.tsx`, `src/utils/capabilityDispatcher.ts` call endpoints.
- **Potentially affected:** Missed/duplicate jobs, account ownership, timezone interpretation, notifications not proven to have a separate delivery service.
- **API impact:** `/api/automations/*`, `/api/automations/cron/execute`, capability/readiness payloads.
- **Data impact:** `automations`, `automation_runs` (migrations `001`–`004`) and downstream `runs`.
- **Security impact:** Principal ownership and workspace checks; cron bearer token validated using timing-safe comparison.
- **Runtime impact:** `start`, `runScheduledCronCycle`, process timers vs serverless cron; scheduler may be deliberately unavailable.
- **Frontend impact:** Automations view and natural-language scheduling through `resolveSchedule` in `src/utils/scheduleResolver.ts`.
- **Tests to review:** `test/automation-policy-b.test.ts`, `test/behavioral/booking-clarification.test.ts`, `test/staging-agent-mission-certification.ts`, `test/aira-one-two-mode-architecture.test.ts`.
- **Infrastructure impact:** `AIRA_SCHEDULER_ENABLED`, `AIRA_SERVERLESS_CRON_CONFIGURED`, `CRON_SECRET`, Vercel cron configuration (actual `vercel.json` contains **no** `crons` entry at this baseline).
- **Confidence:** Verified implementation/gating; Unknown whether an external scheduler invokes the endpoint.
- **Evidence:** `AutomationEngine.getSchedulerStatus,runScheduledCronCycle,start`; `apps/api/src/index.ts:handleCronCycleExecution`; `src/utils/capabilityDispatcher.ts:createBackendAutomation`; `vercel.json`.

### O. Durable conversations and semantic/lexical retrieval

- **Component:** `packages/retrieval/src/index.ts` → `ConversationSearchRepository`, `ConversationEmbeddingIndexer`, `HybridConversationSearchService`; `embeddings.ts` → `createEmbeddingProvider`.
- **Role:** Persist principal-scoped conversations/messages, protect newer syncs against stale writes, build full-text/vector indexes and search within a principal.
- **Directly affected:** `apps/api/src/index.ts` constructs these services for `/api/conversations*` and `/api/search*`; `src/utils/conversationSearch.ts`, `src/App.tsx` and `ConversationSearchOverlay` consume the HTTP results.
- **Potentially affected:** Cross-account search leakage, deleted-message resurfacing, search freshness, history recovery and local/server divergence.
- **API impact:** `POST /api/conversations/sync`, `GET /api/conversations`, `GET /api/conversations/:id`, `DELETE /api/conversations/:id`, `GET /api/search/conversations`, `GET /api/search/capabilities`.
- **Data impact:** `conversations`, `conversation_messages`, `conversation_search_documents`, optional `embedding_vector` and indexes (migrations `013`–`015`).
- **Security impact:** `principal_id` filters, deterministic principal-salted storage IDs, advisory transaction lock and ownership checks.
- **Runtime impact:** Post-request embedding index, provider calls, hybrid fallback when vector capability is unavailable.
- **Frontend impact:** Chat history reload, conversation search overlay, sidebar navigation and sync status.
- **Tests to review:** `test/conversation-persistence.test.ts`, `test/conversation-search.ts`, `test/conversation-search-semantic.ts`, `test/conversation-search-client.ts`, `test/embedding-provider.ts`, `test/knowledge-isolation.test.ts`.
- **Infrastructure impact:** Postgres `pgvector`, `AIRA_SEMANTIC_SEARCH`, embedding provider credentials; `db:verify:deploy` tests vector readiness when enabled.
- **Confidence:** Verified source path; Unknown live index/extension state.
- **Evidence:** `ConversationSearchRepository.syncConversation` uses `pg_advisory_xact_lock`, `conversations`, `conversation_messages`; `ConversationEmbeddingIndexer`, `HybridConversationSearchService`; `apps/api/src/index.ts` conversation/search routes; migration `014_conversation_search_pgvector.ts`.

### P. Server knowledge graph and durable memories

- **Component:** `packages/knowledge/src/{index,repositories}.ts` → `BrainV2KnowledgeEngine`, `PostgresKnowledgeRepository`/knowledge repository implementations.
- **Role:** Ingest/retrieve knowledge sources, chunks, entities, graph edges and scoped server memory.
- **Directly affected:** `apps/api/src/index.ts` calls knowledge APIs; `AgentRuntime`/`ResearchService` consult engine; `src/components/LibraryView.tsx` calls source/graph/search/ingest endpoints.
- **Potentially affected:** Retrieval grounding, cross-tenant memories, source deletion, agent research citations, future autonomous memory lifecycle.
- **API impact:** `/api/knowledge/sources*`, `/api/knowledge/ingest`, `/api/knowledge/graph`, `/api/knowledge/search`, `/api/knowledge/memories`.
- **Data impact:** `knowledge_sources`, `knowledge_chunks`, `knowledge_entities`, `knowledge_edges`, `memory_records`; principal-isolation columns from migration `016`.
- **Security impact:** `PrincipalScope` filtering and account/workspace isolation across source and memory persistence.
- **Runtime impact:** Ingest, indexing/search and research pipeline; no separate knowledge queue is evidenced in baseline.
- **Frontend impact:** Library view, search results, agent answers/citations.
- **Tests to review:** `test/knowledge-isolation.test.ts`, `test/memory-context-policy.ts`, `test/research-evidence.ts`, `test/behavioral/targeted-retrieval-hardening.test.ts`.
- **Infrastructure impact:** `DATABASE_URL`, migration `016`, optional research/embedding providers.
- **Confidence:** Verified for source consumers; Potential for generated answer quality.
- **Evidence:** `packages/knowledge/src/index.ts:BrainV2KnowledgeEngine`; `packages/knowledge/src/repositories.ts` scoped repository methods; `apps/api/src/index.ts` knowledge endpoints; `packages/agent-runtime/src/research.ts`.

### Q. Client memory vault and account isolation

- **Component:** `src/utils/{agentMemoryEngine,agentMemoryMigration}.ts` → `agentMemory`, `assembleMemoryContext`, `consolidateFromTurn`, vault migration.
- **Role:** Store, recall, consolidate, import/export client-side memories; inject selected memory into chat requests.
- **Directly affected:** `src/utils/aiEngine.ts`, `src/App.tsx`, `src/components/MemoryVaultModal.tsx`; `agentMemoryEngine.ts` calls `migrateAgentMemoryVault`.
- **Potentially affected:** Cross-account memory contamination, obsolete seed facts, account-switch races, chat personalization and privacy export.
- **API impact:** No direct vault endpoint in baseline; affects `POST /api/chat/stream` through `contextSubgraph` and downstream generated response.
- **Data impact:** Baseline `aira_agentmemory_vault_v1` localStorage key and migration version; not identical to Postgres `memory_records`.
- **Security impact:** User ID on `MemoryItem` is optional in baseline. **Draft PR #128 explicitly changes vault scoping**; baseline behavior must not be described as certified cross-account isolation.
- **Runtime impact:** Automatic response consolidation, local storage migration and cache notifications.
- **Frontend impact:** Memory vault, settings memory controls, personalized chat and account transitions.
- **Tests to review:** `test/behavioral/memory-save-routing.test.ts`, `test/behavioral/migration.test.ts`, `test/behavioral/security.test.ts`, `test/memory-context-policy.ts`, and draft #128 `test/agent-memory-account-isolation.test.ts`.
- **Infrastructure impact:** Browser storage and `VITE_*` auth integration; no server migration for local vault.
- **Confidence:** Verified baseline linkage; **Potential** cross-account behavior pending PR #128 acceptance.
- **Evidence:** `agentMemoryEngine.ts:AgentMemoryEngine.loadFromStorage,assembleMemoryContext,consolidateFromTurn`; `agentMemoryMigration.ts:STORAGE_KEY,migrateAgentMemoryVault`; `aiEngine.ts:streamAIResponse`; draft diff described in §3.

### R. Database connection, migration execution and schema contract

- **Component:** `packages/db/src/index.ts` → `db`, `resolveEffectiveDatabaseUrl`, `runMigrations`, `evaluateMigrationMaintenancePlan`; `scripts/{migrate,verify-deploy}.ts`.
- **Role:** Central Knex/Postgres pool, migration runner, maintenance-aware migration plan and build-time schema verification.
- **Directly affected:** Repository classes under `packages/agent-runtime`, `approvals`, `automation`, `knowledge`, `retrieval`, `tool-runtime`, model capacity store and API billing/auth modules import `db` or use the migration scripts.
- **Potentially affected:** Every durable record, tenant key, SQL transaction, schema lock, deployment, recovery and billing entry; migration changes are **not** limited to their immediate table owner.
- **API impact:** Most protected write/read endpoints; `db:verify:deploy` can stop a production build even if API code compiles.
- **Data impact:** Schema groups are mapped below; migrations `001`–`030` are tracked in baseline. Migration `031` appears only in PR #127.
- **Security impact:** Pool SSL/strict TLS, production/staging connection selection, maintenance bypass and migration safety.
- **Runtime impact:** Pool acquire timeout, connection churn, transaction isolation, migration locks, startup readiness.
- **Frontend impact:** Widespread via API failures, missing search, login or run history.
- **Tests to review:** `test/connection-pool.test.ts`, `test/migration-clean.ts`, `test/migration-path-b.ts`, `test/database-isolation-guard.test.ts`, `test/isolated-neon-certification.ts`, `test/tool-calls-schema-drift.ts`, `test/run-prompt-schema-drift.ts`.
- **Infrastructure impact:** `DATABASE_URL`, direct vs pooled connection, `docker-compose.yml`, `vercel.json:buildCommand`, `.github/workflows/postgres-certification.yml`.
- **Confidence:** Verified code/schema linkage; Unknown live migration state (no database queried for this document).
- **Evidence:** `packages/db/src/index.ts:db,runMigrations`; `packages/db/src/scripts/verify-deploy.ts:requiredTables,expectedMigrationNames`; imports of `db` in repository files; `package.json:db:migrate,db:verify:deploy`.

**Database model → verified source consumer → change ripple (baseline):**

| Tables / model family | Declaring migrations | Verified query/logic consumers | Review beyond the schema |
| --- | --- | --- | --- |
| `agents`, `runs`, `run_events` | `001`, `003`, `005`–`008`, `012`, `018`, `024` | `packages/agent-runtime/src/repositories.ts`, `AgentRuntime`, API runs/chat | Principal/workspace, state recovery, SSE ordering, prompt text |
| `automations`, `automation_runs` | `001`–`004` | `packages/automation/src/repositories.ts`, `AutomationEngine` | Scheduler activation, ownership, cron deduplication |
| `approvals`, `session_grants`, `approval_resumption_outbox` | `002`, `003`, `027`–`029` | `packages/approvals/src/repositories.ts`, `ApprovalKernel`, workflow/runtime | Atomic decisions, one-time grants, leases, replay prevention |
| `tool_calls`, `mcp_servers` | `001`–`003`, `011`, `025` | `packages/tool-runtime/src/repository.ts`, gateway / MCP | Tool contract, permission scopes, audit and schema drift |
| `specialist_tasks`, `specialist_task_events` | `026` | `durable/specialist-task-repository.ts`, worker/scheduler | Fencing, task claim, checkpoint, cross-tenant consistency |
| `principal_workspace_authorities` | `030` | `workspace-authority.ts`, runtime/automation/approval guards | Revocation, personal workspace derivation, authorized resumes |
| `conversations`, `conversation_messages`, `conversation_search_documents` | `013`–`015` | `packages/retrieval/src/index.ts`, API conversation/search | Account isolation, indexes, stale writes, pgvector |
| `knowledge_sources`, `knowledge_chunks`, `knowledge_entities`, `knowledge_edges`, `memory_records` | `002`, `016` | `packages/knowledge/src/repositories.ts`, `BrainV2KnowledgeEngine` | Principal scoping, retrieval, knowledge graph |
| `bff_sessions`, `users`, `oauth_accounts`, `account_recovery_requests` | `017`, `021`, `022` | `apps/api/src/auth/{bff-session,direct-oauth}.ts`, `account-routes.ts` | Cookies, linked identity, session restoration; **see source mismatch U1** |
| `billing_customers`, `plans`, `plan_prices`, `subscriptions`, `credit_accounts`, `credit_grants`, `credit_reservations`, `credit_transactions`, `usage_events`, `entitlement_snapshots`, `billing_audit_events`, `payment_gateway_events` | `020` | `commercial-billing-service.ts`, `payment-gateway-service.ts`, billing/vision/chat API | Money, quota, usage, webhook idempotency, reconciliation |
| `capacity_permits`, `capacity_rate_log` | `019` | `model-router/src/capacity/capacity-store.ts` | Multi-instance concurrency/RPM gating |
| `idempotent_operations` | `023` | `apps/api/src/utils/idempotency.ts` and mutating handlers | Duplicate checkout/automation/vision operations |

### S. Shared contract schemas and model IDs

- **Component:** `packages/contracts/src/{index,commercial,agent-specialists,behavioral,deployment-environment}.ts` → Zod schemas/types (`CreateRunRequestSchema`, `ApprovalDecisionSchema`, `TaskDAGSchema`, `AutomationDefinitionSchema`, `normalizeModelIdentifier`, commercial catalog).
- **Role:** Shapes data crossing frontend/API/runtime/database/provider boundaries; validates DAGs, model IDs and commercial inputs.
- **Directly affected:** API handlers parse schemas, `AgentRuntime`/`WorkflowEngine` consume types, model router consumes model IDs, billing and vision services use shared commercial definitions.
- **Potentially affected:** Persisted JSON compatibility, old clients, event payloads, retries, invalid model fallback and billing UI.
- **API impact:** Chat/runs/agents/automations/workflows, billing/vision contracts.
- **Data impact:** Serialized `runs`/`workflow_runs`/agent policies and billing identifiers.
- **Security impact:** Principal/permission schemas, payload validation and approval decision enum changes.
- **Runtime impact:** Routing, DAG validation, permission decisions, provider selection.
- **Frontend impact:** `src/types/index.ts`, model selector, agent UI and pricing/billing interpretation.
- **Tests to review:** `test/unified-intelligence-architecture.test.ts`, `test/workflow-engine-preflight.test.ts`, `test/agent-specialists.test.ts`, `test/model-router-provider-routing.ts`, `test/commercial-credit-ledger.test.ts`.
- **Infrastructure impact:** TypeScript builds across client/server; schema migration if persisted representation changes.
- **Confidence:** Verified for named imports; Potential for external consumers or old stored JSON.
- **Evidence:** `apps/api/src/index.ts` contract imports and schema `.parse`; `packages/agent-runtime/src/index.ts`; `packages/model-router/src/index.ts`; `packages/contracts/src/index.ts:validateWorkflowDag`.

### T. Commercial entitlements, credits and payment webhooks

- **Component:** `apps/api/src/billing/{commercial-billing-service,payment-gateway-service}.ts` → `CommercialBillingService`, `PaymentGatewayService`; `billing-routes.ts`.
- **Role:** Meter chat/vision usage, reserve/settle credits, manage subscription state and verify/process payment gateway events.
- **Directly affected:** `apps/api/src/index.ts` chat quota and public webhook handlers; `vision/vision-service.ts` credit operations; billing routes invoke services; `AccountBillingModal`, `PricingModal`, `AccountMenuDropdown` consume billing APIs.
- **Potentially affected:** Charging on failed streams/generations, duplicate webhook grants, billing summaries, GST invoices and administrative readiness.
- **API impact:** `/api/billing/plans`, `/entitlements`, `/summary`, `/invoices`, `/checkout/subscription`, `/subscription/cancel`, `/webhook/razorpay`, `/webhook/cashfree`.
- **Data impact:** All billing ledger tables in migration `020`, plus `idempotent_operations` for eligible mutation paths.
- **Security impact:** Principal-scoped credit access, raw-body HMAC webhook verification and replay checks.
- **Runtime impact:** External Razorpay/Cashfree callbacks, quota counters and credit reservations.
- **Frontend impact:** Account/billing modal, pricing/checkout, vision purchase barriers, chat limit errors.
- **Tests to review:** `test/commercial-credit-ledger.test.ts`, `test/commercial-payment-webhooks.test.ts`, `test/commercial-gst-tax.test.ts`, `test/vision-billing-integrity.test.ts`, `test/account-billing-truth.test.ts`.
- **Infrastructure impact:** Gateway secrets, webhook URLs, `DATABASE_URL`, entitlement/price configuration.
- **Confidence:** Verified source chain; Unknown actual merchant configuration and live settlement.
- **Evidence:** `commercial-billing-service.ts:consumeStandardChat,reserveCredits,settleReservation,releaseReservation`; `payment-gateway-service.ts:processRazorpayWebhook,processCashfreeWebhook`; `apps/api/src/index.ts` webhook routes and chat quota; migration `020`.

### U. Vision understanding, generation, and editing

- **Component:** `apps/api/src/vision-routes.ts` → `createVisionRoutes`; `vision/vision-service.ts` → `VisionService`.
- **Role:** Validate image operations, use configured vision providers and charge/refund through commercial service.
- **Directly affected:** API router mounts `/api/vision`; `src/utils/capabilityDispatcher.ts` and `VisionStudioModal` call vision endpoints; billing service is consumed by vision implementation.
- **Potentially affected:** Image output quality, remote URL expiration, editing/download UX, credit refunds, provider-specific limits.
- **API impact:** `GET /api/vision/capabilities`; `POST /api/vision/understand`, `/generate`, `/edit`.
- **Data impact:** Billing reservations/usage; image blob persistence is **not verified** from these routes.
- **Security impact:** Principal ownership, input validation, provider keys, sensitive image uploads.
- **Runtime impact:** External provider HTTP, timeouts, partial response and credit settlement.
- **Frontend impact:** `VisionStudioModal`, chat prompt capability dispatcher, generated image cards.
- **Tests to review:** `test/vision-billing-integrity.test.ts`, `test/commercial-vision-tariffs.test.ts`, `test/behavioral/security.test.ts`.
- **Infrastructure impact:** Vision provider configuration/keys, outbound network, image URL availability.
- **Confidence:** Verified source integration; Unknown live provider availability and long-term image storage.
- **Evidence:** `createVisionRoutes`; `VisionService.understand,generate,edit`; `src/utils/capabilityDispatcher.ts:executeVisionGeneration`; `src/components/VisionStudioModal.tsx` fetch calls.

### V. Builder service, sandbox providers and generated files

- **Component:** `packages/builder-runtime/src/{index,sandbox,security}.ts` → `BuilderService`, `MultiProviderSandboxFactory`, `verifyTicket`, `builderAccess`; `apps/api/src/builder-routes.ts`.
- **Role:** Authorize builder jobs, allocate isolated sandbox, stream build events, cancel job and deliver ZIP/download under signed ticket.
- **Directly affected:** API `/api/builder/*` uses `BuilderService`; `BuilderWorkspace` and `AgentContextualPanel` use `src/utils/builderClient.ts`.
- **Potentially affected:** Preview origin restrictions, sandbox escape, path traversal, failed cleanup, orphan workspaces and generated artifact download.
- **API impact:** `/api/builder/status`, `/stream`, `/cancel`, `/download`; ticket formats and event payloads.
- **Data impact:** Ephemeral sandbox files/tickets; no dedicated builder table established from inspected baseline.
- **Security impact:** `safeRelativePath`, signed ticket principal binding, access/consent and provider isolation.
- **Runtime impact:** E2B/Lightning/OCI provider creation, command execution, streaming, timeout and cancellation.
- **Frontend impact:** Builder workspace and agent contextual panel previews/ZIP.
- **Tests to review:** `test/builder-agent.test.ts`, `test/builder-auth-client.test.ts`, `test/sandbox-providers.test.ts`, `test/lightning-provider.test.ts`, `test/builder-ui.ts`, `test/browser-execution-suite.ts`.
- **Infrastructure impact:** Provider credentials, sandbox network, E2B/OCI services; draft PR #127 adds Docker/local/sidecar providers and Python runner.
- **Confidence:** Verified baseline routes/provider interface; Unknown active provider and runtime filesystem isolation without acceptance testing.
- **Evidence:** `BuilderService.run,cancel,download`; `MultiProviderSandboxFactory.create,connect`; `builder-routes.ts:createBuilderRoutes`; `src/utils/builderClient.ts:streamBuilder`.

### W. Artifact parsing, sandbox rendering and message HTML

- **Component:** `src/utils/{artifactParser,artifactSandbox,markdown}.ts` → `createStreamingArtifactDetector`, `generateArtifactSandboxHtml`, `renderMarkdownToHtml`.
- **Role:** Extract generated artifacts, prepare isolated HTML preview, sanitize markdown and render chat/math/citations.
- **Directly affected:** `src/utils/aiEngine.ts` uses streaming detector; `ArtifactStudio.tsx` uses sandbox HTML; `ChatMessage.tsx` uses markdown renderer; `src/App.tsx` opens studio.
- **Potentially affected:** Script execution isolation, unsafe links, HTML injection, artifact code compatibility, clipboard output and styling.
- **API impact:** Indirectly chat stream artifact event/chunk interpretation; no direct artifact endpoint from client preview.
- **Data impact:** Parsed artifact type/content in conversation messages; preview HTML constructed client-side.
- **Security impact:** Iframe sandbox attributes, sanitizer, origin and CSP behavior; PR #127 modifies `artifactSandbox.ts`/`ArtifactStudio.tsx`.
- **Runtime impact:** Stream chunk boundaries, iframe/document execution, potentially expensive render.
- **Frontend impact:** Artifact card/studio, chat message HTML, formula rendering, rich clipboard.
- **Tests to review:** `test/artifact-studio-m1.test.ts`, `test/math-rendering.ts`, `test/behavioral/security.test.ts`; PR #127 adds `test/artifact-sandbox-containment.test.ts`.
- **Infrastructure impact:** Browser iframe policies, CSP and Vite assets.
- **Confidence:** Verified source consumers; Potential security/runtime outcomes until browser containment testing.
- **Evidence:** `aiEngine.ts:createStreamingArtifactDetector`; `ArtifactStudio.tsx:generateArtifactSandboxHtml`; `ChatMessage.tsx:renderMarkdownToHtml`; `src/utils/artifactSandbox.ts`.

### X. Shared UI components, design tokens and navigation

- **Component:** `src/components/{Sidebar,ChatInput,ChatMessage,SettingsModal,AgentContextualPanel,AiraMark}.tsx`; `src/components/brand/*`; `src/index.css`, `src/App.css`.
- **Role:** Common navigation, input, message rendering, account/settings controls and brand identity.
- **Directly affected:** `src/App.tsx` imports/layouts components; `ChatMessage` calls markdown renderer; `AiraMark` delegates brand geometry/motion; `SettingsModal` consumes current settings and auth.
- **Potentially affected:** Mobile breakpoints, accessibility, global theme, keyboard shortcuts, collapsed panels, route-less view transitions.
- **API impact:** Indirect: `AgentContextualPanel`/builder client and settings/account screens trigger APIs.
- **Data impact:** Settings and local project/chat state; no direct Postgres models in these presentational components.
- **Security impact:** Rendering sanitation, auth-dependent menu visibility, links and iframe behavior.
- **Runtime impact:** React effects and lazy chunk loading; no server worker owner.
- **Frontend impact:** All chat/agent/account/navigation screens; favicon, light/dark motion.
- **Tests to review:** `test/mobile-sidebar-responsive.ts`, `test/mobile-settings-responsive.ts`, `test/account-menu-visual-regression.test.ts`, `test/seo-metadata.test.ts`, `test/browser-branding-favicon.ts`.
- **Infrastructure impact:** `src/index.css`, `tailwind.config.js`, Vite chunking/build and `public/brand`/favicon assets.
- **Confidence:** Verified direct render paths; Potential visual/accessibility changes.
- **Evidence:** `src/App.tsx` component imports/rendering; `src/components/AiraMark.tsx`; `src/components/brand/AiraBrandMark.tsx`; `src/utils/animatedFavicon.ts`.

### Y. Environment classification, staging maintenance and DB isolation

- **Component:** `packages/db/src/security/{database-isolation-guard,staging-maintenance-barrier,staging-role-separation}.ts`; `apps/api/src/middleware/staging-maintenance.ts`; `apps/api/src/startup-config.ts`.
- **Role:** Refuse unsafe DB/environment crossover, enforce staging write freeze/role separation and validate API boot configuration.
- **Directly affected:** API startup/middleware; `apps/specialist-worker/src/index.ts` DB classification; `scripts/staging-*.ts`, `scripts/verify-neon-checkpoint.ts` and staging workflows use guards.
- **Potentially affected:** Production-vs-preview data safety, blocked writes during cutover, inability to start API/worker, unsafe migration commands.
- **API impact:** Mutations under staging maintenance, `/api/health`/`/api/ready`, startup failures.
- **Data impact:** `_aira_staging_maintenance` sentinel/triggers and guarded tables, database branch/project metadata; no live state asserted.
- **Security impact:** Disallow cross-environment DB connections, privileged migration bypass, no unauthorized DML.
- **Runtime impact:** Startup fail-closed, worker activation, maintenance responses and migration lock.
- **Frontend impact:** 503/maintenance messaging, unavailable actions during cutover.
- **Tests to review:** `test/database-isolation-guard.test.ts`, `test/staging-maintenance-barrier.test.ts`, `test/staging-maintenance-barrier-integration.test.ts`, `test/staging-cutover-safety-gates.test.ts`, `test/startup.ts`.
- **Infrastructure impact:** `DATABASE_URL`, `AIRA_ENV`, `STAGING_MAINTENANCE_MODE`, `AIRA_MAINTENANCE_BYPASS_TOKEN`, expected Neon IDs; staging deployment workflow.
- **Confidence:** Verified source guard relationships; Unknown actual branch identity/maintenance state without read-only control-plane checks.
- **Evidence:** `database-isolation-guard.ts:classifyDatabaseUrl,verifyConnectedDatabaseIdentity,assertCanRunMigrations`; `staging-maintenance-barrier.ts:activateStagingMaintenance`; `apps/api/src/index.ts:createStagingMaintenanceMiddleware,validateApiStartupConfiguration`.

### Z. Deployment, CI, release authority and recovery gate

- **Component:** `AGENTS.md`; `vercel.json`; `.github/workflows/{ci,postgres-certification,staging-deployment,release-authorization,release-authorization-publisher,release-authorization-revoke}.yml`; `src/security/release-authorization-validator.ts` and scripts.
- **Role:** Defines production-change authority, exact-SHA approval, staging/CI checks, schema readiness and release promotion constraints.
- **Directly affected:** Vercel `buildCommand` invokes `npm run db:verify:deploy` and `npm run build`; release workflows invoke script validators; CI invokes TS/build/secrets/database tests.
- **Potentially affected:** Automatic deployment on `prod-release` merge, failed build, bad DB connection, missing rollback, false GO LIVE claims.
- **API impact:** `api/index.ts` production handler and runtime startup; deployed route availability.
- **Data impact:** Build gate checks all migrations and required tables; standalone migration scripts can mutate DB if authorized (not run during this audit).
- **Security impact:** `AGENTS.md` prohibits implicit merge/migration authorization; release tokens/signatures, CI isolation.
- **Runtime impact:** Production deploy, staging smoke testing, worker/service startup, rollback readiness.
- **Frontend impact:** Entire published app, asset/cache headers, SEO and API URL behavior.
- **Tests to review:** `test/release-authorization-guard.test.ts`, `test/release-gate-app-publisher.test.mjs`, `test/staging-deployment-attestation.ts`, `test/staging-deployed-acceptance.ts`, `test/tracked-secrets-hygiene.test.ts`, `test/seo-metadata.test.ts`.
- **Infrastructure impact:** GitHub protected `prod-release` rules, Vercel project, Neon branches, CI runners/Docker and deployment environment.
- **Confidence:** Verified checked-in policy/wiring; Unknown actual live deployment SHA, external workflow ruleset state, recovery artifacts and GO LIVE evidence.
- **Evidence:** `AGENTS.md:Strict deployment authority`; `vercel.json:buildCommand,rewrites`; `packages/db/src/scripts/verify-deploy.ts`; `scripts/verify-release-authorization.ts`; `.github/workflows/release-authorization.yml`, `.github/workflows/ci.yml`.

## 3. Draft-branch additions — not deployed by this map

These are **verified changes in the named PR source**, but their effect on the deployed app is **Unknown** until the exact commit is integrated, migrations are separately authorized/applied, and acceptance is performed. Do not merge the PRs or execute migrations as part of map maintenance.

### D127-1. New autonomous engine, task contract and lifecycle endpoints (PR #127)

- **Component:** `packages/agent-runtime/src/autonomous/{autonomous-engine,autonomous-worker-host,repository}.ts` → `AutonomousAgentEngine`, `PostgresAutonomousTaskRepository`; `packages/contracts/src/autonomous-agent.ts`.
- **Role:** Plan/execute/refine/pause/resume/recover high-level agent tasks and persist plans, observations, working memory and leases.
- **Directly affected:** PR #127 changes `packages/agent-runtime/src/index.ts`, `apps/api/src/index.ts`, `apps/specialist-worker/src/index.ts` to construct/expose autonomous runtime; new specialists under `packages/agent-runtime/src/specialists/` implement planner, researcher, browser, coder, documents, automation and synthesizer roles.
- **Potentially affected:** Existing `/api/runs`, durable specialist queue, tool/approval authority, behavior and latency of chat/agent mode, recovery after crashes.
- **API impact:** PR #127 introduces `/api/agent/autonomous/tasks*` lifecycle handlers (create, read/control) and additional browser/MCP/Python endpoints; verify the current PR head for the exact complete route list before changing clients.
- **Data impact:** Migration `031_autonomous_agent_tasks.ts` adds `autonomous_agent_tasks` including principal/workspace, idempotency, lease/fencing and JSON state.
- **Security impact:** Task ownership/authorization, planned tool capabilities, scoped worker execution and stale-worker fencing.
- **Runtime impact:** New background work and worker host; verify whether immediate execution or `AIRA_AUTONOMOUS_QUEUE_ONLY` mode is active.
- **Frontend impact:** Agent mission status and eventual task controls; the exact production UI integration remains unreleased.
- **Tests to review:** PR #127 `test/autonomous-api-worker-integration.test.ts`, `test/autonomous-task-postgres-certification.test.ts`, `test/autonomous-worker-recovery.test.ts`, `test/autonomous-adversarial-scenarios.test.ts`, `test/autonomous-platform-e2e.test.ts`.
- **Infrastructure impact:** Migration `031`, dedicated worker networking/compute, `AIRA_AUTONOMOUS_QUEUE_ONLY` and production worker activation.
- **Confidence:** Verified **on PR #127 head only**; Unknown production activation.
- **Evidence:** PR #127 source `AutonomousAgentEngine.createTask,startTask,executeAutonomousTask,recoverTask`; `PostgresAutonomousTaskRepository` queries `autonomous_agent_tasks`; API diff adds `/api/agent/autonomous/tasks`; migration `031` defines the table/unique/indexes.

### D127-2. Browser persistence, isolated Python runner and production worker (PR #127)

- **Component:** `packages/builder-runtime/src/{sidecar,docker,local}-provider.ts`, `apps/sandbox-runner/runner.py`, `Dockerfile.sandbox-runner`, `infrastructure/production/docker-compose.prod.yml` and `infrastructure/production/systemd/aira-production-worker.service`.
- **Role:** Dedicated container-backed execution, Python sidecar HTTP protocol, persisted browser session storage, and a fail-closed production worker deployment shape.
- **Directly affected:** PR #127 alters `packages/builder-runtime/src/sandbox.ts`, `packages/tool-runtime/src/{gateway,adapters/browser-adapter}.ts`, `apps/specialist-worker/src/index.ts`, `worker-activation-policy.ts` and adds a production environment validator.
- **Potentially affected:** Browser session recovery, sandbox network exposure, access to files/secrets, worker queue drain, exact-image reproducibility and rollout safety.
- **API impact:** PR #127 adds `/api/sandbox/python/execute`, `/api/browser/sessions*`, `/api/browser/action`, expanded `/api/mcp/servers*` endpoints.
- **Data impact:** Migration `031` adds `durable_browser_sessions` with encrypted session envelope, principal/workspace and expiration indexes.
- **Security impact:** Sidecar bearer auth, non-root/read-only container, no Docker socket mount, internal bridge network, encrypted persisted browser sessions; these are source configurations, not live penetration-test results.
- **Runtime impact:** `SidecarSandboxProvider` calls sidecar `/workspaces` and `/run`; dedicated worker container polls Postgres only after activation gate.
- **Frontend impact:** Builder/artifact previews, browser actions and agent mission outputs.
- **Tests to review:** PR #127 `test/python-sandbox-containment.test.ts`, `test/sidecar-runner-real-execution.test.ts`, `test/sidecar-security-audit.test.ts`, `test/browser-persistence-recovery.test.ts`, `test/production-worker-activation-guard.test.ts`, `test/operational-staging-worker-certification.test.ts`.
- **Infrastructure impact:** Oracle ARM64 compose, systemd, guarded env template, `AIRA_PRODUCTION_WORKER_ENABLED`, `AIRA_SANDBOX_RUNNER_URL`, `AIRA_SANDBOX_AUTH_TOKEN`, `BROWSER_SESSION_ENCRYPTION_KEY`, backup/restore scripts.
- **Confidence:** Verified **on PR #127 head only**; Unknown VM provisioning/standby, live DB schema or restored backup.
- **Evidence:** PR #127 `infrastructure/production/docker-compose.prod.yml` services `specialist-worker`/`sandbox-runner`; `SidecarSandboxProvider.execute` POSTs `/run`; migration `031` creates `durable_browser_sessions`.

### D128. User-scoped client memory correction (PR #128)

- **Component:** `src/utils/agentMemoryEngine.ts` → scoped `storageKey`, `getScope`, filtered `recall`, `remember`, import; `src/utils/aiEngine.ts` → completion consolidation boundary.
- **Role:** Separate browser vaults by signed-in account and avoid writing one user's completed stream memory to another user's vault after identity changes.
- **Directly affected:** Client `agentMemory`, `streamAIResponse`, `neonAuth` listener, `MemoryVaultModal`, `App`.
- **Potentially affected:** Guest legacy vault visibility/export, signed-in memory migration, personalized response injection, cross-tab state and account switching.
- **API impact:** Indirect `contextSubgraph` in `/api/chat/stream`; no SQL schema change.
- **Data impact:** Per-account localStorage keys of shape `aira_agentmemory_vault_v1:user:<userId>`; legacy unscoped key is retained. Only records with matching `userId` are migrated for that account in draft code.
- **Security impact:** Prevent cross-account vault reuse; verify after two-account switching, stream completion and logout races.
- **Runtime impact:** Auth change subscriptions and in-flight consolidation guard.
- **Frontend impact:** Memory vault, response memory context and settings behavior.
- **Tests to review:** PR #128 `test/agent-memory-account-isolation.test.ts`, modified `test/behavioral/{migration,security}.test.ts`, baseline `test/auth-account-switching-isolation.test.ts`.
- **Infrastructure impact:** Browser localStorage; no database migration.
- **Confidence:** Verified **in draft diff only**; Unknown live authenticated browser behavior.
- **Evidence:** PR #128 diff `agentMemoryEngine.ts` adds `neonAuth.onAuthStateChange`, `getScope`, user-scoped `storageKey`, `userId` filters; `aiEngine.ts` completion handling changes; PR #128 metadata is draft/unmerged.

## 4. Critical change paths

Risk here means **blast radius if changed incorrectly**, not a claim that the current code is vulnerable. Source-verified edges appear before the final potential consequence.

| Component → affected areas → reason → risk | Risk |
| --- | --- |
| `apps/api/src/index.ts` middleware ordering → all protected/public APIs → CORS/CSRF/session/principal/runtime readiness order governs the request pipeline → unauthorized access or mass 401/503 | Critical |
| `bff-session.ts` + `principal-provider.ts` + `workspace-authority.ts` → sessions, tools, runs, automations, account data → identity propagated into authorization and persistence → cross-account access or lockout | Critical |
| `src/lib/neonAuth.ts` → fetch clients, `App`, SSE, memory → auth epoch and cancellation shared by multiple asynchronous consumers → stale-user data/state disclosure | Critical |
| `packages/db/src/index.ts` / migration series → all repository models + `db:verify:deploy` → shared connection/schema and deploy gate → data corruption or release failure | Critical |
| `packages/contracts/src/index.ts` + API event formats → UI/runtime/models/persisted JSON → structural contracts cross service boundaries → silent incompatibility | High |
| `AgentRuntime` + `WorkflowEngine` → agent routes, tool use, run events, recovery, automations → central execution coordinator → duplicate/wrong/missing work | Critical |
| `ToolGateway` + `ApprovalKernel` + outbox → browser/files/connectors/tool records → authorization and exactly-once side effects → unapproved action or replay | Critical |
| Durable specialist repo + lease/fencing + worker → mission queue and run state → asynchronous claim/checkpoint recovery → duplicate task or lost result | Critical |
| `ModelRouter` + capacity store → chat, agent, builder and provider health → central admission and routing → overload, failed inference, wrong model/provider | High |
| `ConversationSearchRepository` + sync client → history, search, hydration, embedding index → principal-bound persistent data and ordering → missing/leaked conversations | Critical |
| `agentMemoryEngine.ts` + `aiEngine.ts` → local vault and prompt context → behavior-based, non-import account boundary → wrong user's memory in prompt | Critical |
| Billing ledger + vision/chat + payment webhooks → credits, quotas, invoices, checkout → financial side effects across routes → double charge or incorrect balances | Critical |
| `AutomationEngine` + cron secret/gates → scheduled runs/agent runtime → out-of-band triggers and owner checks → unapproved/duplicate scheduled execution | High |
| `BuilderService` + sandbox factory + artifact iframe → generated files/preview → untrusted code crosses sandbox/display boundary → host/session exposure or preview failure | Critical |
| `database-isolation-guard.ts` + staging barrier → migrations/worker/staging/production → environment identity and write barriers → accidental production write | Critical |
| `AGENTS.md` + release workflows + `vercel.json` → production deployment → merge to `prod-release` triggers release; DB gate expects schema → unauthorized cutover | Critical |
| Draft PR #127 autonomous engine + migration `031` + sidecar → new task/browser state/worker → asynchronous multi-process deployment dependency → unrecoverable work if schema/worker mismatch | Critical (pending) |

## 5. Change-impact checklist

Before changing **any** mapped component, verify and record the exact target branch/SHA and the evidence in this document:

- [ ] Direct consumers checked (imports, calls, inheritance, runtime registration and dynamic dispatch).
- [ ] Indirect consumers checked (events, queues, state, middleware, serialization, background execution).
- [ ] API contracts checked (routes, verbs, auth boundary, errors, SSE/MCP/webhook payloads, existing clients).
- [ ] Database/data dependencies checked (migrations, indexes, constraints, owner columns, storage/caches, replay and recovery).
- [ ] Authentication/authorization checked (guest/account switch, CSRF, workspace, roles/scopes, cross-tenant access).
- [ ] Background jobs/events checked (cron, queue claims, leases, retries, idempotency, approvals, cancellation).
- [ ] Frontend consumers checked (screens, UI state, hooks, mobile, browser storage, settings).
- [ ] Tests checked (focused unit/integration, disposable-Postgres, browser/E2E, staging and release gates).
- [ ] Configuration/infrastructure checked (feature flags, env vars, provider integrations, Docker, CI, Vercel, worker, storage).
- [ ] Critical user/admin workflows checked (sign-in/out, chat, run/approve, history, search, billing, scheduled tasks, builder/vision, recovery/deploy).
- [ ] Unverified dependencies documented explicitly; no guessed confidence upgrades.
- [ ] For production-affecting proposals: exact-SHA checks, approved migration/backup/rollback evidence, and **fresh owner GO LIVE** as required by `AGENTS.md` before any production change.

### Minimum end-to-end business flows to re-check by change area

1. **Identity:** guest → Google/GitHub account → refresh → account switch → sign-out → second account; inspect client vault/history and server ownership.
2. **Chat:** select model → prompt + attachment → capacity admission → stream/thinking/source/artifact events → save/reload/search → cancel/retry.
3. **Agent:** create mission → route/plan → tool permission → approve/reject → background worker lease → result → recovery/restart.
4. **Automation:** parse schedule/timezone → create inactive/active task → authorized cron trigger → one execution/run history → disable/delete.
5. **Commercial:** plan/entitlement → standard chat/vision consumption → checkout → signed webhook retry → credit balance/invoice and rejection when quota is exhausted.
6. **Builder/vision:** gated access → execution/generation → cancellation/failure → refund/cleanup → preview/download, including browser origin isolation.
7. **Release:** isolated migration rehearsal → backup restore proof → staged worker → mandatory CI/browser acceptance → exact-SHA owner approval → deploy/monitor/rollback plan. **Checklist is not execution authorization.**

## 6. Unknown / unverified dependencies — do not guess

| ID | Observation and source evidence | What remains unknown / next read-only verification |
| --- | --- | --- |
| U1 | `apps/api/src/account-routes.ts` security handler queries **`durable_bff_sessions`**; `apps/api/src/auth/bff-session.ts:BffSessionStore` and migration `017` use **`bff_sessions`**. This is a **verified source-name mismatch**. | Whether an untracked/legacy live table or view exists, and whether `/api/account/security` succeeds. Check disposable/staging schema and endpoint under authorized test account before changing either name. |
| U2 | `src/lib/firebase.ts` declares Firebase Auth/Firestore/Storage adapters but no import into active `src/` or `apps/` was found in the checked baseline. | Whether an external client, untracked plugin or legacy deployment uses it. Treat as possibly dormant; **do not delete based on import search**. |
| U3 | `package.json` defines `verify:prod-readiness` pointing at `scripts/verify-production-release-readiness.ts`, which is absent from the tracked `prod-release` inventory. | Whether a separate branch/workspace or CI workflow supplies it; do not assume the npm script works. |
| U4 | `AutomationEngine.getSchedulerStatus` requires `AIRA_SERVERLESS_CRON_CONFIGURED=true` plus an actual cron caller, but baseline `vercel.json` contains no `crons`. | Whether an independently configured external scheduler exists, if it is authenticated and if cron work runs in deployed environment. |
| U5 | `vercel.json`, `AGENTS.md`, worker source and migrations describe expected production/staging topology. | Live Vercel SHA/settings, linked aliases, real Neon branch/schema/migration state, worker/Oracle VM activation, network and recovery readiness were **not** queried. Repository docs are not live proof. |
| U6 | Model adapters, vision, E2B/OCI builder, Tavily/Exa, OAuth and payment gateways have configured-client code. | Actual provider keys, entitlements, upstream API versions/rate limits, payment settlement, sandbox capacity and fallback behavior in production. |
| U7 | `ConversationEmbeddingIndexer` and Postgres migration `014` reference pgvector; deploy verification checks it conditionally. | Whether extension, vector column, index state and embedding backfill are healthy on each environment. |
| U8 | Client memory localStorage and server `memory_records` use separate implementations; PR #128 scopes the client vault. | Any synchronization/migration between these stores, or interaction with third-party `@agentmemory/agentmemory` server, has **not** been established from an active call path. |
| U9 | Shared `src/components/*` can depend on CSS, media, `localStorage`, event-driven props and runtime feature flags without explicit import edges. | Full browser accessibility/performance cross-viewport impact and dynamically discovered consumers require visual/browser acceptance for a concrete change. |
| U10 | PR #127 is draft/unmerged with `031` and separate sidecar/Oracle production infrastructure; PR #128 is draft/unmerged with client memory fixes. | Integration ordering, migration application, live worker standby, multi-account acceptance, sidecar security and release authorization cannot be verified from these source diffs. Rebase/re-audit this map against their **actual merged SHA** if approved. |
| U11 | API routes include webhook handlers mounted at both early app level and in billing router, plus dynamic tools/MCP registrations. | Which handler is reached under each deployment mode, external webhook delivery configuration, and dynamically registered remote tools require runtime route traces; avoid assuming imports expose the full graph. |
| U12 | Several source paths derive feature availability from `process.env`/network and a local in-memory fallback; worker behavior depends on runtime `DATABASE_URL`, flags and host lifecycle. | Actual use of in-memory vs persistent implementations and durability across restarts in each environment. Verify from redacted startup telemetry/approved staging tests rather than extrapolating. |

## 7. Maintenance rule and audit procedure

Update this file **in the same reviewable change** whenever a route, schema, event, permission boundary, shared interface, worker, scheduled trigger, external integration, release gate or frontend state owner materially changes.

1. Freeze an exact repository ref and enumerate *all tracked files* (including generated configuration, hooks, scripts, workflow definitions and non-TypeScript entry points). Identify added/deleted files against the previous mapped SHA.
2. Search forward and backward: imports/exports, symbols/call sites, route mounts, dependency injection, reflection/dynamic registry, events, hooks, IPC, scheduled invocations, queues and generated clients. For any language/framework, use its actual parser/call graph when available; **do not substitute an import graph for the full impact graph**.
3. Search storage and boundaries: SQL/table/column literals, migrations, constraints, ORM models, indexes, caches, browser storage keys, file paths, auth scope keys, HTTP/SSE/MCP/webhook payloads, env flags, Docker/CI/deploy contracts and third-party endpoints.
4. Trace at least one complete user/admin workflow across those edges, then test the changed boundary plus its nearest cross-layer and negative authorization regressions. Use disposable databases and isolated staging; never run production tests/migrations merely to populate the map.
5. Record each relationship as **Verified**, **Potential** or **Unknown**, with exact `path:symbol` evidence. Remove stale assertions rather than accumulating historical conjecture; retain draft-only rows until merged or closed, then refresh their status.
6. Update baseline SHA, review `AGENTS.md` for release authority changes, preserve docs unrelated to this map, and submit via PR against `prod-release`. A map update by itself **never** authorizes a production merge, deployment or migration.

**Explicit non-claims:** This is a source-derived change-investigation index, not a complete transitive runtime trace, a claim of test passage, a vulnerability report, a production deployment inventory, or approval to change live systems. Its value is to tell the next developer **where to look and what to verify**, with uncertain edges kept visible.
