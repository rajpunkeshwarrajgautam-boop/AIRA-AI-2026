# AIRA GenUI Phase 1 — Native GenUI Certification & Continuation Record

**Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI`  
**Branch:** `feat/aira-genui-phase1-foundation`  
**Phase 0.5 Foundation Base:** `a17982ca8cc17b657b503135a429e244dc700b8d`  
**Preserved Production Reference:** `f429d90a1f4322a0d362956fb9e55a38cb3b5508` (`origin/prod-release`, unmodified)  
**Preserved Commercial PR #215 Reference:** `fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` (unmodified)  
**Protocol Contract:** `aira-genui/v1` (with structural A2UI `v1.0` boundary; full A2UI transport deferred to Phase 2)

---

## 1. Verdict

**`PHASE_1_NATIVE_GENUI_IMPLEMENTED_EXTERNAL_CERTIFICATION_BLOCKED`**

All authorized Phase 1 deliverables — targeted foundation remediations (`3A`–`3D`), native GenUI contract (`aira-genui/v1`), 39-component React registry, lazy self-hosted Chart.js v4 visualization runtime, deterministic zero-`eval` calculators, `@ag-ui/core@1.0.5` adapter & progressive streaming, bidirectional state & server-authorized follow-up actions, Chat + initial Agent Execution integration, Playwright Chromium E2E acceptance (`A–O` across desktop/tablet/mobile & light/dark), live NVIDIA NIM GenUI verification, and isolated WSL PostgreSQL 18 certification — pass with zero known release-blocking defects.

Full cross-provider live certification (`Groq`, `Gemini`, `OpenAI`, `Anthropic`) and live authenticated staging/production OAuth Agent Workspace acceptance remain blocked externally by absent provider API keys and interactive OAuth credentials on this workstation.

---

## 2. Targeted Foundation Remediations (Section 3)

### 3A. Retired NVIDIA Model Remediation (`nvidia/llama-3.1-nemotron-70b-instruct` HTTP 410)
- Replaced active selectable registry references to EOL `nvidia/llama-3.1-nemotron-70b-instruct` with verified live `nvidia/nemotron-3.5-lightning-30b-a3b` while preserving fast (`nvidia/nemotron-3.5-bolt-e4b`) and deep (`nvidia/nemotron-3.5-super-vl-120b-a12b`) capability distinctions and unchanged commercial pricing/tier allowlists (`packages/contracts/src/index.ts`, `packages/contracts/src/model-registry.ts`, `packages/contracts/src/commercial.ts`, `src/types/index.ts`, `src/utils/constants.ts`).
- `resolveNvidiaModel` (`packages/model-router/src/index.ts`) rejects retired model IDs even inside misconfigured `NVIDIA_*_MODEL` env overrides (`RETIRED_NVIDIA_MODELS`, `isRetiredNvidiaModel`), migrating legacy identifiers deterministically.
- `OpenAIAdapter` and `ProviderHealthTracker` (`packages/model-router/src/health-tracker.ts`) classify HTTP `410 Gone` as non-retryable and immediately trip the circuit breaker (`OPEN`).

### 3B. `PresentationRouter` Live Tier 2 Classification Fix
- **Root Cause:** `nvidia/nemotron-3.5-lightning-30b-a3b` enables hidden reasoning tokens by default, exhausting `maxTokens` before emitting JSON (`finish_reason: "length"`, `content: null`).
- **Fix:** Wired structured JSON `response_format` (`PRESENTATION_JSON_SCHEMA`), `chat_template_kwargs: { enable_thinking: false }`, and `maxTokens <= 160` against fast non-reasoning `nvidia/nemotron-3.5-bolt-e4b` (`packages/agent-runtime/src/presentation-router.ts`, `packages/model-router/src/index.ts`, `packages/model-router/src/gemini-adapter.ts`), with a bounded `2500ms` timeout and deterministic calculator fast-path (`0ms`, `0` tokens).
- **Live Verification (`NVIDIA_API_KEY`):** Bounded probe returned `source: "model"`, `degradedToFallback: false`, `invalidStructuredOutput: false` across 3 unseen prompts (`638ms`/`173 tokens`, `797ms`/`175 tokens`, `716ms`/`174 tokens`). Offline deterministic + model stubs remain clearly separated (`test/presentation-router-poc.test.ts`, `test/presentation-router-holdout.test.ts`).

### 3C. Artifact Preview Assessment
- Fixed hardcoded `isDark = false` in `src/components/UnifiedWorkspace.tsx` (`document.documentElement.classList.contains('dark')`) and extended pure-TS `renderSafeMarkdownHtml` (`src/utils/sandboxSecurity.ts`) with escaped GFM tables, ordered lists, blockquotes, and horizontal rules.
- Verified SVG sanitization, Mermaid/React honest static containment (`script-src 'none'`, zero `unsafe-eval`, zero floating CDNs), sandboxed HTML execution (without `allow-same-origin`), multi-file bundling, and version revision switching (`test/foundation-remediation.test.ts`, `test/artifact-sandbox-security-gate.test.ts`, `test/artifact-sandbox-containment.test.ts`, `test/artifact-studio-m1.test.ts`). Mermaid & React remain explicit static containment/source previews until a future sandboxed self-hosted compiler phase.

### 3D. Isolated PostgreSQL 18 Certification
- Executed DB migrations and test suites sequentially (`--test-concurrency=1`) on local disposable WSL `Ubuntu-24.04` `PostgreSQL 18.7` (`127.0.0.1:5432/aira_test_db`, zero Neon access):
  - `test/genui-postgres18-certification.test.ts` (3/3 PASS: PG18 identity check, `ToolGateway` + `PostgresApprovalRepository` + `approval_resumption_outbox` one-time claim/once-consumption & cross-principal denial, `WorkflowEngine` + `PostgresWorkflowRepository` approval pause & cancellation persistence)
  - `test/postgres-durable-idempotency.test.ts` (9/9 PASS)
  - `test/migration-034-real-postgres.test.ts` (8/8 PASS)
  - `test/outbox-cancellation-and-invoice-rehearsal.test.ts` (9/9 PASS)
  - `test/announcements-durability-postgres.test.ts` (9/9 PASS)
  - `test/worker-destructive-postgres-rehearsal.test.ts` (3/3 PASS)

---

## 3. Phase 1 Architecture & Security Summary

1. **Contract (`packages/contracts/src/genui.ts`):** Versioned Zod v4 schema (`aira-genui/v1`) covering 39 discriminated component types, unique IDs, cycle & dangling-child checks, nesting depth cap (`<= 8`), component cap (`<= 100`), payload cap (`<= 256 KB`), state cap (`<= 64 KB`), forbidden `__proto__`/`constructor`/`prototype` rejection, `http:`/`https:` evidence URI validation, deterministic sorted-key serialization, and structural A2UI `v1.0` boundary envelope mapping (`a2uiCompliant: false`).
2. **Deterministic Calculators (`packages/contracts/src/genui-calculators.ts`):** Pure recursive-descent math parser (`<= 128` tokens, `<= 16` depth, zero `eval`/`new Function`), compound interest, percentages, unit conversions (including temperature offsets), loan amortization, and `f(x)` function plotting. Never routed to web search (`packages/agent-runtime/src/router.ts`).
3. **Component Registry & Lazy Chart.js v4 (`src/components/genui/*`):** All 39 Content, Layout, Visualization, Interactive, and Agent Execution components integrated with AIRA `tokens.css`/terracotta contrast (`#b84b29`/`#c25938`) and accessible Chart/Table local toggling. Vite bundle confirmed `chart.js@4.6.2` code-splits into lazy chunk `dist/assets/GenUIChartCanvas-*.js` (`198.26 kB` raw / `68.69 kB` gzip), adding `0 kB` to initial main load until a chart surface renders.
4. **Streaming, `@ag-ui/core@1.0.5` & Action Security (`packages/agent-runtime/src/genui-streaming.ts`, `packages/agent-runtime/src/index.ts`, `apps/api/src/index.ts`, `src/utils/aiEngine.ts`, `src/App.tsx`, `src/components/ChatMessage.tsx`):** Narrow `@ag-ui/core` translation (`adaptAiraEventToAGUI`), partial-tag `<airaGenUI>` stream extraction, idempotent/ordered/run-scoped surface reducer (`applyGenUILifecycleEventToMap`), BFF CSRF + principal-enforced `POST /api/genui/actions` rejecting cross-principal and workflow/approval bypasses (`403`).

---

## 4. Verification Matrix

| Check / Suite | Scope | Result |
| :--- | :--- | :--- |
| `npm run lint` (`oxlint`) | 731 files | **PASS** (0 errors) |
| `npm run typecheck` | Frontend, server, API (`tsc`) | **PASS** (0 errors) |
| `npm run build` (`vite build`) | Production bundle + Chart.js split | **PASS** (`GenUIChartCanvas` `68.69 kB` gzip) |
| Core & GenUI Unit/Security Suites (20 files) | Contract, calculators, 39-component registry, AG-UI/streaming, remediation, sandbox, entitlements, provenance, workflows, tool gateway | **PASS (175/175)** |
| `npm run test:remediations` | Security & billing/isolation matrix | **PASS (53/53)** |
| `npm run test:router` | Intent routing & freshness policy | **PASS** |
| `npm run test:model-routing` | Provider fallback & circuit breakers | **PASS** |
| `test/presentation-router-poc.test.ts` + `holdout` | Presentation routing & fault resilience | **PASS** |
| Sequential PostgreSQL 18 (`--test-concurrency=1`, 6 files) | PG `18.7` `aira_test_db` | **PASS (41/41)** |
| Playwright Chrome E2E (`test/genui-phase1-browser-acceptance.test.ts`) | Built `dist/` across Desktop (`1440x900`), Tablet (`768x1024`), Mobile (`375x812`), Light & Dark + live `nvidia/nemotron-3.5-lightning-30b-a3b` GenUI turn | **PASS** (live NIM `genuiSurfaces=1`, `chartDelta=1`, `latencyMs=1657`, zero console errors, zero horizontal overflow) |
| Live Groq/Gemini/OpenAI/Anthropic + OAuth Production Agent Workspace | Multi-provider & prod OAuth UI | **BLOCKED (EXTERNAL)** — missing API keys & OAuth credentials locally |
