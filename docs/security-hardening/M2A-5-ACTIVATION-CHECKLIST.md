# M2-A.5 — Production Activation Checklist

**Disposition: HOLD — NO-GO / NOT AUTHORIZED / NOT CERTIFIED.** Production activation remains disabled. This checklist does not authorize a migration, deployment, staging run, OCI operation, worker startup, or production activation.

**Candidate under preparation:** local uncommitted worktree based on `25f06f83a38b771dfaca615ba952c50286bf1901`. It is not yet an immutable/published candidate SHA.

## Current local preparation (not remote certification)

- [x] Verified current branch `arena/0f72d2ce-aira-ai-2026`, `HEAD` `25f06f83a38b771dfaca615ba952c50286bf1901`; no commit or push made.
- [x] Read-only GitHub verification: PR #117 remains OPEN/DRAFT; frozen PR #115 remains OPEN/DRAFT at `56064639ea2bf691cd7476b42d734864a32d595e` and was not edited.
- [x] Migration 030 and its `down` guard are present. Migration 030 is additive; its `down` refuses without test mode, matching disposable URLs, and the connected-server/network preflight.
- [x] Deterministic workspace/approval/durable-worker/activation tests are registered in Fast CI; the suites pass locally without a DB connection.
- [x] Disposable PostgreSQL workflow contains identity/network preflight and the certification suites listed below. It has not run on the current worktree.
- [x] Locally available verification: TypeScript typecheck, production build, lint (0 errors; 293 repository warnings), workflow YAML syntax parsing, diff checks, targeted 129 deterministic tests (0 failed/0 skipped), fail-closed invocation checks, and tracked-file secret scan passed.
- [x] No staging/production credentials were used, retrieved, or passed to tests. No database was connected to, migrated, or mutated; no deployment/resource/worker action occurred.

## PostgreSQL certification suites registered

The dedicated `PostgreSQL 16 isolated regression certification` job runs these in one fail-on-error job against a per-run PostgreSQL 16 container:

1. Network-address policy tests; preflight verifies run-scoped role/database, exact generated URL, DNS/server endpoint addresses, PostgreSQL major version, private Docker network, and live `inet_server_addr()` before migrations.
2. `npm run db:migrate`, including migrations through 030; then a second connected-target identity preflight. The guarded `npm run test:tool-calls-drift`, `npx tsx test/run-prompt-schema-drift.ts`, and `npm run test:recovery` steps also run here; each requires certification mode and performs a live identity/network preflight. Recovery's whole-runs-table cleanup and both temporary-schema tests were removed from ordinary service-PostgreSQL CI.
3. `npm run test:workflow` (workflow engine and workflow approval authority).
4. `npm run test:tools` with explicit PostgreSQL workspace-authority enforcement; its DB-writing certification was moved out of ordinary service-PostgreSQL CI and performs its own preflight.
5. `test/tool-gateway-approval-fail-closed.test.ts` (Stage 1.1 gateway denial).
6. `test/approval-lifecycle-stage-1-2a.test.ts` (Stage 1.2A lifecycle).
7. `test/approval-atomic-resolution.test.ts` (Stage 1.2B/C atomic decisions).
8. `test/approval-once-consumption.test.ts` (Stage 1.2B/C ALLOW_ONCE consumption).
9. `test/durable-worker-authorization.test.ts` (owner/workspace/allowlist/revocation regressions).
10. `test/m2a-production-activation-security.test.ts` and `test/m2a-durable-specialist-execution.test.ts` (offline activation policy and deterministic durable lifecycle).
11. `test/m2a-real-postgres-verification.test.ts` (real PostgreSQL workers, workspace binding, concurrent claims, leases, fencing, process recovery, idempotency, and cross-tenant recovery); its entrypoint refuses missing certification mode and runs the live preflight.
12. `test/approval-resumption-outbox-postgres.test.ts` (migration-030 constraints, first-login concurrency, revocation tombstones, cross-principal checks, legacy run/task rejection, approval CAS/grants, ALLOW_ONCE, transactional outbox, crash recovery, lease takeover/fencing, and workflow resumption); its entrypoint now refuses missing certification mode, validates the run-scoped DB contract, and reruns live identity/network preflight rather than silently skipping.
13. `npm run test:integration` (guarded full API/SSE/approval replay integration; includes destructive schema reset paths, spoofed workspace/project, wrong-run/foreign-owner denial, rejection, and revocation cases); the entrypoint performs preflight before its first destructive SQL; path B independently preflights.
14. Final connected-server identity preflight after destructive integration.

The job has no production, staging, Neon, GitHub, or Vercel secrets. Its PostgreSQL data directory is tmpfs only, the Docker network is internal and exclusive to the test runner/database, no host database ports are published, run-scoped credentials are created with restrictive file permissions and removed, and cleanup only removes resources bearing this run's unique owner/name/role labels. Preflight and postflight failures fail the job. This workflow has **not** executed against the current candidate; registration is not certification.

## Remaining blockers and exact acceptance evidence

### 1. Local code/test defects

**Status: no known remaining local code defect after the targeted guard/legacy-fixture corrections; PostgreSQL behavior remains unverified.**

- [ ] Typecheck, build, lint, deterministic suite, diff check, secret scan, and YAML parse are rerun on the final worktree after all edits.
- [ ] The approval/outbox suite is confirmed non-skipping: missing `AIRA_POSTGRES_CERTIFICATION`, disposable URL contract, or live endpoint preflight must fail before its SQL/tests.
- [ ] Review the exact disposable PostgreSQL logs on the published candidate; an in-memory pass is not a substitute.

### 2. GitHub configuration — owner authorization required

The active `AIRA Production Protection` ruleset targets `refs/heads/prod-release` and currently requires `Fast CI`, `Semantic Search CI`, and `Main / PR certification`, with strict up-to-date checks. It does not require PostgreSQL certification.

- [ ] Owner separately authorizes the ruleset update. Do not alter branch protection/rulesets without that authorization.
- [ ] Add this exact required status object, retaining the existing entries and strict policy:

```json
{
  "context": "PostgreSQL 16 isolated regression certification",
  "integration_id": 15368
}
```

A missing check must remain pending; a failure must block; strict checks must require the latest base. The workflow has no path filter, its PR trigger includes `prod-release`, the certification job is unconditional, and critical PostgreSQL suites fail closed rather than silently skip. Owner must verify the resulting ruleset through a fresh read-only ruleset inspection after the authorized change. A required context alone is insufficient if a future workflow edit conditionally skips the job; keep the job unconditional and preserve fail-closed test entrypoints.

### 3. CI certification — publication required

- [ ] Obtain separate authorization for one controlled publication/CI attempt; do not publish from this checklist.
- [ ] Run all required checks on the exact immutable candidate SHA, including `PostgreSQL 16 isolated regression certification`; all must conclude success, with no mandatory job/step skipped or absent.
- [ ] Confirm in logs that migration 030 and each PostgreSQL subtest ran, identity checks bracketed DB use, integration completed, and labeled containers/network/tempfiles were removed on both success and failure. Capture run URL, head SHA, job conclusion, and relevant non-secret evidence.
- [ ] Resolve the currently surfaced PR #117 Main / PR certification failure on the new candidate. The published run at `25f06f83a38b771dfaca615ba952c50286bf1901` failed; its older PostgreSQL success does not certify this worktree.

### 4. Staging acceptance — separately authorized environment

- [ ] Obtain separate authorization before using any staging credential, database, deployment, or worker.
- [ ] Run the deployed staging acceptance workflow against the explicitly verified permanent staging target; record exact deployment SHA, database project/endpoint identity (redacted/non-secret evidence only), test summary, logs, and cleanup. The surfaced checks on PR #115/#117 were skipped; no staging acceptance is currently evidenced.
- [ ] Confirm staging worker activation/replica state and complete acceptance without modifying PR #115. No staging access was performed in this assessment.

### 5. OCI infrastructure — current capacity evidence required

- [ ] Obtain authorized read-only OCI access/profile, then record inspection time, tenancy, compartment, region, VM/shape/AD, subnet and NSG/security-list attachment, ingress/egress, quotas/reservations, current regional capacity, and worker state.
- [ ] Confirm capacity and cost from current OCI evidence, not historical notes. No create/update/delete/scale/capacity reservation request is authorized by this checklist. OCI CLI/config were unavailable; current infrastructure state is UNKNOWN.

### 6. Production readiness and activation — explicit release authorization required

- [ ] Verify production versus staging/preview database identity and TLS through authorized read-only evidence without exposing secret values; migration 030 application to production remains separately authorized.
- [ ] Verify production worker activation flag remains disabled and production worker replica count is zero; capture evidence and keep it that way until every gate above passes.
- [ ] Name monitoring, alerting, audit, incident response, worker shutdown, migration/rollback, and canary owners; attach a separately reviewed rollback plan.
- [ ] Record explicit owner authorization tied to the exact candidate SHA, production environment, migration, deployment, and worker activation. Activation remains a distinct later operation, not part of CI certification.

## PR order and disposition

PR #115's frozen head is an ancestor of PR #117's current published head. Keep PR #115 unchanged and both PRs OPEN/DRAFT. If integration is later authorized, integrate #115 first, preserve ancestry, refresh #117 against the new base, and rerun all gates before considering either promotion.

**No gate in this checklist currently certifies production GO. Keep the worker disabled.**
