# AIRA AI 2026 — P1.5 Pre-Token Database Waterfall Baseline Report

**Baseline Commit SHA:** `a73bc05976f6080116b1692fc69dfa6cdb47e81b`
**Date:** 2026-10-17T12:58:05.907Z
**Environment:** Staging Neon PostgreSQL / PgBouncer Transaction Pooler

## 1. Executive Summary & Root Cause Confirmation

Our instrumented architectural audit confirms that on normal Fast chat requests, **11 sequential database operations** are executed synchronously before LLM provider dispatch and first token delivery.

- **Total Pre-Provider DB Time:** 1712.46 ms
- **Redundant Read-After-Write Queries:** 4 (`getRun` re-fetching the exact run object just saved)
- **Non-Critical Lifecycle Event Writes:** 6 (`run.created`, `routing.decision`, `run.started`, `model.provenance`)
- **Unindexed Prior Runs Text Scan:** `searchRunsForPrincipal` ILIKE scan on every chat request
- **Knex Pool Impact:** With `pool.max = 2` and `acquireTimeoutMillis = 5000`, executing 7-9 serial queries per request starves connections under serverless concurrency, causing 3,000–6,300 ms TTFT stalls and pool timeouts.

## 2. Complete Baseline Pre-Token Database Waterfall

| # | Operation | Method | SQL Snippet | Req Before Dispatch? | Req Before Token? | Can Defer? | In-Memory Duplicate? | Duration | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `saveRun (create)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | **YES** | **YES** | 829.72 ms | Initial run record created |
| 2 | `getRun` | `getRun` | `SELECT * FROM runs WHERE id = ? LIMIT 1` | **NO** | **NO** | **YES** | **YES** | 122.12 ms | Read-after-write duplicate of run state already in memory |
| 3 | `appendRunEvent (run.created)` | `appendRunEvent` | `INSERT INTO run_events (...) VALUES (...) RETURNING *` | **NO** | **NO** | **YES** | NO | 100.17 ms | Lifecycle event run.created persisted before delivery |
| 4 | `appendRunEvent (routing.decision)` | `appendRunEvent` | `INSERT INTO run_events (...) VALUES (...) RETURNING *` | **NO** | **NO** | **YES** | NO | 82.13 ms | Lifecycle event routing.decision persisted before delivery |
| 5 | `getRun` | `getRun` | `SELECT * FROM runs WHERE id = ? LIMIT 1` | **NO** | **NO** | **YES** | **YES** | 81.36 ms | Read-after-write duplicate of run state already in memory |
| 6 | `getRun` | `getRun` | `SELECT * FROM runs WHERE id = ? LIMIT 1` | **NO** | **NO** | **YES** | **YES** | 80.37 ms | Read-after-write duplicate of run state already in memory |
| 7 | `saveRun (state: RUNNING)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | **YES** | **YES** | 84.19 ms | Updates run.state to RUNNING |
| 8 | `appendRunEvent (run.started)` | `appendRunEvent` | `INSERT INTO run_events (...) VALUES (...) RETURNING *` | **NO** | **NO** | **YES** | NO | 82.98 ms | Lifecycle event run.started persisted before delivery |
| 9 | `saveRun (checkpoint: SYNTHESIZING)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | **YES** | **YES** | 81.5 ms | Updates checkpoint to SYNTHESIZING |
| 10 | `searchRunsForPrincipal` | `searchRunsForPrincipal` | `SELECT * FROM runs WHERE principal_id = ? AND (prompt ILIKE ... OR content ILIKE ...)` | **NO** | **NO** | **YES** | NO | 84.99 ms | Full ILIKE scan for prior runs of principal |
| 11 | `appendRunEvent (model.provenance)` | `appendRunEvent` | `INSERT INTO run_events (...) VALUES (...) RETURNING *` | **NO** | **NO** | **YES** | NO | 82.93 ms | Lifecycle event model.provenance persisted before delivery |
| 12 | `saveRun (checkpoint: SYNTHESIZING)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | **YES** | **YES** | 81.62 ms | Updates checkpoint to SYNTHESIZING |
| 13 | `appendRunEvent (content.delta)` | `appendRunEvent` | `INSERT INTO run_events (...) VALUES (...) RETURNING *` | **NO** | **NO** | **YES** | NO | 81.18 ms | Lifecycle event content.delta persisted before delivery |
| 14 | `saveRun (checkpoint: SYNTHESIZING)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | **YES** | **YES** | 85.53 ms | Updates checkpoint to SYNTHESIZING |
| 15 | `appendRunEvent (model.provenance)` | `appendRunEvent` | `INSERT INTO run_events (...) VALUES (...) RETURNING *` | **NO** | **NO** | **YES** | NO | 81.94 ms | Lifecycle event model.provenance persisted before delivery |
| 16 | `saveRun (checkpoint: FINALIZING)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | **YES** | **YES** | 81.44 ms | Updates checkpoint to FINALIZING |
| 17 | `saveRun (create)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | **YES** | **YES** | 105.53 ms | Initial run record created |
| 18 | `getRun` | `getRun` | `SELECT * FROM runs WHERE id = ? LIMIT 1` | **NO** | **NO** | **YES** | **YES** | 93.59 ms | Read-after-write duplicate of run state already in memory |
| 19 | `saveRun (state: COMPLETED)` | `saveRun` | `INSERT INTO runs (...) VALUES (...) ON CONFLICT (id) DO UPDATE` | **NO** | **NO** | NO | **YES** | 82.87 ms | Final completion state persistence |
| 20 | `appendRunEvent (run.completed)` | `appendRunEvent` | `INSERT INTO run_events (...) VALUES (...) RETURNING *` | **NO** | **NO** | NO | NO | 80.47 ms | Lifecycle event run.completed persisted before delivery |

## 3. Telemetry Event Correlation

- **requestReceived:** 0 ms
- **authDone:** 2.01 ms
- **contextDone:** 2.51 ms
- **routeDone:** 840.59 ms
- **providerStart:** 840.63 ms
- **firstUpstreamDelta:** 1725.22 ms
- **firstDownstreamDelta:** 1727.22 ms
- **persistenceDone:** 2502.58 ms
- **totalDuration:** 2502.61 ms

## 4. Remediation Plan (P1.5 Architecture Contract)

1. **Eliminate Redundant Reads:** Pass in-memory authoritative `Run` state through `createRun` $\to$ `startRun` $\to$ `executeRunLoop` or request cache. Zero `getRun` queries before first token.
2. **Defer & Batch Lifecycle Events:** Forward `run.created`, `routing.decision`, `run.started`, `model.provenance` immediately to the SSE client in-memory; queue DB writes into the existing post-token batch write pipeline (`flushDeltas` / finalization).
3. **Bypass Expensive Prior Run History Scan on Fast Normal Chat:** Only query persistent prior runs if explicitly requested or in multi-turn memory recall modes.
4. **Single Initial Write / Post-Token Write Pipeline:** Ensure provider dispatch begins with $\le 1$ short-lived DB transaction or collapsed write, releasing connection immediately before `adapter.stream`.
5. **Preserve PR #81 & PR #83 Invariants:** Retain batched stream delta writes, sanitized DB errors, zero duplicate stream events, and Groq Fast / NVIDIA Deep route integrity.
