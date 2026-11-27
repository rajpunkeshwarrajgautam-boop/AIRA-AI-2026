# AIRA GenUI Phase 2 — Declarative A2UI v1.0 Implementation Profile

**Status:** APPROVED SPECIFICATION PROFILE (`ready-for-agent`)  
**Worktree & Branch:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI` (`feat/aira-genui-phase1-foundation`)  
**Phase 1 Baseline:** `f2e9b40e26bfaca6172ed90b9d483fa821af2494` (`PHASE_1_NATIVE_GENUI_IMPLEMENTED_EXTERNAL_CERTIFICATION_BLOCKED`)  
**Authoritative Protocol Input:** [AIRA_GENUI_A2UI_V1_0_RESEARCH.md](./AIRA_GENUI_A2UI_V1_0_RESEARCH.md) (`a2ui-project/a2ui@36725eee`)  
**Domain & ADR Alignment:** [GLOSSARY.md](../../GLOSSARY.md), [ADR-0001](../../docs/adr/0001-commercial-billing-and-credit-ledger-architecture.md)–[0004](../../docs/adr/0004-pgvector-version-compatibility.md), [AUTH_SESSION_SECURITY_ARCHITECTURE.md](../../docs/AUTH_SESSION_SECURITY_ARCHITECTURE.md), [AGENTS.md](../../AGENTS.md)

---

## Problem Statement

AIRA Phase 1 delivered native `aira-genui/v1` rendering, lazy Chart.js v4 visualizations, zero-`eval` domain calculators, `@ag-ui/core` event adaptation, and `POST /api/genui/actions` enforcement, but explicitly flagged `a2uiCompliant: false` (`structural-adapter-boundary`). As a result:
- Interactive components only read top-level state keys (`/key`) and pre-wired calculator kinds rather than supporting general A2UI v1.0 JSON Pointer reactive bindings across arbitrary AI-composed apps (sliders, filters, weights, multi-step forms, computed metrics, dynamic charts/tables).
- A2UI v1.0 wire lifecycle messages (`createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`, `action`, `error`, capability negotiation) are not yet validated or reduced incrementally through the streaming pipeline.
- Interactive GenUI surfaces and user-modified state are stored locally in browser `Conversation` state without durable server persistence and validation across `conversations/sync` and cross-device reloads.

## Solution

Extend AIRA's existing native GenUI contract (`aira-genui/v1`) and 39-component React registry with a profiled **A2UI v1.0 Interoperability & Reactive Runtime**:
1. Add native Zod v4 validation and bidirectional translation for the supported A2UI `v1.0` profile (`version: "1.0"`, `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`, `action`, `error`, capability objects) while keeping `aira-genui/v1` authoritative inside React.
2. Add a pure deterministic **Reactive Data Binding & Computed Dependency Engine** supporting RFC 6901 JSON Pointer paths (`/section/field`), A2UI `@path` / `@call` / `@checks` expressions, safe recursive-descent math + tabular filter/sort/weight/schedule/step operations (zero `eval`), cycle detection, and `$0` local recalculation.
3. Upgrade `GenUIStreamTagExtractor`, `adaptAiraEventToAGUI`, `PresentationRouter`, and `AgentRuntime` to stream incremental component/data/deletion lifecycle events while preserving ordinary Markdown prose when UI generation is unnecessary or invalid.
4. Persist sanitized surface specs and user input state inside `conversation_messages.metadata` (reusing existing migration `013_conversation_search_foundation.ts`, avoiding risky DB schema changes) and enforce idempotent server-side action checks on `POST /api/genui/actions` (reusing `idempotent_operations` / principal/conversation/run ownership and `ApprovalKernel`).

---

## Primary Testing & Integration Seams

Per `to-spec` discipline, changes target the fewest high-leverage seams:
1. **Contract & Reactive Boundary Seam:** `packages/contracts/src/` (`a2ui.ts`, `genui.ts`, `genui-reactive.ts`, `genui-calculators.ts`) — single pure entrypoint for schema validation, A2UI v1.0 translation/reduction, JSON Pointer mutations, computed dependency evaluation, and safety/size bounds.
2. **Runtime & Streaming Seam:** `packages/agent-runtime/src/` (`genui-streaming.ts`, `presentation-router.ts`, `index.ts`) — single lifecycle stream reducer/extractor, `@ag-ui/core` adaptation, Agent Workspace live surface patching, and prompt guidance.
3. **API & Persistence Seam:** `apps/api/src/index.ts`, `packages/retrieval/src/index.ts`, `src/utils/conversationSearch.ts`, `src/App.tsx` — sanitized `genui` metadata persistence on `/api/conversations/sync` + `GET /api/conversations/:id`, and server-authoritative `POST /api/genui/actions` (principal, CSRF, conversation/run ownership, idempotency, approval gating).
4. **React Presentation Seam:** `src/components/genui/` (`GenUISurfaceRenderer.tsx`, `types.ts`, `ContentRenderers.tsx`, `VizAndInteractiveRenderers.tsx`, `charts/LazyGenUIChart.tsx`) — single reactive state evaluation pass feeding all 39 existing renderers without rebuilding components or breaking focus/scroll.

---

## Implementation Profile (Sections 5A–5H)

### A. Protocol Interoperability (`profiled` A2UI v1.0)
- **Catalog IDs Supported:**
  - `https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json` (profiled subset mapped to AIRA registry)
  - `urn:aira:genui:catalog:v1` (AIRA 39-component + visualization + agent execution catalog)
- **Supported Wire Messages (`version: "1.0"`):** `createSurface` (rejecting deprecated `theme`), `updateComponents` (requiring root/no `Surface` override), `updateDataModel` (RFC 6901 pointers & `null` deletion), `deleteSurface`, plus renderer->agent `action` (`userMessage`, resolved `context`, optional `metadata.extensions`) and `error` (`VALIDATION_FAILED`, `UNALLOWED_PARENT`, `UNALLOWED_CHILD`, generic errors).
- **Supported `@call` Catalog Functions:** `required`, `regex` (ReDoS-guarded), `length`, `numeric`, `email`, `formatString`, `formatNumber`, `formatCurrency`, `formatDate`, `pluralize`, `and`, `or`, `not`, `openUrl` (`http:`/`https:` only, explicit user activation), and template `@index`.
- **Explicitly Unsupported / Rejected in Phase 2 (Honest Boundary):** Remote `$ref` schema fetching, `inlineCatalogs` (`acceptsInlineCatalogs: false`), agent-invoked `callRendererFunction` / `callAgentFunction` arbitrary RPC, `Video`/`AudioPlayer` streaming widgets, external CDN scripts, D3/Three.js, Phase 3 sandboxed web apps, and Phase 4 remote MCP Apps (`MCP_EGRESS_ENFORCEMENT_REQUIRED`). Conformance claims strictly scope to this documented Phase 2 profile (`complianceLevel: 'profiled-a2ui-v1.0'`).

### B. Declarative Component Composition
- Reuses all 39 components in `GENUI_COMPONENT_REGISTRY`; maps A2UI Basic Catalog names (`Row`->`horizontal_group`, `Column`->`vertical_group`, `Card`->`card`, `Text`->`text`/`heading`/`rich_text`, `Divider`->`divider`, `Button`->`action_button`, `TextField`->`text_input`, `CheckBox`->`checkbox`, `ChoicePicker`->`select_control`/`radio_group`/`segmented_control`, `Slider`->`slider`, `List`/`Tabs`/`Image`/`Icon`/`DateTimeInput` mapped safely within allowed AIRA components).
- Preserves stable React keys (`component.id`), controlled input focus, and scroll offsets across `genui.surface.patched` / `updateComponents` updates.
- Enforces `AIRA_GENUI_LIMITS`: `256 KB` payload, `64 KB` state, `<= 100` components, depth `<= 8`, acyclic DAG, unique IDs, no dangling refs, and strict schema checking.

### C. Shared Reactive Data Models
- JSON Pointer path engine (`getByJsonPointer`, `setByJsonPointer`, rejecting `__proto__`, `constructor`, `prototype`, max depth `<= 8`, array index bounds `<= 500`).
- Reactive computation & binding pipeline on `GenUISurface`:
  - `bindings`: component property / input `dataRef` (e.g., `/loan/principal`, `/filters/category`) and A2UI `{"@path": "..."}` / `{"@call": "..."}` bindings.
  - `computed`: ordered declarative computations (`math` via zero-`eval` AST parser, `compound_growth`, `amortization`, `function_series`, `weighted_scores`, `table_filter_aggregate`, `step_gate`, `format_currency`, `format_number`, `ratio`) topologically sorted with cycle detection (`GENUI_COMPUTED_CYCLE`) and bounded iterations (`<= 1000` points/rows).
  - `@checks` validation evaluation producing accessible inline validation messages and blocking invalid form submissions cleanly.
- Zero AI calls or credit deductions on local interactive changes.

### D. Progressive Surface Lifecycle
- `GenUILifecycleEventSchema` supports `genui.surface.created`, `genui.surface.patched` (component upserts, component removals, JSON Pointer or shallow state updates, A2UI incremental translation), `genui.surface.completed`, `genui.surface.deleted`, and `genui.surface.error`.
- `applyGenUILifecycleEventToMap` remains idempotent and strictly ordered (ignores stale run IDs, duplicate `eventId`s, out-of-order lower sequences), preserves stream reconnection recovery, and cleanly falls back to `textFallback` without corrupting streamed Markdown text.
- `adaptAiraEventToAGUI` translates all GenUI & runtime events (including deletion) cleanly to `@ag-ui/core@1.0.5`.

### E. Bidirectional AI–UI Communication
- Distinguishes:
  1. `local_recompute` / `reset_state` — pure local reactive update ($0 cost).
  2. `attach_followup` — explicit user-triggered follow-up prompt attaching verified surface snapshot via authenticated `POST /api/genui/actions` -> new conversational turn.
  3. `run_approval` / `workflow_trigger` / consequential actions (`requiresApproval: true` or `WRITE`/`DESTRUCTIVE`) — rejected by `POST /api/genui/actions` (`403`) unless executed through `ApprovalKernel` (`/api/runs/:id/approve` / `/api/workflows/runs/:id/steps/:stepId/approve`).
- `POST /api/genui/actions` validates: BFF session + CSRF, `ExecutionPrincipal`, `conversationId` ownership (via `conversationSearchRepo`), `runId` ownership (via `agentRuntime.getRun`), payload limits (`GenUIInteractionEventSchema`), surface/action definition integrity, and idempotency key deduplication (backed by `idempotent_operations` when PostgreSQL is active, bounded in-memory guard otherwise).

### F. Persistent Interactive State
- **Database Decision:** Zero new SQL migration needed. Existing table `conversation_messages` (`013_conversation_search_foundation.ts`) already provides tenant-isolated `metadata JSONB` and atomic sync/load inside `ConversationSearchRepository`, and `idempotent_operations` (`023_idempotent_operations.ts`) handles durable server action deduplication.
- Persists only validated `genui: { surfaces, surfaceState, updatedAt }` inside message metadata (bounded <= `256 KB` per surface / `<= 64 KB` state; stripped of hidden reasoning, credentials, runtime tokens, or unvalidated objects).
- Local IndexedDB + localStorage (`src/utils/storage.ts`) + server sync (`src/utils/conversationSearch.ts` <-> `apps/api/src/index.ts`) guarantee deterministic restoration on reload, conversation switch, and cross-device sign-in without re-running inference or replaying consequential actions.

### G. Adaptive Presentation Routing & Model Integration
- Extends `PresentationRouter` (`packages/agent-runtime/src/presentation-router.ts`) to recognize interactive planner/calculator/decision-matrix/filterable-dashboard/study-planner/multi-step-form prompts cleanly at Tier 1/Tier 2 without forcing UI onto ordinary prose Q&A.
- `buildGenUISystemInstruction` instructs capable models (verified live against `NVIDIA_API_KEY` non-reasoning/lightning models) on generating validated declarative reactive `aira-genui/v1` or profiled A2UI `v1.0` `<airaGenUI>` surfaces dynamically — never hardcoded prompt fixtures — with accurate status reporting (`surfaceDelivered` only when schema validation succeeds).

### H. Agent Workspace Integration
- Extends `AgentRuntime` (`packages/agent-runtime/src/index.ts`) to emit incremental `genui.surface.patched` lifecycle events during execution as tools start/complete/fail, approvals trigger/resolve, artifacts are produced, and runs reach terminal `COMPLETED`/`FAILED`/`CANCELLED` states — strictly derived from authoritative runtime events with zero fabricated progress or hidden reasoning leakage, respecting existing plan/entitlement gates (`requireCapability('autonomous')`).

---

## Acceptance Scenarios & Testing Decisions (Section 6)

Behavior is verified across unit/integration tests, real PostgreSQL 18.7 tests, bounded live NVIDIA model generation tests, and Chromium Playwright browser E2E tests (Desktop `1440x900`, Tablet `768x1024`, Mobile `375x812`, Light & Dark themes):
1. **A2UI v1.0 Protocol & Conformance Fixtures:** Valid/invalid `1.0` envelopes, `theme` rejection, catalog mapping, missing `root` / `Surface` override rejection, `@checks`, JSON Pointer updates, Apache-2.0 attributed upstream fixtures.
2. **All 7 Required Dynamic Interactive Applications (no hardcoded template cheat):**
   - Investment planner (principal, contribution, return, years -> reactive value, metrics, growth chart, summary table)
   - Loan calculator (principal, rate, duration -> EMI, total interest, repayment, amortization table)
   - Supplied-data dashboard (shared dataset + category/threshold filters -> dependent charts, metrics, table update at $0 inference)
   - Interactive decision matrix (editable criteria weights & candidate scores -> deterministic weighted score ranking + chart/table update)
   - Study planner (configurable schedule, task completion/allocation -> live progress indicator, metrics, persistent reload state)
   - Scientific function explorer (`f(x)` expression, `xMin`/`xMax`/param sliders -> safe recursive-descent evaluation + live line chart, invalid/unsafe syntax rejected cleanly)
   - Multi-step form (step navigation, dependent field visibility, `@checks` validation, explicit authorized `POST /api/genui/actions` submit + idempotent replay handling)
3. **Live AI Generation + Browser E2E:** Novel legitimate interactive prompts sent to live NVIDIA NIM producing validated dynamic GenUI surfaces rendered in Chromium with real user pointer/keyboard interactions verifying `<16ms`/smooth client recompute, 0 incremental LLM requests on interaction, 0 console/page errors, reload persistence, and accessible semantics.

---

## Out of Scope
- Remote external catalog fetching, `inlineCatalogs`, `callRendererFunction` / `callAgentFunction` remote RPC, D3/Three.js, Phase 3 arbitrary JS/sandboxed HTML micro-app compilation, Phase 4 remote MCP Apps, commercial billing/entitlement modifications, PR #215 changes, staging/production DB migrations or deployments.
