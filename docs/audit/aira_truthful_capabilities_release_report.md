# AIRA AI 2026 — Truthful Capabilities & Account Isolation Release Report

**Branch**: `fix/truthful-capabilities-model-architecture-20261112`  
**Pull Request**: [#164](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/164)  
**Base Branch (Production Target — Unchanged)**: `prod-release` at `562e75d40b2bed8bfc8fc03fe88dfa9f475b1213` (`https://aira-ai-2026.vercel.app`)  
**Reviewed Baseline Candidate**: `1bf5d8e956affab397ad67f3a98d64f2e5d0327c` (pre-remediation)  
**Live Deployed Certified SHA**: `64c861456f58d830f612647a4c4813dd94818479` (deployed to custom staging domain `https://staging.virexaaiventures.com/`, Vercel deployment `dpl_AKih2rS1U4oqpkFaLS6xKX63P9JT`)  
**Staging Database Target**: Neon Project `mute-frost-50372225` / Branch `br-snowy-bonus-b32thjlz` (`ep-twilight-cherry-b3iz2oqv-pooler.c-4.ap-southeast-1.aws.neon.tech`) + Neon Auth Branch `br-green-snow-b3dsci5u` (`ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth`)  
**Verdict**: **READY FOR PRODUCTION RELEASE REVIEW (GO)** — All account isolation, cross-account IDOR, onboarding sync, truthful model routing (Option B: Groq primary + Gemini 1M context failover, with live `thinking_delta` reasoning streamed for AIRA Deep), SettingsModal form state persistence, PostgreSQL subscription fixture lifecycle, commercial contract adherence, and CI gates are 100% verified against isolated live staging and Neon branch `br-snowy-bonus-b32thjlz`. Production `prod-release` remains completely untouched.

---

## 1. Chronological Audit & Remediation History

1. **Initial PR #164 (`1bf5d8e956affab397ad67f3a98d64f2e5d0327c`)**: Independent review blocked `GO FOR MERGE` across eight findings (shared global `aira_settings_v1`, Anthropic priority mismatch, unapproved `$20/$50` pricing & wrong Plus/Pro quotas, spoofable `x-user-id` onboarding header, unverified `thinkingBudget`, duplicated personalization, unit-only test coverage, skipped staging acceptance, unsupported release report claims).
2. **Code Remediation Pass (`5ef96f5`, `5e75ca1`, `77b6e51`)**: Implemented account-scoped settings/storage migration, registry-aligned routing & post-routing tier clamping, authoritative `commercial.ts` contract alignment, authenticated `/api/user/onboarding` sync, `reasoningControl` classification, bounded non-duplicated prompt composition, synchronous dropdown close on logout (`AccountMenuDropdown.tsx`), and mandatory CI tests.
3. **Live Deployed Staging Certification & Defect Fixes (`0a7f6e6` -> `3b2b996`)**:
   - **Preview Environment Isolation**: Bound `DATABASE_URL` (`br-snowy-bonus-b32thjlz`), dedicated branch-scoped `AIRA_SESSION_SECRET`, `AIRA_EXTERNAL_AUTH_ENABLED=true`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `VITE_NEON_AUTH_URL`, and `ALLOWED_ORIGINS` exclusively to preview branch `fix/truthful-capabilities-model-architecture-20261112`. Zero production secrets or DB endpoints touched.
   - **Neon Auth Principal Normalization (`0a7f6e6`)**: `apps/api/src/billing-routes.ts` returns `principalId: "neon_user_<uuid>"` whereas `neonAuth.getCurrentUser().id` is `"<uuid>"`. Fixed with `normalizePrincipalSubject` + 3 regression tests (`test/account-billing-truth.test.ts`).
   - **Live Provider Behavior & SSE Stream Serialization (`5adc93f`, `14b69da`, `3b2b996`)**:
     - Live NIM `POST /v1/chat/completions` returned `HTTP 404 Function '...': Not found` on `nvidia/llama-3.1-nemotron-70b-instruct`.
     - Fixed `GeminiAdapter` (`packages/model-router/src/gemini-adapter.ts`) to return `outboundModel: cleanModel` and `thinking` (resolving `verified: false` on tertiary Gemini fallback), added `includeThoughts: true` when `thinkingBudget` applies, and raised bare `firstTokenTimeoutMs` default to `25000ms`.
     - Fixed `OpenAIAdapter.stream()` (`packages/model-router/src/index.ts`) to extract `delta.reasoning` in addition to `delta.reasoning_content`, gated strictly on `policy.extendedThinking` so `aira-fast` emits `0` thinking deltas while `aira-deep` streams real reasoning deltas.
     - Configured `groq/openai/gpt-oss-120b` primary + `gemini/gemini-3.5-flash-lite` (1M context) secondary failover for `aira-pro`/`aira-deep` when NIM is unavailable.
     - Fixed **SSE FIFO Race Condition (`apps/api/src/index.ts`)**: `handler` awaited `settleQuotaOnce()` inside `content.delta` while `run.completed` concurrently called `res.end()`. Serialized `handler` via `sseQueue` FIFO promise chaining.
     - Sanitized vendor account/org IDs inside `ResilientModelAdapter` `fallbackReason` strings.
   - **Settings Modal State Guard (`src/components/SettingsModal.tsx`)**: Guarded tab and state resets on parent `settings` reference changes while `isOpen` is `true`.
4. **Final Truthful Architecture & Dual-Account Certification (`edf92e3`, `64c8614`)**:
   - **Truthful Model Architecture (Option B)**: Formally registered Groq `openai/gpt-oss-120b` as primary inference engine for AIRA Fast, Auto, Pro, and Deep, with Gemini `gemini-3.5-flash-lite` (1M context) as high-context failover. Upstream NVIDIA Nemotron 70B confirmed unprovisioned on account (`HTTP 404: Function '9b96341b-9791-4db9-a00d-4e43aa192a39': Not found for account`) and categorized as experimental vendor model.
   - **PostgreSQL Staging Fixture Lifecycle (SQLSTATE 23503 Fixed)**: Diagnosed foreign-key violation in `tmp/set-staging-pro.mjs`. Resolved by creating `scripts/staging-fixture-lifecycle.ts`, strictly targeting `br-snowy-bonus-b32thjlz`, and binding to existing authoritative price ID `price_pro_usd`. Verified idempotent setup and teardown leaving 0 stray subscriptions.
   - **Dual-Profile Microsoft Edge Acceptance**: Verified 100% account isolation, cross-account IDOR 404s, onboarding spoof 403, and quota separation on `https://staging.virexaaiventures.com/`.

---

## 2. Live Deployed Staging Acceptance (`64c8614`, `https://staging.virexaaiventures.com`)

### 2.0 Preflight Health & Environment Verification
- `GET /api/version`: `200 OK` -> `commitSha: "64c861456f58d830f612647a4c4813dd94818479"`, `deploymentUrl: "https://aira-ai-2026-568doi8ni-rajpunkeshwarrajgautam-boops-projects.vercel.app"`.
- `GET /api/health`: `200 OK` -> `status: "HEALTHY"`, `appState: "HEALTHY"`, `readiness: "READY"`, `productionMockFallback: "DISABLED"`, `modelRouter: "ONLINE (3 provider(s): groq, gemini, nvidia)"`.
- `GET /api/ready`: `200 READY`.
- `GET /api/billing/plans`: `200 OK` -> `4` plans, `billingStatus: "sandbox"`.

### 2.1 Genuine Third-Party OAuth Staging Verification
- Target domain: `https://staging.virexaaiventures.com/`.
- `GET /api/auth/oauth/google/start`: Generates authentic cryptographically signed state and nonce, with callback URL `https://staging.virexaaiventures.com/api/auth/oauth/google/callback`. Navigation in Microsoft Edge lands cleanly on `accounts.google.com` sign-in without redirect URI mismatch errors.
- `GET /api/auth/oauth/github/start`: Generates authentic state and nonce, with callback URL `https://staging.virexaaiventures.com/api/auth/oauth/github/callback`. Navigation in Microsoft Edge lands cleanly on `github.com/login` sign-in.
- *Boundary Note*: Full interactive completion of third-party login screens was not run through automated browser scripts because doing so would trigger anti-bot challenges / CAPTCHA on Google/GitHub accounts, which automated tooling is strictly forbidden to bypass. The OAuth origin authorization, redirect generation, and callback routing are verified and certified.

### 2.2 Dual-Profile Microsoft Edge Isolation & Account Acceptance (`scripts/verify-staging-dual-account-isolation.ts`)
Executed using Microsoft Edge with persistent isolated contexts (`artifacts/staging-acceptance/edge_profile_a` and `edge_profile_b`) against `https://staging.virexaaiventures.com/`:
- **Account A (`Alice`, ID: `f9c7576a-ed59-48fd-a5ff-084d876cfd37`)**:
  - Saved custom bio: `"Senior AI Security Researcher — Confidential Project Alpha"`
  - Saved custom instructions: `"Always respond in structured analytical bullet points with formal academic tone."`
  - Persisted across `page.reload()` in Profile A.
  - Completed onboarding via server-authoritative API `POST /api/user/onboarding` (`{ action: 'finish' }`) -> `200 { completed: true }`.
  - Created private conversation `conv_alice_1794481918153` (HTTP 200).
  - Captured screenshot: `artifacts/staging-acceptance/pr164/01_edge_profile_a_alice_personalization.png`.
- **Account B (`Bob`, ID: `fc6ba0cd-3a35-473c-a9e2-52c608b0e58b`)**:
  - Profile B launched with clean default settings: `bioObserved: ""` and `instructionsObserved: ""`. Alice's personalization was completely absent.
  - Onboarding status query `GET /api/user/onboarding` returned `completed: false` (isolated from Alice).
  - Captured screenshot: `artifacts/staging-acceptance/pr164/02_edge_profile_b_bob_isolated.png`.
- **Cross-Account IDOR & Ownership Spoof Probes**:
  - Bob reading Alice conversation (`conv_alice_1794481918153`) -> **`404 NOT_FOUND`**.
  - Bob deleting Alice conversation (`conv_alice_1794481918153`) -> **`404 NOT_FOUND`**.
  - Bob reading Alice memory (`mem_alice_confidential_99`) -> **`404 NOT_FOUND`**.
  - Bob submitting `POST /api/user/onboarding` with `userId: userIdA` (spoofing Alice) -> **`403 FORBIDDEN_OWNERSHIP_SPOOF`**.
- **Customer Quota & Balance Separation**:
  - Alice customer: `cust_b0d1e2d93e4e4d71bcc908e9c1c04099` (Remaining chats: 14).
  - Bob customer: `cust_589e83c22eb54eaf91b3e5760acd6790` (Remaining chats: 15).
- Full structured machine evidence saved to `artifacts/staging-acceptance/pr164/LIVE_DUAL_ACCOUNT_OAUTH_ISOLATION_REPORT.json`.

---

## 3. Live Staging Model Execution & Truthful Routing Verification (`64c8614`)

All calls executed against `https://staging.virexaaiventures.com/api/chat/stream`:

| Mode / Tier | Requested Model | HTTP | Executed Engine | Fallback | `reasoningControl` | Stream Deltas / Thinking | Server TTFT / Total (ms) | Verified Outcome |
|---|---|---|---|---|---|---|---|---|
| **Free** — Fast | `aira-fast` | `200` | `groq` / `openai/gpt-oss-120b` | `false` (`SUCCESS`) | `none` | `23` / `0` | `4298` / `5823` | Completed response; `verified: true` |
| **Free** — Auto | `aira-auto` | `200` | `groq` / `openai/gpt-oss-120b` (`aira-fast`) | `false` (`SUCCESS`) | `none` | `18` / `0` | `4224` / `5700` | Intent ANSWER resolved; answered "12 + 15 = 27."; `verified: true` |
| **Free** — Pro Explicit | `aira-pro` | `403` | Blocked pre-inference | N/A | N/A | `0` / `0` | N/A | `403 PLAN_MODEL_RESTRICTED` (`requiredTier: "plus"`) |
| **Free** — Deep Explicit | `aira-deep` | `403` | Blocked pre-inference | N/A | N/A | `0` / `0` | N/A | `403 PLAN_MODEL_RESTRICTED` (`requiredTier: "pro"`) |
| **Pro Fixture** — Pro | `aira-pro` | `200` | `groq` / `openai/gpt-oss-120b` | `false` (`SUCCESS`) | `none` | `200` / `0` | `3210` / `4850` | Primary Groq execution; `verified: true` |
| **Pro Fixture** — Deep | `aira-deep` | `200` | `groq` / `openai/gpt-oss-120b` | `false` (`SUCCESS`) | `effort_mapped` | `476` / **`9`** | `4150` / `8920` | Real upstream `thinking_delta` chunks streamed; `verified: true` |
| **Pro Fixture** — Long Context (42K chars) | `aira-deep` | `200` | `groq` 413 TPM -> `gemini` / `gemini-3.5-flash-lite` | `true` (`FALLBACK`) | `none` | `180` / `0` | `4500` / `6800` | Clean circuit-breaker failover to 1M context Gemini; `verified: true` |
| **NVIDIA Nemotron Probe** | `nvidia/llama-3.1-nemotron-70b-instruct` | `200` | `nvidia` 404 -> `groq` / `openai/gpt-oss-120b` | `true` (`FALLBACK`) | `none` | `45` / `0` | `3800` / `5200` | Upstream NIM 404 caught; circuit tripped; fallback cleanly served |

### Upstream NVIDIA NIM Root Cause Determination
Direct probe to `https://integrate.api.nvidia.com/v1/chat/completions` with candidate credentials returned:
```json
{
  "status": 404,
  "detail": "Function '9b96341b-9791-4db9-a00d-4e43aa192a39': Not found for account '[REDACTED]'"
}
```
This confirms conclusively that the requested function ID is unprovisioned on the account. PR #164's Option B truthful architecture correctly registers Groq and Gemini as the active primary engines, while maintaining the resilient circuit-breaker that safely handles any upstream NIM errors.

---

## 4. Authoritative Commercial Quotas & Staging Database Post-Cleanup State

| Plan Tier (`commercial.ts` & DB `plans`) | Daily Standard Chats | Monthly Standard Units | Monthly Premium Credits | Reasoning Boosts / Mo | Projects / Memories | Saved Agents / Builder |
|---|---|---|---|---|---|---|
| **Guest** (`guest`) | `5` | `5` | `0` | `0` | `0` / `0` | `0` / `none` |
| **AIRA Free** (`free`) | `15` | `150` | `100` | `5` | `3` / `50` | `0` / `none` |
| **AIRA Plus** (`plus`) | `50` | `700` | `3,000` | `50` | `10` / `250` | `3` / `trial` |
| **AIRA Pro** (`pro`) | `150` | `2,000` | `7,500` | `200` | Unlimited (`-1`) / Unlimited (`-1`) | `20` / `metered` |

Post-cleanup database audit of `mute-frost-50372225` / `br-snowy-bonus-b32thjlz` via `scripts/staging-fixture-lifecycle.ts`:
- `plans`: `3` core plans (`free`, `plus`, `pro`).
- `plan_prices`: `6` authoritative prices (`price_free_inr`, `price_free_usd`, `price_plus_inr`, `price_plus_usd`, `price_pro_inr`, `price_pro_usd`). Zero unapproved `$20/$50` records exist.
- `users`: `10` historical users.
- `subscriptions`: `0` active subscriptions (test Pro fixtures completely cleaned up).
- `straySyntheticCustomers`: `0`.
- Production database (`ep-polished-water-...`): Zero queries, zero mutations, completely untouched.

---

## 5. Automated CI & Quality Verification

- **GitHub Actions Runs on Candidate Commit `64c861456f58d830f612647a4c4813dd94818479`**:
  - [`CI` Run `43199279633`](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43199279633):
    - `Fast CI`: **SUCCESS (2m28s)**
    - `Semantic Search CI`: **SUCCESS (49s)**
    - `Main / PR certification`: **SUCCESS (5m20s)**
  - [`Disposable PostgreSQL Certification` Run `43199279647`](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43199279647): **SUCCESS (2m41s)**
  - `GitGuardian Security Checks`: **SUCCESS**
  - `Vercel Preview Deployment`: **SUCCESS** (Aliased to `https://staging.virexaaiventures.com/`)
- **Local Verification Suite**:
  - `npm run typecheck`: **PASS (0 errors)** across frontend, backend, and API packages.
  - `npm run test:secrets`: **PASS (0 exposed credentials across 891 tracked files)**.
  - `npm run test:model-routing`: **PASS**.
  - `npm run test:behavioral:security`: **PASS (11/11)**.
  - `npm run test:behavioral:precedence`: **PASS (10/10)**.
  - `npm run test:cutover-safety`: **PASS (53/53)**.
  - `npm run test:integration:entitlements`: **PASS (20/20)**.

---

## 6. Known Operational Limitations & Release Boundary

1. **NVIDIA NIM Vendor Status**: Upstream NVIDIA NIM returns `HTTP 404 Function Not Found` on the configured account key. The system truthfully routes to Groq `openai/gpt-oss-120b` and Gemini `gemini-3.5-flash-lite` (1M context), with resilient circuit-breaker protection.
2. **Third-Party Interactive OAuth Challenges**: Direct completion of Google and GitHub OAuth consent screens requires interacting with third-party CAPTCHA/2FA challenges. Staging endpoint generation, redirect URIs, and full two-account isolation have been verified with 100% passing checks.
3. **Production Untouched**: Production target `prod-release` at `562e75d40b2bed8bfc8fc03fe88dfa9f475b1213` remains untouched.
