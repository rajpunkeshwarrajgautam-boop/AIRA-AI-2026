# AIRA GenUI Phase 3 — Open Generative UI Applications, Secure Sandbox Runtime & Advanced Visualizations

**Specification Version:** `3.0.0`  
**Status:** `READY_FOR_IMPLEMENTATION`  
**Author:** Software Architect & Application Security Engineer Specialists (Agency Orchestrator)  
**Triage Label:** `ready-for-agent`  
**Target Branch:** `feat/aira-genui-phase1-foundation`  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  

---

## 1. Problem Statement

Modern conversational AI systems are frequently asked to build and display complex interactive experiences that exceed the boundaries of fixed component catalogs: physics simulations, custom multi-axis financial models, 3D spatial scenes, hierarchical network graphs, scientific diagrams, interactive articles, and specialized domain tools.

In Phase 1 and Phase 2, AIRA established native deterministic components (Phase 1) and declarative interactive streaming surfaces with A2UI v1.0 compatibility (Phase 2). However:
1. **Catalog Boundary Ceiling:** Users asking for custom canvas-based animations, particle systems, procedural graphs, 3D visualizations, or arbitrary bespoke HTML/CSS/JS interactions cannot be expressed solely as static layout trees or declarative sliders.
2. **Execution Security Risks:** Executing arbitrary model-generated HTML, JavaScript, or WebGL creates high-risk attack surfaces: Cross-Site Scripting (XSS), prototype pollution, local storage exfiltration, host cookie theft, clickjacking, and parent DOM manipulation.
3. **Fragile CDN Dependencies:** Traditional generative UI implementations inject external floating CDN scripts (e.g. `unpkg.com`, `cdnjs`, `cdn.tailwindcss.com`) that fail in air-gapped environments, create supply-chain vulnerabilities, and violate CSP rules.
4. **State Isolation & Loss:** Sandboxed applications often run as ephemeral visual toys disconnected from the conversational context, inability to persist state across browser reloads, or trigger authenticated backend actions.

AIRA requires a production-grade, secure, sandboxed Open Generative UI runtime that executes rich, model-generated applications in an opaque-origin iframe with strict CSP, zero external CDN dependencies, self-hosted D3 v7 and Three.js runtimes, a cryptographically bounded bidirectional host bridge, and seamless integration with ArtifactStudio and UnifiedWorkspace V3.

---

## 2. Solution Overview

AIRA GenUI Phase 3 introduces **Open Generative UI Applications (`aira-app/v1`)** with a multi-layered security and rendering architecture:

1. **Dual-Mode Generative UI Architecture:**
   - **Mode A (Declarative Component Surface):** Phase 1 & 2 native catalog components (sliders, charts, calculators, forms) rendered directly in React with zero inference cost for local recomputes.
   - **Mode B (Sandboxed Open Application):** Phase 3 rich applications (HTML/CSS/JS, D3, Three.js, Canvas, SVG) rendered inside an isolated iframe with opaque origin (`null`).
2. **Defense-in-Depth Sandbox Security:**
   - **Iframe Isolation:** `sandbox="allow-scripts allow-forms"` with **zero** `allow-same-origin`, **zero** `allow-top-navigation`, **zero** `allow-popups`.
   - **Authoritative CSP:** `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`
   - **Static Containment Invariant:** Static previews (Markdown, SVG, code) continue to enforce strict `script-src 'none'`.
   - **Zero Floating CDNs:** D3 v7 and Three.js runtimes are bundled locally as self-hosted chunks (`d3.min.js`, `three.min.js`) and injected via secure local data blobs or pre-compiled bridge scripts.
3. **Cryptographically Guarded Host-Sandbox Bridge:**
   - Bidirectional communication via `window.postMessage` gated by active session nonce, origin verification (`origin === 'null'`), and strict zod-validated message schemas.
   - Validated message types: `GENUI_APP_INIT`, `GENUI_APP_RESIZE`, `GENUI_APP_STATE_UPDATE`, `GENUI_APP_ACTION`, `GENUI_APP_FOLLOWUP`, `GENUI_APP_ERROR`.
   - Server-side action dispatch routed through `/api/genui/actions` with principal ownership validation and durable idempotency (`DurableIdempotencyManager`).
4. **ArtifactStudio & UnifiedWorkspace V3 Integration:**
   - Multi-tab inspection: Interactive App Preview, Source Code (HTML, CSS, JS), State Inspector, and Console Logs.
   - Version history and deterministic state restore from PostgreSQL 18.7 JSONB (`conversation_messages.metadata.genui.appState`).
   - Standalone export: One-click export as a self-contained, offline-runnable HTML file.

---

## 3. Extensive User Stories

1. **US-01 (Physics Simulation):** As a STEM student or researcher, I want AIRA to generate an interactive 2D physics simulation (e.g. double pendulum, orbital gravity, wave interference) with interactive parameter controls, so that I can explore dynamic system behaviors visually.
2. **US-02 (Custom Financial Dashboard):** As a financial analyst, I want AIRA to generate a bespoke multi-asset portfolio rebalancing tool with custom canvas heatmaps and interactive scenario toggles, so that I can analyze asset distributions beyond standard bar charts.
3. **US-03 (3D Spatial Visualization):** As an engineer or designer, I want AIRA to generate an interactive 3D scene (e.g. molecule viewer, solar system, CAD model preview) powered by self-hosted Three.js, so that I can rotate, zoom, and inspect spatial structures.
4. **US-04 (Scientific Diagram & Graph):** As a data scientist, I want AIRA to render complex network graphs and hierarchical force-directed diagrams using self-hosted D3 v7, so that I can inspect relational cluster topologies.
5. **US-05 (Multi-Step Web Tool):** As an operations manager, I want AIRA to build a custom interactive checklist and ROI calculator with exportable summary metrics, so that my team can calculate operational efficiencies.
6. **US-06 (Zero Host Leakage):** As a security auditor, I want the sandboxed application to be executed in an opaque origin without access to host `document.cookie`, `localStorage`, `sessionStorage`, or parent window DOM, so that malicious prompt injections cannot compromise user credentials.
7. **US-07 (Zero External Network Egress):** As an enterprise compliance officer, I want all scripts and assets to be self-hosted with `connect-src 'none'`, so that sensitive corporate data entered into generative tools cannot be exfiltrated to external endpoints.
8. **US-08 (State Persistence & Restoration):** As a user returning to a previous conversation, I want my interactive app inputs and generated simulation states to reload deterministically without re-running AI inference, so that my work is preserved.
9. **US-09 (Bidirectional Agent Action):** As a user using an interactive app, I want clicking an action button (e.g. "Generate Report from Scenario") to send an authenticated action event back to the AI assistant, so that the conversation continues with the app's exact output state.
10. **US-10 (ArtifactStudio Source Inspection):** As a developer, I want to open any generated app in ArtifactStudio, view and edit its clean HTML/CSS/JS source, and test live edits in real time, so that I can customize or learn from the code.
11. **US-11 (Single-File Standalone Export):** As a user, I want to download the generated application as a single self-contained HTML file that runs completely offline in any modern browser, so that I can share it with colleagues.
12. **US-12 (Graceful Error Recovery):** As a user, if a generated script throws a runtime exception or creates an infinite loop, I want an inline error boundary with a "Reload" and "Fix with AI" option rather than a frozen browser tab.

---

## 4. Implementation Decisions

### D-01: Application Schema Contract (`aira-app/v1`)
A new schema contract `GenUIAppSchema` is introduced in `packages/contracts/src/genui.ts` alongside `aira-genui/v1`:

```typescript
export const AIRA_GENUI_APP_CONTRACT_VERSION = 'aira-app/v1';

export const GenUIAppTypeSchema = z.enum([
  'html_application',     // Standalone HTML/CSS/JS app
  'd3_visualization',     // D3 v7 force, tree, network, or hierarchical chart
  'three_scene',          // Three.js WebGL 3D scene
  'simulation',           // Canvas-based numerical/physics simulation
  'interactive_article',  // Rich multimedia article with embedded reactive widgets
]);

export const GenUIAppSchema = z.object({
  schemaVersion: z.literal(AIRA_GENUI_APP_CONTRACT_VERSION),
  appId: IdSchema,
  appType: GenUIAppTypeSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  html: z.string().max(512 * 1024),
  css: z.string().max(128 * 1024).optional(),
  javascript: z.string().max(256 * 1024).optional(),
  libraries: z.array(z.enum(['d3', 'three'])).max(2).default([]),
  initialState: z.record(z.string().max(64), GenUIStateValueSchema).default({}),
  actions: z.array(GenUIActionDefinitionSchema).max(16).default([]),
  height: z.number().int().min(200).max(1200).default(500),
  allowResize: z.boolean().default(true),
  textFallback: z.string().min(1).max(1000),
}).strict();
```

### D-02: Strict Opaque Sandbox Execution Environment
- **Iframe Container:**
  ```html
  <iframe
    sandbox="allow-scripts allow-forms"
    srcdoc="..."
    data-testid="genui-app-iframe"
    style="width:100%; border:none; border-radius:12px; overflow:hidden;"
  />
  ```
  Omission of `allow-same-origin` enforces `window.origin === 'null'`. The iframe has zero access to host cookies, `localStorage`, `sessionStorage`, `indexedDB`, or `window.parent` DOM.
- **Authoritative Content Security Policy:**
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
  ```
- **Self-Hosted Library Injection:**
  When `libraries: ['d3']` or `libraries: ['three']` is declared, the host injects the self-hosted bundled script code directly into the iframe `<head>` before the application code executes. Zero external HTTP requests are made.

### D-03: Typed Bidirectional Bridge Protocol
The sandbox communicates with the host exclusively via `window.parent.postMessage`:

```typescript
export const GenUIBridgeMessageTypeSchema = z.enum([
  'GENUI_APP_INIT',          // Host -> Sandbox: handshake with nonce, theme, initialState
  'GENUI_APP_READY',         // Sandbox -> Host: app mounted and ready
  'GENUI_APP_RESIZE',        // Sandbox -> Host: requested iframe height (clamped 200-1200px)
  'GENUI_APP_STATE_UPDATE',  // Sandbox -> Host: user state change snapshot
  'GENUI_APP_ACTION',        // Sandbox -> Host: user action dispatch (routed to /api/genui/actions)
  'GENUI_APP_FOLLOWUP',      // Sandbox -> Host: follow-up chat prompt trigger
  'GENUI_APP_ERROR',         // Sandbox -> Host: uncaught error report
]);
```

- **Cryptographic Nonce Validation:** Every iframe instance is assigned a unique cryptographic nonce `crypto.randomUUID()`. Messages lacking the active nonce or having invalid origin (`event.origin !== 'null'`) are discarded immediately.
- **Action Dispatch Authentication:** Consequential actions dispatched via `GENUI_APP_ACTION` are routed to the existing `/api/genui/actions` endpoint with principal verification and `DurableIdempotencyManager` deduplication.

### D-04: Streaming Tag Extraction (`<airaApp>...</airaApp>`)
The streaming extractor is extended to recognize `<airaApp>` tags alongside `<airaGenUI>` tags:
- Opening tag: `<airaApp>`
- Closing tag: `</airaApp>`
- Clean prose separation: Prose before/after the tag is streamed cleanly into the chat stream; code fences (` ```json `) are stripped automatically.
- Graceful EOF recovery: If the stream terminates before `</airaApp>`, the flush routine attempts recovery parsing of the accumulated JSON.

### D-05: ArtifactStudio & UnifiedWorkspace V3 Integration
- **Component:** `GenUISandboxApp.tsx` renders the sandboxed application inside chat messages and UnifiedWorkspace V3.
- **Source Inspection:** A toolbar button "Inspect Source" opens ArtifactStudio with tabs:
  - `Preview`: Live interactive app.
  - `HTML`: Raw HTML template.
  - `CSS`: Stylesheet.
  - `JavaScript`: Application logic.
  - `State`: Real-time reactive state JSON.
  - `Console`: Sandboxed logs and errors.
- **Export Utility:** A dedicated "Export Standalone HTML" button bundles the HTML, CSS, JavaScript, self-hosted libraries, and current state into a single portable `.html` file.

---

## 5. Testing Decisions

1. **High Seam Testing:** Test via end-to-end browser acceptance (`Playwright Chromium`) against the production Vite build (`dist/index.html`) and live Express backend.
2. **Contract & Schema Suite (`test/genui-phase3-app-contract.test.ts`):**
   - Validates `aira-app/v1` app schema with valid and invalid payloads.
   - Tests bridge message validation, type safety, and payload caps.
   - Verifies normalization and error handling.
3. **Sandbox Security & Isolation Suite (`test/genui-phase3-sandbox-security.test.ts`):**
   - Proves sandbox iframe lacks `allow-same-origin` (`window.origin === 'null'`).
   - Asserts script cannot access parent `window.localStorage` or host cookies.
   - Verifies external network requests (`fetch('https://...')`, `new XMLHttpRequest()`) fail immediately fail-closed under CSP `connect-src 'none'`.
   - Verifies prototype pollution attempts inside state payload are blocked.
4. **Browser E2E Acceptance Suite (`test/genui-phase3-browser-acceptance.test.ts`):**
   - **Scenario A (Physics Simulation):** Gravity pendulum with canvas render, slider controls, and $0 local recomputes.
   - **Scenario B (Advanced Dashboard):** Multi-view financial planner with interactive table and dynamic canvas visual.
   - **Scenario C (D3 Visualization):** Force-directed relational network graph using self-hosted D3 v7.
   - **Scenario D (Three.js 3D Scene):** Interactive rotating geometric mesh using self-hosted Three.js.
   - **Scenario E (Bridge Action & Follow-up):** Sandboxed button click dispatches authorized action and appends conversational follow-up.
   - **Scenario F (State Persistence & Page Reload):** Modify state, reload browser page, verify state restored from PostgreSQL JSONB without AI inference.
   - **Scenario G (ArtifactStudio Source Inspection):** Inspect source tabs (HTML, CSS, JS, State), test live code preview.
   - **Scenario H (Standalone HTML Export):** Generate and verify offline standalone HTML bundle.
   - **Scenario I (Error Recovery):** Script error inside iframe triggers error boundary without crashing main chat.
   - **Scenario J (Accessibility & Viewport Responsiveness):** Dark mode theme, tab keyboard navigation, Tablet (768px) and Mobile (375px) responsive layouts without horizontal overflow.

---

## 6. Out of Scope

1. **Native WebAssembly Compiler:** In-browser compilation of C/Rust to WASM is deferred to future milestones.
2. **Dynamic Unpinned NPM Package Imports:** Importing arbitrary remote npm packages at runtime via unpkg/esm.sh is strictly forbidden under zero-CDN security invariants.
3. **Database Schema Alterations:** No database migrations or DDL changes required; existing PostgreSQL 18.7 `conversation_messages.metadata` JSONB cleanly houses application specs and states.
4. **Payment Gateway / Billing:** PR #215 commercial billing and payment gateways remain strictly untouched.
