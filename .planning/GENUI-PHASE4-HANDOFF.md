# AIRA GenUI — Phase 4 Continuation Handoff

> **Canonical Temp Copy (per `/handoff`):** `C:\Users\WORKSTATION\AppData\Local\Temp\aira-genui-phase4-handoff.md`  
> **Verdict:** `PHASE_3_OPEN_GENUI_APPLICATIONS_IMPLEMENTED_EXTERNAL_CERTIFICATION_BLOCKED`  
> **Repo:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
> **Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI`  
> **Branch:** `feat/aira-genui-phase1-foundation`  
> **HEAD Commit:** `d6172655f3f47059baa946a995734a44956731ff`  
> **Lineage:** `6c90c12` (`origin/staging`) -> Phase 0 `f77fb64` -> Phase 0.5 `a17982c` -> Phase 1 `f2e9b40` -> Phase 2 `f39ecab` -> Phase 3 `d617265` (`origin/prod-release` `f429d90` & PR #215 `fd2f8b9` untouched)

See `.planning/LEARNINGS.md`, `.planning/graphs/GRAPH_REPORT.md`, and `docs/genui/AIRA_GENUI_PHASE3_CERTIFICATION.md` for full evidence, verification counts, and architecture ledger.

---

## 1. Quick Baseline & Architecture Overview

Phase 3 introduces **Open Generative UI Applications (`aira-app/v1`)** with a secure sandbox runtime and advanced visualizations:
- **Dual-Mode Generative UI Architecture:**
  - **Mode A (Declarative Component Surface):** Phase 1 & 2 native catalog components (sliders, charts, calculators, forms) rendered directly in React with zero inference cost for local recomputes.
  - **Mode B (Sandboxed Open Application):** Phase 3 rich applications (HTML/CSS/JS, D3 v7, Three.js, Canvas, SVG) rendered inside an isolated iframe with opaque origin (`null`).
- **Key Phase 3 Sources:**
  - `packages/contracts/src/genui.ts`: `AIRA_GENUI_APP_CONTRACT_VERSION = 'aira-app/v1'`, `GenUIAppSchema`, `GenUIBridgeMessageSchema`, `validateGenUIApp`, `normalizeGenUIAppPayload`.
  - `packages/agent-runtime/src/genui-streaming.ts`: `<airaApp>` streaming tag extraction, multi-tag streaming support, `sandboxed_app` presentation mode, and `adaptAiraEventToAGUI` protocol mapping.
  - `src/utils/genuiAppBridge.ts`: `buildSandboxAppHtml`, `validateSandboxAppBridgeMessage`, `generateStandaloneExportHtml`.
  - `src/utils/sandboxSecurity.ts`: Opaque sandbox attributes (`allow-scripts allow-forms`, zero `allow-same-origin`), CSP `connect-src 'none'`.
  - `src/components/genui/GenUISandboxApp.tsx`: Sandboxed iframe lifecycle, decoupled HTML memoization, inspect source modal, standalone offline export.
  - `src/utils/conversationSearch.ts`: `extractGenUIMetadata` & `hydrateGenUIMetadata` persisting and restoring `genuiApps` and `genuiAppState` in `conversation_messages.metadata`.
  - `test/genui-phase3-browser-acceptance.test.ts`: Automated Playwright Chromium browser acceptance covering all 10 scenarios (A–J).

---

## 2. Invariants & Security Mandates

1. **Opaque Sandbox Origin:** All sandboxed applications run under `sandbox="allow-scripts allow-forms"` with strictly **zero** `allow-same-origin`, **zero** `allow-top-navigation`, **zero** `allow-popups`. Browser sets `window.origin === 'null'`, physically cutting off parent cookies, `localStorage`, `sessionStorage`, and host DOM.
2. **Zero-Egress CSP:** Authoritative Content Security Policy:
   `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`
   Ensures all `fetch`, `XHR`, `WebSocket`, and `EventSource` calls fail immediately at browser level.
3. **Zero Floating CDNs:** D3 v7 and Three.js runtimes are bundled locally as self-hosted chunks and injected offline via local bridge scripts. No external network requests to `unpkg.com`, `cdnjs.cloudflare.com`, or `cdn.tailwindcss.com`.
4. **Cryptographic Bridge:** All host-sandbox postMessage interactions require active session nonces (`crypto.randomUUID()`) and origin checks (`origin === 'null'`). Consequential actions route to `/api/genui/actions` with principal validation and `DurableIdempotencyManager` deduplication.
5. **Release & Production Invariants:** Zero database migrations, zero schema alterations, zero secret rotations, zero infrastructure mutations. PR #215 commercial candidate, GST invoicing, payment gateways, and `prod-release` remain completely frozen.

---

## 3. Remaining External Blockers & Phase 4 Scope

- **External Blockers:**
  - Multi-provider live LLM keys (`Groq`, `Gemini`, `OpenAI`, `Anthropic`) absent on workstation.
  - Interactive OAuth credentials for production/staging authentication.
  - Pre-existing external Scenario 17 dependency.
- **Phase 4 Continuation Scope:**
  - Advanced multi-modal generative artifacts and unified collaborative canvas.
  - Multi-agent synchronous workspace editing within ArtifactStudio.
  - Full multi-provider live certification when external API credentials are provided.

---

## 4. Suggested Skills

`gsd-graphify`, `research`, `to-spec`, `tdd`, `implement`, `react-best-practices`, `agency-application-security-engineer`, `code-review`, `diagnosing-bugs`

---

## 5. Short Phase 4 Resumption Prompt

> Resume AIRA GenUI Phase 4 in `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI` (`feat/aira-genui-phase1-foundation`). Load `.planning/LEARNINGS.md`, `docs/genui/AIRA_GENUI_PHASE3_CERTIFICATION.md`, and query `.planning/graphs/graph.json` via `gsd-tools.cjs graphify query` instead of rescanning the repo. Keep PR #215/billing, `prod-release`, static sandbox hardening, CSP `connect-src 'none'`, and Phase 3 security gates intact.
