# Personal Workspace Authority Lifecycle

## Trust boundary

A workspace ID is an identifier, not a credential. `derivePersonalWorkspaceId(principalId)` only produces a stable candidate ID. Authorization requires a PostgreSQL row in `principal_workspace_authorities` whose `principal_id` and `workspace_id` both match, whose `state` is `ACTIVE`, and whose `revoked_at` is null. Production/DB-backed principal resolution, run creation, run execution/recovery entry, approval persistence/resolution, reusable grant checks, ToolGateway dispatch, and durable-worker recovery use this live record. Database errors fail closed.

The principal ID must first come from an authenticated server context (verified managed identity/JWT, verified BFF session, or the explicitly test-only local identity path). The workspace repository does not authenticate a client-provided ID. Client workspace headers and body fields are ignored. Client project IDs are also ignored for run authorization because no persisted project-membership relation exists.

## Provisioning and legacy accounts

Migration `030_principal_workspace_authority` intentionally creates an empty authority table. It does not derive authority from old `runs.workspace_id`, tool calls, tasks, project IDs, or client values. On the first request after successful server-side authentication, `PostgresWorkspaceAuthorityRepository.resolveWorkspace` inserts the principal's deterministic personal workspace with `ON CONFLICT (principal_id) DO NOTHING`, then re-reads and validates the row. Existing user accounts therefore receive a workspace lazily on their next authenticated request; they do not need to sign up again or select a workspace.

The primary key on `principal_id` serializes simultaneous first-login requests, and the unique constraint on `workspace_id` prevents one workspace from being assigned to two principals. A collision or incompatible existing row fails closed. Revocation uses a single PostgreSQL upsert and leaves a `REVOKED` tombstone even if it races first provisioning or precedes first login.

Legacy runs and durable tasks are deliberately not backfilled. Their historical workspace fields may have been client-selected and cannot prove membership. A run/task whose persisted workspace does not match an active authority row cannot be approved or recovered by a worker. The owner can create a new run after authenticated provisioning; old tasks fail closed rather than receiving an invented workspace. Existing reusable grants remain unusable unless their owner, workspace, run, and active authority all match.

## Revocation semantics

Revocation changes the authority row to `REVOKED` and stamps `revoked_at`; it is not a session logout. Subsequent authentication resolution fails. Run creation rechecks the live authority. Approval submission, decision persistence, reusable grant creation/lookup, protected ToolGateway dispatch, and worker identity recovery also recheck it. Pending approval work therefore cannot resume after revocation, and the one-time grant remains consumed/uncertain if revocation races the dispatch boundary. A running specialist is checked at recovery and again immediately before specialist dispatch; its result is revalidated before being persisted, and its ToolGateway calls are independently checked. Revocation during a specialist therefore prevents a stale result from being committed, though external side effects already completed before revocation cannot be undone. A model-only run already inside an external model request may finish that request, but re-entry and protected dispatch are denied; this mechanism does not retroactively erase prior output.

## Migration and rollback

Migration 030 is discovered through the existing numeric migration directory (`packages/db/src/migrations`) and is ordered after 029. It adds a principal primary key, globally unique workspace ID, active/revoked state constraints, revocation timestamp consistency, and a workspace/state lookup index. It has no FK to `users`: trusted guest/session principals are supported even when no application `users` row exists.

`down` drops the entire authority table. That erases workspace bindings and revocation tombstones. Rolling back while serving traffic is unsafe: the next authenticated request could provision a new active row for an identity whose revocation was erased. The migration refuses to run `down` unless `NODE_ENV=test`, the explicit disposable marker and matching isolated URL are present, and the live PostgreSQL/Docker-network preflight succeeds. This destructive rollback is for a verified disposable database only. Any production recovery must use a separately reviewed and authorized recovery procedure, with a protected backup and affected application/worker traffic stopped; do not use this down migration as routine production rollback.
