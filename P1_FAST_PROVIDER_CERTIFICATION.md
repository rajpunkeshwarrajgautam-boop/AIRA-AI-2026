# AIRA AI 2026 — P1.3 Fast Provider Enablement & Multi-Provider Routing Certification Report

**Execution Date:** 2026-10-17  
**PR:** [#83 (fix/p1-inference-latency-production-ux-20261016)](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/83)  
**Target Branch:** `prod-release`  
**Base Commit:** `f835a4c997945d756ac0a8eca25f14ca3dfeaac8`  
**Current PR HEAD SHA:** `f59be8afabdbcb2d3fa6e48cfa003d162f4b277b`  
**Target Production Untouched:** YES (zero production mutation, zero merge to `prod-release`)  
**Active Agency Specialists:** `agency-reality-checker`, `agency-backend-architect`, `agency-sre-site-reliability-engineer`  
**Applied Matt Pocock Skills:** `research`, `diagnosing-bugs`, `tdd`, `code-review`, `pr`

---

## 1. Executive Summary & Authoritative Verdict

```
P1 FAST PROVIDER FAILED
```

### Key Metrics & Telemetry Summary
- **Target Fast Provider:** `groq` (Configured in Vercel Preview)
- **Target Fast Model:** `llama-3.1-8b-instant`
- **Preview Deployment Tested:** `https://aira-ai-2026-reos3wv39-rajpunkeshwarrajgautam-boops-projects.vercel.app`
- **Groq Upstream HTTP Status:** `404 Not Found`
- **Groq Upstream Error:** `The model 'llama-3.1-8b-instant' does not exist or you do not have access to it.`
- **P50 Browser Visible TTFT:** N/A (Failed upstream before first token)
- **P95 Browser Visible TTFT:** N/A (Failed upstream before first token)
- **Fallback Occurred:** `false` (Truthfully preserved; no silent mask/fallback)
- **Real Progressive Streaming:** Verified on Deep route (103 deltas); failed on Groq due to 404
- **Fake Streaming Used:** NO (Strictly zero synthetic token delay or client simulation)
- **Deep Nemotron 120B Preserved:** YES (`aira-deep` verified on `nvidia/nemotron-3-super-120b-a12b`, TTFT 3,223 ms, 103 content deltas, 45 thinking deltas)
- **Research Route Preserved:** YES (`intent: "RESEARCH"`, `executionTarget: "RESEARCH_SYNTHESIS"`, `sideEffectLevel: "READ"`)
- **Current Exact-Head CI:** Fast CI PASS, Semantic Search CI PASS

---

## 2. 19-Point Verification Checklist & Empirical Results

| # | Verification Item | Target Standard | Observed Empirical Result | Verdict |
| :- | :--- | :--- | :--- | :--- |
| **1** | `/api/health` | `HEALTHY` | Status `200 OK`, `status: "HEALTHY"`, `modelRouter: "ONLINE (2 provider(s): groq, nvidia)"`, `productionMockFallback: "DISABLED"` | **PASS** |
| **2** | `/api/ready` | `READY` | Status `200 OK`, `status: "READY"`, `timestamp: 1792220620931` | **PASS** |
| **3** | `executedProvider` | `groq` | Fast router successfully selected `groq`, but upstream inference returned HTTP 404 | **ATTEMPTED / UPSTREAM FAILED** |
| **4** | `executedModel` | `llama-3.1-8b-instant` | Model requested, but rejected by Groq: `The model 'llama-3.1-8b-instant' does not exist or you do not have access to it.` | **FAILED** |
| **5** | `fallbackOccurred` | `false` | Truthful error reporting enforced. When Groq failed, `fallbackOccurred: false` was retained and failure emitted; no silent fallback to Nemotron or mock | **PASS** |
| **6** | Real Upstream SSE Streaming | Verified | 0 tokens received from Groq due to HTTP 404 stream failure | **FAILED (0 Deltas)** |
| **7** | No Fake Streaming | Strict ban | Verified: Zero artificial token chunking, zero synthetic delays | **PASS** |
| **8** | 20-Prompt Benchmark | Complete suite | Blocked: Groq rejected `llama-3.1-8b-instant` on 100% of prompt executions | **BLOCKED** |
| **9** | P50 Browser TTFT $\le 2000$ ms | $\le 2,000$ ms | N/A (Upstream 404 stream error) | **FAILED** |
| **10** | Preferred P95 $\le 3000$ ms | $\le 3,000$ ms | N/A (Upstream 404 stream error) | **FAILED** |
| **11** | Repeated Variance Tests | 5x variance check | Blocked by upstream 404 | **BLOCKED** |
| **12** | Desktop 1440x900 | Browser render | Verified layout; stream fails at network boundary | **BLOCKED** |
| **13** | Mobile 390x844 | Mobile render | Verified responsive layout; stream fails at network boundary | **BLOCKED** |
| **14** | Mobile 375x667 | Small viewport | Verified responsive layout; stream fails at network boundary | **BLOCKED** |
| **15** | Browser Render Overhead | $<200$ ms | Measured at 51–77 ms in P1.1 / P1.2 baseline tests | **PASS** |
| **16** | Deep Remains on NVIDIA Nemotron 120B | Strict isolation | Verified on Preview: `aira-deep` routed to `nvidia/nemotron-3-super-120b-a12b`, emitted 45 thinking deltas, 103 content deltas, TTFT 3,223 ms | **PASS** |
| **17** | Research Route Preserved | Independent | Verified on Preview: `RESEARCH` query routed to `RESEARCH_SYNTHESIS` target with `sideEffectLevel: "READ"` | **PASS** |
| **18** | Quality Comparison | Accurate answers | Cannot evaluate Groq output quality because 0 tokens were generated | **BLOCKED** |
| **19** | Exact-Head CI Fully Successful | 100% green | Fast CI: PASS (1m51s), Semantic Search CI: PASS (46s), Vercel Build: PASS | **PASS** |

---

## 3. Root Cause Diagnosis & Upstream Entitlement Audit

### The Diagnostic Breakthrough
When the Preview deployment was re-tested with `GROQ_API_KEY`, `AIRA_FAST_PROVIDER=groq`, and `AIRA_FAST_MODEL=llama-3.1-8b-instant`, every streaming request immediately triggered:
```text
[CHAT_STREAM_RUN_FAILED] model=llama-3.1-8b-instant: groq streaming request failed (HTTP 404): The model `llama-3.1-8b-instant` does not exist or you do not have access to it.
```
Testing the alternative Groq general model `llama-3.3-70b-versatile` yielded the identical response:
```text
[CHAT_STREAM_RUN_FAILED] model=llama-3.3-70b-versatile: groq streaming request failed (HTTP 404): The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.
```

To isolate the root cause, a non-sensitive diagnostic probe was executed directly against Groq's model catalog (`GET https://api.groq.com/openai/v1/models`) using the configured `GROQ_API_KEY`:
- **HTTP Status:** `200 OK` (Key is valid and authenticated)
- **Key Prefix:** `gsk_`
- **Key Length:** 56 characters
- **Actual Models Entitled on this Key:**
  1. `canopylabs/orpheus-v1-english`
  2. `meta-llama/llama-prompt-guard-2-86m`
  3. `allam-2-7b`
  4. `whisper-large-v3`
  5. `qwen/qwen3.8-27b`
  6. `meta-llama/llama-prompt-guard-2-22m`
  7. `canopylabs/orpheus-arabic-saudi`
  8. `openai/gpt-oss-120b`
  9. `whisper-large-v3-turbo`
  10. `openai/gpt-oss-20b`
  11. `openai/gpt-oss-safeguard-20b`

### Conclusion
The Groq account/organization associated with the provided `GROQ_API_KEY` does **not** have permissions enabled for Meta Llama models (`llama-3.1-8b-instant` or `llama-3.3-70b-versatile`). As a result, Groq Cloud denies access with HTTP 404.

---

## 4. Required Action for Repository Owner

To complete P1.3 certification with sub-2s TTFT, choose ONE of the two solutions:

### Solution A: Enable Llama Models in Groq Console (Recommended)
1. Log into [Groq Console](https://console.groq.com/).
2. Navigate to **Project Settings** $\to$ **Model Access / Permissions**.
3. Enable `llama-3.1-8b-instant` (or generate an API key from a project that has Llama 3.1 access enabled).
4. Update `GROQ_API_KEY` in Vercel Preview if a new key was created.

### Solution B: Switch to OpenAI `gpt-4o-mini` (~600-900 ms TTFT)
1. Add `OPENAI_API_KEY` to Vercel Preview:
   ```bash
   vercel env add OPENAI_API_KEY preview
   ```
2. Update fast provider variables in Vercel Preview:
   ```bash
   vercel env add AIRA_FAST_PROVIDER preview # value: openai
   vercel env add AIRA_FAST_MODEL preview    # value: gpt-4o-mini
   ```

---

## 5. Security & Safety Boundaries
- **Production Status:** Untouched (`prod-release` not modified, live canonical URL untouched).
- **PR Status:** Unmerged (PR #83 remains open).
- **Secrets Hygiene:** `GROQ_API_KEY` was never printed, logged, or committed.
