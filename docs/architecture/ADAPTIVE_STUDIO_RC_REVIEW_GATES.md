# Adaptive Studio RC — Isolated Review-Gate Remediation

**Audit date:** 2026-11-07  
**Certified parent RC:** `967b34a6f3575658e3cf1b69c2f12943163b464c` (Draft PR #144)  
**Review branch:** `fix/adaptive-studio-rc-review-gates`  
**Scope:** Client safety/compatibility fixes and read-only certification only.

## Corrections made on the review branch

1. The graph approval handler no longer treats a rejected or unreachable server request as success. Both graph and modal approvals use `POST /api/runs/:id/approve` with the existing `{ requestId, decision }` contract, and local graph state advances only after an HTTP 2xx response. Concurrent local submissions share a guard.
2. The graph accepts the existing durable-run SSE dotted names (`workflow.step.*`, `tool.*`, `approval.*`, `run.*`) in addition to chat-stream underscore aliases. Actionable approval IDs come from server `requestId`/`id`; a missing ID is never fabricated.
3. Untrusted SVG previews render as inert `data:image/svg+xml` image resources instead of injecting markup into AIRA's own document. The original sanitizer remains defense in depth. Invalid control characters in artifact paths are rejected even at the string boundaries.
4. A per-session sandbox nonce is kept in React state and rotated on artifact/revision changes and reloads, avoiding ref mutation during render. The view no longer revokes object URLs it does not own.
5. Removed warning-producing unused imports and stabilized graph render dependencies. The Phase 1 browser acceptance script now supports explicit local browser/worktree/evidence-directory paths without changing its Windows defaults.

## Read-only evidence obtained

| Gate | Result | Scope/qualification |
| --- | --- | --- |
| Frontend + architecture tests | **74/74 PASS** | 15 local test files, including approval dispatch, original Adaptive Studio tests, and AIRA ONE architecture assertions. |
| Core routing/security regression | **70/70 PASS** | Node runner summary across curated CORS, specialist, capacity, routing, authorization and auth lifecycle files; internal assertion counts may differ. |
| Client + server TypeScript | **PASS** | `npm run typecheck` exit 0. |
| Default-off build | **PASS** | `npm run build` exit 0; existing bundle-size advisory remains. |
| Flag-enabled build | **PASS** | `VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build` exit 0. |
| Lint | **PASS, 0 errors** | `277` warnings on this branch, down from `283` on certified `prod-release` baseline. |
| Diff hygiene | **PASS** | `git diff --check` exit 0 before commit. |
| Browser acceptance of this patch | **NOT CERTIFIED HERE** | Linux Chromium cannot launch due restricted process socket (`Operation not permitted`); earlier Windows Edge evidence pertains to unpatched PR #144. Windows Edge rerun is required. |
| Live authenticated and worker acceptance | **NOT EXECUTED** | No database writes, migrations, worker activation, Cloudflare/Vercel deployment, or production cutover authorized. |

The reported original **57** Adaptive Studio runner tests are retained as the authoritative original-commit count. This review branch intentionally adds tests; do not conflate its aggregate count with PR #144's historical count.

## Real contract and staging blockers

- `GET /api/runs/:id/events` emits durable dotted SSE events; `POST /api/chat/stream` emits chat aliases. Approval writes target **`POST /api/runs/:id/approve`** and require an authenticated caller bound to the run/approval principal.
- `POST /api/approvals/:id/decision` and `POST /api/workspaces/:id/sync` remain **proposals**, not certified deployed endpoints. Local workspace synchronization alone does not prove remote tenant isolation.
- Existing staging Vercel host `staging.virexaaiventures.com` and Neon staging project `mute-frost-50372225` were inventoried read-only during preflight; the deployed staging commit did **not** match the coordinated RC, and required schema migrations 024–030 were not applied to the permanent staging main branch.
- PR #127 (runtime/schema), PR #137 (standby workers), authenticated two-principal isolation, and live SSE/cancellation/HITL acceptance remain **release-blocking**.
- This branch is for **human code review**, not a production release authorization. PR #144 and phase PRs #138–#143 must remain DRAFT; `prod-release` and production feature flags remain unchanged.

## Minimum next authorization

1. Approve an **isolated, disposable staging database branch** under the staging project, with a verified target ID, no production data writes, and a cleanup/retention decision, before applying any missing migrations there.
2. Approve an **isolated staging-only** runtime/worker environment for PR #127/#137 contract verification; do not deploy a production worker or enable the production preview flag.
3. Approve a **two-principal authenticated staging acceptance** against a deployment pinned to the eventual review-branch SHA, including 403 cross-tenant probes, HITL one-time approvals, SSE ordering, cancellation, sandbox origin, and explicit fail-closed behavior.
4. After all staging tests and a fresh Microsoft Edge browser suite pass, review exact-SHA CI, Vercel preview provenance, and the production cutover plan. A separate exact-SHA **GO LIVE** approval is still required before merging or deploying.
