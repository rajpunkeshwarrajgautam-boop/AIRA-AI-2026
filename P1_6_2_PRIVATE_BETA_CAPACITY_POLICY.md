# AIRA AI 2026 — P1.6.2 FREE-TIER PRIVATE BETA CAPACITY POLICY

## 1. Executive Summary & Purpose

AIRA operates with a high-performance Fast route leveraging **Groq** (`openai/gpt-oss-120b`) as its primary provider and **Google Gemini** (`gemini-3.5-flash-lite`) as its independent fallback. Under unconstrained continuous burst traffic (as demonstrated in continuous 120-request benchmarks), Groq reaches account-level TPM limits and Gemini free-tier credentials experience severe rate limits (~15 RPM quota), culminating in cascading 429 errors (`FAST_FALLBACK_CASCADE_EXHAUSTED`).

The **Private Beta Capacity Guard** implements an evidence-based, serverless-native admission control layer. It enforces strict concurrency, sliding-window request rate budgets, token expenditure caps, per-user fairness, and bounded queueing. Crucially, it throttles or cleanly rejects excess traffic **before** upstream providers are starved or exhausted, maintaining a $\ge 99\%$ success rate for all admitted requests while preserving low TTFT (P50 $\le 2000$ ms) and zero database regressions.

---

## 2. Empirical Free-Tier Constraints

The capacity policy is calibrated directly from empirical stress measurements on live provider tiers:

| Provider / Tier | Enforced / Observed Limit | Measured Bottleneck | Policy Calibration |
| :--- | :--- | :--- | :--- |
| **Groq (Free/Developer Tier)** | Account-level TPM (~8,000 TPM) & burst limits | Multi-turn token exhaustion under parallel load | Max 2 global concurrent requests, token estimator rejecting prompts $>16,000$ chars |
| **Gemini (Free Tier)** | ~15 RPM quota on current credentials | 429 Resource Exhausted during sustained fallback bursts | Global 14 RPM admission limit, fallback headroom preserved |
| **Fast Combined Route** | 14 RPM aggregate, 2 concurrent maximum | Cascading dual-provider failure under $>2$ concurrent requests | Admission envelope throttles to 1 concurrent during degraded provider states |

---

## 3. Configuration Contract & Environment Variables

All limits are centralized, strictly typed, and dynamically configurable via environment variables with safe defaults:

```bash
# Feature Flag (Default: true)
AIRA_PRIVATE_BETA_CAPACITY_GUARD_ENABLED=true

# Global Concurrency (Default: 2)
AIRA_FAST_GLOBAL_MAX_CONCURRENT=2

# Per-User Concurrency (Default: 1)
AIRA_FAST_PER_USER_MAX_CONCURRENT=1

# Global Sliding-Window Rate Limit (Default: 14 RPM)
AIRA_FAST_GLOBAL_RPM=14

# Per-User Sliding-Window Rate Limit (Default: 5 RPM)
AIRA_FAST_PER_USER_RPM=5

# Queue Configuration
AIRA_FAST_QUEUE_MAX_DEPTH=5
AIRA_FAST_QUEUE_MAX_WAIT_MS=6000
AIRA_FAST_RETRY_AFTER_SECONDS=8

# Context Bounding
AIRA_FAST_MAX_CONTEXT_TURNS=10
AIRA_FAST_MAX_ESTIMATED_TOKENS=4000
```

---

## 4. Admission Control Algorithm & Architecture

### 4.1 Sliding-Window Log Rate Limiting
Rather than simplistic fixed-window counters that permit double-rate boundary spikes, the capacity guard uses a **Sliding Window Log** (`capacity_rate_log`).
- Computes active request count within the trailing 60,000 ms window:
  $$\text{Count}(t) = |\{ r \in \text{Log} \mid r.\text{timestamp} > t - 60000 \}|$$
- If $\text{Count}(t) \ge \text{MaxRPM}$, calculates exact millisecond wait until the oldest entry expires:
  $$\Delta t_{\text{reset}} = 60000 - (t - t_{\text{oldest}})$$
  Emits a truthful, jittered `Retry-After` header: $\lceil \Delta t_{\text{reset}} / 1000 \rceil + \text{jitter}(1..3)$.

### 4.2 Distributed Concurrency Leases & Safe Permit Release
Concurrency is tracked across serverless instances using an atomic lease table (`capacity_permits`) with an automatic 45-second TTL:
- Atomic lease acquisition via `INSERT INTO capacity_permits ... WHERE (SELECT COUNT(*) < MaxConcurrent)`.
- Guarantees zero permit leaks upon client aborts, stream completions, server crashes, or unhandled exceptions via idempotent `release()` callbacks registered on HTTP `req.on('close')`.

### 4.3 Bounded FIFO Queue & Async Polling
When global concurrency is saturated but rate limits permit and queue capacity is available ($\text{Depth} < 5$):
- Request is suspended asynchronously in memory without blocking event loops.
- Emits truthful SSE progress events (`event: queue_status`) to notify the client without sending fabricated token streams.
- Periodic queue poller (50ms interval) checks for released permits and resolves the suspended request immediately upon availability.
- Requests exceeding `AIRA_FAST_QUEUE_MAX_WAIT_MS` (6000ms) or cancelled via client disconnect (`req.on('close')`) are immediately pruned with zero leaked permits.

### 4.4 Token-Sensitive Prompt Bounding
Shared free-tier token budgets (TPM) are guarded before dispatch:
- Estimated request cost: $\text{Tokens} \approx \frac{\text{len(prompt)} + \text{len(context)}}{4} + 1024$.
- If estimated tokens exceed 4,000 (~16,000 characters), the request is rejected immediately with `AIRA_PROMPT_TOO_LARGE` to prevent a single oversized query from exhausting the shared pool.

---

## 5. Circuit Breaker Integration & Dynamic Throttling

The capacity guard interfaces directly with `ProviderHealthTracker`:
- **Groq Circuit OPEN**: Global concurrency throttled down to **1** to prevent Gemini Free Tier (15 RPM) from immediate cascade exhaustion.
- **Gemini Circuit OPEN**: Global concurrency throttled down to **1** to protect Groq from unhedged fallback demand.
- **Both Circuits OPEN**: Immediate `REJECT_CAPACITY` with `AIRA_PRIVATE_BETA_CAPACITY` and safe `Retry-After: 15`. No traffic is admitted into a guaranteed failure cascade.

---

## 6. Route Separation

Capacity limits apply strictly to Fast traffic (`aira-fast`, `aira-auto`, or unspecified Fast models):
- **AIRA Deep** (`nvidia/nemotron-3-super-120b-a12b`): Bypasses Fast capacity guard; governed by independent NVIDIA enterprise limits.
- **AIRA Research & Builder**: Separate dedicated workflows; completely unthrottled by Fast limits.

---

## 7. Client & UX Communication Contract

When capacity is exhausted or the queue is saturated, AIRA returns clean HTTP 429 responses with structured payloads:
```json
{
  "error": "AIRA Private Beta is temporarily at capacity. Please retry in a moment.",
  "code": "AIRA_PRIVATE_BETA_CAPACITY",
  "retryAfterSeconds": 8
}
```
- **Header**: `Retry-After: 8`
- **Internal Privacy**: Never exposes provider names, account IDs, TPM limits, or secret keys to clients.

---

## 8. Paid-Tier Migration Path

Transitioning to paid provider tiers (e.g. Groq Tier 3/Enterprise, Google Vertex AI / Gemini Pay-as-you-go) requires **zero architectural refactoring**:
1. Update environment configuration:
   - `AIRA_FAST_GLOBAL_MAX_CONCURRENT=25`
   - `AIRA_FAST_GLOBAL_RPM=300`
   - `AIRA_FAST_PER_USER_RPM=30`
   - `AIRA_FAST_QUEUE_MAX_DEPTH=25`
2. Or toggle feature flag `AIRA_PRIVATE_BETA_CAPACITY_GUARD_ENABLED=false` for completely unthrottled enterprise routing.
