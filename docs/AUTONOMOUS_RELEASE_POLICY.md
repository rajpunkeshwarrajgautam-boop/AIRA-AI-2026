# AIRA AI 2026 — Delegated Production Release Boundary

**Mode:** Standing technical delegation for bounded code-only releases. No recurring human `GO LIVE <SHA>` dispatch is necessary for an otherwise eligible release.

## Source of authority and scope

The owner delegates technical GO/NO-GO decisions for code-only releases targeting **only**:

- Repository: `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`
- Protected branch: `prod-release` (ruleset `25079946`)
- Vercel project: `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`)
- Production domain: `https://aira-ai-2026.vercel.app`

The operator owns the technical decision. **NO GO is an autonomous decision**, not a request for the owner to waive a failed gate. The operator may fix the defect on a reviewable feature branch and re-run certification.

The standing delegation **excludes** production database migrations, data deletion/irreversible cleanup, credential rotation, auth or permissions bypasses, worker/infrastructure activation, new paid resources or upgrades, changes to production environments, and unverified rollback procedures. Those require separately bounded authority. No automation may bypass branch protection.

## Two levels of release operation

1. **Unattended static release:** `.github/workflows/autonomous-release.yml` runs after the ordinary `CI` or `Disposable PostgreSQL Certification` workflows complete. Only a PR authored by the repository owner, from the same repository, targeting the protected production branch, and changing allowlisted static content can reach the merge step. Executable TS/JS, dependencies, auth, runtime, database, CI, release-governance and infrastructure files are rejected automatically.
2. **Engineering-reviewed code release:** Trusted engineering operators can assess and release broader *code-only* changes under `AGENTS.md`. They must produce independent, source-backed evidence for the specific candidate SHA. A green report alone does not establish readiness. No repeated owner phrase is needed, but the protected PR path and all checks remain mandatory. Protected or destructive operational changes remain out of scope.

The older `.github/workflows/release-authorization.yml` and dedicated App publisher remain as a legacy, optional attestation path. `npm run verify:release-auth` still checks **that legacy path only**; it is not a verifier for autonomous releases. Avoid describing a missing legacy App status as proof an autonomous release failed if the new workflow's own scope and evidence checks pass. Branch rules still govern what can actually merge.

## Unattended release checks

The trusted operator code is checked out only from `prod-release`; **never execute checkout, scripts, or artifacts from the PR head in its write-token job**. The operator verifies:

1. Successful source workflows for the **current PR head SHA**, including the named `Fast CI`, `Semantic Search CI`, and `Main / PR certification` jobs and the isolated PostgreSQL workflow. The newest matching workflow run must pass; skipped or missing required jobs deny release.
2. GitGuardian completed-success check and the Vercel success status whose target URL belongs to the configured AIRA project.
   Pending Vercel or GitGuardian results receive bounded retries; explicit failures are terminal. This prevents a CI/preview completion race from requiring a new manual trigger.
3. Same-repository owner-authored open PR, not draft or held, with clean/up-to-date mergeability. A fork, rename, deletion, excessive scope, changed SHA, or any executable/protected path produces NO GO.
4. No open `[AUTO-RELEASE-FREEZE]` incident.
5. Exact-SHA squash merge through the GitHub PR API, preserving branch/ruleset restrictions. GitHub rejects stale SHA or unsatisfied branch checks; no direct push or force flag is used.
6. Post-merge production `/api/version` reports the exact **merge commit SHA** and `/api/health` reports healthy runtime, online agent runtime and disabled production mock fallback within eight minutes.

If live verification fails, the job creates an `[AUTO-RELEASE-FREEZE]` issue and fails. Subsequent automatic merges are denied until the incident is resolved and the issue is closed. A freeze prevents further rollout; it **does not undo the already merged commit**. An incident operator must independently verify a safe rollback target and route. No automatic irreversible database mutation or unverified Vercel promotion is attempted.

## Operational considerations

- This event-driven design consumes GitHub Actions minutes only when CI finishes; there is no recurring scheduler and no new paid infrastructure.
- The repository's GitHub Actions setting must permit `GITHUB_TOKEN` to use its explicitly declared `contents:write` and `pull-requests:write` permissions. If GitHub denies a merge, leave the candidate in NO GO; do not weaken the ruleset.
- All required GitHub checks must already be present on the exact candidate SHA. A Vercel `READY` preview status means its build succeeded, **not** that an authenticated live Builder execution was performed. Sensitive code changes remain outside unattended scope and need genuine end-to-end acceptance.
- The `prod-release` Git event is the Vercel production deployment trigger. The release operator does **not** call `vercel --prod`, `vercel promote`, mutate Neon, or edit Vercel environment variables.
- Review the exact workflow permissions and the new operator code as privileged infrastructure before first activation. The workflow is not active until the reviewed PR containing it lands on the protected default branch.

## Releasing PR #150

PR #150 modifies executable Builder, storage, authentication and agent-runtime code, so the unattended operator **must deny it** with `EXECUTABLE_OR_PROTECTED_CHANGE`. Under standing delegation, a trusted engineering operator can resolve and recertify the previously identified persistence, production authority and authentic Builder execution findings, then make an evidence-backed GO/NO-GO decision for its exact current head. Do not treat all-green CI alone as closure of those findings.
