# Aira Bot Phase 7 — Live Distributed Runtime

Status: **Integration implemented; exact-head CI and review required before merge.**

Draft PR #12 continues merged Phase 6 baseline `5aabe0e`. The PostgreSQL foundations now serve live API startup, managed computer actions, runner authority, routine dispatch and durable event delivery. No production deployment is included.

## Durable authority and actions

Production uses database-backed computer leases. The in-memory manager remains for explicitly selected local fixtures. Bot authority is bound to the captured run execution owner/fence, not just a reusable run ID. Action preparation locks and validates current run and computer authority using database time.

Every mutation commits a STARTED action before an external effect. One unresolved action per owner is enforced by a partial unique index. Expiry, takeover and release cannot bypass it. Human callers supply and retain `Idempotency-Key`; changed arguments under the same key are rejected. The browser persists a digest-keyed identifier in session storage across uncertain responses/reloads, clearing it only after a successfully parsed response. Bodies and lease tokens are not persisted there.

The runner requires signed method/route/body/action/lease authority. Its persistent `/data/.control` journal fsyncs fencing high-water marks and STARTED receipts before execution, and completed receipts before replying. Completed replays return stored responses; STARTED replays never execute again. Authority expires no later than the captured run/computer lease. Synchronize runner clocks; PostgreSQL time governs coordination.

A saved runner receipt recovers a lost API acknowledgement. An effect without a completed receipt is deliberately ambiguous, not exactly-once. New actions remain blocked. Inspect `GET /bots/:id/computer/actions`; explicit acknowledgement uses `POST /bots/:id/computer/actions/:actionId/acknowledge` with `acknowledgeMayHaveExecuted: true`. It first serializes durable runner revocation, blocking delayed replay, then abandons the database action. It does not undo the effect, and the old identifier remains rejected.

## Durable delivery

Computer events use owner-global cursors for cross-instance polling/SSE replay. Action completion atomically commits its result and outbox record. The live publisher uses attempt-fenced claims, bounded exponential retry and unique event `source_key` deduplication. Delivery is at least once; canonical completion redelivery does not duplicate its event. Direct operational audit events remain separate.

## Lifecycle and readiness

API startup starts receipt recovery, interrupted-run recovery, heartbeat/leadership, guarded lifecycle reconciliation and the publisher. Shutdown stops timers and the routine engine. Lifecycle intent is persisted only inside accepted action authority; observations match exact generations.

`/api/health` is liveness. `/api/ready` requires completed startup, database availability, this API instance's own fresh heartbeat, active routine leadership and no lifecycle backlog. Another healthy API cannot hide this instance's stale heartbeat. Database loss returns 503. Outbox depth is diagnostic, not evidence of successful delivery. Provider lifecycle responses reporting ERROR remain unreconciled and are never published as successful transitions.

## Routine and worker recovery

The routine engine checks database-backed leadership. Unique slots have expiring dispatch tokens and monotonic fences. Immutable routine snapshots survive dispatcher death and later configuration edits. Run persistence, task registration and slot attachment commit together under the dispatch fence. Expired orphan claims are reclaimed; stale completion/failure cannot overwrite recovered slots. Cursors never regress.

Periodic run recovery skips active execution leases and approval waits. Expired interrupted workers use normal execution fencing. Uncertain external effects are never blindly retried.

## Verification

- `test:bot:worker-leases`: Phase 6 atomic execution writes/events and stale-worker rejection.
- `test:bot:distributed-runtime`: real PostgreSQL, eight OS workers, skewed clocks, first claims, lock-wait expiry, lifecycle generations, outbox attempts and readiness.
- `test:bot:live-runtime`: actual BotRouter/AgentRuntime/managed-provider HTTP path in separate API processes and the actual runner. Covers cross-instance ownership/files/events, request-key conflicts, rejected runner authority, killed API receipt recovery, runner crash ambiguity/revocation, killed execution-worker recovery, orphan routine dispatch and real database network interruption.
- `AIRA_TEST_USE_DOCKER_RUNNER=true`: same integration against a persistent Docker container, including Chromium start/stop.
- CI repeats leases/foundations five times, builds the image, runs native and Docker live gates, then computer/browser regressions.

Use only a test PostgreSQL account allowed to create/drop disposable databases. Never point certification at production.

## Boundaries

API instances must share PostgreSQL, runner secret, Docker engine and durable owner volumes. Multi-host runner routing is not implemented. Arbitrary external effects are not guaranteed exactly once. One runner per owner volume and trusted host/terminal administration are assumed; deleting/modifying the journal invalidates receipt guarantees. Docker CLI lifecycle interruption may require operator restoration before acknowledgement.

Native tests do not certify the Docker deployment host. The CI container gate tests the image/shared protocol with injected provider address resolution for fixture isolation; production Docker allocation and the deferred Oracle Cloud host smoke remain separate promotion gates. Real model-provider calls and Firebase sign-in still require credentials.

Migration 014 is additive repository schema work. No production migration, host change or deployment has occurred. Keep PR #12 draft and unmerged until exact-head terminal CI success and review.
