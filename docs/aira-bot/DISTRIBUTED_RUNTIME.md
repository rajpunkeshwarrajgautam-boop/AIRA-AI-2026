# Aira Bot Phase 7 — Distributed Runtime Reliability

Phase 7 removes correctness assumptions that depend on one Node.js process. PostgreSQL is the coordination authority for computer ownership, event cursors, scheduler leadership, outbox delivery, runtime heartbeats, and desired/observed computer lifecycle state.

## Durable computer ownership

`aira_computer_leases` stores one lease per AIRA owner. Every ownership change advances a monotonic fence. Bot runs cannot steal a live human lease or another run's live lease. Human takeover may explicitly preempt BOT ownership. Release/assert operations can include token + fence so a stale process cannot mutate a newer owner's computer after failover.

The pre-Phase-7 in-memory `ComputerLeaseManager` remains only as a compatibility/local-provider primitive. Production distributed coordination is provided by `DistributedRuntimeCoordinator`; new production lifecycle integrations must use its durable lease methods.

## Durable computer events

`aira_computer_event_sequences` allocates owner-global monotonically increasing cursors transactionally. `aira_computer_events` stores replayable events keyed by `(owner_id, sequence)`. A reconnecting API instance can replay after a cursor without depending on the process that originally observed the action.

## Transactional outbox

`aira_runtime_outbox` provides deduplicated durable delivery. Records have a stable `dedupe_key`, availability time, attempts, worker claim lease, and terminal `PUBLISHED` state. Claims use row locks with `SKIP LOCKED`; expired claims are reclaimable after worker death. Consumers must be idempotent by dedupe key.

## Scheduler leadership and recovery

`aira_scheduler_leases` provides fenced leadership. `RuntimeReliabilityService` heartbeats its runtime instance and renews/acquires the `aira-bot-routines` leadership lease. Routine slot uniqueness remains the final exactly-once scheduling guard, so leadership reduces duplicate work but is not the sole correctness mechanism.

## Computer lifecycle reconciliation

`aira_computer_instances` records desired and observed state with generation numbers. API intent increments `generation`; a reconciler applies the desired state to the provider and advances `observed_generation`. After API or Docker-host restart, any `generation > observed_generation` or desired/observed mismatch is recovered from PostgreSQL and reconciled again. Stale observations cannot overwrite a newer generation.

## Health and readiness contract

`RuntimeReliabilityService.health()` distinguishes liveness from distributed readiness inputs. Liveness means the process can answer. Readiness verifies PostgreSQL access and reports scheduler leadership visibility, stale runtime instances, lifecycle reconciliation backlog, and pending outbox depth. Production probes should return HTTP 503 when the runtime is not ready rather than reporting a static healthy value.

## Certification

`npm run test:bot:distributed-runtime` certifies durable fenced ownership, stale-token rejection, replay cursors, outbox dedupe/reclaim, scheduler failover fencing, lifecycle generation recovery, and readiness inputs using an embedded PostgreSQL-compatible PGlite engine. The normal Aira Bot workflow runs this gate before browser/computer E2E.

## Deployment boundary

This phase changes repository schema and coordination semantics but does not run production migrations or mutate the deferred Oracle Cloud host. The deployment-host Docker smoke gate remains separate and must be run before production promotion.
