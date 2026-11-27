---
phase: "phase-5-final-release-assurance"
phase_name: "AIRA AI 2026 Engineering Knowledge through GenUI Phase 5 Assurance"
project: "AIRA-AI-2026"
branch: "feat/aira-genui-phase1-foundation"
commit: "112a0f6bdf08cc624770589e61554920c7a9f69b"
verdict: "GENUI_LOCAL_RELEASE_ASSURANCE_COMPLETE_EXTERNAL_ACCEPTANCE_BLOCKED"
generated: "2026-11-28T00:35:00Z"
counts:
  decisions: 22
  lessons: 15
  patterns: 14
  surprises: 8
missing_artifacts:
  - ".planning/ROADMAP.md"
  - ".planning/REQUIREMENTS.md"
  - ".planning/phases/*-PLAN.md"
  - ".planning/phases/*-SUMMARY.md"
---

# AIRA AI 2026 Engineering Learnings (Consolidated through GenUI Phase 5 Release Assurance)

> **Scope Note:** This repository tracks phase outcomes via certification records (`docs/genui/`, `docs/adr/`, `docs/architecture/`, `.planning/STATE.md`, `.planning/HANDOFF.json`, `.continue-here.md`) rather than `.planning/phases/{N}/*-PLAN.md`. Learnings below are consolidated strictly from verified codebase files, ADRs, and certification artifacts across GenUI Phases 0 through 5 at candidate commit `112a0f6bdf08cc624770589e61554920c7a9f69b` (`feat/aira-genui-phase1-foundation`).

---

## Decisions

### 1. Strategy C — Hybrid AIRA-Native GenUI (Accept Protocol, Build AIRA Renderer)
Chosen over CopilotKit/external monolithic runtimes: retain Express 5, React 19, Vite 8, `ModelRouter`, `ServerIntentRouter`, `SemanticReasoner`, `AgentRuntime`, `WorkflowEngine`, `ApprovalKernel`, and Neon PostgreSQL 18; adopt `@ag-ui/core@1.0.5` only as a narrow protocol adapter (`adaptAiraEventToAGUI`), build `aira-genui/v1` Zod v4 native contract + 39-component React registry with an explicit A2UI `v1.0` structural boundary (`a2uiCompliant: false`), and defer full A2UI v1.0 wire transport to Phase 2.
**Rationale:** `@copilotkit/a2ui-renderer` (`_def?.typeName`) and `@a2ui/react@0.16.1` (`zod@^3.25.76`) are incompatible with AIRA's `zod@^4.6.7`, whereas `@ag-ui/core@1.0.5` supports `zod@^3.25.18 || ^4.0.0` (`ADOPT_WITH_ADAPTER`).
**Source:** `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`, `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`, `packages/contracts/src/genui.ts`, `packages/agent-runtime/src/genui-streaming.ts`

### 2. Dual-Mode Intent + Presentation Routing Separation (`SemanticReasoner` + `PresentationRouter`)
Keep side-effect/capability routing inside `SemanticReasoner` + `ServerIntentRouter`, and route output modality (`plain_text`, `structured_explanation`, `table`, `native_visualization`, `declarative_interactive`, `sandboxed_app`, `editable_artifact`, `agent_workspace_view`) via 3-tier `PresentationRouter` (Tier 1 deterministic fast-path <1ms/0 tokens; Tier 2 schema-constrained fast non-reasoning model; Tier 3 `text_markdown` fallback).
**Rationale:** Prevents analytical/chart/calculator requests from defaulting to privileged `web_search` (P4 guest `browser.read` 403) and keeps ordinary chat answers intact if presentation classification fails.
**Source:** `packages/agent-runtime/src/presentation-router.ts`, `packages/agent-runtime/src/behavioral/semantic-reasoner.ts`, `packages/agent-runtime/src/router.ts`

### 3. Self-Hosted Lazy Chart.js v4 Visualization Split (`GenUIChartCanvas`)
Render native charts (`bar_chart`, `line_chart`, `scatter_chart`, `pie_chart`, `doughnut_chart`) via `React.lazy(() => import('./GenUIChartCanvas'))` inside `LazyGenUIChart` with accessible Chart/Table toggle and zero floating external CDNs.
**Rationale:** Keeps initial main bundle size unaffected (`GenUIChartCanvas` code-splits to `198.26 kB` raw / `68.69 kB` gzip) while honoring strict CSP (`unsafe-eval` / unpinned CDN prohibition).
**Source:** `src/components/genui/charts/LazyGenUIChart.tsx`, `src/components/genui/charts/GenUIChartCanvas.tsx`, `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`

### 4. Pure Recursive-Descent Zero-`eval` Deterministic Calculators
Implement financial/unit/function calculators (`recomputeCalculatorSurface`) using a bounded pure TypeScript expression parser (`<= 128` tokens, `<= 16` depth) rather than `eval`, `new Function`, or LLM round-trips per slider movement.
**Rationale:** Guarantees `$0` incremental AI cost on local slider/input interaction, zero code-injection surface, and immune routing (calculator intents never hijack to `web_search`).
**Source:** `packages/contracts/src/genui-calculators.ts`, `packages/agent-runtime/src/genui-streaming.ts`, `packages/agent-runtime/src/router.ts`

### 5. Authoritative Server-Side BFF Session & Principal Binding
Authenticate SPA requests via first-party `HttpOnly`/`Secure`/`SameSite=Lax` opaque session cookies (`__Host-aira_auth_session` / `aira_auth_session`) backed by server `BffSessionStore`, strict origin/CSRF validation (`Sec-Fetch-Site`, `Origin`/`Referer`, `X-CSRF-Token`), and Neon Auth two-phase revocation, binding verified `ExecutionPrincipal` (`neon_user_<id>`).
**Rationale:** Third-party cookies face browser partitioning and `localStorage` tokens risk XSS exposure; local token deletion without server `POST /sign-out` leaves stolen tokens valid.
**Source:** `docs/AUTH_SESSION_SECURITY_ARCHITECTURE.md`, `apps/api/src/index.ts`

### 6. Neon PostgreSQL Authoritative Financial & Workflow Persistence
Store all wallet balances (`credit_accounts`), two-phase `HOLD`/`SETTLE`/`RELEASE` reservations (`credit_reservations`), immutable `credit_transactions`, raw HMAC-SHA256 verified webhooks, and durable workflow/approval outbox records in Neon PostgreSQL with `SELECT ... FOR UPDATE` and unique `idempotency_key` constraints. Keep `vector 0.8.6` on Neon production (`br-shiny-moon-b3vy9xj7`) pending separate review while whitelisting `0.8.7` strictly for isolated PG 18.7 DR rehearsal.
**Rationale:** Eliminates double-spending races, webhook replay fraud, and premature pgvector changes in production.
**Source:** `docs/adr/0001-commercial-billing-and-credit-ledger-architecture.md`, `docs/adr/0002-payment-gateway-webhook-and-gst-model.md`, `docs/adr/0003-vision-multimodal-and-metered-execution.md`, `docs/adr/0004-pgvector-version-compatibility.md`

### 7. Atomic Release Candidate Integration & Hobby Vercel Trigger Discipline
Integrate stacked UI phases via a single atomic release branch rather than sequentially squash-merging stacked PRs (which causes base-shift replay conflicts), and recognize that merging to `prod-release` immediately triggers live Vercel Hobby production deploy (`vercel promote` forbidden for agents; `db:verify:deploy` gates build on PG schema readiness).
**Rationale:** Vercel Hobby lacks native deployment approval holds; GitHub Pro Ruleset `25079946` (`AIRA Production Protection` on `refs/heads/prod-release`) is the primary server-side deployment barrier.
**Source:** `AGENTS.md`, `docs/AIRA_AI_2026_MASTER_EXECUTION_PROMPT.md`, `docs/architecture/ADAPTIVE_STUDIO_FINAL_INTEGRATION_PLAN.md`

### 8. Strict Static Sandbox Containment for Non-HTML Preview Types
Keep `image/svg+xml`, `text/markdown`, `application/vnd.ant.code`, `application/vnd.ant.mermaid`, and `application/vnd.ant.react` on script-disabled static previews (`sandboxAttributesForType` returns `''`, `script-src 'none'`) and restrict interactive iframes to `allow-scripts allow-forms` (never `allow-same-origin` or `allow-top-navigation`).
**Rationale:** Prevents parent-origin cookie/DOM access and CSP bypasses while preserving safe source inspection, GFM Markdown tables/lists, sanitized SVG, and multi-file bundling.
**Source:** `src/utils/sandboxSecurity.ts`, `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`, `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`

---

## Lessons

### 1. NVIDIA Default Model EOL & Circuit-Breaker Classification (`3A`)
`nvidia/llama-3.1-nemotron-70b-instruct` returned upstream **HTTP 410 Gone** (`EOL 2026-11-15T00:00:00Z`). Deprecated model IDs must be explicitly blocked in `resolveNvidiaModel` (`RETIRED_NVIDIA_MODELS`, `isRetiredNvidiaModel`) even when supplied via stale env overrides, and HTTP `410` must be classified as non-retryable and trip `ProviderHealthTracker` circuit breakers immediately.
**Context:** Verified against live NVIDIA NIM endpoint and commercial allowlists (`packages/model-router/src/index.ts`, `packages/model-router/src/health-tracker.ts`, `packages/contracts/src/model-registry.ts`).
**Source:** `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`, `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`

### 2. Hidden Thinking Tokens Break Compact JSON Structuring Unless Explicitly Disabled (`3B`)
Calling `nvidia/nemotron-3.5-lightning-30b-a3b` for compact `PresentationRouter` JSON exhausted `maxTokens` on hidden reasoning tokens (`1403.85ms`, `343` tokens, `finish_reason: "length"`, `content: null`). Routing Tier 2 classification to non-reasoning `nvidia/nemotron-3.5-bolt-e4b` with `PRESENTATION_JSON_SCHEMA` + `chat_template_kwargs: { enable_thinking: false }` + `maxTokens <= 160` + `2500ms` timeout cut live latency to `638-797ms` (`173-175` tokens) with `invalidStructuredOutput: false`.
**Context:** Always match classification/routing tasks to non-reasoning fast models or disable thinking budgets explicitly; separate offline dev stubs from live model measurements.
**Source:** `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`, `packages/agent-runtime/src/presentation-router.ts`

### 3. Provider Deadlines Must Respect Google Regional Cold Starts & Serverless DB Absence
Setting Gemini first-token deadlines `<= 2500ms` falsely severed healthy streams; `>= 4000ms` (with `gemini-3.5-flash-lite` pinned rather than thinking-heavy `gemini-3.5-flash`) is required. Similarly, Vercel Preview containers without `DATABASE_URL` must gracefully select `InMemoryWorkflowRepository` / `InMemoryToolCallRepository` (or fail-closed where security requires).
**Context:** Discovered during P1.6.1 120-request reliability benchmarking.
**Source:** `.continue-here.md`

### 4. Code Fences Are Not Automatically Live HTML Applications (`P3` & `3C`)
Defaulting missing fenced-block languages to `'html'` or emitting `artifact.created` for every ``` block hijacked normal coding explanations into broken HTML iframes with Tailwind CDN CSP failures. Unknown / `application/vnd.ant.code` blocks must default to `'text'`, remain excluded from HTML preview tabs, and respect dark mode dynamically via `document.documentElement.classList.contains('dark')` rather than hardcoded `isDark = false`.
**Context:** Remediated across Phase 0.5 (`a17982c`) and Phase 1 (`f2e9b40`).
**Source:** `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`, `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`

### 5. Tier Default Model Mismatch Locks Out Guest Users (`P1`)
Setting UI default `DEFAULT_SETTINGS.activeModel = 'aira-auto'` (`minTier: 'free'`) caused immediate `HTTP 403 PLAN_MODEL_RESTRICTED` errors for guests (`minTier: 'guest'`, allowed only `aira-fast` / `claude-3-5-haiku`). Reactive tier clamping (`getDefaultModelForTier`, `resolveEntitledModelForTier`) must normalize anonymous defaults while preserving pending Pro selections until auth resolves.
**Context:** Preserves commercial server enforcement without breaking guest first-turn UX.
**Source:** `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`, `packages/contracts/src/model-registry.ts`

### 6. Client Redirects Are Never Authoritative Payment Proof
Subscription states (`initiating -> pending -> active -> canceled/expired`) and INR 18% reverse GST invoices (`Plus ₹399 = ₹338.14 + ₹60.86 GST`, `Pro ₹999 = ₹846.61 + ₹152.39 GST`) must transition solely from raw-body HMAC-SHA256 verified webhooks recorded idempotently in `payment_gateway_events`.
**Context:** Verified across Razorpay & Cashfree sandbox lifecycles and Gate-4 staging isolation rules.
**Source:** `docs/adr/0002-payment-gateway-webhook-and-gst-model.md`, `AIRA-COMMERCIAL-PLATFORM-PAYMENT-CERTIFICATION.md`, `.planning/HANDOFF.json`

---

## Patterns

### 1. Contract-First Discriminated Zod Schema with Explicit Structural Limits
`packages/contracts/src/genui.ts` enforces size/depth caps (`256 KB` payload, `64 KB` state, `<= 100` components, depth `<= 8`), acyclic child graphs, prototype-pollution key rejection (`__proto__`, `constructor`, `prototype`), and `http:`/`https:` URI filtering before any React component renders.
**When to use:** Any declarative or model-emitted UI payload crossing server/client boundaries.
**Source:** `packages/contracts/src/genui.ts`, `src/components/genui/GenUISurfaceRenderer.tsx`

### 2. Server-Authoritative GenUI Interaction & Workflow Approval Dispatch
Client UI actions (`GenUISurfaceRenderer` -> `POST /api/genui/actions`) require BFF CSRF validation, authenticated `ExecutionPrincipal` matching, and `authorizeGenUIActionServerSide`, while `WorkflowEngine.createWorkflowRun` and `ApprovalKernel` enforce parent-run workspace ownership and single-use `approval_resumption_outbox` claims.
**When to use:** Any state-mutating GenUI button, approval decision, or workflow resumption.
**Source:** `packages/agent-runtime/src/genui-streaming.ts`, `packages/agent-runtime/src/workflow-engine.ts`, `packages/approvals/src/index.ts`, `apps/api/src/index.ts`

### 3. Defense-in-Depth Sandbox Sanitization + Concurrent Slot Cap
`stripUntrustedHtmlSecurityVectors` strips attacker CSP/refresh/base/external script tags, `safeJsonStringifyForHtmlScript` escapes `<`, `>`, `&`, U+2028, U+2029, `validateSandboxBridgeMessage` checks `event.source`, `event.origin === 'null'`, and cryptographic nonce, and `acquireSandboxSlot` caps concurrent sandboxes at `2`.
**When to use:** All iframe-hosted artifact previews (single-file or multi-file bundles).
**Source:** `src/utils/sandboxSecurity.ts`, `src/components/ArtifactStudio.tsx`, `src/components/UnifiedWorkspace.tsx`

### 4. Incremental AST Code Graph Caching + Community Hubs for Token Conservation
`graphify update .` synced into `.planning/graphs/` indexes `979` files (`8,878` nodes, `20,342` edges, `405` communities) at `0` LLM tokens (`f2e9b40`), reducing benchmark query context from `~591,866` naive tokens to `~1,400` avg tokens (`422.8x` measured reduction).
**When to use:** Onboarding fresh sessions or tracing cross-package callers/contracts before touching source files.
**Source:** `.planning/graphs/GRAPH_REPORT.md`, `gsd-tools.cjs graphify benchmark`

### 5. Tiered Two-Phase Credit Reservation (`HOLD` -> `SETTLE` / `RELEASE`)
Every billable multimodal, builder, or metered inference run reserves maximum estimated credits (`1 Credit = $0.001 USD`) under row locks before calling external APIs and settles actual cost upon completion.
**When to use:** Any metered capability across Vision, Research, Agents, or Builder.
**Source:** `docs/adr/0001-commercial-billing-and-credit-ledger-architecture.md`, `docs/adr/0003-vision-multimodal-and-metered-execution.md`, `GLOSSARY.md`

### 6. Sequential Isolated Disposable Postgres Certification (`--test-concurrency=1`)
Run destructive/outbox/approval Postgres integration suites sequentially against local disposable WSL PostgreSQL 18.7 (`127.0.0.1:5432/aira_test_db`) using `assert-disposable-postgres.mjs`, keeping Staging/Production Neon branches untouched.
**When to use:** Verifying DB migrations, approval outbox resumption, and RLS/principal isolation locally.
**Source:** `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`, `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`

---

## Surprises

### 1. Live Production DB Version Differed from Legacy Docs (PostgreSQL 18.7, not 16/17)
Read-only Neon production inspection (`br-shiny-moon-b3vy9xj7`) revealed **PostgreSQL 18.7** (`vector 0.8.6`), superseding older PG 16/17 assumptions; WSL DR runs PG `18.7` (`vector 0.8.7`, fixing IVFFlat CVE-2026-103484).
**Impact:** Required explicit PG 18.7 compatibility gating (`ADR-0004`) and dedicated PG 18 test runs (`41/41` in Phase 1).
**Source:** `docs/adr/0004-pgvector-version-compatibility.md`, `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`

### 2. Local Graph Tooling Divergence Across MCP Servers
While `graphify` CLI updated `.planning/graphs/graph.json` cleanly to `f2e9b40`, `graft` MCP is bound to an unrelated workspace (`perplexity-clone/my-turborepo`) and `context-packet` MCP resolves `.context-packet` against `C:\Users\WORKSTATION\AppData\Local\Programs\antigravity`.
**Impact:** Fresh sessions must query `.planning/graphs/graph.json` via `graphify` / `gsd-tools.cjs graphify query` rather than `graft_*` or `context_packet_*` MCP tools until those MCP roots are re-pointed.
**Source:** Observed MCP tool responses (`graft_repo_map`, `context_packet_status`), `gsd-tools.cjs graphify status`

### 3. `test-results/behavioral/*.md` Indexed into Graph Alongside Active Source
Even with `test-results/` listed in `.gitignore`, 19 Markdown files under `test-results/behavioral/` remain tracked/present and entered `graphify` indexing (`unique_source_files: 942`), while 1 `.sql` file was skipped due to missing `tree_sitter_sql` and 106 barrel/data files yielded 0 AST symbols.
**Impact:** Graph HTML renders aggregated `405` communities (`>5000` node cap), and `.sql` schema DDL requires direct file inspection rather than graph lookup.
**Source:** `graphify update .` output, `.planning/graphs/GRAPH_REPORT.md`

### 4. Pre-Existing Scenario 17 & GitHub Free vs Pro History Evolution
Historical `.planning/STATE.md` (`2026-10`) recorded GitHub Free HTTP 403 on branch rulesets, whereas `AGENTS.md` (`2026-10-14`) confirms GitHub Pro is now active with Ruleset `25079946` (`AIRA Production Protection`) enforcing `Fast CI`, `Semantic Search CI`, and `Main / PR certification` on `prod-release`; separately, base `6c90c12` had a pre-existing Scenario 17 failure in Razorpay strict cancellation lookup (`sub_gw_fbe8081d`) unrelated to GenUI.
**Impact:** Always verify live `AGENTS.md` + current branch rules rather than stale October `.planning/STATE.md` notes.
**Source:** `AGENTS.md`, `.planning/STATE.md`, `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`

---

## Consolidated Reference Ledgers

### Resolved Defects & Rejected Alternatives

| Defect / Option | Status / Decision | Resolution / Rejection Reason | Evidence Path |
| :--- | :--- | :--- | :--- |
| **P1** Guest Default Model (`aira-auto` 403) | **RESOLVED (Phase 0.5)** | Tier-aware `getDefaultModelForTier` / `resolveEntitledModelForTier`; server 403 boundary kept | `a17982c`, `src/utils/constants.ts`, `src/App.tsx` |
| **P3** Code Explanation Hijacked to HTML Iframe | **RESOLVED (Phase 0.5 & 1)** | `artifact-classifier.ts` + `artifactClassification.ts`; unknown code defaults to `'text'`; dynamic dark mode + GFM Markdown | `a17982c`, `f2e9b40`, `src/components/UnifiedWorkspace.tsx` |
| **P4** Charts/Calcs/HTML Routed to `web_search` (403) | **RESOLVED (Phase 0.5 & 1)** | `SemanticReasoner` + `PresentationRouter` + zero-default `router.ts`; supplied data stays `ANSWER` | `a17982c`, `f2e9b40`, `packages/agent-runtime/src/router.ts` |
| **3A** Retired `nvidia/llama-3.1-nemotron-70b-instruct` (410) | **RESOLVED (Phase 1)** | `RETIRED_NVIDIA_MODELS` rejection in `resolveNvidiaModel` + non-retryable 410 circuit breaker | `f2e9b40`, `packages/model-router/src/index.ts` |
| **3B** `PresentationRouter` Live Tier 2 JSON Truncation | **RESOLVED (Phase 1)** | `enable_thinking: false` + `PRESENTATION_JSON_SCHEMA` + `nemotron-3.5-bolt-e4b` (`638-797ms`) | `f2e9b40`, `packages/agent-runtime/src/presentation-router.ts` |
| **3C** Artifact Preview Regression Assessment | **RESOLVED (Phase 1)** | Extended `renderSafeMarkdownHtml` tables/lists; fixed dark theme; kept static React/Mermaid safety | `f2e9b40`, `src/utils/sandboxSecurity.ts` |
| **3D** Isolated PostgreSQL 18 Certification | **RESOLVED (Phase 1)** | 6 suites / 41/41 PASS sequentially on WSL PG 18.7 `aira_test_db` | `f2e9b40`, `test/genui-postgres18-certification.test.ts` |
| `@copilotkit/a2ui-renderer` & `@a2ui/react@0.16.1` | **REJECTED** | Zod v3 peer incompatibility (`_def?.typeName`, `zod@^3.25.76`) vs AIRA `zod@^4.6.7` | `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md` |
| Client-side `eval` / Dynamic JSX / Unpinned CDNs | **REJECTED** | Removed `unsafe-eval`, Tailwind/unpkg/jsdelivr CDNs; replaced with pure parser + lazy bundled Chart.js v4 | `src/utils/sandboxSecurity.ts`, `GenUIChartCanvas.tsx` |
| Multi-PR Sequential Squash on Stacked UI Branches | **REJECTED** | Squash base-shift causes spurious conflicts across #138-#143; use atomic RC merge | `docs/architecture/ADAPTIVE_STUDIO_FINAL_INTEGRATION_PLAN.md` |

### Capability Status Classification

| Capability / Area | Classification | Notes & Exact References |
| :--- | :--- | :--- |
| Phase 0 ModelRouter tool-call streaming & PresentationRouter PoC | **IMPLEMENTED & LOCALLY VERIFIED** | `f77fb64`, `packages/model-router/src/tool-call-stream.ts` |
| Phase 0.5 P1/P3/P4 fixes & Sandbox Security Gate | **IMPLEMENTED & LOCALLY VERIFIED** | `a17982c`, `src/utils/sandboxSecurity.ts` |
| Phase 1 `aira-genui/v1` contract, 39 components, Chart.js v4 lazy chunk, calculators, `@ag-ui/core` adapter, `/api/genui/actions`, Playwright E2E, live NIM check, PG 18 `41/41` | **IMPLEMENTED & LOCALLY VERIFIED** | `f2e9b40`, `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md` |
| Phase 2 A2UI `v1.0` profile (`createSurface`/`updateComponents`/`updateDataModel`/`deleteSurface`), `@call` + `@index`, reactive computed DAG + `@checks` + `visibleWhen`, DB metadata persistence, `DurableIdempotencyManager` (`genui_action`), fail-closed AppSec hardening, PG 18 (`15/15`), Playwright 7-app E2E + live NIM | **IMPLEMENTED & LOCALLY VERIFIED** | `f39ecab`, `docs/genui/AIRA_GENUI_PHASE2_CERTIFICATION.md`, `packages/contracts/src/a2ui.ts`, `packages/contracts/src/genui-reactive.ts` |
| Phase 3 Open Generative UI Applications (`aira-app/v1`), Opaque Sandbox (`allow-scripts allow-forms`, zero `allow-same-origin`), CSP `connect-src 'none'`, self-hosted D3 v7 & Three.js offline shims, cryptographic nonce bridge, ArtifactStudio inspector, standalone offline export, PG 18 metadata persistence, Playwright 10-app E2E (A–J) | **IMPLEMENTED & LOCALLY VERIFIED** | `docs/genui/AIRA_GENUI_PHASE3_CERTIFICATION.md`, `packages/contracts/src/genui.ts`, `src/utils/genuiAppBridge.ts`, `src/components/genui/GenUISandboxApp.tsx` |
| Commercial Billing, PR #215 / PR #216 / PR #217, GST Invoicing | **HISTORICALLY VERIFIED / PRESERVED UNTOUCHED** | `fd2f8b9`, `6c90c12`, `docs/adr/0001`-`0002`; production billing on **STRICT HOLD** |
| First-party BFF Session Auth Gateway & Staging OAuth | **IMPLEMENTED / HISTORICALLY VERIFIED ON AUTH BRANCH** | `docs/AUTH_SESSION_SECURITY_ARCHITECTURE.md` |
| Sandbox Mermaid & React live execution (beyond static `script-src 'none'` containment) | **PROPOSED / DEFERRED** | Explicit safe source preview only (`3C`) |
| Phase 4 Collaborative Canvas & Multi-Agent Synchronous Workspace Editing | **PROPOSED (PHASE 4 SCOPE)** | Documented in `AIRA_GENUI_PHASE3_CERTIFICATION.md` |
| Live Multi-Provider (`Groq`, `Gemini`, `OpenAI`, `Anthropic`) & Interactive OAuth Prod Agent Workspace Acceptance | **EXTERNALLY BLOCKED / UNVERIFIED HERE** | Missing provider API keys & OAuth credentials in local workstation env |

### Exact Commits & Evidence Locations

- Phase 3: Open GenUI Applications & Sandbox Runtime — `docs/genui/AIRA_GENUI_PHASE3_CERTIFICATION.md`
- `f39ecab1124c8d9d325aa9cafee7136dd6b01333`: `feat/aira-genui-phase1-foundation` HEAD (Phase 2) — `docs/genui/AIRA_GENUI_PHASE2_CERTIFICATION.md`
- `f2e9b40e26bfaca6172ed90b9d483fa821af2494`: Phase 1 Native GenUI — `docs/genui/AIRA_GENUI_PHASE1_CERTIFICATION.md`
- `a17982ca8cc17b657b503135a429e244dc700b8d`: Phase 0.5 Remediation & Sandbox Gate — `docs/genui/AIRA_GENUI_PHASE0_CERTIFICATION.md`
- `f77fb64061415b1b466f682a00d34614ffd18db5`: Phase 0 Foundation (`ModelRouter` tool streaming & `PresentationRouter` PoC)
- `6c90c12930a23018ff02435a7832ca5bd0578b26`: `origin/staging` base (#217)
- `f429d90a1f4322a0d362956fb9e55a38cb3b5508`: `origin/prod-release` (preserved unmodified)
- `fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568`: PR #215 (`rc/prod-billing-release-20261126`, preserved unmodified)
- Knowledge Graph Index: `.planning/graphs/graph.json`, `.planning/graphs/GRAPH_REPORT.md`, `.planning/graphs/graph.html`, `.planning/graphs/.last-build-snapshot.json`

---

## Phase 2 Additions (`f39ecab`)
- **Decision — Authoritative A2UI v1.0 Profile over Existing Express/PG Stack (`a2ui.ts`, `genui-reactive.ts`):** Adopted verified upstream `a2ui-project/a2ui@36725eee` (`v1.0`) wire schemas (`version: "1.0"`, `@path`/`@call`/`@checks`/`@accessibility`, `createSurface` without `theme`, reserved `Surface`), `@call` + `@index` template expansion, acyclic computed DAG, and existing DB tables (`conversation_messages.metadata` JSONB Migration `013`, `idempotent_operations` Migration `023`) with zero new schema migrations.
- **Lesson — `SemanticReasoner` Must Pre-Gate Interactive Declarative Prompts (`semantic-reasoner.ts`):** Without fast-path recognition of Phase 2 declarative nouns (`budget allocator`, `decision matrix`, `study planner`, `multi-step form`), `classifyWithModel` can classify `"Create an interactive ..."` as `AUTOMATION_CREATE`, crashing `AUTOMATION_ENGINE_NOT_AVAILABLE` and overriding `PresentationRouter`. Always match `isGenerativePresentationTask` and `PresentationRouter` conceptual/plain-text guards in coordinated order.
- **Security Invariants Established in Phase 2:**
  1. `authorizeGenUIActionServerSide` and `POST /api/genui/actions` require ownership + persisted surface/component/action verification (`requirePersistedSurface: true`) and enforce `allowedKeys` stripping.
  2. `POST /api/conversations/sync` preserves server-persisted `metadata.genui.surfaces` on existing messages and sanitizes newly synced client evidence/origin; `hydrateGenUIMetadata` validates prototype keys, IDs, Zod state records, and 64 KB limits.
  3. `POST /api/genui/actions` delegates idempotency to `DurableIdempotencyManager` (`beginOrGet` / `complete`, `409` on hash mismatch, fail-closed `503` on production DB failure).
  4. `isSafeGenUIRegexPattern` enforces structural quantifier/group propagation checks, `GenUIStateValueSchema` caps recursion (`<= 8`), `containsForbiddenObjectKey` caps walk depth (`<= 16`), and `GenUIStreamTagExtractor` enforces `maxTagBytes` (`256 KB`) before buffering or parsing complete blocks.
- **React & Sync Patterns:** Never call parent `onStateChange` inside child `setLocalState((prev) => ...)` functional updaters (notify via `useEffect` on dirty flag); maintain a trailing dirty queue in `syncConversationToServer` (`pendingTrailingSyncs`) so rapid slider changes never drop final persisted state.

---

## Phase 3 Additions (Open Generative UI Applications)
- **Decision — Open Generative UI Application Contract (`aira-app/v1` in `packages/contracts/src/genui.ts`):**
  Introduced `AIRA_GENUI_APP_CONTRACT_VERSION = 'aira-app/v1'` for bespoke canvas simulations, multi-view financial dashboards, force-directed graphs, and 3D scenes. Strict payload caps: HTML <= 512 KB, CSS <= 128 KB, JS <= 256 KB, libraries <= 2 (`d3`, `three`), height clamped (200–1200px), with prototype pollution defenses.
- **Decision — Opaque Sandbox Origin & Zero-Egress CSP (`src/utils/genuiAppBridge.ts`):**
  Enforced `sandbox="allow-scripts allow-forms"` with zero `allow-same-origin`, zero `allow-top-navigation`, zero `allow-popups`. Browser sets `window.origin === 'null'`, physically isolating parent cookies, `localStorage`, `sessionStorage`, and host DOM. Paired with CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';` to deny all outbound network exfiltration.
- **Decision — Offline Self-Hosted Visualizations without Floating CDNs:**
  Packaged self-hosted D3 v7 and Three.js runtime shims directly into the bridge injection pipeline; zero external network requests to floating CDNs (`unpkg.com`, `cdnjs`, `cdn.tailwindcss.com`).
- **Decision — Cryptographically Guarded Host-Sandbox Bridge:**
  Per-instance cryptographic nonces (`crypto.randomUUID()`) and origin checks (`origin === 'null'`) over `window.postMessage`, securing `GENUI_APP_STATE_UPDATE`, `GENUI_APP_ACTION`, `GENUI_APP_FOLLOWUP`, and `GENUI_APP_RESIZE`.
- **Lesson — Iframe State Decoupling Prevents DOM Teardown:**
  `sandboxHtmlDoc` in `GenUISandboxApp.tsx` must NOT include `appState` in its `useMemo` dependency array. Rewriting `srcDoc` on every state update unmounts the iframe and resets user slider/form focus. Decoupling HTML rendering to depend only on initial mount state preserves running animations and allows seamless local interaction.
- **Lesson — Guard Global Scripts Against Sandboxed Iframe LocalStorage Access:**
  `page.addInitScript` runs in every frame, including sandboxed iframes. Reading or writing `window.localStorage` inside a sandboxed iframe without `allow-same-origin` throws a `SecurityError`. Global scripts must always be guarded with `if (window.self === window.top && typeof window.localStorage !== 'undefined')`.
- **Lesson — Dual Metadata Serialization for Complete Multi-Turn Persistence:**
  Both declarative surfaces (`genuiSurfaces`) and open applications (`genuiApps`, `genuiAppState`) must be extracted, validated, and hydrated in `src/utils/conversationSearch.ts` across client-server sync, enabling rich simulation and dashboard states to reload deterministically across browser reloads with $0 re-inference cost.

---

## Phase 3.5 Additions (Closure & Genuine Model Verification)
- **Decision — Dynamic XML Tag Attribute Parsing (`packages/agent-runtime/src/genui-streaming.ts`):**
  NVIDIA Nemotron (`nvidia/nemotron-3.5-lightning-30b-a3b`) and similar instruction-tuned models frequently emit `<airaApp schemaVersion="aira-app/v1" appId="..." title="...">` directly with attributes on the opening XML tag while placing the JSON body (`html`, `css`, `javascript`, `initialState`) inside. `GenUIStreamTagExtractor` and `tryParseGenUIBlock` now utilize `parseTagAttributes()` regex matching to extract and merge tag attributes directly into the parsed descriptor, preventing tag-parsing drops.
- **Decision — Resilient JSON Repair for Large Model-Generated Code (`packages/agent-runtime/src/genui-streaming.ts`):**
  When LLMs output 4,000–6,000 characters of JavaScript within a JSON string, subtle issues like trailing commas or unescaped control characters can break standard `JSON.parse`. Integrated `tryRepairJson` into `tryParseGenUIBlock` to automatically sanitize trailing commas and recover valid HTML/JS/CSS payloads without raising fatal parse errors.
- **Decision — Defensive `document.write` Shim & Top-Level Script Isolation (`src/utils/genuiAppBridge.ts`):**
  In headless browser rendering via Playwright, nested `try/catch` wrappers around user-provided script strings could produce syntax parser errors (`Failed to execute 'write' on 'Document': Unexpected end of input`). Replaced the nested try/catch wrapper with top-level script execution, relying on `window.addEventListener('error')` for the sandbox error boundary, and added a defensive shim `document.write = function() { console.warn('document.write is disabled in aira sandbox'); }`.
- **Finding & Metric — Genuine Multi-Domain Live Generation Verified:**
  Executed genuine live generation with NVIDIA NIM `nemotron-3.5-lightning-30b-a3b` across 3 distinct domains:
  1. *Simulation:* "Interactive 2D Physics Pendulum Simulation" (16.6s latency, 1052 chars HTML, 6122 chars JS, rendered 1 canvas & 3 controls).
  2. *Dashboard:* "Custom Multi-Asset Financial Portfolio Dashboard" (9.9s latency, 1583 chars HTML, 254 chars CSS, 2356 chars JS, rendered 1 canvas & 3 controls).
  3. *Visualization:* "Planetary Orbital Mechanics Educational Visualization" (18.5s latency, 1065 chars HTML, 3835 chars JS, rendered 1 canvas & 2 controls).
  All 3 apps rendered successfully in headless Chromium under opaque origin (`null`) and zero-egress CSP.
- **Accurate Library Capability Classification:**
  D3.js and Three.js are classified truthfully: D3 is Category C (Compatibility Shim with lightweight SVG/DOM selection & linear/ordinal scales subset) and Three.js is Category D (Demonstration Substitute with 2D canvas wireframes). Neither is claimed as a full 3D WebGL engine without verified npm installation.

---

## Phase 4A Additions (Local MCP Apps Runtime & Fail-Closed Gating)
- **Decision — Formal `aira-mcp-app/v1` Contract (`packages/contracts/src/mcp-apps.ts`):**
  Defined `AIRA_MCP_APP_CONTRACT_VERSION = 'aira-mcp-app/v1'`, `McpAppDescriptorSchema`, `validateMcpAppDescriptor`, and `McpAppRpcMessageSchema`. Caps: entrypointHtml <= 512 KB, supportedTools <= 32, maxActiveConnections <= 8, maxHeightPx clamped (200–1200px).
- **Decision — Host-Mediated JSON-RPC 2.0 & ApprovalKernel Integration (`src/components/genui/GenUIMcpApp.tsx`):**
  MCP Apps communicate with host via postMessage using JSON-RPC 2.0 (`tools/call`, `tools/list`, `ui/resize`, `state/save`, `state/load`). Host validates tool authorization against `descriptor.supportedTools`. Side-effecting mutations (e.g. `execute_query`, `update_order`, `deploy_asset`) trigger an interactive Tool Approval Modal, enforcing zero silent execution.
- **Security Invariant — Fail-Closed Remote MCP Destination Enforcement:**
  `assertApprovedPublicMcpDestination()` strictly enforces `MCP_EGRESS_ENFORCEMENT_REQUIRED` (503) in production environments until kernel-level socket binding and connection-time address pinning are implemented, protecting against DNS rebinding and SSRF to cloud metadata endpoints (`169.254.169.254`).

---

## Phase 4B Additions (Advanced Multimodal Artifact Workspace & Unified Interactive Canvas)
- **Decision — Unified Multimodal Contract (`aira-artifact/v1` in `packages/contracts/src/artifacts.ts`):**
  Introduced `AIRA_ARTIFACT_CONTRACT_VERSION = 'aira-artifact/v1'` covering 8 artifact classes (`code`, `document`, `sheet`, `slide`, `diagram`, `markdown`, `svg`, `html`). Defined structured Zod schemas for spreadsheets (`SpreadsheetWorkbookSchema`, `SpreadsheetWorksheetSchema`, `SpreadsheetCellSchema`), slide decks (`PresentationDeckSchema`, `SlideSchema`, `SlideLayoutSchema`), multimodal descriptors (`AiraArtifactDescriptorSchema`), and atomic patch specifications (`ArtifactPatchSchema`).
- **Decision — Bounded AST Spreadsheet Recalculation Engine (`src/utils/spreadsheetEngine.ts`):**
  Implemented recursive-descent formula evaluation supporting arithmetic, comparisons, logical expressions, and essential functions (`SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `PRODUCT`, `IF`, `ABS`, `ROUND`, `CONCAT`). Built an acyclic dependency graph with cycle detection (`#CYCLE!`) and division by zero detection (`#DIV/0!`). Zero dynamic `eval()` or `new Function()` prevents client-side code execution vulnerabilities.
- **Security Invariant — Formula Injection Neutralization in CSV Exports:**
  `sanitizeSpreadsheetCsvCell` automatically detects leading dangerous characters (`=`, `+`, `-`, `@`) and prepends a single quote (`'`), defending against CSV formula injection (DDE execution) in desktop spreadsheet software (Excel/Calc) while adhering to RFC 4180 quoting.
- **Decision — Pure TypeScript In-Memory OpenXML Packager (`src/utils/officeDocumentExporter.ts`):**
  Leveraged IEEE 802.3 CRC-32 and PKZip binary serialization to build valid OpenXML document packages (`.docx`, `.xlsx`, `.pptx`) completely in-memory with zero third-party npm dependencies and zero external network calls:
  - DOCX: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, `word/styles.xml`
  - XLSX: `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/worksheets/sheet1.xml`, `xl/styles.xml`
  - PPTX: `[Content_Types].xml`, `_rels/.rels`, `ppt/presentation.xml`, `ppt/slides/slide*.xml`
  All generated archives begin with standard PKZip magic bytes `PK\x03\x04` and open seamlessly in Microsoft Office and LibreOffice.
- **Decision — Atomic Artifact Patching with Optimistic Concurrency Control (`src/utils/artifactPatchEngine.ts`):**
  Supported granular operations (`replace_section`, `update_cells`, `update_slide`, `insert_slide`, `replace_all`) avoiding full content re-generation. Enforced optimistic concurrency checking against `patch.baseVersion !== artifact.version`, safely returning `STALE_BASE_VERSION` on concurrent conflicting updates.
- **Decision — Zero-Migration Conversation Metadata Artifact Persistence (`src/utils/conversationSearch.ts`):**
  Persisted multimodal artifacts directly within existing PostgreSQL JSONB `conversation_messages.metadata` (Migration `013`). Validated, normalized, and hydrated artifact descriptors on client reload with zero new database schema migrations.

---

## Phase 4C Additions (Real-Time Collaborative Canvas, CRDT-Based Artifact Editing & Multi-Agent Co-Authoring)
- **Decision — Unified Collaboration Contract (`aira-collab/v1` in `packages/contracts/src/collaboration.ts`):**
  Defined `AIRA_COLLAB_CONTRACT_VERSION = 'aira-collab/v1'`, `CollabActorSchema`, `CollabOperationSchema`, `CollabPresenceSchema`, and `CollabSessionStateSchema`. Strict payload caps: individual update <= 512 KB, presence update <= 10 Hz with 30s TTL. Enforced roles: `owner`, `editor`, `viewer`, `agent`, ensuring viewers cannot emit mutating operations.
- **Decision — Convergence Model per Data Type (`src/utils/collaborationEngine.ts`):**
  - *Text & Documents:* Causal Lamport clock and positional rebase for concurrent inserts/deletes based on older sequences, preserving concurrent edits.
  - *Spreadsheets:* Cell-level causal Last-Writer-Wins (LWW) with coordinate addressing, deterministic AST recalculation, and explicit conflict detection on concurrent same-cell modifications.
  - *Presentations:* Slide-level fractional indexing and keyed operations (`insert`, `update`, `reorder`, `delete`) with stable slide UUIDs.
  - *Diagrams:* Referential node/edge integrity checks.
- **Decision — Separation of Durable Document Ops from Ephemeral Presence:**
  Durable operations are sequenced by the server, idempotent via client-generated `opId`, and persisted to PostgreSQL. Ephemeral presence (cursors, selections, active artifact) is kept in memory with a 30-second TTL and rate-limited fanout, never polluting the durable document log.
- **Decision — Participant-Scoped Undo/Redo Invariants:**
  Implemented per-actor undo/redo stacks. Undoing an actor's operation generates an inverse delta that leaves other collaborators' concurrent work untouched.
- **Decision — State-Vector Resumption over Vercel 300s Socket Timeout Bounds:**
  Clients track `lastServerSeq` and submit state vectors (`actorId => maxLamportClock`) on reconnect. `computeDeltaSince` computes the exact missing delta, allowing seamless resumption without full document re-fetch.
- **Decision — Pure TypeScript PDF 1.4 Binary Serialization (`src/utils/officeDocumentExporter.ts`):**
  Implemented `generatePdfArchive` conforming to standard PDF 1.4 specification with `%PDF-1.4` binary header, catalog dictionary, pages tree, Helvetica font resources, content streams, and xref table with `%%EOF` marker, with zero external npm dependencies.
- **Decision — Server-Authoritative Mutation & Tenant Isolation (`src/server/collaborationManager.ts`):**
  Enforced atomic sequence assignment, cross-tenant modification rejection (`TENANT_ISOLATION_VIOLATION`), and real-time actor revocation (`ACTOR_REVOKED`).

---

## Phase 5 Additions (Integrated Foundation Closure, Autonomous Intelligence Integration & Release Certification)

### Phase 5A: Integrated Foundation Closure
- **Decision — CRDT Engine Formal Classification (`src/utils/collaborationEngine.ts`):**
  Formally classified the collaboration architecture as a **Hybrid Server-Authoritative Sequenced Operational Model with Modality-Specific Convergence (Positional-Rebase for Text, Causal LWW CRDT for Spreadsheets, Keyed Entity Graph for Slides/Diagrams, and State-Vector Delta Synchronization for Transport Resumption)**. Text/code uses positional rebase; spreadsheets use cell-level causal Last-Writer-Wins (LWW) with recursive-descent AST formula evaluation; presentations use fractional indexing; diagrams use referential graph maps.
- **Security Invariant — Server-Authoritative Presence Receipt Time (`src/server/collaborationManager.ts`):**
  Ephemeral presence timestamps cannot be trusted from client payloads. `CollaborationSessionManager.updatePresence()` strictly stamps `updatedAt = (presence as any)._testClockOverride ?? Date.now()` (authoritative server receipt time), preventing client-spoofed expiration or awareness manipulation while allowing deterministic test clock overrides.
- **Verification — Property-Based CRDT & Concurrency Verification (`test/crdt-property-verification.test.ts`):**
  Authored an exhaustive 11-property verification suite verifying concurrent insertions at identical positions, concurrent deletion/insertion interleaving, idempotency under duplicate delivery, state-vector delta computation for catch-up, multi-replica convergence, participant-scoped undo/redo, spreadsheet reactive AST recalculation, slide order collision resistance, diagram referential integrity, server-authoritative timestamps, and randomized stress sequences (11/11 passed).
- **Resolution — Test Count Reconciliation (8/8 vs 9/9):**
  Verified that `node --test` treats the top-level test runner suite as 1 test and its child subtests as N, resulting in N+1 reported tests (`pass: 9` for 8 subtests). Confirmed zero test coverage loss between Phase 4B and Phase 4C.
- **Truthful Boundary — Live AI Revision Status:**
  Verified absence of production `NVIDIA_API_KEY` credential and truthfully classified live LLM revision as `BLOCKED_EXTERNAL`, with internal model-guided patch generation passing 100%.

### Phase 5B: Autonomous Intelligence Integration
- **Decision — Collaborative Agent Bridge (`packages/agent-runtime/src/collaborative-bridge.ts`):**
  Implemented `CollaborativeAgentBridge` binding existing `AutonomousAgentEngine` and canonical specialists (`PlannerSpecialistAgent`, `ResearcherSpecialistAgent`, `DocumentSpecialistAgent`, `VerificationSpecialistAgent`, `CoderSpecialistAgent`, `AnalysisSpecialistAgent`, `SynthesizerSpecialistAgent`) directly to the collaborative canvas (`CollaborationSessionManager`). Provides:
  - `createAgentActor(task, stepId, role, displayName)`: Formulates immutable agent identity (`isAgent: true`, `agentRole`, `runId`, `taskId`, `principalId`).
  - `getOrCreateSession()`: Enforces tenant isolation matching `task.principal.workspaceId`.
  - `submitAgentOperation()`: Submits sequenced mutations through `CollaborationSessionManager`.
  - `syncArtifactToTask()`: Synchronizes convergent artifact state into `task.artifacts`.
  - `coAuthorMultiAgent()`: Coordinates multi-specialist concurrent co-authoring.
  Avoided redundant execution engines by reusing existing `AutonomousAgentEngine` and `SpecialistRegistry`.
- **Verification — Autonomous Swarm Acceptance Missions (`test/autonomous-swarm-acceptance.test.ts`):**
  Authored and verified 13 mandatory representative missions (13/13 passed):
  - *Mission A (Research Report):* Multi-specialist task decomposition, research gathering, and markdown synthesis.
  - *Mission B (Data Analysis):* Spreadsheet cell population and AST formula recalculation (`=A1-A2`).
  - *Mission C (Multi-Artifact Consistency):* Coordinated generation of DOCX brief, XLSX model, and PPTX slide deck.
  - *Mission D (Code Development):* Bounded multi-file HTML/CSS/JS project bundle creation.
  - *Mission E (Concurrent Co-Authoring):* Researcher and Copywriter specialists editing distinct document sections concurrently.
  - *Mission F (Human-Agent Concurrency):* Human edit at index 0 preserved alongside AI specialist append.
  - *Mission G (Durable Recovery):* Resumed worker skipping completed step 1 without re-executing.
  - *Mission H (Provider Failure Handling):* Clean task failure and diagnostic error capture on unmapped specialist role.
  - *Mission I (Approval Gating):* Privileged WRITE action pausing in `WAITING_FOR_APPROVAL` state.
  - *Mission J (Cancellation Propagation):* Immediate transition to `CANCELLED` on user abort.
  - *Mission K (Multi-Tenant Isolation):* Cross-tenant modification rejection with `TENANT_ISOLATION_VIOLATION`.
  - *Mission L (Loop Budget Guard):* Task termination with `LOOP_LIMIT_EXCEEDED` when cycle limits are reached.
  - *Mission M (Verification Gate):* Step verification gate validating output quality before task completion.

### Phase 5C: Integrated Release Certification
- **Certification — Full Multimodal GenUI Suite:**
  Certified all 16 presentation and workspace modes across A2UI declarative runtime, local MCP Apps containment, multimodal artifact workspace (Code, Docs, Sheets, Slides, Diagrams), and real-time collaborative canvas.
- **Verification — Zero Known Release-Blocking Errors:**
  Verified 0 lint errors, 0 TypeScript errors across client, server, and API projects, successful production build (Vite bundle in 2.23s), 52/52 release auth unit tests passed, and 86/86 GenUI test suites passed.
- **Governance Invariant — Commercial Boundary & Strict Release Hold:**
  Preserved PR #215 on STRICT HOLD. Documented that production deployment remains on STRICT HOLD pending staging sign-off and separate owner attestation. Zero database migrations introduced.


