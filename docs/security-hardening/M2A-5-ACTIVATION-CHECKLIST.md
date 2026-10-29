# M2-A.5 — Activation Checklist

**Current disposition: HOLD — NOT AUTHORIZED / NOT CERTIFIED.**
No production activation, deployment, worker startup, database migration, traffic change, or credential/environment change has occurred. Every item below must remain unchecked until the named evidence is reviewed and the owner separately authorizes any activation step.

## Required evidence gates

### Code, database, and recovery

- [ ] PostgreSQL migrations `027_atomic_approval_decisions.ts` and `028_approval_resumption_outbox.ts` pass `up` (and the approved rollback verification) against a newly created, explicitly disposable PostgreSQL database.
- [ ] Approval compare-and-set race tests pass with concurrent PostgreSQL transactions: same-decision retry, conflicting decisions, resolver mismatch, and rollback on grant-write failure.
- [ ] Grant-risk and workspace isolation tests pass against PostgreSQL, including legacy workspace-less grants failing closed.
- [ ] `ALLOW_ONCE` tests pass against PostgreSQL for exact owner/workspace/run/call/tool/argument/version/policy binding, concurrent claims, stale pre-dispatch fencing, cancelled runs, adapter timeout, and process restart after dispatch.
- [ ] Outbox tests pass against PostgreSQL for approved-unclaimed, claimed-not-dispatched, dispatched-unknown, completed-with-result, cancelled/revoked, recoverably-failed, concurrent claims, lease takeover, stale fencing, duplicate delivery, crash/restart, and workflow-step resumption.
- [ ] No destructive/external-side-effect action with unknown outcome is automatically replayed; terminal dispatch is not repeated; delivery failure is queryable and recoverable.
- [ ] Durable task owner/workspace and immutable task-ID checks pass against PostgreSQL, including concurrent task-ID collisions.
- [ ] Durable worker allowlists are reviewed by role, and a real worker test proves unauthorized tools never reach an adapter.

### Acceptance, CI, and adversarial review

- [ ] All M2-A acceptance suites pass using only approved disposable resources; no production or permanent-staging credential is used.
- [ ] CI runs the ToolGateway certification script and verifies OS-temp and database cleanup on both success and test failure.
- [ ] Full CI is green on the exact candidate commit; results are inspected from logs, not inferred from job status alone.
- [ ] Independent adversarial review covers approval replay, resolver identity, argument/policy drift, cross-workspace access, task-ID collisions, lease takeover, idempotency replay, cancellation/revocation, and uncertain external side effects.
- [ ] Critical/high findings are fixed and impacted tests rerun; accepted residual risks are documented with an accountable owner.

### M2-A.4 OCI read-only review

- [ ] Read-only OCI inventory is completed using an authorized CLI profile; account, tenancy, compartment, region, and worker resources are verified.
- [ ] Review uses read-only inspection only. No resource creation, update, delete, scale, capacity-report write, or cost-incurring request is made.
- [ ] OCI findings and evidence timestamps are attached to the certification report.

### Operations and authorization

- [ ] Production/staging database identity, TLS, environment flags, credentials, and network policy are independently verified without exposing secret values.
- [ ] Migration/rollback plan is reviewed against the correct environment; production migrations remain separately authorized.
- [ ] Monitoring, audit retention, alerting, incident response, worker shutdown, and rollback owners are named and tested.
- [ ] An explicit owner authorization is recorded for the exact candidate SHA, environment, migration, deployment, and worker activation.
- [ ] A separately approved canary/rollback plan exists; this checklist itself does not authorize those actions.

## Present evidence state

- Local typecheck and focused suites passed: Stage 1.1 fail-closed gateway **21/21**, Stage 1.2A **16/16**, Stage 1.2B/C atomicity/once unit coverage **5/5**, durable-worker authorization **4/4**, M2-A durable execution **17/17**. Combined suite: **63 passed, 0 failed, 1 PostgreSQL suite skipped**. Exact command and caveats are in `M2A-SECURITY-HARDENING-STATUS.md`.
- New PostgreSQL integration tests are wired into `.github/workflows/postgres-certification.yml`. They require that job's run-scoped user/database, internal-only `postgres:5432` service, tmpfs data mount, independent pre/post connected-server identity assertions, and `AIRA_POSTGRES_CERTIFICATION=1`. They have **not** been run locally or remotely in this session.
- No disposable PostgreSQL service was available locally. Do not substitute Neon, production, permanent staging, or unverified localhost.
- OCI CLI/config and permission for live staging/Neon acceptance runs are unavailable or prohibited in this session.
- **No activation gates are certified. Production remains inactive.**
