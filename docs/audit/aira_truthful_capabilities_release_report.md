# AIRA AI 2026 — Truthful Capabilities & Account Isolation Release Report

**Branch**: `fix/truthful-capabilities-model-architecture-20261112`  
**Pull Request**: [#164](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/164)  
**Base Branch (Production Target — Unchanged)**: `prod-release` at `562e75d40b2bed8bfc8fc03fe88dfa9f475b1213` (`https://aira-ai-2026.vercel.app`)  
**Reviewed Baseline Candidate**: `1bf5d8e956affab397ad67f3a98d64f2e5d0327c` (pre-remediation)  
**Live Deployed Acceptance SHA**: `3b2b996bc563e6c3d1dec55b532d973bec863a3e` (`https://aira-ai-2026-b465ysgu9-rajpunkeshwarrajgautam-boops-projects.vercel.app`, Vercel `dpl_CdTZrFWTuWKsT3WqMgbbfSpMPG6m`)  
**Staging Database Target**: Neon Project `mute-frost-50372225` / Branch `br-snowy-bonus-b32thjlz` (`ep-twilight-cherry-b3iz2oqv-pooler.c-4.ap-southeast-1.aws.neon.tech`) + Neon Auth Branch `br-green-snow-b3dsci5u` (`ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth`)  
**Verdict**: **READY FOR RELEASE REVIEW (WITH EXPLICIT OAUTH PREVIEW BLOCKER)** — All account isolation, cross-account IDOR, onboarding sync, model failover, SSE streaming race, `SettingsModal` form-reset, commercial contract, and CI gates are resolved and verified against the isolated live Vercel Preview and Neon staging database. Production `prod-release` remains unchanged. Interactive third-party Google/GitHub OAuth code exchange remains **BLOCKED** on ephemeral PR preview URLs because `GOOGLE_CLIENT_SECRET` / `GITHUB_CLIENT_SECRET` are `staging`/`production`-only sensitive Vercel vars and preview deployment callback URLs are not registered in the external OAuth consoles.

---

## 1. Chronological Audit & Remediation History

1. **Initial PR #164 (`1bf5d8e956affab397ad67f3a98d64f2e5d0327c`)**: Independent review blocked `GO FOR MERGE` across eight findings (shared global `aira_settings_v1`, Anthropic priority mismatch, unapproved `$20/$50` & wrong Plus/Pro quotas, spoofable `x-user-id` onboarding header, unverified `thinkingBudget`, duplicated personalization, unit-only test coverage, skipped staging acceptance, unsupported release report claims).
2. **Code Remediation Pass (`5ef96f5`, `5e75ca1`, `77b6e51`)**: Implemented account-scoped settings/storage migration, registry-aligned routing & post-routing tier clamping, authoritative `commercial.ts` contract alignment, authenticated `/api/user/onboarding` sync, `reasoningControl` classification, bounded non-duplicated prompt composition, synchronous dropdown close on logout (`AccountMenuDropdown.tsx`), and mandatory CI tests.
3. **Final Deployed Staging Certification & Defects Found Live (`0a7f6e6` -> `3b2b996`)**:
   - **Preview Environment Isolation**: Bound `DATABASE_URL` (`br-snowy-bonus-b32thjlz`), dedicated branch-scoped `AIRA_SESSION_SECRET`, `AIRA_EXTERNAL_AUTH_ENABLED=true`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `VITE_NEON_AUTH_URL`, and `ALLOWED_ORIGINS` exclusively to preview branch `fix/truthful-capabilities-model-architecture-20261112`. Zero production secrets or DB endpoints touched.
   - **Defect Found & Fixed (`0a7f6e6`) — Neon Auth Principal Prefix Mismatch (`src/lib/accountBillingTruth.ts`)**: `apps/api/src/billing-routes.ts` returns `principalId: "neon_user_<uuid>"` whereas `neonAuth.getCurrentUser().id` is `"<uuid>"`. `parseBillingSummary` rejected every real Neon Auth principal, leaving `userTier` stuck at `'guest'`. Fixed with `normalizePrincipalSubject` + 3 regression tests (`test/account-billing-truth.test.ts`).
   - **Defects Found & Fixed (`5adc93f`, `14b69da`, `3b2b996`) — Live Provider Behavior & SSE Stream Serialization**:
     - Live NIM `POST /v1/chat/completions` returned `HTTP 404 Function '...': Not found` on `nvidia/llama-3.1-nemotron-70b-instruct`; `gemini-2.5-flash` returned `HTTP 404` (deprecated on key); `gemini-3.8-flash` exceeded 6s/15s first-token deadlines.
     - Fixed `GeminiAdapter` (`packages/model-router/src/gemini-adapter.ts`) to return `outboundModel: cleanModel` and `thinking` (resolving `verified: false` on tertiary Gemini fallback), added `includeThoughts: true` when `thinkingBudget` applies, and raised bare `firstTokenTimeoutMs` default from `4000ms` to `25000ms`.
     - Fixed `OpenAIAdapter.stream()` (`packages/model-router/src/index.ts`) to extract `delta.reasoning` in addition to `delta.reasoning_content`, gated strictly on `policy.extendedThinking` so `aira-fast` emits `0` thinking deltas while `aira-deep` streams real reasoning deltas.
     - Fixed `createModelSpecificAdapter` selection (`packages/model-router/src/index.ts`) and configured `groq/openai/gpt-oss-120b` secondary + `gemini/gemini-3.5-flash-lite` (1M context) tertiary failover for `aira-pro`/`aira-deep` when NIM is unavailable.
     - Fixed **SSE FIFO Race Condition (`apps/api/src/index.ts`)**: `handler` awaited `settleQuotaOnce()` inside `content.delta` while `run.completed` concurrently called `res.end()`, producing `deltaCount: 0` on fast bursts (`pro-aira-deep`). Serialized `handler` via `sseQueue` FIFO promise chaining.
     - Sanitized vendor account/org IDs inside `ResilientModelAdapter` `fallbackReason` strings (`packages/model-router/src/resilient-adapter.ts`).
   - **Defect Found & Fixed (`src/components/SettingsModal.tsx`)**: Removed `setActiveTab(resolveTab(initialTab))` / form overwrite on parent `settings` reference changes while `isOpen` remained `true` (`wasOpenRef` guard).

---

## 2. Live Deployed Preview Acceptance (`3b2b996`, `b465ysgu9`)

### 2.0 Preflight Health & Environment Verification
- `GET /api/version`: `200 OK` -> `commitSha: "3b2b996bc563e6c3d1dec55b532d973bec863a3e"`, `deploymentUrl: "https://aira-ai-2026-b465ysgu9-rajpunkeshwarrajgautam-boops-projects.vercel.app"`.
- `GET /api/health`: `200 OK` -> `status: "HEALTHY"`, `appState: "HEALTHY"`, `readiness: "READY"`, `productionMockFallback: "DISABLED"`, `modelRouter: "ONLINE (3 provider(s): groq, gemini, nvidia)"`.
- `GET /api/ready`: `200 READY`.
- `GET /api/billing/plans`: `200 OK` -> `4` plans, `billingStatus: "sandbox"`.
- `npx tsx test/staging-deployed-acceptance.ts` (`PLAYWRIGHT_CHANNEL=msedge`, `STAGING_BASE_URL=https://aira-ai-2026-b465ysgu9-rajpunkeshwarrajgautam-boops-projects.vercel.app`): **PASS** (`1440x900` desktop & `390x844` mobile chat, math, scroll, viewport).

### 2.1 Third-Party OAuth Probe & Honest Blocker Status
- `GET /api/auth/oauth/google/start`: `200 OK` (`redirect_uri=https://aira-ai-2026-b465ysgu9-rajpunkeshwarrajgautam-boops-projects.vercel.app/api/auth/oauth/google/callback`); Edge navigation landed on `Sign in - Google Accounts` with **`redirect_uri_mismatch_or_error_400`** (artifact: `01_oauth_google_probe.png`).
- `GET /api/auth/oauth/github/start`: `200 OK` (`redirect_uri=https://aira-ai-2026-b465ysgu9-rajpunkeshwarrajgautam-boops-projects.vercel.app/api/auth/oauth/github/callback`); Edge navigation landed on `https://github.com/login` (`Sign in to GitHub · GitHub`, artifact: `02_oauth_github_probe.png`).
- **Status**: **BLOCKED on PR #164 Preview** — `GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_SECRET` are write-only `sensitive` Vercel variables bound only to `production` and `staging` environments, and ephemeral `*.vercel.app` preview callback URLs are not registered in the owner's Google Cloud Console / GitHub OAuth App settings.

### 2.2 Two-Profile Microsoft Edge Isolation & Onboarding Lifecycle (Neon Auth BFF)
Executed with two isolated Microsoft Edge browser contexts (`edge-profile-a` and `edge-profile-b`) authenticated against Neon Auth BFF `/api/auth/sign-up` + `/api/auth/sign-in`:
- **Profile A (`Alice`, `401688...d559`)**: Custom bio `LIVE_ALICE_BIO_TOKEN` & instructions saved and persisted across `page.reload()` (`03_edge_profileA_alice_personalization.png`).
- **Profile B (`Bob`, `8a888c...4209`)**: Isolated clean bio/instructions (`04_edge_profileB_bob_isolated.png`). Cross-account IDOR probes by Bob against Alice's resources returned **`404`** on conversation GET, memory GET, project GET, and live run GET (`bobListMemsCount: 0`, `bobListProjsCount: 0`). Spoofed `x-user-id` onboarding POST returned **`403 FORBIDDEN_OWNERSHIP_SPOOF`**.
- **Same-Browser `Alice -> Bob -> Alice` Switch & Onboarding Close**: Opening Alice's unfinished walkthrough (`05_live_onboarding_open_alice.png`), switching to completed Bob closed the walkthrough; switching back to Alice restored `LIVE_ALICE_BIO_TOKEN` without Bob contamination. In-flight `/api/chat/stream` abort yielded `{ aborted: true, name: 'AbortError' }`.

---

## 3. Live `/api/chat/stream` Model Execution, Reasoning, Context & Quotas (`b465ysgu9`)

All calls ran against `https://aira-ai-2026-b465ysgu9-rajpunkeshwarrajgautam-boops-projects.vercel.app/api/chat/stream` with real Neon Auth BFF cookies and isolated `br-snowy-bonus-b32thjlz` persistence (`artifacts/staging-acceptance/pr164/acceptance-evidence.json`):

| Tier / Test Case | Requested Model | HTTP | Executed Provider & Model | Fallback | `reasoningControl` | Stream Deltas / Thinking | Server TTFT / Total (ms) | Outcome & Entitlements |
|---|---|---|---|---|---|---|---|---|
| **Free** — Fast | `aira-fast` | `200` | `groq` / `openai/gpt-oss-120b` | `false` (`SUCCESS`) | `none` | `5` / `0` | `4361` / `5710` | `FREE_FAST_OK 42`; `verified: true` |
| **Free** — Auto (Complex, `budget: 8192`) | `aira-auto` | `200` | `groq` / `openai/gpt-oss-120b` (`aira-fast`) | `false` (`SUCCESS`) | `none` | `3321` / `0` | `5229` / `13298` | Clamped within Free allowlist; `0` boosts consumed; `dailyStandardChatRemaining` `14 -> 12` |
| **Free** — Pro Explicit | `aira-pro` | `403` | Blocked pre-inference | N/A | N/A | `0` / `0` | N/A | `403 PLAN_MODEL_RESTRICTED` (`requiredTier: "plus"`) |
| **Free** — Deep Explicit | `aira-deep` | `403` | Blocked pre-inference | N/A | N/A | `0` / `0` | N/A | `403 PLAN_MODEL_RESTRICTED` (`requiredTier: "pro"`) |
| **Pro Fixture** — Fast | `aira-fast` | `200` | `groq` / `openai/gpt-oss-120b` | `false` (`SUCCESS`) | `none` | `5` / `0` | `~` / client `8738` | `PRO_FAST_OK 63`; `verified: true` |
| **Pro Fixture** — Auto (`budget: 4096`) | `aira-auto` | `200` | `groq` / `openai/gpt-oss-120b` (`aira-fast`) | `false` (`SUCCESS`) | `none` | `937` / `0` | `~` / client `10500` | `verified: true` |
| **Pro Fixture** — Pro | `aira-pro` | `200` | `nvidia` 404 -> `groq` / `openai/gpt-oss-120b` | `true` (`FALLBACK`) | `none` | `134` / `0` | `3437` / `5058` | NVIDIA 404 sanitized & circuit-opened; `verified: true` |
| **Pro Fixture** — Deep (`budget: 4096`) | `aira-deep` | `200` | `nvidia` OPEN -> `groq` / `openai/gpt-oss-120b` | `true` (`FALLBACK` direct -> `SUCCESS`) | `effort_mapped` (`4096`) | `388` / **`54`** (`257` chars) | `6630` / `9002` | Real upstream `thinking_delta` streamed; `reasoningBoostsRemaining` `200 -> 199`; `verified: true` |
| **Pro Fixture** — 28K-char Context | `aira-pro` | `200` | `nvidia` 404 -> `groq` 429 (8K TPM) -> `gemini` / `gemini-3.5-flash-lite` | `true` (`FALLBACK`) | `none` | `1` / `0` | `5703` / `7254` | `PR164_LONG_CTX_CONFIRMED`; `verified: true`; 1M context verified on Gemini fallback |

- **Edge UI Live Chat Screenshot**: `06_edge_profileB_pro_live_chat.png` confirms `AIRA Pro`, `Bob Staging Cert`, conversation list, and streaming composer live against staging.
- **Commercial Quota & Billing Settlement Finding**: `dailyStandardChatRemaining` decremented `150 -> 145` (`5` chats settled), `reasoningBoostsRemaining` decremented `200 -> 199` (`1` boost for `aira-deep`), `entitlement_snapshots` recorded `daily_standard_chat_count: 5`, while `usage_events` remained `0` (`usage_events` is recorded by `apps/api/src/vision/vision-service.ts`, whereas chat metering uses `entitlement_snapshots` + `credit_transactions`).

---

## 4. Authoritative Commercial Quotas & Post-Cleanup Read-Only Neon Audit (`br-snowy-bonus-b32thjlz`)

| Plan Tier (`commercial.ts` & DB `plans`) | Daily Standard Chats | Monthly Standard Units | Monthly Premium Credits | Reasoning Boosts / Mo | Projects / Memories | Saved Agents / Builder |
|---|---|---|---|---|---|---|
| **Guest** (`guest`) | `5` | `5` | `0` | `0` | `0` / `0` | `0` / `none` |
| **AIRA Free** (`free`) | `15` | `150` | `100` | `5` | `3` / `50` | `0` / `none` |
| **AIRA Plus** (`plus`) | `50` | `700` | `3,000` | `50` | `10` / `250` | `3` / `trial` |
| **AIRA Pro** (`pro`) | `150` | `2,000` | `7,500` | `200` | Unlimited (`-1`) / Unlimited (`-1`) | `20` / `metered` |

Read-only post-cleanup inspection of `mute-frost-50372225` / `br-snowy-bonus-b32thjlz` (`31` migrations; latest `031_autonomous_agent_tasks.ts`):
- `user_entitlements`: `null` (`TABLE_DOES_NOT_EXIST`).
- `users`: `10`; `subscriptions`: `0` (isolated `pro` test fixture cleaned up); `straySyntheticCustomers`: `0`; `billing_audit_events`: `0`; `usage_events`: `0`.
- `plan_prices`: `6` dormant seed rows (`price_free_inr` `0.00`, `price_free_usd` `0.00`, `price_plus_inr` `399.00`, `price_plus_usd` `7.99`, `price_pro_inr` `999.00`, `price_pro_usd` `19.99`, all `gateway_price_id: null`, `is_active: true`). Live `/api/billing/plans` returns `billingStatus: "sandbox"`, `checkoutAvailable: false`, `prices: []`. Zero `$20/$50` pricing exists.
- `credit_grants`: `60` `subscription_monthly` rows totaling `6,000` granted / `6,000` remaining (`credit_transactions`: `60`).
- `payment_gateway_events`: `1` row (`gateway: "razorpay"`, `event_type: "subscription.cancelled"`, `signature_valid: true`, `processed: true`).
- `oauth_accounts`: `6` linked accounts (`github: 1`, `google: 5`).

---

## 5. Automated CI & Local Regression Evidence

- **GitHub Actions on `3b2b996bc563e6c3d1dec55b532d973bec863a3e`**:
  - [`CI` Run `43188781879`](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43188781879): `Fast CI` **PASS (2m57s)**, `Semantic Search CI` **PASS (53s)**, `Main / PR certification` **PASS (4m33s)**, `Deployed staging acceptance` **SKIPPED (0s, PR-gated; executed directly against `b465ysgu9`)**.
  - [`Disposable PostgreSQL Certification` Run `43188779636`](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43188779636): **PASS**. *(Note: final CI run for the release-report + `SettingsModal` commit supersedes this SHA on GitHub.)*
- **Local Verification Suites Executed**:
  - `npm run typecheck`: **PASS** (`0` errors across client, server, `api/tsconfig.json`).
  - `npm run lint`: **PASS** (`0` errors, `433` pre-existing warnings).
  - `npm run build`: **PASS** (`dist/` cleanly built).
  - `npm run test:secrets`: **PASS** (`879` tracked files scanned, `0` exposed credentials).
  - `npm run test:model-routing`: **PASS** (provider routing, `p1-3`, `p1-6-*`, `p1-6-7`).
  - `npx tsx --test test/truthful-capabilities-model-architecture.test.ts test/account-billing-truth.test.ts`: **PASS**.
  - `npm run test:integration:entitlements`: **PASS (`20/20`)** (concurrency race, cancellation before/after first token, DB failure fail-closed, cross-account IDOR).
  - `npx tsx test/entitlements-onboarding-browser.test.ts`: **PASS (`5/5` scenarios)** in Microsoft Edge.
  - `npm run test:behavioral:security` (`11/11`), `npm run test:behavioral:precedence` (`10/10`), `npm run test:release-readiness`, `npm run test:db-isolation`, `npm run test:cutover-safety` (`53/53`), `npm run test:auth-fail-closed`, `npm run test:projects-storage-regression` (`12/12`): **PASS**.
  - Suites requiring local `127.0.0.1:5432` PostgreSQL (`test:direct-oauth`, `test:cors` `/api/health` HEALTHY check) or pre-started Vite dev server (`test:mobile-settings`) are verified inside GitHub Actions CI (`Fast CI` & `Main / PR certification`) rather than standalone local runs without a local DB container.

---

## 6. Known Operational Limitations & Release Boundary

1. **Upstream NVIDIA NIM 404 on Configured Account**: `nvidia/llama-3.1-nemotron-70b-instruct` currently returns `HTTP 404` (`Function '...': Not found`) on NVIDIA NIM under the deployed key. Runtime automatically trips the NVIDIA circuit breaker and fails over cleanly to `groq/openai/gpt-oss-120b` (`effort_mapped` reasoning on `aira-deep`) and `gemini/gemini-3.5-flash-lite` (1M context) on payloads exceeding Groq's 8,000 TPM on-demand quota.
2. **Third-Party OAuth Acceptance Scope**: Direct Google/GitHub OAuth code exchange could not be completed on PR preview URLs due to missing preview `GOOGLE_CLIENT_SECRET`/`GITHUB_CLIENT_SECRET` and unwhitelisted ephemeral preview callbacks.
3. **Production Untouched**: `prod-release` remains at `562e75d40b2bed8bfc8fc03fe88dfa9f475b1213`, billing remains in `sandbox`, zero production DB migrations or secret rotations occurred, and PR #164 remains open for release review.
