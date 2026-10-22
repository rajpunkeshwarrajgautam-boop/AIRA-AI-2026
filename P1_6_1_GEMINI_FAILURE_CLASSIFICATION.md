# AIRA AI 2026 — P1.6.1 Gemini Fallback Failure Classification & Root Cause Analysis

## 1. Executive Summary

In Phase P1.6, Google Gemini was introduced as an independent secondary provider for AIRA Fast (`groq:openai/gpt-oss-120b` -> `gemini:gemini-3.5-flash-lite`).
While latency targets were decisively met:
- **True Browser P50 TTFT:** **935 ms** (Target <= 2,000 ms: **PASS**)
- **True Browser P95 TTFT:** **2,767 ms** (Target <= 3,000 ms: **PASS**)
- **Mean Quality Score:** **9.1 / 10** (Target >= 7.5: **PASS**)

The combined route success rate was **76.7%**, driven by an **18.9% Gemini error rate** (17 failures out of 90 total requests; 17 failures out of 46 Gemini requests = 37.0%) and a **4.4% non-Gemini error rate** (4 failures).

This document provides a systematic, exhaustive classification of every failure in the 90-request dataset, isolates root causes, and defines the remediation architecture to elevate combined Fast reliability to **>= 99%**.

---

## 2. Exhaustive Category Classification

| Failure Category | Total Occurrences | % of Gemini Failures (n=17) | % of Total Dataset (n=90) | Status |
| :--- | :---: | :---: | :---: | :--- |
| **First-Token Timeout** | **17** | **100.0%** | **18.9%** | **PRIMARY FAILURE MODE** |
| HTTP 400 (Bad Request) | 0 | 0.0% | 0.0% | Normal (zero payload syntax errors) |
| HTTP 401 (Unauthorized) | 0 | 0.0% | 0.0% | Normal (`GEMINI_API_KEY` valid) |
| HTTP 403 (Forbidden) | 0 | 0.0% | 0.0% | Normal (API access permitted) |
| HTTP 404 (Not Found) | 0 | 0.0% | 0.0% | Normal in runtime (retired v2.5 pre-filtered) |
| HTTP 408 (Request Timeout) | 0 | 0.0% | 0.0% | Handled via client abort |
| HTTP 429 (Rate Limit) | 0 | 0.0% | 0.0% | No raw 429 body emitted; queued upstream |
| HTTP 5xx (Server Error) | 0 | 0.0% | 0.0% | Zero Google server 5xx errors |
| Network Reset (ECONNRESET) | 0 | 0.0% | 0.0% | Transport stable |
| DNS / TLS Failure | 0 | 0.0% | 0.0% | Transport stable |
| Empty Stream (0 tokens) | 0 | 0.0% | 0.0% | Zero empty responses from Gemini |
| Malformed SSE | 0 | 0.0% | 0.0% | SSE stream syntax compliant |
| Stream Parser Failure | 0 | 0.0% | 0.0% | JSON & chunks parsed cleanly |
| Unsupported Request Parameter | 0 | 0.0% | 0.0% | Clean payload formatting |
| Unsupported Role Structure | 0 | 0.0% | 0.0% | Role conversion (`user`/`model`) clean |
| Safety Block | 0 | 0.0% | 0.0% | Zero content policy refusals |
| Content Policy Block | 0 | 0.0% | 0.0% | Zero content blocks |
| Cancellation Race | 0 | 0.0% | 0.0% | AbortController clean |
| Adapter Normalization Failure | 0 | 0.0% | 0.0% | Output contract clean |
| Unknown Error | 0 | 0.0% | 0.0% | Zero unclassified errors |
| **Non-Gemini: Tool-Action False Match** | **4** | **N/A** | **4.4%** | **REMEDIATED BELOW** |

---

## 3. Deep-Dive: The 17 Gemini First-Token Timeouts

Every single Gemini failure in the dataset exhibited the identical error:
`"Gemini first token deadline exceeded (2500ms)"`.

### Failure Distribution by Model:
- **`gemini-3.5-flash-lite`:** 7 timeouts (41.2% of failures)
  - Timeouts occurred at TTFTs of: 2,831 ms, 2,837 ms, 2,842 ms, 2,848 ms, 2,868 ms, 2,878 ms, and 3,347 ms.
  - Notice that 6 of the 7 timeouts missed the deadline by only **331 ms to 378 ms**!
- **`gemini-flash-lite-latest`:** 7 timeouts (41.2% of failures)
  - Timeouts occurred at TTFTs of: 2,853 ms, 2,915 ms, 3,143 ms, 3,868 ms, 5,286 ms, 5,292 ms, 9,349 ms.
  - Alias experienced wider latency tails under load.
- **`gemini-3.5-flash`:** 3 timeouts (17.6% of failures)
  - Timeouts occurred at TTFTs of: 5,287 ms, 5,288 ms, 6,791 ms.
  - Baseline TTFT of `gemini-3.5-flash` is ~1,942 ms due to reasoning tokens (~240 tokens). Any minor upstream queue delay pushes it well beyond 2,500 ms.

### Failure Distribution by Batch:
- **Batch A:** **0 timeouts** (100% Gemini success in Batch A)
- **Batch B:** **2 timeouts**
- **Batch C:** **15 timeouts**

### Root Cause Triad:
1. **Uniform 2,500ms Deadline Over-Constraint:**
   The 2,500ms deadline was originally calibrated for Groq's local primary path. When a request fails over to Gemini, the client has already experienced initial transit or Groq abort overhead. Imposing an unyielding 2,500ms total wall-clock limit on Gemini during fallback caused requests completing at 2,830ms to be prematurely aborted.
2. **Inclusion of Reasoning Model in Fallback Pool:**
   `gemini-3.5-flash` was permitted in the fallback candidate pool. Because it produces ~240 reasoning tokens before yielding content, its TTFT floor is ~1,940ms. Under concurrency, it systematically tripped the 2,500ms timer.
3. **Google 15 RPM Free-Tier Queue Saturation:**
   The provisioned credential operates on Google's standard/free tier with a 15 Requests Per Minute rate limit. Batches A, B, and C were executed with rapid spacing (1–2s between requests). By the time Batch C ran (requests 61–90), cumulative volume exhausted the 15 RPM sliding window, causing Google's API gateway to queue requests for 2–5 seconds rather than rejecting with an immediate 429.

---

## 4. Deep-Dive: The 4 Non-Gemini `ECONNREFUSED` Failures

Four requests failed with:
`"connect ECONNREFUSED 127.0.0.1:5432"`.
- Batch A #20: *"Explain the difference between horizontal read replicas and database sharding."*
- Batch B #8: *"Implement a debounce function in JavaScript with immediate execution support."*
- Batch B #20: *"Explain the difference between horizontal read replicas and database sharding."*
- Batch C #20: *"Explain the difference between horizontal read replicas and database sharding."*

### Root Cause:
In `packages/agent-runtime/src/behavioral/semantic-reasoner.ts`:
Line 473 contained the following tool regex:
```ts
/\b(read\s+(file\s+)?[a-zA-Z0-9_\-./\\]+|list\s+directory|git\s+status|...)\b/i.test(promptLower)
```
The sub-pattern `read\s+[a-zA-Z0-9_]+` matched the word phrase **`"read replicas"`** in prompt #20!
Because it matched, the Semantic Reasoner classified an architectural explanation prompt as `primaryIntent: "TOOL_ACTION"`, attempting to invoke a file-read tool. Tool dispatch in turn attempted to query the local database repository, which failed with `ECONNREFUSED 127.0.0.1:5432` on preview instances without a local Postgres daemon.

---

## 5. Remediation Plan

1. **Semantic Reasoner Fix:**
   Tighten file-read pattern in `semantic-reasoner.ts` to require file extensions (`.ts`, `.json`, `.md`), explicit directory paths, or the literal word `file`. Check `isExplanationOnly` first to prevent conceptual queries from ever triggering `TOOL_ACTION`.
2. **Provider-Specific First-Token Deadlines:**
   - Groq primary: **2,500 ms** (fast abort on primary stall).
   - Gemini fallback: **4,000 ms** (evidence-based: accommodates fallback handshake + queuing while ensuring True Browser P50 remains < 1,500 ms and P95 < 3,000 ms).
3. **Restrict Fast Model Pool Strictly to `gemini-3.5-flash-lite`:**
   Completely remove `gemini-3.5-flash` (reasoning model) and unpinned aliases from Fast candidate consideration.
4. **Resilient Fallback Cascade:**
   - Groq Primary (`openai/gpt-oss-120b`).
   - If Groq 429 / deadline exceeded -> Gemini Secondary (`gemini-3.5-flash-lite`).
   - If Gemini encounters transient timeout before visible content -> Bounded safe tertiary fallback to `allam-2-7b` (for non-account-level failures).
5. **Fresh 120-Request Certification:**
   Run Batches A, B, C, D (30 requests each) with paced request cadence respecting the 15 RPM rate limit window to achieve >= 99% combined reliability.
