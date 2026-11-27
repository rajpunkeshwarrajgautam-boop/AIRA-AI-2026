# AIRA GenUI Phase 0 — Engineering Verification & Continuation Record

**Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI`  
**Branch:** `feat/aira-genui-phase1-foundation`  
**Base Commit:** `6c90c12930a23018ff02435a7832ca5bd0578b26` (`origin/staging`)  
**Architecture Direction:** Strategy C — Hybrid AIRA-Native (Express 5, React 19 + Vite 8, `ModelRouter`, `ServerIntentRouter`, `SemanticReasoner`, `AgentRuntime`, `ApprovalKernel`, `CapacityGuard`, `QuotaReservation`, Neon PostgreSQL 18, `zod@^4.6.7`).

---

## 1. Preserved Certified Baselines

| Reference | Verified SHA / State | Status |
| :--- | :--- | :--- |
| `origin/staging` | `6c90c12930a23018ff02435a7832ca5bd0578b26` | Used as Phase 0 base |
| `origin/prod-release` | `f429d90a1f4322a0d362956fb9e55a38cb3b5508` | Unmodified |
| PR #215 (`rc/prod-billing-release-20261126`) | `fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` | Unmodified |
| Research worktree (`aira_genui_research_specification`) | `c1e7d1748f7f8d61dcc17b5fec82482bc16dc8bf` | Preserved (`docs/genui/` intact) |
| Main repo (`C:\Users\WORKSTATION\AIRA-AI-2026`) | `97995f1` (`fix/long-prompt-storage`) | Untouched |

---

## 2. Production Behavioural Discovery & Root Causes (`https://aira-ai-2026.vercel.app/`, SHA `f429d90`)

Live Microsoft Edge inspection + `origin/prod-release` source analysis confirmed five production findings (`scratch/prod-discovery/prod_discovery_report.json`):

1. **P1 — Guest Default Model Rejection (`HTTP 403 PLAN_MODEL_RESTRICTED`):** `DEFAULT_SETTINGS.activeModel` is `'aira-auto'` (`minTier: 'free'`), while unauthenticated guests only qualify for `'aira-fast'` (`minTier: 'guest'`).
2. **P2 — Standard Chat/Math/Tables/Multi-Turn/Research (`HTTP 200` PASS on `aira-fast`):** Switching explicitly to `AIRA Fast` (`groq/openai/gpt-oss-120b`) rendered plain answers, KaTeX (`katex=4`/`katex=6`), Markdown tables (`tables=1`/`tables=2`), multi-turn DuckDB extension, and sourced research cleanly.
3. **P3 — Code Explanation Hijacked into Broken HTML Artifact Preview:** `AgentRuntime` (`packages/agent-runtime/src/index.ts:1771`) emits `artifact.created` with `title: 'Generated Analysis Artifact'`, `type: 'application/vnd.ant.code'`, and raw markdown prose whenever `run.content.includes('\`\`\`')`. `src/utils/aiEngine.ts:411` defaults missing `language` to `'html'`, and `UnifiedWorkspace` / `ArtifactStudio` mounts raw Markdown inside the HTML sandbox iframe, triggering CSP console errors blocking `https://cdn.tailwindcss.com`.
4. **P4 — Charts, Interactive Calculators, and HTML/SVG Artifacts Fail End-to-End (`tool_started` -> `error`):**
   - `SemanticReasoner.evaluateFastPath` (`isDirectCodingOrMath`) omits `chart`, `calculator`, `simulation`, `html`, and `svg`.
   - Prompts fell through to `classifyWithModel` -> classified as `TOOL_ACTION`.
   - `AgentRuntime` Checkpoint 2 defaults unmatched `TOOL_ACTION` prompts to `selectedToolName = 'web_search'`.
   - `tool_web_search` requires `permissionScopes: ['browser.read']` (`packages/tool-runtime/src/gateway.ts:1414`), whereas guest principals only hold `scopes: ['chat:write']` (`apps/api/src/auth/principal-provider.ts:67`), causing `ToolGateway.execute` Step 5 (`TOOL_PERMISSION_DENIED`) -> `run.state = 'FAILED'`.
5. **P5 — Agent Workspace Behaviour & Entitlement Reality:** Source inspection confirms `AgentRuntime`, `WorkflowEngine`, and `BuilderService` execute real DAG workflows, approvals, and E2B/Docker/OCI sandboxes (not simulated UI), and stream genuine SSE lifecycle events (`workflow_step_*`, `tool_started`, `approval_required`). However, `AgentRuntime` Checkpoint 2 relies on keyword/regex heuristics rather than native model tool calling, and guests clicking Agent mode hit the guest gate (`"Sign In to Access Agent Workspace"`).

---

## 3. Commercial Entitlement Matrix (Design Proposal — Unchanged in Code/Billing)

Aligned with `COMMERCIAL_PLANS` (`packages/contracts/src/commercial.ts`), `PLAN_CAPABILITY_MATRIX`, and `ADR-0001`/`ADR-0003` (`1 Credit = $0.001 USD`):

| Capability / Mode | Cost Center Separation | Guest (`₹0` / `$0`) | Free (`₹0` / `$0`) | Plus (`₹399` / `$7.99`) | Pro (`₹999` / `$19.99`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Plain text, Markdown, KaTeX, Tables | Standard inference only | 5/day, `aira-fast` | 15/day (150/mo) | 50/day (700/mo) | 150/day (2000/mo) |
| Native visualizations (`chart.js` v4 / `d3` v7 / SVG / Mermaid) | Standard inference for initial JSON; **$0** for local pan/zoom/sort/export | Allowed (`aira-fast`) | Allowed | Allowed | Allowed |
| Declarative interactive controls (A2UI v1.0 sliders/calculators/forms) | Standard inference per AI turn; **$0** deterministic local state interaction | Basic read-only / local calc | Allowed | Allowed | Allowed |
| Sandboxed generated mini-apps (client Websandbox HTML/CSS/JS) | Inference + light host validation only; **$0** local user interaction | Disabled | Limited credit-metered (requires verification + `100` credits pool / small per-app allowance) | Metered from `3,000` credits | Metered from `7,500` credits |
| Editable multi-file artifacts & export | Standard inference; Storage budget cap (`maxProjects`/`maxMemoryRecords`) | Session-only | Up to 3 projects | Up to 10 projects | Unlimited (`-1`) |
| Agent Workspace (autonomous missions, workflows, E2B/Docker sandbox) | Inference + Tool + Sandbox + External Data (separate line items) | Blocked (Sign-in gate) | Blocked (`allowAutonomous: false`) | Autonomous + Builder trial (`savedAgentsLimit: 3`) | Full (`allowBrowserTools`, `allowPythonSandbox`, `savedAgentsLimit: 20`, 2 concurrent) |

---

## 4. Technical & Security Validation Summary

1. **Zod v3 vs v4 & A2UI Version Selection:**
   - AIRA runs `zod@^4.6.7`. Verified `@ag-ui/core@1.0.5` supports `zod@^3.25.18 || ^4.0.0` (`ADOPT_WITH_ADAPTER`).
   - Verified `@copilotkit/a2ui-renderer` (`_def?.typeName`) and `@a2ui/react@0.16.1` (`zod@^3.25.76`) are incompatible with Zod v4 -> build native AIRA A2UI renderer targeting **A2UI `v1.0`** (`specification/v1_0` embeds initial component tree cleanly in `createSurface` and decouples host theme/styling).
2. **Upstream License Compliance:**
   - `OpenIntelligentUI`: MIT License (Copyright Atai Barkai) -> preserve MIT notice in adapted headers/ATTRIBUTION for Phases 1–3.
   - `ag-ui`: MIT; `A2UI`: Apache-2.0; `clarinet`: BSD-2-Clause; `idiomorph`: 0BSD; `chart.js`: MIT; `d3`: ISC; `three`: MIT.
3. **Existing `src/utils/artifactSandbox.ts` Security Audit -> REMEDIATED (Phase 0.5):**
   - `safeJsonStringifyForHtmlScript` (`src/utils/sandboxSecurity.ts`) escapes `<`, `>`, `&`, U+2028, and U+2029 (blocks `</script>` and `<!--` breakouts).
   - Floating unpinned external CDNs (`cdn.tailwindcss.com`, `unpkg.com`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`) and `'unsafe-eval'` are removed from all single-file and multi-file sandbox templates (`ARTIFACT_CSP_META_TAG`, `ARTIFACT_STRICT_STATIC_CSP_META_TAG`, `ARTIFACT_REACT_CSP_META_TAG`); SVG/Markdown/React/Mermaid/Code preview render statically with `script-src 'none'`.
   - `stripUntrustedHtmlSecurityVectors` strips model-supplied `<meta http-equiv="Content-Security-Policy|refresh">`, `<base>`, and external `script[src]` (including protocol-relative `//`) before injecting the authoritative CSP.
   - Pure TypeScript `renderSafeMarkdownHtml` and `sanitizeSvgMarkup` neutralize HTML/script/event-handler/`javascript:`/`vbscript:`/`data:text/html`/`data:image/svg+xml` XSS vectors without unsafe inline scripts.
   - Host `postMessage` bridge (`validateSandboxBridgeMessage`) enforces `event.source`, opaque `event.origin === 'null'`, active cryptographic `nonce`, allowed action allowlist (`CONSOLE_LOG`, `AIRA_ARTIFACT_RUNTIME_ERROR`), message/payload byte caps (`SANDBOX_LIMITS`), and a max concurrent sandbox preview slot limit (`acquireSandboxSlot`/`releaseSandboxSlot`, limit 2).
4. **Visualization Dependencies:** Not installed in Phase 0/0.5 (`chart.js@4.6.2`, `d3@7.9.2`, `three@0.187.0` deferred to Phases 1–3).

---

## 5. Phase 0 & Phase 0.5 Implementation Ledger

### Lineage & Commits
- **Original Discovery & Research Baseline:** `origin/prod-release` (`f429d90`) and `aira_genui_research_specification` (`c1e7d17`).
- **Phase 0 Implementation Commit:** `f77fb64061415b1b466f682a00d34614ffd18db5` (`ModelRouter` normalized tool-call streaming across OpenAI/Anthropic/Gemini/Resilient/Mock adapters + isolated `PresentationRouter` PoC).
- **Phase 0.5 Remediation & Security Hardening (Current HEAD on `feat/aira-genui-phase1-foundation`):**
  - **P1 Guest Default Model:** `src/utils/constants.ts`, `src/utils/storage.ts`, `src/App.tsx` (`getDefaultModelForTier`, `resolveEntitledModelForTier`, reactive entitlement clamping preserving pending Pro preferences until settled, sign-in/sign-out/clear-data reset hygiene, server `PLAN_MODEL_RESTRICTED` preserved).
  - **P3 Code & Artifact Classification:** `packages/agent-runtime/src/artifact-classifier.ts`, `packages/agent-runtime/src/index.ts`, `src/utils/artifactClassification.ts`, `src/utils/aiEngine.ts`, `src/components/UnifiedWorkspace.tsx` (normal fenced snippets remain chat Markdown; unknown/`application/vnd.ant.code` defaults to `'text'` and is excluded from HTML preview tabs).
  - **P4 Intent, Tool Selection & PresentationRouter Integration:** `packages/agent-runtime/src/behavioral/semantic-reasoner.ts`, `packages/agent-runtime/src/router.ts`, `packages/agent-runtime/src/index.ts` (supplied-data charts/calculators/HTML-SVG route to `ANSWER`, live external queries route to `RESEARCH`, arbitrary Checkpoint 2 `'web_search'` default removed, bounded `ModelRouter` tool validation fallback, graceful Tier 3 fallback, guest `browser.read` restriction preserved).
  - **Section 8 Sandbox Security Gate:** `src/utils/sandboxSecurity.ts`, `src/utils/artifactSandbox.ts`, `src/utils/multiFileSandbox.ts`, `src/components/ArtifactStudio.tsx`, `src/components/UnifiedWorkspace.tsx`.

### Measured PresentationRouter Benchmarks
- **Dev Corpus (28 cases, `test/presentation-router-benchmark.ts`):** `28/28` (`accuracy: 1.0`), `avgLatency: 0.17ms`, `p95: 1.12ms`, `fallbackRate: 0`, `tierBreakdown: { deterministic: 24, model: 4, fallback: 0 }` (Tier 2 offline stub).
- **Fault-Resilience Corpus (4 cases):** `4/4` non-failing recovery.
- **Independent Holdout Corpus (20 unseen prompts, `test/presentation-router-holdout.test.ts`):** Separate offline deterministic baseline (`>=10` Tier 1 matches at `<5ms` avg, graceful Tier 3 fallback on unseen ambiguous phrasing) vs model-assisted classifier (`accuracy >= 0.90`, `invalidStructuredOutputRate: 0`).

### Live Provider Probe (NVIDIA NIM)
- **Hardcoded Default Finding:** Calling `nvidia/llama-3.1-nemotron-70b-instruct` against live `integrate.api.nvidia.com/v1` on `2026-11-27` returned **HTTP 410 Gone** (`EOL 2026-11-15T00:00:00Z`).
- **Active Model Verification (`nvidia/nemotron-3.5-lightning-30b-a3b` via `NVIDIA_API_KEY`):**
  - Text stream: PASS (`904ms`, `2` text deltas, `finishReason: "stop"`, `totalTokens: 148`).
  - Native tool-call streaming: PASS (`sawToolEvent: true`, `toolCalls: [{ name: "calculator", arguments: { expression: "19 * 23" } }]`, `finishReason: "tool_calls"`, `totalTokens: 296`).
  - Cancellation (`AbortSignal`): PASS (`261ms`, aborted cleanly as `USER_CANCELLED_PROBE`).
  - Live Tier 2 `PresentationRouter`: `1403.85ms`, `$0.00015045` (`totalTokens: 343`); lightning reasoning output exceeded compact JSON expectation and degraded safely to Tier 3 `text_markdown` (`degradedToFallback: true`).
  - Unverified providers due to absent keys in local `.env`: Groq, Gemini, OpenAI, Anthropic (`INCOMPLETE_MISSING_PROVIDER_KEYS`).

---

## 6. Post-Fix Verification Ledger

| Check / Suite | Command / Target | Result |
| :--- | :--- | :--- |
| Targeted Lint (14 changed files) | `npx oxlint ...` | **PASS** (0 errors) |
| Repo Lint | `npm run lint` | **PASS** (0 errors, pre-existing warnings only) |
| Typecheck (`tsc -b`, server, api) | `npm run typecheck` | **PASS** (0 errors) |
| Production Build | `npm run build` (`vite build`) | **PASS** |
| Phase 0 + 0.5 + Sandbox Suites (11 files) | `npx tsx --test test/genui-defect-repro-and-guest-model.test.ts test/artifact-classification-remediation.test.ts test/intent-tool-presentation-remediation.test.ts test/presentation-router-holdout.test.ts test/artifact-sandbox-security-gate.test.ts test/artifact-sandbox-containment.test.ts test/artifact-studio-m1.test.ts test/multi-file-bundle-engine.test.ts test/adaptive-studio-preview.test.tsx test/presentation-router-poc.test.ts test/model-router-tool-streaming.test.ts` | **PASS (69/69)** |
| Intent Router & Policy | `npm run test:router` | **PASS** |
| Model Routing Suite | `npm run test:model-routing` | **PASS** |
| Security & Isolation Remediations | `npm run test:remediations` | **PASS (53/53, 16 suites)** |
| Ephemeral WSL PostgreSQL 16 Suite | `assert-disposable-postgres.mjs` + `npm run db:migrate` + `npm run test:tools` (`AIRA_POSTGRES_CERTIFICATION=1`) + `clarification-delivery.test.ts` + `cancellation-cleanup-telemetry.test.ts` + `audit-remediation-suite.test.ts` | **PASS** (`11/11` `test:tools` + `18/18` API/Behavioral/Cancellation) |
| Ephemeral WSL PostgreSQL 18 Compat | `npm run db:migrate` + `clarification-delivery.test.ts` on PG 18 (`/usr/lib/postgresql/18`) | **PASS (9/9)** |
| Scenario 17 Pre-Existing Check | Compared cleanly on detached base `6c90c12930a23018ff02435a7832ca5bd0578b26` | **PRE-EXISTING FAIL** (PR #217 strict Razorpay cancellation webhook lookup `sub_gw_fbe8081d`; unrelated to GenUI) |
| Live NVIDIA NIM Probe (`nemotron-3.5-lightning`) | Text + tool-call stream + `AbortSignal` + Tier 2 `PresentationRouter` | **PASS (bounded)**; hardcoded `llama-3.1-nemotron-70b-instruct` hit upstream **HTTP 410 EOL** |
| Live Groq/Gemini/Anthropic/OpenAI | Required API keys missing locally | **BLOCKED (EXTERNAL)** (`INCOMPLETE_MISSING_PROVIDER_KEYS`) |
| Live Authenticated Production Agent Workspace UI | Production OAuth test credentials unavailable locally | **BLOCKED (EXTERNAL)** (`INCOMPLETE_AUTHENTICATED_UI_CREDENTIALS`; local DB-backed API auth/isolation verified via `audit-remediation-suite.test.ts`) |
| Parallel Subagent Review | `code-review` + `research` subagents hit API quota (`429`) | Direct two-axis + AppSec review completed in-session |

**Current Verdict:** `PHASE_0_FOUNDATION_IMPLEMENTED_EXTERNAL_CERTIFICATION_BLOCKED`  
All Phase 0 and Phase 0.5 deliverables, defect remediations (P1, P3, P4), AppSec sandbox hardening, local ephemeral PostgreSQL 16/18 certification (`test:tools`, `clarification-delivery`, `audit-remediation-suite`), live NVIDIA NIM tool-streaming smoke checks, lint, typecheck, and build pass with zero release-blocking regressions. Full multi-provider live certification (Groq/Gemini/OpenAI/Anthropic) and interactive OAuth Agent Workspace browser acceptance remain blocked solely by missing external provider API keys and interactive OAuth credentials in this workstation environment.
