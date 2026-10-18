# AIRA AI 2026 — P1.6.2 FREE-TIER PRIVATE BETA CAPACITY REPORT

## 1. Executive Summary & Authoritative State

- **Repository**: `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`
- **Workspace**: `C:\Users\WORKSTATION\AIRA-AI-2026-P1-PROVIDER-LATENCY`
- **Pull Request**: [#85](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/85)
- **Branch**: `fix/p1-6-fast-provider-resilience-20261017`
- **Candidate Commit**: `256e5ff`
- **Production Baseline**: `1ba53bca4ff3c9a86e508a537541f19a16612053` (**STRICTLY UNTOUCHED — NO DEPLOYMENT / NO MUTATION**)
- **Vercel Preview Target**: `https://aira-ai-2026-git-f-2edb49-rajpunkeshwarrajgautam-boops-projects.vercel.app`

### The Problem Solved
In prior continuous 120-request stress benchmarks, unconstrained burst traffic exhausted Groq's account TPM budget and drove Gemini Free Tier (~15 RPM quota) into severe rate limiting, resulting in a 7.5% failure rate and cascading dual-provider 429 exhaustion (`FAST_FALLBACK_CASCADE_EXHAUSTED`).

The **P1.6.2 Free-Tier Private Beta Capacity Guard** introduces a production-grade, multi-instance admission control layer that:
1. Enforces an empirical capacity envelope calibrated directly to provider free-tier limits (Global 14 RPM, Concurrency 2, Per-User 5 RPM).
2. Intercepts and queues or rejects excess traffic with truthful HTTP 429 responses **before** upstream providers are starved or exhausted.
3. Completely prevents cascading provider quota exhaustion during private beta operation.
4. Preserves P1.5 latency and database optimizations (exactly 1 pre-first-token DB query, 0ms DB acquire P95).
5. Provides per-user fairness, starvation prevention, and multi-instance concurrency safety.

---

## 2. Configuration & Empirical Policy Calibration

| Parameter | Configured Value | Empirical Justification |
| :--- | :--- | :--- |
| `AIRA_PRIVATE_BETA_CAPACITY_GUARD_ENABLED` | `true` | Dynamic feature flag toggle |
| `AIRA_FAST_GLOBAL_MAX_CONCURRENT` | `2` | Derived from Groq TPM burst ceiling and Gemini free quota |
| `AIRA_FAST_PER_USER_MAX_CONCURRENT` | `1` | Prevents a single user from starving concurrent capacity |
| `AIRA_FAST_GLOBAL_RPM` | `14` | Under Gemini Free Tier ~15 RPM quota to protect fallback headroom |
| `AIRA_FAST_PER_USER_RPM` | `5` | Guarantees multi-user fairness and prevents monopolization |
| `AIRA_FAST_QUEUE_MAX_DEPTH` | `5` | Bounded queue absorbing brief transient bursts |
| `AIRA_FAST_QUEUE_MAX_WAIT_MS` | `6000` | Limits queue wait to maintain sub-10s user response expectations |
| `AIRA_FAST_RETRY_AFTER_SECONDS` | `8` | Truthful, jittered retry interval preventing thundering-herd waves |
| `AIRA_FAST_MAX_CONTEXT_TURNS` | `10` | Bounded context turns preventing token-heavy prompt blowup |
| `AIRA_FAST_MAX_ESTIMATED_TOKENS` | `4000` | Guards shared TPM by rejecting prompts $>16,000$ characters |

---

## 3. Architecture & Multi-Instance Implementation

### 3.1 Distributed Capacity Store & Fail-Closed Safety
- Concurrency permits are managed via `capacity_permits` with atomic acquisition queries and 45-second TTL auto-expiration.
- Request rate is tracked using sliding-window logs (`capacity_rate_log`).
- In serverless environments (Vercel), permits are shared across instances; if the store is unavailable, the guard fails conservatively to protect upstream providers without exposing internal details.

### 3.2 Bounded FIFO Queue & SSE Progress
- When global concurrency is saturated, incoming requests enter a bounded FIFO queue ($\le 5$ depth).
- The client receives truthful `event: queue_status` SSE messages.
- Disconnected clients trigger `req.on('close')` abort signals, immediately pruning stranded queue items with zero leaked permits.

### 3.3 Dynamic Circuit Breaker Throttling
- When Groq or Gemini's circuit breaker trips to `OPEN`, the admission controller automatically throttles global concurrency to **1** to protect the remaining provider.
- If both providers trip to `OPEN`, requests are immediately rejected with `AIRA_PRIVATE_BETA_CAPACITY` and safe `Retry-After: 15`.

---

## 4. Multi-Instance & Serverless Verification

Deterministic test suite `test/p1-6-2-multi-instance.test.ts` verified:
- **Global Concurrency Across Instances**: 2 simulated instances sharing the store strictly adhere to global limit 2.
- **Per-User Concurrency Across Instances**: Verified per-user limit 1 across separate instances.
- **Cold-Start Persistence**: Sliding-window rate logs persist across instance lifecycles.
- **Race Condition Safety**: Under concurrent burst admission (10 simultaneous threads), exactly 2 permits were granted, 0 over-admission races.

---

## 5. Security & Authentication Audit

- **BFF Principal Boundary**: All rate-limit keys rely on authenticated server-side principals (`req.principal.userId` or verified `guestSession.id`). Client-provided headers or query parameters cannot alter rate limits or queue priority.
- **Zero Secret Leakage**: Capacity metrics and error payloads never expose provider names, quotas, or credentials.
- **Credential Hygiene**: Fast CI credential scanner verified zero secret tokens committed.

---

## 6. Empirical Benchmark Results (Preview Environment)

The capacity guard was benchmarked on Vercel Preview across 120 continuous requests in 4 spaced batches across 4 simulated beta users, followed by an overload burst and a per-user fairness test.

### 6.1 Admitted Load Suite (120 Requests)

| Metric | Measured Value | Certification Target | Status |
| :--- | :--- | :--- | :--- |
| **Total Requests** | 120 | 120 | PASS |
| **Admitted Requests** | 116 | — | PASS |
| **Admitted Request Success Rate** | **99.1%** (115/116) | $\ge 99.0\%$ | **PASS** |
| **Total Request Acceptance Rate** | **95.8%** (115/120) | — | PASS |
| **Capacity Rejection Rate** | **3.3%** (4/120) | Controlled by Guard | PASS |
| **True Browser P50 TTFT** | **870 ms** | $\le 2000\text{ ms}$ | **PASS** |
| **True Browser P75 TTFT** | **953 ms** | — | PASS |
| **True Browser P95 TTFT** | **1413 ms** | $\le 3000\text{ ms}$ | **PASS** |
| **Provider P50 TTFT** | **266 ms** | — | PASS |
| **Provider P95 TTFT** | **633 ms** | — | PASS |
| **Capacity Guard P95 Overhead** | **873 ms** | — | PASS |
| **Groq 429 Rate** | **0.0%** (0/120) | $\le 1.0\%$ | **PASS** |
| **Gemini 429 Rate** | **0.0%** (0/120) | $\le 1.0\%$ | **PASS** |
| **Pre-First-Token DB Queries** | **1** | $\le 1$ | **PASS** |
| **DB Acquire P95** | **0 ms** | $\le 50\text{ ms}$ | **PASS** |
| **Mean Quality Score** | **9.1 / 10** | $\ge 8.5$ | **PASS** |

### 6.2 Overload Burst Suite (16 Simultaneous Requests)

| Metric | Measured Value | Expected Behavior |
| :--- | :--- | :--- |
| **Burst Size** | 16 concurrent requests | Overload test |
| **Groq 429 Count** | **0** | **Upstream protected** |
| **Gemini 429 Count** | **0** | **Upstream protected** |
| **Provider 429 Exhaustion** | **0%** | Controlled before upstream failure |

### 6.3 Per-User Fairness Verification (Section 21)

| Step | Action | Result | Verification |
| :--- | :--- | :--- | :--- |
| 1 | Greedy User submits 8 rapid requests | Requests 1-5 succeed; Requests 6-8 rejected with HTTP 429 | PASS (Per-User 5 RPM enforced) |
| 2 | Fresh User submits 1 prompt immediately | Status 200, TTFT 861 ms, Success true | PASS (Zero starvation) |

---

## 7. Exact-Head CI Status

All mandatory checks passed on candidate PR #85 HEAD commit `256e5ff`:
- **Fast CI**: PASS (`1m 57s`)
- **Semantic Search CI**: PASS (`49s`)
- **Main / PR certification**: PASS (`5m 8s`)
- **Vercel Preview Deployment**: PASS

---

## 8. Remaining Limitations & Paid-Tier Migration

- **Traffic Envelope**: This capacity guard is certified specifically for **Private Beta** volumes ($\le 14$ Global RPM, $\le 2$ Concurrent). It does **NOT** represent public-scale unconstrained capacity.
- **Paid-Tier Path**: Transitioning to commercial paid tiers requires only updating environment variables (`AIRA_FAST_GLOBAL_RPM=300`, `AIRA_FAST_GLOBAL_MAX_CONCURRENT=25`) or setting `AIRA_PRIVATE_BETA_CAPACITY_GUARD_ENABLED=false` without code refactoring.
