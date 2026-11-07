# Adaptive Studio Phase 4 — Architecture Specification & Execution Checkpoint

Status: **Milestones 4.1–4.4 verified; Microsoft Edge acceptance PASS; Live execution gates remain open.**

## 1. Executive Summary & Context

Phase 7 delivered the standalone prototype and visual truth on port `4173`.  
Phase 6 delivered the opt-in presentation shell bridge on port `4174` (PR #138).  
Phase 5 delivered the streaming artifact parser, agent timeline event mapping, sandboxed error relay, reviewable repair draft, and revision diff view (PR #139, commit `6fcce53`).

**Phase 4 establishes the Interactive Studio Canvas Controls, Multi-Artifact Navigation, and Human-In-The-Loop (HITL) Tool Approval Bridge.**

```
+---------------------------------------------------------------------------------------------------------+
|                                           TOPBAR (AIRA SHELL)                                           |
|  [Logo: Sheared Portal]   Project Title   [Mode: Chat / Agent]   Model: Auto   Theme   User             |
+-------------------------------------------------------+-------------------------------------------------+
|  LEFT NAVIGATION     |  CONVERSATION TIMELINE         |  ADAPTIVE ARTIFACT STUDIO (46% DOCK)            |
|  - Recent Chats      |  - User Messages               |  - Artifact Switcher: [<] [1 of 3: Orbit] [>]   |
|  - Projects          |  - Agent Timeline Events       |  - Device Frame: [Desktop] [Tablet] [Mobile]    |
|  - Sandboxes         |  - [HITL Approval Card]        |  - Zoom Canvas: [-] [100%] [+] [Reset]          |
|                      |    * Tool: write_file          |  - Tabs: [Preview] [Code] [Diff]                |
|                      |    * [Approve] [Reject]        |  - Sandboxed iframe (allow-scripts)             |
|                      |  [Composer: Chat/Agent toggle] |  - Actions: [Copy] [Export HTML] [Save Project] |
+-------------------------------------------------------+-------------------------------------------------+
```

---

## 2. Implemented & Verified Capabilities

### Pillar 4.1: Studio Canvas Zoom & Device Viewport Emulation
- **Device Presets:** Verified Desktop (fluid 100%), Tablet (768px bounded frame), Mobile (375px bounded frame) presets in Microsoft Edge.
- **Canvas Zoom:** Verified non-destructive CSS transform scaling (`scale(zoomScale)`) with bounded steps: 50%, 75%, 100%, 125%, 150%, and Reset.
- **Sandbox Refresh:** Reload button re-mounts iframe sandbox with fresh session cryptographic nonce.

### Pillar 4.2: Multi-Artifact Carousel & Session Navigation
- **Deduplicated Extraction:** Collects all artifacts from conversation messages while preserving order.
- **Pagination Carousel:** Header displays `<` Prev, `Artifact X of N: Title`, `>` Next controls.
- **Smooth Switch:** Switching artifacts dynamically mounts the selected artifact without losing state.

### Pillar 4.3: Interactive Human-In-The-Loop (HITL) Tool Approvals
- **Timeline Card:** Rendered when `event.kind === 'approval'` or `status === 'waiting'`.
- **Authorization Buttons:** Accessible "Approve Execution" and "Reject" buttons connect directly to `handleApprovalDecision`.
- **Data Minimization:** No raw parameters or unverified inputs displayed.

### Pillar 4.4: Project Workspace Binding & Safe Export
- **Save to Project:** Allows binding active artifact to active project workspace.
- **Safe Export:** Preserves MIME sanitization and origin isolation.

---

## 3. Microsoft Edge Acceptance Evidence

- **Automated CDP Suite (`scripts/adaptive-phase4-browser-acceptance.mjs`)**:
  - `1600×1000` Desktop: **PASS** (Zero horizontal overflow; canvas zoom, device frame, carousel, HITL card verified).
  - `768×1024` Tablet: **PASS** (Zero horizontal overflow; overlay & controls accessible).
  - `390×844` Mobile: **PASS** (Zero horizontal overflow; drawer & controls accessible).
  - `320×700` Small Mobile: **PASS** (Zero horizontal overflow; drawer & controls accessible).
  - **Default-Disabled Baseline (`PHASE4_FLAG_OFF=true`)**: **PASS** (Port 4177: 100% legacy UI, 0 adaptive shell elements, 0 canvas controls, 0 carousel, 0 approval cards).

- **Automated Test Matrix**:
  - Phase 4 unit tests (`test/artifact-canvas-controls.test.ts`, `test/multi-artifact-navigation.test.ts`, `test/hitl-approval-card.test.tsx`): **PASS**.
  - Regression unit & lifecycle suites: **35/35 PASS**.
  - TypeScript client typecheck (`npm run typecheck:client`): **PASS**.
  - Linter (`npm run lint`): **exit 0**.
  - Default-off production build (`npm run build`): **PASS**.
  - Flag-enabled production build (`VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build`): **PASS**.

---

## 4. Open Release Prerequisites

1. Live remote multi-agent durable execution and backend tool sandboxes remain pending PR #127 / PR #137 activation.
2. Production database migrations and live multi-account isolation testing remain pending staging database access.
3. Formal owner GO LIVE authorization required before merging to `prod-release` or enabling preview flag in production.
