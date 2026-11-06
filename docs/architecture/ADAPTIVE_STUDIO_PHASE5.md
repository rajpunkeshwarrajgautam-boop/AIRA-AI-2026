# Adaptive Studio Phase 5 — execution checkpoint

Status: **Milestone 5.1 implementation candidate**, not a Phase 5 certification or production release.

## Source of truth and isolation

- Base is certified Phase 6 draft PR #138, GitHub head `c3e911f8c6895949f658c49c716d2768833f8a01` (verified via GitHub; the earlier pasted full SHA differed).
- Working branch is `design/adaptive-studio-phase5`, separate from Phase 6's draft branch, PR #127, PR #137, `prod-release`, and production workers.
- The original `src/utils/artifactParser.ts` remains the authority for AIRA's tagged artifact envelopes; `src/utils/aiEngine.ts` continues to own its existing SSE stream lifecycle and auth-epoch checks.
- Experimental coalescing and fenced-code previews activate only when the UI passes `VITE_ADAPTIVE_STUDIO_PREVIEW=true` through the optional stream argument. Existing streaming behavior remains the default.

## Milestone 5.1 candidate

1. Fixed partial `<airaArtifact>` and `</airaArtifact>` token boundaries alongside the existing `<antArtifact>` handling.
2. Added a bounded reconciler: first update is immediate, subsequent rapid snapshots are coalesced within approximately 150 ms, completed versions are emitted immediately, and cancellation discards pending work.
3. Added recognition of explicitly previewable markdown fences (`html`, `svg`, `jsx`, `tsx`, `react`, `mermaid`) in already-cleaned message text without removing the original code block from the conversation.
4. Connected coalescing to the existing tagged-artifact and SSE `artifact_open` / `artifact_delta` / `artifact_close` paths in opt-in Adaptive Studio only.
5. Suppressed sandbox iframe execution against incomplete code in opt-in mode; the user can inspect incoming source in the Code tab, and the real nonce-validated iframe mounts after the artifact has a completed version.

## Local checks

- Artifact parser/sandbox and new milestone tests: 16/16 PASS.
- Auth session transition, revocation, and SSE identity isolation: 10/10 PASS.
- TypeScript client and full typecheck: PASS.
- Lint: exit 0, with existing warnings.
- Production-style build with preview flag unset: PASS (existing large-chunk advisory).

This branch has **not** completed Windows Microsoft Edge CDP acceptance for the new streaming runtime. A pass on these unit/build checks must not be represented as a Phase 5 PASS.

## Follow-on milestones

- **5.2 Agent events:** map the actual `tool_started`, `tool_completed`, and `workflow_step_*` SSE payloads into an accessible conversation timeline; never invent unverified `agent:*` events or display private chain-of-thought.
- **5.3 Error relay:** extend the existing iframe source+nonce validation; sanitize error payloads, bound log sizes, and make repair an explicit user action.
- **5.4 Version diff:** preserve immutable artifact versions, provide a code diff view, and avoid destructive rollback of conversation history.
- **5.5 Certification:** run exact-SHA Edge/browser checks and security regression suites in a separate Windows worktree before calling Phase 5 complete.

## Acceptance and release cautions

- Validate both flag modes. Default-off **behavior** must remain equivalent; source or bundle hashes cannot be expected to remain byte-identical after code changes.
- Ensure cancelled/revoked sessions cannot emit delayed artifact updates.
- Ensure generated executable content remains in `sandbox="allow-scripts allow-modals allow-forms"` without `allow-same-origin`.
- Keep any Phase 5 PR in **DRAFT**; no merges, live feature-flag changes, Neon migrations, or worker activation without the repository's exact-SHA release authorization.
