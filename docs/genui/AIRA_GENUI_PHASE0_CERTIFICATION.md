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
3. **Existing `src/utils/artifactSandbox.ts` Security Audit (Actionable before Phase 3):**
   - `JSON.stringify(...)` inside `<script>` tags does not escape `</script>` or `<!--` (`\u003c` escaping required).
   - Unpinned third-party CDNs (`cdn.tailwindcss.com`, `unpkg.com`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`) trigger CSP failures and supply-chain exposure; React mode uses `'unsafe-eval'` for Babel.
   - HTML mode uses substring `.includes('Content-Security-Policy')` check, bypassable by HTML comments.
   - Markdown mode runs `marked.parse` without DOMPurify under `'unsafe-inline'`; SVG mode injects unvalidated `<svg>` markup.
   - No host-side concurrent sandbox instance limit.
4. **Visualization Dependencies:** Not installed in Phase 0 (`chart.js@4.6.2`, `d3@7.9.2`, `three@0.187.0` deferred to Phases 1–3).

---

## 5. Phase 0 Implementation & Benchmark Metrics

### Implemented Files
- `packages/contracts/src/index.ts` — Added optional `ModelToolDefinition`, `ModelToolChoice` schemas onto `ModelPolicySchema` (internal-only; excluded from public `CreateRunRequestSchema`).
- `packages/model-router/src/tool-call-stream.ts` — Shared `ToolCallStreamAccumulator`, `validateToolArgumentsJson`, OpenAI/Anthropic formatters, and `isSubstantiveStreamDelta`.
- `packages/model-router/src/index.ts` — Provider-normalized tool-call streaming across `OpenAIAdapter`, `AnthropicAdapter` (shared `buildRequestPayload`, consecutive `tool_result` merging, `extendedThinking`, `firstTokenTimeoutMs`, SSE error handling), and `DeterministicMockAdapter`.
- `packages/model-router/src/gemini-adapter.ts` — Normalized `functionDeclarations`, `toolConfig`, `functionCall`/`functionResponse` serialization, invalid `functionCall` isolation, truncated-frame detection, `reader.releaseLock()` + `AbortSignal.any`.
- `packages/model-router/src/resilient-adapter.ts` — First-substantive-event stickiness lock (`text` OR `tool_call_*`), tool-only fallback support, listener cleanup.
- `packages/agent-runtime/src/presentation-router.ts` — Isolated 3-tier `PresentationRouter` covering all 8 modes (`Tier 1` deterministic -> `Tier 2` bounded `ModelRouter` Zod v4 JSON -> `Tier 3` text/Markdown fallback).

### Measured Benchmark (`npx tsx test/presentation-router-benchmark.ts`)
- **Primary Corpus (28 cases across all 8 modes):** `28/28` correct (`accuracy: 1.0`), `averageLatencyMs: 0.17ms`, `p95LatencyMs: 1.12ms`, `totalEstimatedCostUsd: $0.0001746` (`$0.00000624` avg/prompt), `fallbackRate: 0`, `invalidStructuredOutputRate: 0`, `tierBreakdown: { deterministic: 24, model: 4, fallback: 0 }`. *(Note: Tier 2 4/4 cases ran against an offline deterministic model stub because no external LLM API keys are configured in this environment.)*
- **Fault-Resilience Corpus (4 cases: malformed JSON, invalid schema, deadline timeout, valid):** `4/4` non-failing recovery, `fallbackRate: 0.75`, `invalidStructuredOutputRate: 0.5`.

---

## 6. Post-Fix Verification Ledger

| Check / Suite | Command | Result |
| :--- | :--- | :--- |
| Lint (9 Phase 0 files) | `npx oxlint ...` | **PASS** (0 warnings, 0 errors, 56ms/18ms) |
| Lint (Repo) | `npm run lint` | **PASS** (0 errors, 563 pre-existing warnings) |
| Typecheck | `npm run typecheck` | **PASS** (`tsc -b`, server, api — 0 errors) |
| Production Build | `npm run build` | **PASS** (`tsc -b && vite build`) |
| Model Routing Suite | `npm run test:model-routing` | **PASS** |
| Intent Router Suite | `npm run test:router` | **PASS** |
| Remediations Matrix | `npm run test:remediations` | **PASS** (53/53, 16 suites) |
| Phase 0 + Adapter Suites | `npx tsx --test test/model-router-tool-streaming.test.ts test/presentation-router-poc.test.ts test/behavioral/model-provenance-identity.test.ts test/behavioral/nemotron-stream-regression.test.ts test/tool-calls-schema-drift.test.ts test/calculator-parsing-and-nvidia-routing.test.ts` | **PASS** (52/52, 9 suites) |
| Tool Gateway PG Cert | `npm run test:tools` | **BLOCKED (EXTERNAL)** (`AIRA_POSTGRES_CERTIFICATION=1` / PG required) |
| Adversarial Entitlements | `npx tsx --test test/integration/entitlements/adversarial-entitlements.test.ts` | **53/54 PASS, 1 PRE-EXISTING FAIL** (Scenario 17 Razorpay webhook record lookup) |
| Behavioral Clarification (PG) | `npm run test:behavioral` (`clarification-delivery.test.ts`) | **BLOCKED (EXTERNAL)** (`ECONNREFUSED 127.0.0.1:5432`) |
| Live Provider Smoke | `test/presentation-router-benchmark.ts` | **SKIPPED (EXTERNAL)** (`SKIPPED_NO_LIVE_PROVIDER_KEYS`) |

**Phase 0 Verdict:** `PHASE_0_INCOMPLETE_EXTERNAL_BLOCKER`  
All Phase 0 engineering deliverables, unit/contract/regression suites, lint, typecheck, build, production discovery, entitlement/security audits, and independent two-axis reviews pass without defect. Full live-provider streaming smoke verification (`GROQ_API_KEY`/`GEMINI_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) and PostgreSQL-backed certification (`npm run test:tools`) require external environment credentials / database connectivity not present in this local shell.
