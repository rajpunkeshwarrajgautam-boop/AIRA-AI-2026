# AIRA AI 2026 — Explicit Production Release Authorization

**Status: GitHub Pro ruleset ACTIVE (ID: 25079946); Vercel Hobby deployment architecture INSPECTED; Separation of Deterministic Unit Tests & Live GitHub API Attestation IMPLEMENTED.**

The production branch is `prod-release`. The production Vercel project is
`aira-ai-2026`, ID `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`.

## GitHub protections (independently verified 2026-10-14)

- GitHub Pro is active; the repository remains private.
- GitHub reports `prod-release.protected=true`.
- Ruleset `AIRA Production Protection`, ID `25079946`, is ACTIVE,
  matching exactly `refs/heads/prod-release`.
- Pull requests, conversation resolution, Fast CI, Semantic Search CI,
  Main / PR certification and branch-up-to-date checks are required.
- Force pushes and branch deletion are denied.
- Required approving reviews: 0 because there is currently one maintainer (`rajpunkeshwarrajgautam-boop`).
  This is an explicit accepted platform limitation: GitHub does not permit the sole maintainer
  to submit approving reviews on their own pull requests.
- Direct git push to `prod-release` is completely denied by GitHub server-side (HTTP 403).
- **Administrative Boundary Note**: While `bypass_actors: []` is configured, repository administrators retain repository-level settings access. "Zero bypass guarantees" must not be claimed. The ruleset prevents non-PR pushes and enforces CI gates before merge.

## Vercel production deployment architecture & Hobby reality (independently verified 2026-10-14)

Live inspection of Vercel project `aira-ai-2026` via authenticated Vercel API and CLI confirms:

- **Project ID**: `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`
- **Team / Organization**: `team_0IZkX9o2Ab319UsAPW9oq1SL` (`rajpunkeshwarrajgautam-boop's projects`)
- **Account Tier / Plan**: `Hobby` (Personal account)
- **Tracked Production Branch**: `prod-release` (switched from `main` on 2026-10-14)
- **Canonical Production URL**: `https://aira-ai-2026.vercel.app`
- **Git Integration**: Connected to `rajpunkeshwarrajgautam-boop/AIRA-AI-2026` with `gitProviderOptions.createDeployments: "enabled"`
- **Ignored Build Step Command**:
  ```bash
  [ "$VERCEL_GIT_COMMIT_REF" = "main" ] && exit 0 || exit 1
  ```
  - When `VERCEL_GIT_COMMIT_REF == "main"`: exits with `0` $\rightarrow$ Vercel cancels/skips the build.
  - When `VERCEL_GIT_COMMIT_REF == "prod-release"`: exits with `1` $\rightarrow$ Vercel executes the build immediately.
  - *Security Reality*: Ignored Build Step is an operational convenience, NOT a security boundary. It can be modified via PR (`vercel.json`) or bypassed via CLI.
- **Native Deployment Approvals & Limitations**:
  - Vercel Hobby tier does **not** support enterprise/pro deployment approval gates, release-hold policies, or preview-only git deployments.
  - Consequently, **merging a pull request into `prod-release` triggers an automatic, unprompted production deployment**.
  - Therefore, production deployment control is **NOT FULLY ENFORCEABLE natively at the Vercel layer** on the Hobby plan. Protection against premature production releases depends entirely on upstream pull request merge gating on GitHub.
- **Production Build Database Safeguard**:
  - In `vercel.json`:
    ```json
    "buildCommand": "if [ \"$VERCEL_ENV\" = \"production\" ] || [ \"$VERCEL_GIT_COMMIT_REF\" = \"staging\" ]; then npm run db:verify:deploy || exit 1; fi; npm run build"
    ```
  - Before Vite build runs in production, `packages/db/src/scripts/verify-deploy.ts` checks database migrations, pgvector, and core schema tables.

## Supported human GO LIVE authorization controls

Given the platform realities (sole maintainer on GitHub Pro, Hobby tier on Vercel):
The merge into `prod-release` is the single definitive production deployment trigger.
To ensure that no automated agent, script, or speculative run can ever deploy to production without explicit human authorization, the following multi-layer authorization controls are implemented:

### Layer 1: Server-side PR gate (GitHub Pro Ruleset 25079946)
- Direct pushes to `prod-release` are blocked by GitHub ruleset.
- Only pull requests can merge into `prod-release`.
- Mandatory status checks (`Fast CI`, `Semantic Search CI`, `Main / PR certification`) must all pass on the exact head commit.

### Layer 2: Human GO LIVE attestation workflow (`.github/workflows/release-authorization.yml`)
- Triggered exclusively by manual `workflow_dispatch` by repository owner `rajpunkeshwarrajgautam-boop` (`if: github.actor == github.repository_owner`).
- Mandatory inputs:
  1. `pr_number`: Numeric PR targeting `prod-release`.
  2. `candidate_sha`: Full 40-character lowercase hex commit SHA.
  3. `approval_phrase`: Must strictly equal `GO LIVE <candidate_sha>`.
- Workflow asserts:
  - Exact 40-char SHA regex match.
  - Exact phrase match.
  - PR exists, is open, targets `prod-release`, and `head.sha == candidate_sha`.
- With `statuses: write` permission, it posts an authenticated GitHub commit status `release/go-live-authorized` (`state: success`) directly on the candidate commit SHA.
- Writes an immutable audit entry to GitHub Actions Step Summary.
- **Does not merge, migrate, or deploy.**

### Layer 3: Separation of Deterministic Unit Tests & Live Release Verification
- **Deterministic Unit Testing (`npm run test:release-auth:unit`)**:
  - Executed in `Fast CI` to verify the authorization rules engine across 24 isolated security boundaries.
  - Validates fail-closed handling of malformed SHAs, uppercase SHAs, short SHAs, invalid phrases, wrong actors, closed PRs, moved HEADs, failed runs, expired attestations, and forged metadata.
  - **Unit test execution is NOT live release authorization.** Passing this step proves code correctness of the rules engine, but does NOT certify that the candidate commit has been approved for release.
- **Authoritative Live Release Verification (`npm run verify:release-auth`)**:
  - Executed via `scripts/verify-release-authorization.ts`.
  - Queries authoritative GitHub REST API for:
    1. PR state (`open`), target branch (`prod-release`), and current HEAD SHA match.
    2. Commit status `release/go-live-authorized` on the candidate commit SHA (`state: success`).
    3. Workflow runs for `release-authorization.yml` verifying owner actor (`rajpunkeshwarrajgautam-boop`), event `workflow_dispatch`, status `completed`, conclusion `success`, exact input matches, and freshness (<24 hours).
  - Fails closed (`exit 1`) if authorization is absent, stale, forged, or unverifiable.

### Layer 4: Mandatory agent stop rule
- All automated agents (Antigravity, Agency Agents, ChatGPT Work, etc.) operate under the strict constraint:
  - **NEVER execute `gh pr merge`, `git push origin prod-release`, `vercel --prod`, or `vercel promote` autonomously.**
  - An agent must prepare the release, run all CI checks, obtain staging verification evidence, present the final candidate SHA and diff to the user, and **STOP**.
  - Merging and production release require the user's explicit, real-time instruction in the active session.

## Emergency and rollback procedure

If an incident or regression occurs post-release:
1. **Instant Rollback**: Execute `vercel rollback` via Vercel CLI or Dashboard to point the production alias `https://aira-ai-2026.vercel.app` back to the previous verified stable deployment:
   - Baseline Deployment: `dpl_89joN6FnCocG3shaBB5rC33CeDRJ` (Commit: `b1635e132544d0772358cb463131d1e6cd4d40a9`).
2. **Reversible Fix**: Prepare a hotfix on a dedicated branch against `prod-release`.
3. **Database Safety**: Never run destructive down-migrations that drop tables or delete production data. Use forward-fix additive migrations.
4. **Attestation**: Run through the full release certification protocol before promoting any replacement deployment.

