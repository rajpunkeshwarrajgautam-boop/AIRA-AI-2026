# Aira Bot Phase 7 — Distributed Runtime Reliability

Status: **IN PROGRESS — distributed foundations, not an end-to-end Phase 7 certification.**

This branch continues PR #12 on the merged Phase 6 baseline (`5aabe0e`). PostgreSQL-backed coordination primitives exist for computer ownership, event cursors, scheduler leadership, outbox claims, runtime heartbeats, and desired/observed lifecycle state. The live API is not yet wired to all of them. A green foundations test or repository workflow must not be reported as a complete Phase 7 PASS.

## Durable computer ownership

`aira_computer_leases` stores one lease per AIRA owner. First claims materialize a sentinel row before locking, so a missing row cannot allow concurrent winners. Every ownership change advances a monotonic fence; release expires the row instead of deleting the fencing high-water mark. Bot runs cannot steal a live human lease or another holder's live lease. Human takeover may explicitly preempt BOT ownership. Tokens and optional fences reject stale assertions/releases. Renewal locks the row and reads PostgreSQL wall-clock time after the lock wait; caller clocks never determine lease validity.

The existing `ManagedComputerRuntime` and API still use the in-memory `ComputerLeaseManager`. The coordinator is a foundation for replacing that path, not evidence that the live path is horizontally safe. Integration must bind computer authority to the current run execution fence, not just a reusable run ID, and enforce authority at the side-effect boundary.

## Durable computer events

`aira_computer_event_sequences` allocates owner-global monotonically increasing cursors transactionally. `aira_computer_events` stores replayable events keyed by `(owner_id, sequence)`. A reconnecting API instance can replay after a cursor without depending on the process that originally observed the action.

## Transactional outbox

`aira_runtime_outbox` provides deduplicated durable delivery records. Claims use row locks with `SKIP LOCKED`; expired claims are reclaimable after worker death. Completion/retry requires the captured attempt number as well as the worker ID and an unexpired claim. Reusing a worker ID cannot acknowledge an older attempt. Consumers must be idempotent by dedupe key: delivery is at least once, not exactly once. No production publisher has been integrated yet.

## Scheduler leadership and recovery

`aira_scheduler_leases` provides fenced leadership using database time and serialized first claims. `RuntimeReliabilityService` heartbeats its runtime instance and renews/acquires the `aira-bot-routines` leadership lease. Leadership assertions consult PostgreSQL rather than trusting a cached token; heartbeat failure clears cached authority. The live routine engine is not yet connected to the service. Routine slot uniqueness prevents duplicate slot claims but does not alone establish crash-safe job delivery after a claim.

## Computer lifecycle reconciliation

`aira_computer_instances` records desired and observed state with generation numbers. Concurrent first intents are serialized. Observations must match the exact current generation. A reconciler locks the lifecycle row across its idempotent provider lifecycle call, observation, and durable notification. Competing reconcilers cannot concurrently apply the same generation. Provider errors remain in the backlog; process death rolls back database progress. Observation and outbox notification commit together.

Provider lifecycle operations must tolerate retry after an ambiguous crash. PostgreSQL cannot roll back an external Docker/browser action. These primitives do not guarantee exactly-once arbitrary tool side effects. Live API intent, lifecycle calls, and provider failure recovery remain integration work.

## Health and readiness contract

`RuntimeReliabilityService.health()` distinguishes liveness from distributed readiness inputs. Database failure reports not ready. Foundation readiness requires a fresh API instance heartbeat, the specific routine leadership lease, and no reconciliation backlog. Historical dead-instance rows are diagnostics rather than a permanent outage. Pending outbox depth is reported, not treated as proof of successful delivery. The live public API probes still need integration and multi-instance HTTP tests.

## Certification

`npm run test:bot:distributed-runtime` invokes actual coordinator/service methods against an isolated real PostgreSQL database with the repository migrations. Eight separate OS workers use independent pools and deliberately skewed clocks. Five contention rounds each cover first computer claims, scheduler claims, lifecycle generations, and event allocation. The gate also covers:

- release/reacquisition fencing and stale owner rejection;
- expiry during actual row-lock waits;
- killed lease owners and killed reconcilers;
- replay from a new coordinator instance;
- outbox dedupe, exclusive claims, reclaim and same-worker attempt fencing;
- atomic observation/outbox rollback under an injected database constraint failure;
- competing reconcilers, provider failure retry, heartbeat loss and readiness inputs.

Set `AIRA_TEST_DATABASE_URL` or `DATABASE_URL` to a test PostgreSQL account allowed to create/drop disposable databases. Never point this test at production. The normal workflow repeats the worker and distributed foundation gates five times each before computer/browser E2E.

## Remaining Phase 7 acceptance gates

1. Replace process-local computer ownership and event replay in the live managed runtime/API with durable authority and cursors, preserving human takeover behavior.
2. Fence computer actions at the runner/provider boundary and introduce durable action receipts or an explicit fail-closed ambiguity contract for non-idempotent actions. Cover crash after a side effect but before acknowledgement.
3. Connect lifecycle intent/reconciliation and truthful readiness to API startup/shutdown. Verify two actual API instances and provider restart recovery.
4. Connect routine leadership and crash-safe job dispatch; integrate an idempotent outbox publisher with retry/backoff.
5. Exercise real worker/runner process interruption and database connectivity loss, not only coordinator methods. Re-run all Phase 6 gates and require exact-head terminal CI success before complete Phase 7 certification.

The draft PR must remain unmerged until these integration gates and review are complete.

## Deployment boundary

This phase changes repository schema and coordination semantics but does not run production migrations or mutate the deferred Oracle Cloud host. The deployment-host Docker smoke gate remains separate and must be run before production promotion.
