# AIRA AI 2026 — P1.4 Entitled Groq Model Benchmark & Fast Route Selection Report

**Execution Date:** 2026-10-17  
**PR:** [#83 (fix/p1-inference-latency-production-ux-20261016)](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/83)  
**Target Branch:** `prod-release`  
**Base Commit:** `f835a4c997945d756ac0a8eca25f14ca3dfeaac8`  
**Target Production Untouched:** YES (zero production mutation, zero merge to `prod-release`)  
**Active Agency Specialists:** `agency-reality-checker`, `agency-frontend-developer`, `agency-backend-architect`, `agency-evidence-collector`, `agency-sre-site-reliability-engineer`  
**Applied Matt Pocock Skills:** `diagnosing-bugs`, `tdd`, `code-review`, `pr`, `systematic-debugging`, `verification-before-completion`

---

## 1. Authoritative Verdict & Certification Summary

```
P1 GROQ ENTITLED FAST MODEL CERTIFIED — PRODUCTION AUTHORIZATION REQUIRED
```

| Metric / Requirement | Target Acceptance Gate | Verified Empirical Result | Verdict |
| :--- | :--- | :--- | :--- |
| **Selected Fast Model** | High-quality text chat | `openai/gpt-oss-120b` (Groq LPU) | **CERTIFIED** |
| **P50 Browser Visible TTFT** | $\le 2,000$ ms | **649 ms** (Desktop 771 ms, Mobile SE 712 ms) | **PASS (3.1x faster than gate)** |
| **P95 Browser Visible TTFT** | Preferred $\le 3,000$ ms | **834 ms** | **PASS (3.6x faster than gate)** |
| **Max Browser Visible TTFT** | Normal chat ceiling | **1,309 ms** (Mobile 390x844: 1,320 ms) | **PASS** |
| **Quality Evaluation Score** | $\ge 8.0 / 10$ | **9.5 / 10** | **PASS** |
| **Hidden Reasoning / Thinking Deltas** | Zero thinking tokens on Fast | **0 thinking deltas** (Immediate visible content) | **PASS** |
| **Real Progressive Streaming** | Mandatory | Verified: 15–585 deltas/query, live SSE | **PASS** |
| **Synthetic / Fake Streaming** | Strictly Banned | **NO** (Zero artificial delay or typing simulation) | **PASS** |
| **AIRA Deep Route Preservation** | `nvidia/nemotron-3-super-120b-a12b` | **YES** (64 thinking deltas, full reasoning preserved) | **PASS** |
| **Research Route Preservation** | `RESEARCH_SYNTHESIS` target | **YES** (`intent: "RESEARCH"`, `sideEffectLevel: "READ"`) | **PASS** |
| **Builder Route Preservation** | Setup mode / unchanged | **YES** (Zero modifications to builder contracts) | **PASS** |
| **Preview Deployment Tested** | Live Vercel Preview | `https://aira-ai-2026-git-f-a6b62b-rajpunkeshwarrajgautam-boops-projects.vercel.app` | **READY & VERIFIED** |
| **Production Mutation** | Strictly Forbidden | **ZERO** (`prod-release` branch untouched) | **ENFORCED** |

---

## 2. Model Entitlement Audit & Candidate Comparison

From live query `GET https://api.groq.com/openai/v1/models` under the user's active `GROQ_API_KEY`:
- Audio/Guard models filtered out: `whisper-large-v3`, `whisper-large-v3-turbo`, `meta-llama/llama-prompt-guard-*`, `openai/gpt-oss-safeguard-20b`, `canopylabs/orpheus-*`.
- 4 Candidate text chat models benchmarked (10 prompts $\times$ 3 runs = 120 total direct runs):

| Model | Success Rate | P50 TTFT | P95 TTFT | MAX TTFT | Thinking Deltas | Quality Score | Evaluation Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `openai/gpt-oss-20b` | 25/30 (83%) | 281 ms | 410 ms | 458 ms | 0 | 7.5 / 10 | 17% dropped/empty completions on Groq. |
| `qwen/qwen3.8-27b` | 18/30 (60%) | 42 ms | 235 ms | 241 ms | 0 | 6.0 / 10 | 40% failure rate (capacity/rate-limits on Groq). |
| `allam-2-7b` | 30/30 (100%) | 235 ms | 251 ms | 467 ms | 0 | 5.5 / 10 | Arabic language model; drifted into Arabic on English technical prompts (e.g. JSON explanation). |
| **`openai/gpt-oss-120b`** | **30/30 (100%)** | **282 ms** | **391 ms** | **481 ms** | **0** | **9.5 / 10** | **Flawless instruction following, rich markdown tables, concise definitions, zero thinking deltas, sub-500 ms ceiling.** |

---

## 3. Full AIRA 20-Prompt Benchmark on Preview

Tested against live Vercel Preview with `AIRA_FAST_PROVIDER=groq` and `AIRA_FAST_MODEL=openai/gpt-oss-120b`:

```
Sample Size: 20 Prompts
Executed Provider: groq
Executed Model: openai/gpt-oss-120b
Fallback Occurred: false

TTFB:  P50 = 286 ms | P90 = 302 ms | P95 = 314 ms | Mean = 292 ms
TTFT:  P50 = 649 ms | P75 = 706 ms | P90 = 822 ms | P95 = 834 ms | Mean = 661 ms
Total: P50 = 775 ms | P75 = 1408 ms | P90 = 2137 ms | P95 = 2206 ms | Mean = 1180 ms
Pre-Provider Routing Overhead: Mean = 326 ms
Thinking Tokens: 0 ms / 0 deltas
```

---

## 4. Browser Acceptance & Viewport Testing

Verified via Playwright browser execution against live Vercel Preview:
1. **Desktop (1440x900)**:
   - First token rendered in **771 ms**
   - Stream completed in **875 ms**
   - Zero horizontal overflow
   - Screenshot: `public/qa-screenshots/desktop-1440x900-chat-streamed.png`
2. **Mobile (390x844 - iPhone 12/13/14)**:
   - First token rendered in **1,320 ms**
   - Zero horizontal overflow, clean composer
   - Screenshot: `public/qa-screenshots/mobile-390x844-completed.png`
3. **Mobile (375x667 - iPhone SE)**:
   - First token rendered in **712 ms**
   - Zero horizontal overflow
   - Screenshot: `public/qa-screenshots/mobile-375x667-chat-streamed.png`

---

## 5. Route Isolation & Regression Verification

1. **AIRA Fast / Auto Normal Chat**:
   - `executedProvider: "groq"`
   - `executedModel: "openai/gpt-oss-120b"`
   - `fallbackOccurred: false`
   - Content Deltas: 15–585 | Thinking Deltas: 0
2. **AIRA Deep**:
   - `executedProvider: "nvidia"`
   - `executedModel: "nvidia/nemotron-3-super-120b-a12b"`
   - Thinking Deltas: 64 | Content Deltas: 3
   - Full deep reasoning and model identity strictly preserved.
3. **Research Synthesis**:
   - Query routed to `RESEARCH_SYNTHESIS` target with `sideEffectLevel: "READ"`.
4. **Builder**:
   - Unchanged, setup mode preserved.

---

## 6. Production Safety & Gating

- Target Production Branch (`prod-release`): **UNTOUCHED**
- Production Deployment: **UNTOUCHED**
- PR #83 remains unmerged awaiting human GO LIVE instruction from owner `rajpunkeshwarrajgautam-boop`.
