# Project: AIRA Autonomous Intelligence Platform — Staging Certification & Production Hardening (PR #127)

## Architecture
- **Web Application / Frontend**: Next.js / Vite SPA hosted on Vercel (`https://staging.virexaaiventures.com` preview, `https://aira-ai-2026.vercel.app` production).
- **API Serverless Layer**: Express API mounted on Vercel Serverless Functions (`/api/*`), stateless, ephemeral, with 10s execution timeout ceiling.
- **Durable Task Queue & Checkpoints**: Neon Serverless PostgreSQL (`ep-shiny-bird-b3xundyt` staging, `ep-withered-art-b36ox90b` production) with tables `autonomous_agent_tasks`, `durable_browser_sessions`, `specialist_tasks`, `runs`.
- **Specialist Worker Host (`apps/specialist-worker`)**: Standalone background Node.js daemon designed for container/VM hosting (Docker, ECS Fargate, Railway) that polls PostgreSQL with `FOR UPDATE` transactional locks, monotonic fencing tokens, 15s leases, and 3s heartbeats. Currently un-deployed in cloud staging (pending owner decision).
- **Execution Sandboxes**: Python isolated runtime (`resolveIsolatedSandboxProvider`) enforcing container isolation (Docker/OCI/E2B/Lightning) with strict fail-closed fallback (`CONTAINER_ISOLATION_UNAVAILABLE`).
- **Browser Automation & Persistence**: Playwright headless browser with authenticated AES-256-GCM envelope persistence in PostgreSQL (`durable_browser_sessions`).
- **MCP Wire Subsystem**: `McpHost` connecting to Model Context Protocol servers over Streamable HTTP, SSE, and Stdio with credential scrubbing and untrusted data tagging.
- **Persistent Memory**: `BrainV2KnowledgeEngine` with pgvector cosine distance similarity search and task-scoped JSONB working memory.

## Code Layout
- `apps/api/`: Express API application serving HTTP endpoints.
- `apps/specialist-worker/`: Long-running task worker daemon.
- `packages/agent-runtime/`: AutonomousAgentEngine, SpecialistRegistry, DurableTaskScheduler, Postgres repositories.
- `packages/tool-runtime/`: ToolGateway, BrowserAdapter, sandbox integrations.
- `packages/builder-runtime/`: Sandbox providers (Docker, OCI, E2B, Lightning, Local).
- `packages/mcp/`: McpHost, Streamable HTTP/SSE/Stdio transport handlers.
- `packages/knowledge/`: BrainV2KnowledgeEngine, pgvector repositories, memory lifecycle.
- `packages/db/`: Knex migrations, connection pools, isolation guards.
- `test/`: Comprehensive autonomous platform regression and adversarial test suites.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Test Count Reconciliation | Reconcile 92 vs 96 tests with runner output; explain PR table arithmetic | M1 | Directive 1 |
| 2 | Certification Accuracy Audit | Classify all tests into Unit, Local Integration, Disposable CI, Preview, Staging; update certification artifact | M1 | Directive 1 |
| 3 | PostgresAutonomousTaskRepository Integration | Wire `AutonomousAgentEngine` in runtime to use PostgreSQL repository when database is configured | M2 | Architectural Survey |
| 4 | Worker Autonomous Task Polling | Extend worker host or bridge to lease and recover `autonomous_agent_tasks` in addition to `specialist_tasks` | M2 | Architectural Survey |
| 5 | Non-Destructive Migration Rollback | Replace destructive `dropTableIfExists` in migration 031 with safe forward-fix and Neon snapshot strategy | M2 | Directive 5 |
| 6 | Staging Schema & Idempotency Verification | Verify migration 031 schema, unique constraint `uq_auto_tasks_idempotency`, and index topology | M3 | Directive 3 |
| 7 | Staging Subsystem Integration Audit | Verify Python sandbox fail-closed, AES-256-GCM browser persistence, MCP wire auth, pgvector memory, and DB isolation | M3 | Directive 3 |
| 8 | Specialist Worker Deployment Assessment | Detail exact deployment status of `apps/specialist-worker`, why it's not live on Vercel, and hosting prerequisites | M3 | Directive 2 |
| 9 | End-to-End Autonomous Mission Execution | Execute complete 10-step autonomous mission (planning, delegation, MCP, sandbox, browser, checkpoints, recovery, memory, artifact, response) | M4 | Directive 4 |
| 10 | Adversarial Scenario Verification | Verify approval denial, cancellation, sandbox failure, DB outage, cross-tenant isolation | M4 | Directive 4 |
| 11 | Full Regression & Security Verification | Execute all 13 autonomous suites, TypeScript checks, linter, secrets audit, and build | M5 | Directive 6 |
| 12 | PR #127 Update & Staging Certification Delivery | Commit validated fixes, push to branch, update PR #127 body in Draft, produce final human certification report | M5 | Directive 6 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Certification Accuracy & Test Reconciliation | Reconcile 92 vs 96 tests, audit certification claims, update certification artifact and PR table | None | DONE |
| M2 | Architectural Defect Remediation & Migration Safety | Wire Postgres repository in agent runtime, bridge autonomous task leasing, implement non-destructive migration 031 safety | M1 | IN_PROGRESS |
| M3 | Staging Infrastructure & Deployment Reality Audit | Audit staging Neon schema, verify sandbox/browser/MCP/memory/isolation, document worker hosting reality | M2 | PLANNED |
| M4 | E2E Autonomous Mission & Adversarial Hardening | Execute full 10-step mission and 5 adversarial failure scenarios with complete evidence capture | M2, M3 | PLANNED |
| M5 | PR #127 Finalization & Certification Report | Run full CI suites, typechecks, build, commit/push, update PR #127 in Draft, deliver final certification report | M1, M2, M3, M4 | PLANNED |

## Interface Contracts
### API ↔ AutonomousAgentEngine
- `POST /api/agent/autonomous/tasks` -> `AutonomousAgentEngine.createTask(objective, principal, plan)`
- Returns `{ task: AutonomousAgentTask }` with `taskId`, `state: 'CREATED'`.
- `AutonomousAgentEngine.startTask(taskId)` transitions to `RUNNING` and executes or enqueues for worker leasing.
- State schema: `CREATED` | `PLANNING` | `RUNNING` | `PAUSED_FOR_APPROVAL` | `COMPLETED` | `FAILED` | `CANCELLED` | `TIMED_OUT`.

### SpecialistWorkerHost ↔ PostgreSQL
- Atomic lease claim: `trx('table').where({ id }).forUpdate()` -> sets `lease_owner`, `lease_expires_at = now + 15000`, `fencing_token = token + 1`.
- Heartbeat renewal: `UPDATE table SET lease_expires_at = now + 15000, heartbeat_at = now WHERE id = :id AND lease_owner = :workerId AND fencing_token = :token`.
- Lease reclamation: `SELECT ... WHERE lease_expires_at < now AND state NOT IN (terminal)` -> transitions to `RETRY_WAIT` (or `TIMED_OUT` if retries exhausted).

### BrowserAdapter ↔ DurableBrowserSessions
- Envelope: `{ version: 1, principalId, workspaceId, sessionKey, iv, tag, data }` encrypted with AES-256-GCM.
- Rejection on tamper, outage, or cross-tenant restore -> fail-closed security.
