# AIRA AI 2026 — Truthful Capabilities & Account Isolation Release Report

**Branch**: `fix/truthful-capabilities-model-architecture-20261112`  
**Pull Request**: [#164](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/164)  
**Base Branch (Production Target — Unchanged)**: `prod-release` at `562e75d40b2bed8bfc8fc03fe88dfa9f475b1213`  
**Reviewed Candidate Prior to Remediation**: `1bf5d8e956affab397ad67f3a98d64f2e5d0327c` (subsequent preview/showcase commits on branch: `d497349530343b9f8eec49582289fa2b3392df4a`, `e5d3f4eb276ca33ff5ce1296db4d82e1479c1d52`)  
**Release Verdict**: **NO-GO FOR IMMEDIATE PRODUCTION MERGE (CONDITIONAL)** — All identified code, account-isolation, routing, onboarding, personalization, quota, copy, and local/Neon-branch test defects are remediated and verified, **while exact-SHA live preview database/OAuth chat execution remains blocked until PR preview environment variables (`DATABASE_URL`, `NEON_AUTH_*`) or `staging` pipeline acceptance complete.**

---

## 1. Chronological Audit & Remediation History

1. **Initial PR #164 Implementation (`1287ad07f33f258d724b6ef64d28030ce03b51cb`)**: Updated `ModelSelector`, Settings labels, feature discovery copy, and added initial truthful-capability metadata checks.
2. **Initial Release Report (`1bf5d8e956affab397ad67f3a98d64f2e5d0327c`) & UI Assets (`d497349`, `e5d3f4e`)**: Independent review rejected `GO FOR MERGE` due to eight material engineering and reporting defects (global `aira_settings_v1` cross-account leak, router prioritizing Anthropic over NVIDIA, wrong Plus/Pro quotas and unapproved `$20/$50` pricing, `user_entitlements` assumption, spoofable `x-user-id` onboarding header, unverified `thinkingBudget` upstream behavior, duplicated personalization injection, shallow unit-only certification suite, skipped CI `Deployed staging acceptance` job, and unsupported performance/DB claims).
3. **Full Remediation Pass (Current Diff on `fix/truthful-capabilities-model-architecture-20261112`)**: Resolved every code, storage, backend enforcement, CI workflow, test coverage, and documentation defect listed below without adding production DB migrations (`31` existing migrations preserved) and without altering `prod-release`.

---

## 2. Resolved Defects & Root-Cause Fixes

### 2.0 Primary Security Finding — Cross-Account Personalization Isolation (`src/utils/storage.ts`, `src/App.tsx`, `src/utils/constants.ts`)
- **Root Cause**: `saveSettings`/`loadSettings` stored `userName`, `email`, `userBio`, `customInstructions`, `activeModel`, `extendedThinking`, `thinkingBudget`, and client API key fields in a single shared global key (`aira_settings_v1`) and retained settings in memory across `onAuthStateChange` transitions and active chat streams.
- **Fix**:
  - Partitioned settings into `DEVICE_PREFERENCE_KEYS` (`aira_device_preferences_v1` + sanitized `aira_settings_v1` containing display preferences only) and `ACCOUNT_SETTING_KEYS` scoped per account via `getAccountSettingsStorageKey(userId)` (`aira_account_settings_user_<userId>` or `aira_account_settings_guest`) plus scoped IndexedDB records (`settings_<scopeId>`).
  - Removed synthetic defaults from `DEFAULT_SETTINGS.email` (`''`) and `DEFAULT_SETTINGS.userBio` (`''`) in `src/utils/constants.ts`.
  - Implemented provenance-checked legacy migration (`quarantineLegacyGlobalSettingsIfPresent` / `tryClaimQuarantinedArchive`): legacy `aira_settings_v1` personalization is archived once and reclaimed only if `ownerId` or a non-placeholder `email` matches the authenticating user; unowned legacy blobs are restricted to guest scope, and `aira_settings_v1` is scrubbed of personalization immediately.
  - Updated `src/App.tsx` `onAuthStateChange` to abort in-flight authenticated requests (`neonAuth.abortActiveRequests()`), close transient modals (`isOnboardingOpen`, `isWhatsNewOpen`), clear `activeFeatureGuidance`/`pendingApproval`/`activeExecutionGraph`/`repairDraft`, synchronously switch `settingsOwnerRef`/`activeUserIdRef`, key `<SettingsModal>`, `<PrivacyCenterModal>`, and `<OnboardingWalkthrough>` by user ID, and guard `streamAIResponse` callbacks with `requestEpoch` and `requestOwnerId`.
  - Updated `exportAllStorageData(identity)` to redact API keys (`'[REDACTED]'`) and support strict single-owner `exportAccountStorageData(identity)`.
- **Verification**: Unit & migration suite (`test/truthful-capabilities-model-architecture.test.ts` Test 6) + full Playwright Chromium BFF E2E (`test/account-settings-isolation-browser.test.ts`: Bob login scrubs/ignores Alice's legacy `aira_settings_v1`, Alice reclaims provenance-matched legacy bio, `A -> B -> A` outgoing `/api/chat/stream` `systemPrompt` verification, full `page.reload()`, and slow-stream abort with zero late crosstalk).

### 2.1 Model Registry, Router Priority & Post-Routing Entitlement Enforcement
- **Root Cause**: `VERIFIED_MODEL_REGISTRY` defined `aira-pro` and `aira-deep` as NVIDIA (`nvidia/llama-3.1-nemotron-70b-instruct`), while `ModelRouter.resolveUnprotectedExecution` prioritized `['anthropic', 'nvidia', ...]`, `/api/ready/providers` reported stale `nvidia/nemotron-3-super-120b-a12b`, and `aira-auto` + `RESEARCH` could route Free/Guest users into `aira-deep` without tier clamping.
- **Fix**:
  - Updated `ModelRouter` (`packages/model-router/src/index.ts`) to resolve the registry-declared provider first (`['nvidia', 'openai', 'groq', 'gemini', 'anthropic']`, while still honoring explicit vendor IDs such as `claude-3-5-sonnet` when configured) and skip `OPEN` circuit-breaker providers to healthy capability fallbacks (`groq` / `gemini` / `anthropic`).
  - Enforced post-routing `PLAN_MODEL_ALLOWLIST[callerTier]` clamping in `ModelRouter`, `AgentRuntime` (`setEntitlementResolver` + `isModelAllowedForTier`), and `/api/runs` (`apps/api/src/index.ts`): Free/Guest `aira-auto` + `RESEARCH` clamps to `aira-fast` + `extendedThinking: false` (`entitlementClamped: true`, `downgradedFrom: 'aira-deep'`); explicit requests for `aira-deep` or `aira-pro` by ineligible tiers fail closed with `PlanRestrictionError` (`403 PLAN_MODEL_RESTRICTED`).
  - Updated `/api/ready/providers` (`apps/api/src/index.ts`) to resolve `deepModel` via `resolveNvidiaModel('aira-deep')` (`nvidia/llama-3.1-nemotron-70b-instruct`) and probe NVIDIA `/v1/models` live.

### 2.2 Commercial Contract Alignment & Empirical Neon Database Audit
- **Root Cause**: Previous draft report cited `$20/mo`, `$50/mo`, `Unlimited chats`, `user_entitlements`, `Enterprise`, and mismatched Plus/Pro limits.
- **Authoritative Runtime Contract (`packages/contracts/src/commercial.ts` & live `/api/billing/plans`)**:

| Plan Tier | Standard Daily | Standard Monthly | Premium Credits / Mo | Reasoning Boosts / Mo | Projects / Memories Limit | Saved Agents / Builder | Concurrent Inference | Active Checkout Prices |
|---|---|---|---|---|---|---|---|---|
| **Guest** (`guest`) | `5` | `5` | `0` | `0` | `0` / `0` | `0` / `none` | `1` | `prices: []` (`sandbox`) |
| **AIRA Free** (`free`) | `15` | `150` | `100` | `5` | `3` / `50` | `0` / `none` | `1` | `prices: []` (`sandbox`) |
| **AIRA Plus** (`plus`) | `50` | `700` | `3,000` | `50` | `10` / `250` | `3` / `trial` | `1` | `prices: []` (`checkoutAvailable: false`) |
| **AIRA Pro** (`pro`) | `150` | `2,000` | `7,500` | `200` | Unlimited (`-1`) / Unlimited (`-1`) | `20` / `metered` | `2` | `prices: []` (`checkoutAvailable: false`) |

- **Empirical Read-Only Neon Staging Database Audit (`mute-frost-50372225`)**:
  - `user_entitlements`: `TABLE_DOES_NOT_EXIST` on both `main` (`br-autumn-star-b36dfu5w`, latest migration `023_idempotent_operations.ts`) and `cert-pr163-entitlements-20261111` (`br-snowy-bonus-b32thjlz`, latest migration `031_autonomous_agent_tasks.ts`).
  - `plans` table (`3` rows on both branches): Exact quota alignment with `COMMERCIAL_PLANS` (`free`: 15/150/100/5; `plus`: 50/700/3000/50; `pro`: 150/2000/7500/200).
  - `plan_prices` DB migration seed (`6` rows): INR `399.00` / USD `7.99` (`plus`) and INR `999.00` / USD `19.99` (`pro`) exist as dormant DB seed rows, while runtime `commercial.ts` sets `prices: []` and `/api/billing/plans` returns `billingStatus: "sandbox"`, `checkoutAvailable: false`. Zero `$20/$50` rows exist anywhere in schema or runtime.
  - `subscriptions`: `0` rows on `main` and `0` rows on `cert-pr163-entitlements-20261111`.
  - `credit_grants`: On `main`, `16` `subscription_monthly` grants totaling `1,600` granted / `1,600` remaining (`16` customers x `100` Free credits). On `cert-pr163-entitlements-20261111` prior to test runs, `55` grants (`57` during subsequent audit pass as signup tests added isolated test accounts); zero `topup` or paid grants.
  - `payment_gateway_events`: `0` rows on `main`; `1` row on `cert-pr163-entitlements-20261111` (`gateway: "razorpay"`, `event_type: "subscription.cancelled"`, `signature_valid: true`, `processed: true`).
  - `billing_audit_events`: `0` rows on both branches.
  - `oauth_accounts`: `6` linked accounts (`github: 1`, `google: 5`).
- **UI & Video Copy Fixes**: Removed `Enterprise` tier references in `LegalViewerModal.tsx`, `ReleaseNotesModal.tsx`, `SettingsModal.tsx`; aligned `src/video/types.ts` & `MotionStudioModal.tsx` to Pro `150/day · 2,000/mo`, `5 progressive steps`, and removed unmeasured `<250 ms`, `450 tps`, `99.95%` claims; replaced no-op toggle on `PrivacyCenterModal.tsx` with `Enforced Safeguard` badge.

### 2.3 Onboarding Lifecycle & Zero-Migration Authenticated Server Sync
- **Root Cause**: `src/utils/onboarding.ts` sent client-supplied `x-user-id` headers to a missing server route and did not close an active tutorial when switching into an account that already completed onboarding.
- **Fix**:
  - Implemented `GET /api/user/onboarding` and `POST /api/user/onboarding` in `apps/api/src/account-routes.ts` strictly deriving ownership from `req.principal.userId`, failing closed with `401` for anonymous/guest sessions, and rejecting spoofed `x-user-id`, `query.userId`, `body.userId`, or `body.principalId` with `403 FORBIDDEN_OWNERSHIP_SPOOF`.
  - Persisted state in `memory_records` (`type: 'onboarding_state'`, `id: 'onboarding:' + userId`) with zero schema migrations (`db:verify:deploy` passes `31` migrations), and excluded `'onboarding_state'` from `PostgresKnowledgeRepository` queries/purges (`packages/knowledge/src/repositories.ts`).
  - Removed `x-user-id` from `src/utils/onboarding.ts`, used `keepalive: true` on `POST /api/user/onboarding` + `authEpoch` stale-response checks, and verified open Account A walkthrough immediately closes when switching to server-completed Account B (`test/account-settings-isolation-browser.test.ts`).

### 2.4 Reasoning & `thinkingBudget` Upstream Provenance
- **Root Cause**: UI and prior report implied uniform `thinkingBudget` token-budget control across all reasoning modes even where NVIDIA NIM `nvidia/llama-3.1-nemotron-70b-instruct` accepts standard `max_tokens` only.
- **Fix & Honest Trace (`Settings -> /api/chat/stream -> AgentRuntime -> ModelRouter -> Adapters`)**:
  - Classified explicit `reasoningControl` provenance (`ReasoningControlMode` in `packages/contracts/src/model-registry.ts`):
    - **`output_cap_only`** (NVIDIA `nvidia/llama-3.1-nemotron-70b-instruct` in `OpenAIAdapter`): Applies `thinkingBudget` strictly to outbound `max_tokens` ceiling (`Math.min(Math.max(policy.reasoningBudget, 256), 16384)`); never injects invalid `thinkingBudget` or `reasoning_budget` JSON parameters.
    - **`effort_mapped`** (Groq `openai/gpt-oss-120b` in `OpenAIAdapter`): Maps `thinkingBudget` when `extendedThinking` is true to OpenAI/Groq `reasoning_effort` (`'low'` <= 2048, `'medium'` <= 8192, `'high'` > 8192).
    - **`native_budget`** (`AnthropicAdapter` `thinking: { type: 'enabled', budget_tokens }` and `GeminiAdapter` `generationConfig.thinkingConfig.thinkingBudget` for non-lite `gemini-2.5-pro`/`gemini-2.5-flash`).
    - **`none`**: Fast/non-extended routes.
  - Fixed `/api/chat/stream` in `apps/api/src/index.ts` so `tryConsumeReasoningBoost` only deducts a monthly boost when `run.modelPolicy?.extendedThinking` is actually enabled.
  - Updated `SettingsModal.tsx`, `HelpCenterModal.tsx`, `OnboardingWalkthrough.tsx`, and `ReleaseNotesModal.tsx` copy accurately.
  - **Empirical Note**: Outbound HTTP request body payloads for NVIDIA, Groq, and Gemini were verified under mocked `fetch` in `test/truthful-capabilities-model-architecture.test.ts` Test 7; live provider completion latency/TTFT comparison across Fast/Auto/Pro/Deep was **not** executed live because provider API keys are not plaintext-accessible locally and the PR preview branch lacks `DATABASE_URL`/`NEON_AUTH_*`.

### 2.5 Personalization Non-Duplication & Bounded Context
- **Root Cause**: `App.tsx` passed custom instructions into `systemContext`, and `composeSystemPrompt` + `apps/api/src/index.ts` appended them again.
- **Fix**: Enforced `PERSONALIZATION_BOUNDS` in `src/utils/aiEngine.ts` (`MAX_BIO_CHARS = 500`, `MAX_CUSTOM_INSTRUCTIONS_CHARS = 2000`, `MAX_RUNTIME_DIRECTIVE_CHARS = 2000`), deduplicated identical directives in both `composeSystemPrompt` and `apps/api/src/index.ts` (`contextSubgraph` vs `systemPrompt`), and established explicit section order (`Response Style Directive -> User Profile Context -> User Custom Instructions -> Mode Directive -> Active Project Workspace`).

### 2.6 Mandatory CI & Certification Coverage
- Expanded `test/truthful-capabilities-model-architecture.test.ts` to 10 comprehensive behavioral/security/integration subtests (`11` test nodes including root suite).
- Added real Playwright Chromium BFF E2E suite `test/account-settings-isolation-browser.test.ts`.
- Wired both into `.github/workflows/ci.yml` as mandatory PR checks (`fast` and `certify` jobs).

---

## 3. Verification Summary (Local & Neon Staging Branch)

| Check / Suite | Scope | Verdict | Notes |
|---|---|---|---|
| `npm run typecheck` | Client + server + API TS 6 configs | **PASS** | Ran cleanly prior to final doc write (re-verified post-final edit before commit) |
| `npm run lint` | `oxlint` across workspace | **PASS** | 0 errors |
| `npm run build` | `tsc -b && vite build` | **PASS** | Clean production client bundle |
| `npm run test:secrets` | Credential scan across tracked files | **PASS** | 0 exposed credentials |
| `npx tsx --test test/truthful-capabilities-model-architecture.test.ts` | Registry, prompt bounds/dedup, `A->B->A` storage/migration, router health/payloads, Free-tier clamping, `/api/user/onboarding`, contract/UI audit | **PASS (11/11)** | Upstream HTTP calls mocked via `fetch` stub |
| `npx tsx --test test/account-settings-isolation-browser.test.ts` | Built `dist/` + Express BFF cookies/CSRF + Playwright Chromium `A->B->A`, reload, stream abort, onboarding close | **PASS (1/1)** | Executed in Microsoft Edge headless |
| `npm run test:mobile-settings` & `npm run test:mobile-sidebar` | Responsive UI across 13 mobile/desktop viewports + touch swipe | **PASS** | All viewports passed |
| `npx tsx test/entitlements-onboarding-browser.test.ts` | M5 5/5 scenarios (What's New, 5-stage Onboarding, Upgrade modals, Plan matrix, Mobile) | **PASS (5/5)** | Scenario 3.2 updated to truthful `aira-pro` / `Unlock NVIDIA Nemotron 70B` selector; Vite dev/preview without backend `/api` uses stateful route stubs |
| `npm run test:model-routing` (`model-router-provider-routing`, `p1-6-*`) | Routing, capacity guard, circuit breakers, hedging | **PASS** | Mocked upstream HTTP where network isn't authorized |
| `npm run test:behavioral:precedence` + `model-provenance-identity` + `security` | Behavioral routing precedence, security invariants, model provenance | **PASS** | `clarification-delivery.test.ts` requires `DATABASE_URL` (Postgres CI container; fails with `ECONNREFUSED` when local PG omitted) |
| `npm run test:integration:entitlements` | 20 adversarial quota/race/webhook/IDOR tests | **PASS (20/20)** | Verified against PostgreSQL |
| `npm run test:release-readiness` & `npx tsx test/adversarial-tier5.test.ts` | Release readiness + 30 Tier-5 stress/security tests | **PASS (30/30)** | Verified |
| `npx tsx test/projects-storage-regression.test.ts` & `resilient-storage-quota.test.ts` | IndexedDB/localStorage fidelity & quota eviction safety | **PASS (18/18)** | Account-scoped vs recovery export preserved |
| Neon `cert-pr163-entitlements-20261111` (`br-snowy-bonus-b32thjlz`) DB Audit + `db:verify:deploy` + Onboarding + `auth-account-switching-isolation.test.ts` | Real Staging Neon Auth + Neon PostgreSQL (`31` migrations) | **PASS** | Verified real multi-account BFF isolation, onboarding DB persistence + `403` spoof rejection (synthetic rows cleaned up) |

---

## 4. Why `Deployed staging acceptance` Skipped on PR #164 & Remaining Limitations

1. **Why CI Skipped `Deployed staging acceptance`**: In `.github/workflows/ci.yml` (`staging-deployed`, line 412), execution is gated by `if: github.event_name == 'push' && github.ref == 'refs/heads/staging'`. Pull requests targeting `prod-release` intentionally skip `staging-deployed` until code is pushed to `refs/heads/staging`.
2. **PR #164 Vercel Preview Environment Gap (`fix/truthful-capabilities-model-architecture-20261112`)**:
   - Inspecting `vercel env ls preview` confirms `GROQ_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, and `AIRA_SESSION_SECRET` apply to all `Preview` builds, while `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `VITE_NEON_AUTH_URL`, and `AIRA_EXTERNAL_AUTH_ENABLED` are **branch-scoped** on Vercel and were not configured for branch `fix/truthful-capabilities-model-architecture-20261112`.
   - Consequently, on PR #164's Vercel Preview (`e5d3f4e`), `/api/billing/plans` returns `200` and `/api/ready/providers` returns `200` (`groq` HTTP 200, `gemini` HTTP 200), whereas `/api/ready` returns `503 AGENT_DATABASE_NOT_CONFIGURED` and `POST /api/chat/stream` returns `401 connect ECONNREFUSED 127.0.0.1:5432`.
3. **Unverified Items / Blockers Before Production Authorization**:
   - **BLOCKED — Live Deployed Preview DB / Chat / Two-Account Third-Party OAuth Flow**: Requires either owner scoping of `DATABASE_URL` + `NEON_AUTH_*` + OAuth credentials onto PR #164's preview branch or execution via `staging` push + interactive two-account Google/GitHub OAuth acceptance on `staging-deployed`.
   - **NOT MEASURED — Live Upstream Multi-Mode Inference Latency/TTFT (Fast/Auto/Pro/Deep)**: Routing, upstream parameter formatting, Free-tier clamping, and provider HTTP 200 catalog availability are verified, whereas live billed `/api/chat/stream` completion latency/reasoning comparisons on the exact PR #164 SHA remain unmeasured without live preview DB + OAuth session execution.
