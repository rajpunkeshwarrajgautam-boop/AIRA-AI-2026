# Adaptive Studio Phase 5 — execution checkpoint

Status: **Milestones 5.1–5.4 verified; Windows Edge acceptance passed; Live execution gates remain open.**

## Source of truth and isolation

- Base is certified Phase 6 draft PR #138, commit `c3e911f`.
- Working branch is `design/adaptive-studio-phase5`, separate from Phase 6's draft branch, PR #127, PR #137, `prod-release`, and production workers.
- Certified Candidate Commit: `236b487` (base PR #139: `2b50c5f`).
- The original `src/utils/artifactParser.ts` remains the authority for AIRA's tagged artifact envelopes; `src/utils/aiEngine.ts` continues to own its existing SSE stream lifecycle and auth-epoch checks.
- Experimental coalescing and fenced-code previews activate only when the UI passes `VITE_ADAPTIVE_STUDIO_PREVIEW=true` through the optional stream argument. Existing streaming behavior remains the default.

## Milestone 5.1 candidate — Artifact streaming & cancellation

1. Fixed partial `<airaArtifact>` and `</airaArtifact>` token boundaries alongside the existing `<antArtifact>` handling.
2. Added a bounded reconciler: first update is immediate, subsequent rapid snapshots are coalesced within approximately 150 ms, completed versions are emitted immediately, and cancellation discards pending work.
3. Added recognition of explicitly previewable markdown fences (`html`, `svg`, `jsx`, `tsx`, `react`, `mermaid`) in already-cleaned message text without removing the original code block from the conversation.
4. Connected coalescing to the existing tagged-artifact and SSE `artifact_open` / `artifact_delta` / `artifact_close` paths in opt-in Adaptive Studio only.
5. Suppressed sandbox iframe execution against incomplete code in opt-in mode; the user can inspect incoming source in the Code tab, and the real nonce-validated iframe mounts after the artifact has a completed version.

## Milestone 5.2 candidate — Verified agent lifecycle events

- `src/utils/agentTimeline.ts` maps only events emitted by the current backend SSE endpoint: `run_started`, `workflow_started`, `workflow_step_started/progress/completed/failed`, `workflow_completed`, `tool_started/completed`, and `approval_required`.
- Public UI metadata is limited to status and sanitized tool/step labels. No raw tool arguments, outputs, speculative subagent events, or hidden chain-of-thought are collected.
- Repeated step updates merge into a bounded 80-entry timeline. The conversation component renders an accessible collapsible section only when the preview flag is enabled.

## Milestone 5.3 candidate — Sandbox runtime errors and repair drafts

- The existing sandbox emits `AIRA_ARTIFACT_RUNTIME_ERROR` for window exceptions and rejected promises, in addition to its console relay.
- The receiving `ArtifactStudio` requires the active iframe `event.source` and ephemeral nonce, then independently checks payload shape and length before display. A sandbox can report an error but its report is **not trusted proof** of the cause.
- The explicit **Repair with Aira Agent** action switches the composer into Agent mode and populates a **reviewable draft**. It never auto-sends, grants execution permission, or executes tools.
- The executable preview remains sandboxed without `allow-same-origin`. A forged host-window error event was rejected in browser acceptance.

## Milestone 5.4 candidate — Versions and code diff

- The same artifact identifier within the same user/conversation accrues non-destructive revisions on completed updates. Incomplete updates do not overwrite completed version records.
- The Diff tab provides bounded, line-based comparisons; very large source files show an explicit inline comparison limit instead of allocating quadratic memory.
- **Restore** writes a new revision whose content comes from a selected earlier snapshot. Existing revision entries remain intact. The in-memory revision cache has an entry cap and clears on principal change.
- Legacy `ArtifactStudio` continues to render its existing Preview/Code controls when the flag is off.

## Verified Acceptance Gates (Windows 11 Microsoft Edge)

- **Microsoft Edge CDP Suite (`scripts/adaptive-phase5-browser-acceptance.mjs`)**:
  - `1600×1000` Desktop: **PASS** (Zero horizontal overflow; timeline, diff, sandboxed error bridge, reviewable repair draft verified).
  - `768×1024` Tablet: **PASS** (Zero horizontal overflow; overlay & controls accessible).
  - `390×844` Mobile: **PASS** (Zero horizontal overflow; overlay & controls accessible).
  - `320×700` Small Mobile: **PASS** (Zero horizontal overflow; overlay & controls accessible).
  - **Mocked SSE Lifecycle**: **PASS** (`workflow_started`, `workflow_step_started`, `tool_started`, `tool_completed`, `workflow_step_completed`, `workflow_completed`, `content_delta` mapped; sensitive payload arguments and outputs suppressed from timeline).
  - **Default-off baseline (`PHASE5_FLAG_OFF=true`)**: **PASS** (Port 4186: legacy layout preserved, 0 adaptive elements, 0 timeline, 0 diff tab, 0 repair action).

- **Automated Test Matrix**:
  - Unit & Integration Suites (`test/streaming-artifact-parser.test.ts`, `test/agent-stream-visualization.test.tsx`, `test/artifact-revision-history.test.ts`, `test/artifact-runtime-error.test.ts`, `test/adaptive-studio-preview.test.tsx`, `test/artifact-studio-m1.test.ts`, `test/auth-identity-transition-lifecycle.test.ts`): **30/30 PASS**.
  - TypeScript client typecheck (`npm run typecheck:client`): **PASS**.
  - Linter (`npm run lint`): **exit 0**.
  - Default-off production build (`npm run build`): **PASS**.
  - Flag-enabled production build (`VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build`): **PASS**.

## Remaining Blockers for Full Production Runtime Certification

1. **Live Backend Durable Worker SSE Integration**: Local browser mocks verify client event decoding and data minimization, but live multi-agent execution requires durable worker infrastructure (PR #127 / PR #137) which remains unmerged and unactivated per strict isolation policy.
2. **Live Multi-User Cross-Account DB Switching**: In-memory identity transition and session revocation pass (10/10), but live database account switching (`test/auth-account-switching-isolation.test.ts`) is blocked because Staging/Production Neon DB credentials are intentionally not provisioned in this isolated design worktree.
3. **Release Governance**: Production deployment and merge require explicit human owner GO LIVE authorization and full security sign-off.
