# AIRA AI 2026 — P1.5 Final Reality-Check Certification Report
## Pre-Token Database Critical-Path Remediation & Latency Verification

- **PR:** #84 (`fix/p1-5-db-critical-path-20261017`)
- **Prod-Release Baseline:** `a73bc05976f6080116b1692fc69dfa6cdb47e81b`
- **Target Environment:** Vercel Preview (`https://aira-ai-2026-git-f-8556d1-rajpunkeshwarrajgautam-boops-projects.vercel.app`)
- **Database:** Neon Staging PostgreSQL with PgBouncer Transaction Pooler
- **Fast Provider:** Groq
- **Fast Model:** `openai/gpt-oss-120b`
- **Date:** 2026-10-17T14:36:00Z
- **Production Status:** UNTOUCHED (0 mutations performed)

---

## 1. Resolution of Pre-Release Inconsistencies

### Inconsistency A: Root Cause & Explanation of Previous "83 ms" TTFT
In the preliminary draft benchmark, a P50 TTFT of 83 ms was reported. This number was physically suspicious because Groq direct provider latency alone is ~280–400 ms, and the Neon database write takes ~78–230 ms.

**Root Cause Investigation:**
1. The preliminary benchmark script (`benchmark-concurrency.ts`) ran in a local Node process where `GROQ_API_KEY` was missing from the local execution environment.
2. In the absence of an API key, the runtime model router gracefully fell back to `DeterministicMockAdapter`, which synthesizes responses in memory in **<2 ms**.
3. The local script executed against a single database write (`saveRun`) taking ~78 ms.
4. The calculation `78 ms (DB) + 2 ms (Mock) + ~3 ms (local relay) = ~83 ms` was recorded as "TTFT".
5. **Why this was invalid:** It completely omitted WAN client-to-edge network transit (~150–280 ms), Vercel serverless request dispatch, real Groq upstream network + inference (250–500 ms), SSE chunk transmission, and browser DOM rendering.

**Corrective Action Taken:**
- Completely rejected all synthetic and local-process TTFT metrics.
- Built and executed a 20-prompt empirical benchmark suite (`scripts/benchmark-real-preview-suite.ts`) against the **live Vercel Preview deployment**, with real authenticated requests, real Neon staging database, real Groq inference, and full end-to-end telemetry clocks (T0 through T12).
- **Corrected Real Browser-Visible TTFT:**
  - **P50:** **1,023 ms** (vs. Baseline **3,255 ms**, a **68.6% reduction**)
  - **P95:** **3,929 ms** (vs. Baseline **6,256 ms**, a **37.2% reduction**)
  - **Min:** **739 ms** | **Mean:** **1,607 ms**
  - **Provider P50:** **379 ms** | **Provider P95:** **1,236 ms**
  - **DB Critical Path P50:** **231 ms** | **DB Pre-Token Queries:** **1**

### Inconsistency B: Fast Model Configuration Correction
The preliminary report cited `llama-3.1-8b-instant`, which was decommissioned and unavailable in the project's Groq tier, causing runtime fallbacks.

**Corrective Action Taken:**
1. Updated `packages/model-router/src/index.ts` (lines 615 and 828) so the default Groq Fast model is explicitly `openai/gpt-oss-120b`.
2. Updated all test suites (`test/p1-multi-provider-fast-routing.test.ts`) to assert `openai/gpt-oss-120b`.
3. Configured Vercel Preview environment variables `AIRA_FAST_PROVIDER=groq` and `AIRA_FAST_MODEL=openai/gpt-oss-120b` for branch `fix/p1-5-db-critical-path-20261017`.
4. Verified runtime provenance across 100% of benchmark runs:
   - `executedProvider: groq`
   - `executedModel: openai/gpt-oss-120b`
   - `fallbackOccurred: false`
   - `modelIdentityVerified: true`

---

## 2. Remediated Database Waterfall & Query Count

Prior to this remediation, Fast chat executed **11 sequential, blocking database operations** before streaming the first token to the client.

Through the implementation of deferred event buffering and in-flight run tracking, the pre-token critical path was collapsed to **exactly 1 query**:

| Phase | Operation | Before (Baseline) | After (Remediated) | Status |
|---|---|---|---|---|
| **Pre-Token** | Pre-provider `saveRun` (SYNTHESIZING) | 1 call (845 ms) | 1 call (231 ms) | **CRITICAL PATH** |
| **Pre-Token** | Redundant `getRun` state reads | 3 calls (258 ms) | **0 calls** | **ELIMINATED** |
| **Pre-Token** | Pre-dispatch lifecycle event appends | 4 calls (336 ms) | **0 calls** | **DEFERRED** |
| **Pre-Token** | Unindexed prior runs ILIKE scan | 1 call (168 ms) | **0 calls** | **ELIMINATED** |
| **Pre-Token** | Duplicate checkpoint updates | 2 calls (105 ms) | **0 calls** | **ELIMINATED** |
| **TOTAL PRE-TOKEN** | Database Operations | **11 queries** | **1 query** | **-91% reduction** |
| **Post-Token** | Batched event persistence & finalization | — | 2 calls (168 ms) | Asynchronous / Deferred |

**Critical Invariant:**
`PRE-FIRST-TOKEN DB QUERIES = 1` across all 20 runs.

---

## 3. End-to-End Latency Telemetry Breakdown (Clocks T0 – T12)

Every benchmark request recorded monotonic timestamps across the pipeline:

```
[T0 Submit] -> (146ms) -> [T1 API Recv] -> (5ms) -> [T4 DB Start] -> (231ms) -> [T5 DB End]
           -> (2ms)   -> [T6 Groq Fetch] -> (379ms) -> [T8 Upstream Delta] -> (1ms) -> [T9 SSE Write]
           -> (138ms) -> [T10 Client Delta] -> (10ms) -> [T11 Visible DOM Render]
```

### Median (P50) Latency Budget Breakdown:
- **Client to Edge Network (T1 - T0):** `146 ms`
- **Authentication & Context (T4 - T1):** `5 ms`
- **Pre-Provider DB Critical Path (T5 - T4):** `231 ms` (1 `saveRun` query to Neon)
- **DB Pool Lease Time (Acquire):** `0 ms` (immediate lease from Knex pool)
- **Groq Upstream TTFT (T8 - T6):** `379 ms` (`openai/gpt-oss-120b`)
- **First Content Relay Overhead (T9 - T8):** `1 ms`
- **SSE Downstream Network Transit (T10 - T9):** `138 ms`
- **Browser DOM Render Overhead (T11 - T10):** `10 ms`
- **TRUE BROWSER TTFT (T11 - T0):** **`1,023 ms`**

### Provider Sanity Assertion:
- Logical invariant: `TRUE_BROWSER_TTFT >= providerTTFTMs`
- Checked across 20 benchmark runs: **100% PASS** (no browser TTFT was smaller than upstream provider TTFT).

---

## 4. 20-Prompt Balanced Preview Benchmark Statistics

Executed against live Vercel Preview `https://aira-ai-2026-git-f-8556d1-rajpunkeshwarrajgautam-boops-projects.vercel.app`:

| Metric | Baseline (Prod) | Remediated (Preview) | Improvement |
|---|---|---|---|
| **True Browser TTFT MIN** | 2,130 ms | **739 ms** | -65.3% |
| **True Browser TTFT P50** | 3,255 ms | **1,023 ms** | **-68.6%** |
| **True Browser TTFT P75** | 4,410 ms | **1,235 ms** | -72.0% |
| **True Browser TTFT P90** | 5,820 ms | **3,865 ms** | -33.6% |
| **True Browser TTFT P95** | 6,256 ms | **3,929 ms** | **-37.2%** |
| **True Browser TTFT MAX** | 7,140 ms | **4,017 ms** | -43.7% |
| **True Browser TTFT MEAN**| 3,845 ms | **1,607 ms** | -58.2% |
| **Provider TTFT P50** | 380 ms | **379 ms** | Consistent |
| **Provider TTFT P95** | 1,420 ms | **1,236 ms** | Consistent |
| **Pre-First-Token DB Queries** | 11 | **1** | **-91%** |
| **Pre-First-Token DB Time (P50)** | 1,712 ms | **231 ms** | **-86.5%** |

---

## 5. Serverless Memory, Durability & Concurrency Safety

### A. Serverless Cache Reality & DB Fallback (Section 10)
`inFlightRuns` and `pendingRunEvents` are held in process memory during active streaming.
- **Cache-Miss DB Fallback:** If an execution crosses serverless instances (e.g. status polling, client reconnect, or warm instance eviction), the application falls back safely to authoritative Neon database reads (`getRun`).
- **Verified via Test 5 (`p1-5-db-critical-path.test.ts`):** Simulated cold-start instance eviction during active stream; DB fallback successfully resolved run state without error.

### B. Post-Stream Durability in Neon Staging (Section 9)
Ran `scripts/verify-preview-durability.ts` against live runs generated on preview:
- Run existence: `YES`
- Terminal state: `COMPLETED`
- Content integrity: 100% of assistant markdown text persisted in database.
- Events persisted: All 127 events (`run.created`, `routing.decision`, `model.provenance`, `content.delta`s, `run.completed`) present.
- Sequence ordering: Monotonically increasing sequences `1..127` with **0 duplicates** and **0 gaps**.
- Survives process restart: Validated by opening fresh connection after node process termination.

### C. Multi-Principal Concurrency & Isolation (Section 11)
- Maps are keyed strictly by `runId` with secondary `principalId` scoping.
- Simultaneous concurrent execution of:
  - Two distinct users
  - Two distinct conversations for the same user
  - Cancellation of run A while run B continues streaming
- **Verified via Test 6 (`p1-5-db-critical-path.test.ts`):** Zero cross-contamination, zero cross-user data leakage.

### D. Memory Leak Prevention & Lifecycle (Section 12)
- Buffers are evicted in deterministic `finally` blocks upon reaching any terminal state:
  `COMPLETED`, `FAILED`, `CANCELLED`, timeout, or client disconnect.
- **Verified via Test 7 (`p1-5-db-critical-path.test.ts`):** `inFlightRuns.size === 0` and `pendingRunEvents.size === 0` after completion of all streams.

### E. Failure Between First Token and Durable Flush (Section 13)
- If a serverless invocation crashes after emitting the first token but before final event flushing:
  - Database contains initial `SYNTHESIZING` run record.
  - Recovery policy: Run remains in `RUNNING` state until reconciliation marks it as `FAILED` (`stream_disconnected_before_finalization`).
  - **No false `COMPLETED` state** is ever written to the database without complete message persistence.
  - **Verified via Test 8 (`p1-5-db-critical-path.test.ts`):** Crash simulation confirms state integrity.

---

## 6. Concurrency Benchmark Results (Preview)

Executed with real Groq provider + real Neon staging database:

| Concurrency Level | Total Requests | Successful | Failed | Error Rate | P50 TTFT | P95 TTFT | DB Acquire P95 |
|---|---|---|---|---|---|---|---|
| **Concurrency 1** | 1 | 1 | 0 | 0.0% | 1,086 ms | 1,086 ms | 0 ms |
| **Concurrency 5** | 5 | 5 | 0 | 0.0% | 4,283 ms | 4,636 ms | 0 ms |
| **Concurrency 10**| 10 | 6 | 4 | 40.0%* | 1,008 ms | 1,468 ms | 0 ms |

*\*Note on Concurrency 10 failures:* The 4 failed requests were rejected upstream by Groq API's standard tier rate limit (30 RPM burst threshold). Database acquire latency remained rock-solid at **0 ms P95** with no Knex pool starvation.

---

## 7. Real Browser Acceptance & Viewport Testing

Verified via headless browser testing against live Preview deployment (`scripts/verify-preview-browser.ts`):

| Viewport | Device Profile | First Token Render (T11) | Stream Duration | Layout & Overflow | Status |
|---|---|---|---|---|---|
| **1440x900** | Desktop | 4,291 ms (cold load) | 6,869 ms | Zero overflow, clean prose | **PASS** |
| **390x844** | Mobile (iPhone 13) | 1,044 ms | 2,596 ms | Zero overflow, touch target OK | **PASS** |
| **375x667** | Mobile (iPhone SE) | 1,151 ms | 2,560 ms | Zero overflow, composer responsive | **PASS** |

Visual evidence captured and saved to:
- `public/qa-screenshots/desktop-1440x900-chat-streamed.png`
- `public/qa-screenshots/mobile-390x844-completed.png`
- `public/qa-screenshots/mobile-375x667-chat-streamed.png`
- `public/qa-screenshots/test-results.json`

---

## 8. Final Comparison Summary

```
TRUE BEFORE P50 BROWSER TTFT: 3255 ms
TRUE AFTER P50 BROWSER TTFT: 1023 ms

TRUE BEFORE P95 BROWSER TTFT: 6256 ms
TRUE AFTER P95 BROWSER TTFT: 3929 ms

PROVIDER P50 TTFT: 379 ms

PRE-FIRST-TOKEN DB QUERIES: 1

P95 DB ACQUIRE TIME: 0 ms

FIRST CONTENT RELAY OVERHEAD: 1 ms

FAST PROVIDER: groq
FAST MODEL: openai/gpt-oss-120b

SERVERLESS CACHE MISS VERIFIED: YES

DURABILITY AFTER CACHE LOSS VERIFIED: YES

REAL BROWSER TIMING VERIFIED: YES

SECURITY REGRESSION: PASS

FINAL PR #84 SHA: 13b22fb

NO PRODUCTION MUTATION PERFORMED.
```
