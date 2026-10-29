# M2-A + Stage 1.2 Production GO-Readiness Assessment

**Assessment date:** 2026-10-29 (UTC)<br>
**Decision:** **NO-GO — production readiness is not established. Keep production workers disabled.**<br>
**Scope:** Local release-certification preparation only. No commit/push, remote CI trigger, merge, ruleset edit, deployment, staging/production DB operation, OCI provisioning, or worker activation was performed.

## 1. Candidate and decision summary

- Working branch: `arena/0f72d2ce-aira-ai-2026`.
- Current `HEAD`: `25f06f83a38b771dfaca615ba952c50286bf1901`. The current changes are uncommitted local worktree changes, not a published candidate SHA.
- PR #117: **OPEN/DRAFT** at published SHA `25f06f83a38b771dfaca615ba952c50286bf1901`.
- PR #115: **OPEN/DRAFT**, frozen at `56064639ea2bf691cd7476b42d734864a32d595e`; unchanged. Its frozen head is an ancestor of PR #117's published head.
- No current-worktree PostgreSQL certification or remote CI exists. An older PostgreSQL success is not evidence for the current worktree. Production stays **NO-GO**.

| Readiness dimension | Status | Evidence and limitation |
|---|---|---|
| Implementation | **PARTIAL — present locally** | Workspace authority, migration 030, revocation/approval/worker enforcement, and focused regressions are in the worktree. Current-diff review and PostgreSQL behavior remain unverified. |
| Local verification | **PASS for the checks listed below** | Typecheck/build, deterministic regression set, fail-closed invocation checks, lint, secret scan, YAML syntax parse, and diff checks passed. No real PostgreSQL test was run. |
| Disposable PostgreSQL certification | **NOT RUN for this worktree** | Workflow coverage is registered; the exact candidate has not passed it. Test registration is not certification. |
| GitHub certification | **BLOCKED / NOT CURRENT** | The candidate has not been published. At the older published PR #117 SHA, Main / PR certification failed; the PostgreSQL success predates these edits. |
| Required-check configuration | **BLOCKED** | The active `prod-release` ruleset does not require the PostgreSQL certification context. An owner-authorized update is required. |
| Staging | **NOT VERIFIED** | Existing surfaced staging-acceptance checks were skipped. No staging credential or database was used. |
| OCI | **UNKNOWN** | OCI CLI/config were unavailable; live capacity, networking, worker, and quota state were not verified. No resource was provisioned. |
| Production activation | **NO-GO / NOT AUTHORIZED** | Required evidence and explicit production authorization are absent. Keep worker activation disabled. |

## 2. Local implementation and safety findings

Migration 030 adds `principal_workspace_authorities`; it does not infer authority from historic run/task workspace identifiers, client headers/body values, or project IDs. The server derives a personal workspace from the authenticated principal. Revocation is persisted as a tombstone and is not undone by lazy workspace resolution. Approval submission/resolution/resumption, reusable grants, direct ToolGateway dispatch, and durable-worker execution enforce persisted owner/workspace authority. Durable workers revalidate before specialist dispatch; cancellation and terminal-task safeguards remain in the repository paths.

Migration 030's destructive `down` requires test mode, the explicit disposable marker, identical isolated URLs, and a live disposable PostgreSQL/network identity preflight before DDL. Its deterministic rollback-guard regression passes. Migration 030 has **not** been applied to any shared database.

Focused certification-safety defects found and corrected locally:

- The PostgreSQL approval/outbox test could silently skip without certification mode. It now refuses missing certification/DB contract, performs live identity/network preflight, and cannot silently skip. Its PostgreSQL fixture now covers a historical legacy run workspace and a legacy durable task: neither becomes active authority or dispatches a specialist.
- The destructive recovery test, prompt-schema drift DDL test, tool-call schema drift DDL test, and DB-writing ToolGateway certification are now gated by the run-scoped disposable-PostgreSQL contract and live preflight. They have been moved out of ordinary service-PostgreSQL CI and into the dedicated disposable workflow.
- The tool-call schema drift runner's previous Neon CLI/default-local-URL fallback has been removed. It now refuses execution without the exact disposable contract and preflight. Its temporary tables are dropped in a `finally` path; the CI job's run-owned tmpfs database/container cleanup remains the outer cleanup boundary. The older isolated-Neon schema certification runner likewise no longer resolves Neon credentials or accepts an arbitrary URL; it requires disposable certification and live preflight. The standalone repository-migration utility that drops core tables now has the same fail-closed contract.
- Full API integration repeats preflight immediately before each schema reset; migration path B independently preflights. These tests remain restricted to the dedicated disposable workflow. Other staging-specific integration scripts were not run or treated as release evidence.

No staging or production credential was retrieved, passed to a test, or used. No database connection, migration, rollback, or data mutation occurred in this assessment. Fail-closed verification commands used only deliberately non-routable placeholder URLs and exited before DB use.

## 3. Coverage and certification registration

The dedicated job is named **`PostgreSQL 16 isolated regression certification`**. Its current workflow registers these important acceptance areas against one per-run PostgreSQL 16 container:

- Network/address policy and preflight identity checks; forward migrations through migration 030; post-migration identity recheck.
- Guarded ToolGateway certification, recovery certification, prompt-schema drift repair, and tool-call schema drift repair.
- Stage 1.1 gateway fail-closed approval; Stage 1.2A lifecycle; Stage 1.2B/C atomic decisions and ALLOW_ONCE consumption; workflow approval authority; durable-worker owner/workspace/allowlist/revocation authorization.
- Migration-030 constraints; first-login workspace provisioning/concurrency; revocation tombstones; cross-principal/workspace isolation; legacy run/task refusal; approval replay/CAS and grants; ALLOW_ONCE; outbox atomicity, crash recovery, lease takeover/fencing, and workflow resumption.
- Real PostgreSQL M2-A task execution, persisted workspace binding, worker lease/fencing, recovery/idempotency, cross-tenant recovery, and API integration/approval replay with destructive schema-reset paths.

The approval/outbox and real-worker suites perform their own live disposable-target preflight. The runner checks the run-scoped role/database, generated URL, server endpoint addresses, PostgreSQL identity/version, exclusive internal Docker network, and `inet_server_addr()` before test SQL. The DB container uses tmpfs only, has no published host port or persistent DB volume, and shares an internal network exclusively with the isolated runner. Run-scoped credentials have restrictive permissions and are removed. Cleanup removes only containers/network/files matching that run's unique ownership labels. No GitHub, Neon, staging, or production secrets are passed to the test containers.

The workflow's job is unconditional and the workflow has a `pull_request` trigger for `prod-release`, without path-based skipping. Keep that property; a failed, cancelled, skipped, or absent certification must never be accepted as a pass. Some ordinary CI service-PostgreSQL migrations remain additive forward migrations; broad destructive/reset/whole-table certification operations are isolated behind the verified disposable contract. Current-worktree execution is still **NOT RUN**.

## 4. Local verification record

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS**; existing Vite large-chunk warning remains |
| `npm run lint` | **PASS**; 0 errors, 293 repository warnings |
| Targeted deterministic approval/authority/durable-worker/M2-A/activation/migration-guard set | **PASS**; 129 passed, 0 failed, 0 skipped, using `NODE_ENV=test` and a deliberately non-routable placeholder DB URL; no PostgreSQL certification implied |
| Fail-closed invocation of recovery, ToolGateway certification, prompt/tool-call/legacy isolated-Neon schema drift, migration-clean, repository-migration utility, and approval/outbox suites | **PASS**; each refused before test/database use when certification mode was absent or false |
| Tool-call schema drift fallback audit | **PASS**; no Neon CLI, Neon endpoint, or local DB fallback remains in that runner |
| `npm run test:secrets` | **PASS**; 582 tracked files scanned, zero exposed credentials. The tracked-file scanner does not inspect untracked files; changed local files were also reviewed. |
| YAML syntax parse | **PASS** for `.github/workflows/ci.yml` and `.github/workflows/postgres-certification.yml` using the Prettier YAML parser. `actionlint` is unavailable; GitHub-specific expression/action semantics were not independently validated. |
| `git diff --check` | **PASS** |
| Current-worktree disposable PostgreSQL, staging, OCI, and remote CI | **NOT RUN** |

## 5. Blockers and exact acceptance evidence

### A. Local code/test — remaining evidence required

**Status:** no additional local defect identified in the focused review; this is not a PostgreSQL pass.

- [ ] Review the final diff and retain the local verification above after all edits.
- [ ] On the exact published candidate SHA, capture the dedicated workflow URL and SHA, final job conclusion, and logs proving that every required PostgreSQL suite actually ran (not skipped); retain non-secret preflight identity/network evidence and confirm cleanup on success and failure.
- [ ] In those logs, specifically verify migration 030 constraints, first-login concurrency/revocation, legacy run/task refusal, cross-principal/workspace cases, Stage 1.1/1.2A/B/C, ALLOW_ONCE, outbox/crash recovery, worker authorization/revocation, full API/approval replay, and final connected-server identity verification.

### B. GitHub configuration — owner authorization required

The readable active `AIRA Production Protection` ruleset targets `refs/heads/prod-release`; it currently requires `Fast CI`, `Semantic Search CI`, and `Main / PR certification`, and its strict-up-to-date policy is enabled. PostgreSQL certification is absent. The separate branch-protection endpoint returned HTTP 403, so no further branch-protection settings are claimed.

Do not change rulesets without owner authorization. The exact required status object to add (retaining existing checks and `strict_required_status_checks_policy: true`) is:

```json
{
  "context": "PostgreSQL 16 isolated regression certification",
  "integration_id": 15368
}
```

After separate owner authorization and change, required evidence is a fresh read-only ruleset inspection showing this exact context/integration alongside all existing contexts and strict policy. A skipped, failed, cancelled, or absent job must block release; keep the workflow/job unconditional and the test entrypoints fail-closed.

### C. Publication and CI — separate authorization required

- [ ] Obtain separate authorization to publish the exact worktree and trigger CI; neither is authorized/performed in this preparation.
- [ ] Run the required checks against the exact immutable candidate SHA, including the newly required PostgreSQL context; retain run URL, head SHA, every required job/step conclusion, and disposable DB/cleanup evidence.
- [ ] Resolve PR #117 Main / PR certification's failure at older SHA `25f06f83a38b771dfaca615ba952c50286bf1901`. Older runs `40872957023` (Main / PR failed) and `40872956981` (PostgreSQL passed) do not certify these edits.
- [ ] Verify no mandatory PostgreSQL job or subtest was skipped or missing. A previous green optional PostgreSQL check does not count.

### D. Staging — separately authorized environment

- [ ] Obtain separate staging authorization before using any staging credential, DB, deployment, or worker.
- [ ] Run the deployed staging acceptance against an explicitly identified permanent staging target; record exact deployed SHA, redacted project/endpoint identity, result summary, logs, and cleanup. Existing surfaced staging acceptance was skipped, so no staging acceptance is evidenced.
- [ ] Verify staging worker state and record acceptance without changing frozen PR #115.

### E. OCI — current read-only capacity evidence required

- [ ] With separately authorized read-only OCI access, capture timestamp, tenancy/compartment/region, VM shape/AD, subnet and NSG/security-list attachment, ingress/egress, quotas/reservations, current capacity, and worker state.
- [ ] Base capacity/cost claims on current OCI output, not historical notes. OCI CLI/config were absent; all listed current OCI state is **UNKNOWN**. No resource operation is authorized here.

### F. Production activation — distinct explicit authorization required

- [ ] Verify production-vs-staging/preview DB identity and TLS via authorized read-only evidence without exposing secrets; production migration 030 application remains separately authorized.
- [ ] Verify the production worker activation flag is disabled and production worker replica count is zero; record evidence and keep both disabled/zero until all preceding gates pass.
- [ ] Name monitoring, alerting, audit, incident-response, shutdown, migration/rollback, and canary owners; attach a reviewed rollback plan.
- [ ] Record explicit owner authorization tied to exact candidate SHA, production environment, migration/deployment, and worker activation. Treat activation as a separate later operation after every gate passes.

## 6. GO / NO-GO matrix

| Gate | Current status | Required to move forward |
|---|---|---|
| Local code and deterministic tests | **PASS locally / PARTIAL overall** | Final diff review; local tests do not substitute for PG evidence. |
| Migration 030 and rollback guard | **Present / guard regression PASS** | Exact candidate's disposable PG constraint test; no shared DB migration in this turn. |
| Disposable PostgreSQL regression suite | **NOT RUN** | All registered suites pass on exact immutable candidate SHA, with no skipped/absent mandatory step and identity/cleanup evidence. |
| `prod-release` required-check policy | **BLOCKED** | Owner-authorized exact context addition and read-only verification. |
| Publication / Main and PR checks | **BLOCKED** | Separate publication authorization; all required checks green on candidate SHA; resolve current Main / PR failure. |
| Staging acceptance | **NOT VERIFIED** | Separately authorized deployed staging run with redacted target identity and evidence. |
| OCI readiness | **UNKNOWN** | Current authorized read-only capacity/network/worker inspection. |
| Production DB/migration and worker activation | **NO-GO / NOT AUTHORIZED** | Every gate above plus explicit owner authorization tied to exact SHA; worker remains disabled until then. |

## 7. Recommended release order and proposed commit message

Preserve PR #115 frozen and untouched; keep PR #117 OPEN/DRAFT. If an owner later authorizes integration, integrate/review #115 first, preserve ancestry, then refresh #117 against the updated base and rerun all gates. Do not merge either PR as part of this preparation. After code review, the recommended later sequence is: owner-authorized ruleset update → publish exact candidate → required CI and isolated PostgreSQL certification → resolve Main / PR failure → separately authorized staging acceptance → current OCI read-only readiness review → production identity/rollback review → explicit production activation authorization → separately approved activation/canary.

**Proposed commit message (not committed):** `fix(release): fail closed on disposable PostgreSQL certification`

**Final disposition: NO-GO.** No commit, push, remote CI trigger, ruleset change, merge, deployment, database mutation, OCI provisioning, credential retrieval, or worker activation occurred. Keep production workers disabled.
