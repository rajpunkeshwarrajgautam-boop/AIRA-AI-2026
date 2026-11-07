# Adaptive Studio Phase 3 — Architecture Specification & Execution Checkpoint

Status: **Milestones 3.1–3.7 verified; Microsoft Edge browser acceptance PASS; Live backend execution gates deferred.**

## 1. Executive Summary & Context

Phase 7 delivered the standalone prototype and visual truth on port `4173`.  
Phase 6 delivered the opt-in presentation shell bridge on port `4174` (PR #138).  
Phase 5 delivered the streaming artifact parser, agent timeline event mapping, and revision diff view (PR #139).  
Phase 4 delivered interactive canvas zoom, device frame presets, multi-artifact carousel, and HITL timeline approval cards (PR #140).

**Phase 3 establishes the Multi-Agent Orchestration & Execution Graph**, delivering full execution observability for AIRA's multi-agent autonomous system directly within the Adaptive Studio right-column pane.

```
+---------------------------------------------------------------------------------------------------------+
|                                           TOPBAR (AIRA SHELL)                                           |
|  [Logo: Sheared Portal]   Project Title   [Mode: Chat / Agent]   Model: Auto   Theme   User             |
+-------------------------------------------------------+-------------------------------------------------+
|  LEFT NAVIGATION     |  CONVERSATION TIMELINE         |  ADAPTIVE ARTIFACT STUDIO (46% DOCK)            |
|  - Recent Chats      |  - User Messages               |  - Studio Tabs: [Preview] [Code] [Diff] [Graph] |
|  - Projects          |  - Assistant Messages          |  - Graph Header: [DAG Canvas] [Timeline List]   |
|  - Sandboxes         |  - Streaming Event Telemetry   |  - Parallel Waves: Wave 1 -> Wave 2 -> Wave 3   |
|                      |  - [HITL Approval Cards]       |  - Nodes: Role, Status, Tool Telemetry, Time    |
|                      |                                |  - [Artifact Sync]: Linked Artifact Pill        |
|                      |  [Composer: Chat/Agent toggle] |  - [Inspector Drawer]: Objective, Summary, Auth |
+-------------------------------------------------------+-------------------------------------------------+
```

---

## 2. Implemented & Verified Capabilities

### Pillar 3.1: Interactive Agent Execution Graph (DAG)
- **Topological Wave Layout:** Implemented deterministic wave calculation using Kahn's algorithm ([`src/utils/executionGraphEngine.ts`](file:///D:/AIRA-PHASE3-WORKTREE/src/utils/executionGraphEngine.ts)), grouping independent concurrent tasks into parallel execution levels.
- **Dynamic Bézier SVG Paths:** Smooth cubic Bézier connection paths (`M x1 y1 C cx1 y1, cx2 y2, x2 y2`) with animated pulse dashing when tasks are actively transferring intermediate state.
- **Node Anatomy:** Specialist role badge (9 canonical roles: `planner`, `researcher`, `coder`, `analyst`, `document`, `browser`, `automation`, `verifier`, `synthesizer`), step name & identifier, status badge, live duration counter, and active tool telemetry.

### Pillar 3.2: Real Backend SSE Event Ingestion & State Machine
- **Authentic Event Contracts:** Strictly derives node state from AIRA's existing contracts (`workflow.created`, `workflow_started`, `workflow.step.started`, `workflow_step_progress`, `tool_started`, `tool_completed`, `approval.required`, `approval.resolved`, `workflow.step.completed`, `workflow.step.failed`, `artifact.created`, `run_cancelled`, `workflow.completed`).
- **Zero Hallucinated Events:** Does not invent unsupported events; maps cleanly to the backend's existing SSE dispatcher.

### Pillar 3.3: Execution Observability & Sensitive Data Sanitization
- **Safe Telemetry:** Exposes only user-visible plan names, specialist roles, execution timings, active tool names, and safe output summaries.
- **Strict Sanitization:** Automatically redacts API keys, passwords, bearer tokens, and private chain-of-thought blocks (`sanitizeUserFacingText`).

### Pillar 3.4: Artifact Synchronization & Direct Navigation
- **Bidirectional Correlation:** When a task produces an artifact (`associatedArtifactId`), the node displays an "Artifact Linked" pill.
- **Direct Navigation:** Clicking the artifact pill or "Open Artifact in Studio" from the Node Inspector immediately opens `ArtifactStudio` in Preview mode with the corresponding artifact mounted.
- **Studio Tab Integration:** `ArtifactStudio` includes a dedicated `Graph` tab allowing users to switch freely between inspecting generated artifacts and observing the multi-agent graph that produced them.

### Pillar 3.5: Human Oversight & HITL Tool Approvals
- **Identity-Bound Approvals:** In-graph approval cards allow approving or rejecting guarded operations.
- **Security Boundaries:** Reuses authenticated API routes (`/api/runs/:id/approve`), prevents double-submission, and preserves CSRF proof and principal boundaries.

### Pillar 3.6: Recovery, Out-of-Order & Cancellation Resilience
- **Idempotent Latching:** Out-of-order events (e.g. `workflow_step_completed` arriving before `workflow_step_started`) synthesize state safely; late progress events cannot reopen completed nodes.
- **Failure & Retry Policies:** Respects `attempt` and `maxAttempts`. Retryable errors transition node to `RETRY_WAIT`, while fatal failures transition downstream dependents to `BLOCKED`.
- **Cancellation Propagation:** Run cancellation cascades cleanly, setting all running, queued, or blocked nodes to `CANCELLED`.

### Pillar 3.7: Responsive Design & Dual Presentation
- **Desktop (1600×1000):** Full visual DAG canvas with SVG connector overlay.
- **Tablet (768×1024):** Scaled responsive graph with zero horizontal scroll overflow.
- **Mobile (390×844 & 320×700):** Accessible Execution Timeline List grouping tasks sequentially by wave with zero horizontal overflow.

---

## 3. Microsoft Edge Acceptance Evidence

The browser acceptance script ([`scripts/adaptive-phase3-browser-acceptance.mjs`](file:///D:/AIRA-PHASE3-WORKTREE/scripts/adaptive-phase3-browser-acceptance.mjs)) was executed using Microsoft Edge against local Vite development servers on ports 4182 and 4183.

### 3.1 Viewport Verification Matrix

| Viewport | Dimensions | Horizontal Overflow | Key Validations | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **Desktop** | 1600 × 1000 | None (`false`) | Multi-wave DAG, SVG connectors, node inspector, artifact sync navigation, studio "Graph" tab, timeline toggle, in-graph HITL approval | **PASS** |
| **Tablet** | 768 × 1024 | None (`false`) | Responsive layout, node inspection, zero horizontal scroll | **PASS** |
| **Mobile** | 390 × 844 | None (`false`) | Full timeline execution list, accessible controls, zero clipping | **PASS** |
| **Small Mobile** | 320 × 700 | None (`false`) | Compact mobile execution cards, zero horizontal scroll | **PASS** |
| **Default-Off Baseline** | 1600 × 1000 | None (`false`) | Port 4183: 100% legacy UI, 0 adaptive elements, 0 execution graph leakage | **PASS** |

### 3.2 Automated Test Matrix

- **Phase 3 Unit Tests (`test/execution-graph-engine.test.ts`):** **9/9 PASS** (161ms).
- **Phase 3 Component Tests (`test/execution-graph-component.test.tsx`):** **4/4 PASS** (122ms).
- **Full Suite Regression Matrix:** **19/19 PASS** (540ms) across all Phase 3, Phase 4, Phase 5, and Auth lifecycle tests.
- **TypeScript Client Typecheck (`npm run typecheck:client`):** **PASS** (0 errors).
- **Linter (`npm run lint`):** **exit code 0** (0 errors).
- **Default-Off Production Build (`npm run build`):** **PASS** (1.26s).
- **Flag-Enabled Production Build (`VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build`):** **PASS** (1.22s).
- **Git Diff Hygiene (`git diff --check`):** **PASS** (0 whitespace/formatting warnings).

---

## 4. Visual Evidence Artifacts

All screenshots captured from Microsoft Edge:
- Desktop DAG View: `phase3-edge-desktop-1600x1000-dag.png`
- Desktop Node Inspector: `phase3-edge-desktop-1600x1000-node-inspector.png`
- Artifact Synchronization in Studio: `phase3-edge-desktop-1600x1000-artifact-sync.png`
- Studio Header "Graph" Tab: `phase3-edge-desktop-1600x1000-studio-graph-tab.png`
- Desktop Execution Timeline Mode: `phase3-edge-desktop-1600x1000-timeline.png`
- Tablet Viewport (768×1024): `phase3-edge-tablet-768x1024.png`
- Mobile Viewport (390×844): `phase3-edge-mobile-390x844.png`
- Small Mobile Viewport (320×700): `phase3-edge-small-mobile-320x700.png`
- Default-Off Baseline Verification: `phase3-edge-default-off-baseline.png`
