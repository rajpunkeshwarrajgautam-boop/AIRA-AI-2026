# AIRA AI 2026 — Security Hardening Status

**Assessment date:** 2026-10-29
**Status:** **PARTIAL IMPLEMENTATION — NOT CERTIFIED / DO NOT ACTIVATE**
**Production state:** Inactive. No production/permanent-staging credentials, migrations, deployments, worker activation, OCI mutation, or traffic changes were performed.

## Executive summary

Local implementation now includes the earlier PostgreSQL approval CAS/grant and `ALLOW_ONCE` controls, durable-worker owner/workspace and role allowlists, plus a transactional approval-resumption outbox (migration `028_approval_resumption_outbox.ts`). The decision, optional grant/once authorization, and resumption intent commit in one PostgreSQL transaction. A startup recovery drain and API polling consumer claim pending intents with leases/fencing; the persisted run/workflow checkpoint is the crash-recovery source. The outbox never reclaims a dispatched-unknown action.

This remains **uncertified**. No disposable PostgreSQL service was available locally, so migration 028 and PostgreSQL lock/transaction/outbox integration tests are prepared for the existing isolated CI workflow but were not executed. Production remains inactive and the activation checklist remains HOLD.

## Implemented locally

### Approval resolution, grants, and once-only authorization

- `PostgresApprovalRepository.saveRequest` persists the run/tool-call/approval records transactionally and refuses mismatched persisted identity.
- `resolvePendingRequest` locks and compare-and-sets the pending decision; owner validation, grant-risk scope validation, and grant writes are in the same transaction. Identical retries report `applied: false`; conflicting decisions fail.
- Reusable grants use deterministic IDs, workspace boundaries, and risk ceilings. Legacy grants default to `READ`; workspace-less rows fail closed.
- `ALLOW_ONCE` binds the decision to owner, workspace, run, call ID, tool ID/name, permission, tool-definition version, policy fingerprint, and canonical arguments. A fenced claim is checked again before dispatch; terminal/cancelled runs cannot claim or dispatch. Adapter retries remain disabled for one-time actions.
- A crash after one-time dispatch remains unknown and is never converted back to available. Destructive/external-side-effect tool recovery remains fail-closed when its outcome is unknown.

### Transactional approval-resumption outbox

- Migration `028_approval_resumption_outbox.ts` creates a unique approval-to-intent record. It backfills only previously resolved approvals whose exact request remains pending on a nonterminal run/workflow.
- Decision/grant/once-token and outbox insertion are atomic. Generic run and workflow targets are validated against owner, workspace, exact pending approval, and workflow step.
- Outbox state model:
  - `APPROVED_UNCLAIMED`: committed decision has a durable resumption intent.
  - `CLAIMED_NOT_DISPATCHED`: leased claim; monotonically increasing fencing token prevents stale workers from applying it.
  - `DISPATCHED_UNKNOWN`: run/workflow continuation checkpoint committed; this state is not automatically reclaimed, so unknown destructive work is not replayed.
  - `COMPLETED_WITH_RESULT`: delivery/result reference is persisted.
  - `CANCELLED_REVOKED`: target became terminal, stale, cancelled, or identity-mismatched; no dispatch.
  - `RECOVERABLY_FAILED`: pre-dispatch delivery error and backoff are persisted; polling can retry it.
- Applying an intent and transitioning the run/workflow checkpoint is transactional. For a crash after checkpoint commit but before execution starts, startup `recoverInterruptedRuns` resumes from the persisted checkpoint. Run recovery leases are heartbeated while execution is active.
- `AgentRuntime` drains the outbox after approval decisions and at startup; the API polls every five seconds. Repeated decisions do not create a second intent, and a dispatched/terminal intent is not terminally dispatched again.
- Delivery failure details remain in `last_error`/`result` on the outbox row and are logged. `DISPATCHED_UNKNOWN` remains visible for operator reconciliation and is not silently retried.

### Durable execution and workspace boundaries

- Durable mission submission requires an authenticated principal with an assigned workspace, rejects a body-supplied workspace mismatch, and checks reuse of an existing parent run against principal and workspace.
- Mission reads check every task in the aggregate against both principal and workspace; task listings are workspace-filtered.
- A server-owned role/tool allowlist constrains durable work (`analyst` may request `calculator`; current other roles have no tool scopes). The API validates submitted scopes, the worker revalidates them, and ToolGateway enforces them before adapter execution.
- Worker context uses a task-scoped session label. The worker checks task owner/workspace against the parent run before specialist dispatch.
- Durable task persistence is insert-only for PostgreSQL submission and rejects changed immutable identity/policy under an existing ID.
- Generic run cancellation clears run-scoped grants; decision/resumption handlers check cancellation and stale identity before dispatch.

## Verification performed locally

| Check | Result |
|---|---|
| `npm run typecheck -- --pretty false` | Passed after the outbox, migration, API, and test changes |
| `git diff --check` | Passed |
| Focused combined approval/durable-worker/M2-A command | **63 passed, 0 failed, 1 skipped**; PostgreSQL suite skipped because isolated-CI guard variables are absent |
| Stage 1.1 fail-closed ToolGateway tests (`test/tool-gateway-approval-fail-closed.test.ts`) | **21 passed, 0 failed** |
| Stage 1.2A lifecycle tests (`test/approval-lifecycle-stage-1-2a.test.ts`) | **16 passed, 0 failed** |
| Stage 1.2B/C local atomicity/once unit tests (`approval-atomic-resolution`, `approval-once-consumption`) | **5 passed, 0 failed**; these do not replace PostgreSQL integration |
| Durable-worker authorization (`test/durable-worker-authorization.test.ts`) | **4 passed, 0 failed** |
| M2-A durable specialist execution (`test/m2a-durable-specialist-execution.test.ts`) | **17 passed, 0 failed** |
| Targeted Oxlint over touched approval/runtime/API/migration/tests | 0 errors, 9 pre-existing unused-symbol warnings; the new migration/outbox tests emitted no warnings. Not warning-free. |
| Migration 028 / PostgreSQL race, rollback, once-claim, outbox takeover and workflow resumption tests | **Not run**; source is added to `.github/workflows/postgres-certification.yml` and statically typechecked |
| ToolGateway PostgreSQL certification / full workflow integration | Not run locally; requires explicitly disposable PostgreSQL |
| Neon/staging activation, TLS, staging-worker suites | Not run; they access protected external resources and were not authorized |
| OCI M2-A.4 read-only inspection | Not run; local OCI CLI/config absent |

The local unit tests do not substitute for PostgreSQL isolation, actual migration execution, concurrency scheduling, crash/restart, or live worker evidence.

## Remaining blockers and residual risks

1. **Isolated PostgreSQL CI evidence:** The new migration and integration suite must pass in the run-scoped disposable PostgreSQL job. Do not run against Neon, production, permanent staging, localhost, or any unverified database.
2. **Uncertain external outcomes:** `DISPATCHED_UNKNOWN` and one-time `DISPATCHED` outcomes require operator reconciliation. The implementation intentionally does not auto-replay these actions. The integration tests are written but have not yet demonstrated this behavior against PostgreSQL.
3. **Integration and adversarial evidence:** Real PostgreSQL cancellation races, multiple API workers, lost acknowledgments, failure observability, and lease-heartbeat behavior still require the isolated CI run and review. No passing PG evidence is claimed.
4. **M2-A.4 OCI inspection:** Read-only inventory remains blocked; no capacity report was created and no OCI write or mutation was attempted.
5. **M2-A.5 activation:** All activation gates remain pending. This work does not authorize or perform activation.

## Repository and publication handling

- Candidate is on `arena/0f72d2ce-aira-ai-2026`, based on remote head `389b049bcaa436017d8ca0eac14c885e87019620`; the working diff is reviewed and validated locally. The user authorized one logical commit and one non-force push, followed by the existing isolated PostgreSQL CI certification. CI evidence is still pending at the time of this status report.
- The supplied prior commit objects `b9de7037089b3d37343669dc3f61fa4ad29df421` and `a951ce21fbc8fa1a660c7f4e67a6677d44ae9145` were not present in this checkout's object database. No historical commit was reset, amended, or rewritten; their working-tree implementation is included in the reviewed candidate diff.
- PR #117 is OPEN/DRAFT on `389b049bcaa436017d8ca0eac14c885e87019620`; it must remain DRAFT. PR #115 remains frozen at `56064639ea2bf691cd7476b42d734864a32d595e`.
- Production remains inactive. Local implementation and a passing CI job are not certification or approval to deploy/activate.
