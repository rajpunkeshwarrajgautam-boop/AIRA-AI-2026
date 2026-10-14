# AIRA AI 2026 — Explicit Production Release Authorization Policy

**Status: GitHub Pro ruleset ACTIVE (ID: 25079946); Vercel Hobby deployment architecture INSPECTED; Dual-Evidence Provenance, Issuer Hardening & Safe Bootstrap Sequence IMPLEMENTED.**

The production branch is `prod-release`. The production Vercel project is
`aira-ai-2026`, ID `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`.

## GitHub protections (independently verified 2026-10-14)

- GitHub Pro is active; the repository remains private.
- GitHub reports `prod-release.protected=true`.
- Ruleset `AIRA Production Protection`, ID `25079946`, is ACTIVE,
  matching exactly `refs/heads/prod-release`.
- Pull requests, conversation resolution, Fast CI, Semantic Search CI,
  Main / PR certification and strict branch-up-to-date checks are required.
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
  - Therefore, production deployment control is **NOT FULLY ENFORCEABLE natively at the Vercel hosting layer** on the Hobby plan. Protection against premature production releases depends entirely on upstream pull request merge gating on GitHub.
- **Production Build Database Safeguard**:
  - In `vercel.json`:
    ```json
    "buildCommand": "if [ \"$VERCEL_ENV\" = \"production\" ] || [ \"$VERCEL_GIT_COMMIT_REF\" = \"staging\" ]; then npm run db:verify:deploy || exit 1; fi; npm run build"
    ```
  - Before Vite build runs in production, `packages/db/src/scripts/verify-deploy.ts` checks database migrations, pgvector, and core schema tables.

---

## Supported human GO LIVE authorization controls

Given the platform realities (sole maintainer on GitHub Pro, Hobby tier on Vercel):
The merge into `prod-release` is the single definitive production deployment trigger.
To ensure that no automated agent, script, or speculative run can ever deploy to production without explicit human authorization, the following multi-layer authorization controls are implemented:

### Layer 1: Server-side PR gate (GitHub Pro Ruleset 25079946)
- Direct pushes to `prod-release` are blocked by GitHub ruleset.
- Only pull requests can merge into `prod-release`.
- Mandatory status checks (`Fast CI`, `Semantic Search CI`, `Main / PR certification`) must all pass on the exact head commit.
- Strict up-to-date policy is active (`strict_required_status_checks_policy: true`).

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
- The commit status description links the PR (`PR #<number>`) and its `target_url` links directly to the GitHub Actions run ID.
- Writes an immutable audit entry to GitHub Actions Step Summary.
- **Does not merge, migrate, or deploy.**

### Layer 3: Authoritative Dual-Evidence Verification (`npm run verify:release-auth`)
- **Deterministic Unit Testing (`npm run test:release-auth:unit`)**:
  - Executed in `Fast CI` to verify the authorization rules engine across 52 isolated security boundaries.
  - Validates fail-closed handling of malformed SHAs, uppercase SHAs, short SHAs, invalid phrases, wrong actors, closed PRs, moved HEADs, failed runs, expired attestations, missing commit status, unlinked status, expired status, untrusted status issuers, forged target URLs, missing/untrusted workflow branch execution (`head_branch !== 'prod-release'`), missing status creator identity, missing/malformed status timestamps, missing run timestamps, malformed workflow execution commit SHAs, workflow run repo mismatches, uncorrelated replay timestamps, display_title input binding (candidate SHA, PR number, approval phrase mismatches), interim states (pending / failure), and forged metadata.
  - Passing this step proves code correctness of the rules engine, but does NOT grant GO LIVE authorization.
- **Authoritative Live Release Verification (`npm run verify:release-auth -- --pr <num> --sha <sha>`)**:
  - Executed via `scripts/verify-release-authorization.ts` delegating directly to `validateReleaseAuthorization()`.
  - Requires **BOTH**:
    1. An authentic owner workflow run (`rajpunkeshwarrajgautam-boop`, `workflow_dispatch`, `completed`, `success`, executed from protected `prod-release`, fresh <24h).
    2. Input verification binding candidate PR SHA, PR number, and approval phrase via authentic server-set `display_title` (and `run.inputs` when present).
    3. An authentic commit status `release/go-live-authorized` on the candidate commit SHA (`state: success`, fresh <24h, issuer `github-actions[bot]`).
    4. **Verified Provenance Linkage**: The commit status `target_url` must link directly to the verified workflow run ID in the authorized repository.
    5. **Temporal Correlation Anti-Replay Bound**: The status creation timestamp must correlate within 15 minutes of the workflow execution window.
  - Fails closed (`exit 1`) if either evidence source is missing, inconsistent, expired, untrusted, or unlinked.

### Layer 4: True Merge-Time Expiration Reality & Active Revocation
- **Platform Reality**: GitHub Commit Statuses do **NOT** natively expire or have a TTL. Once set to `success` on a commit SHA, GitHub rulesets treat them as green indefinitely for that SHA as long as it remains the PR HEAD.
- **Enforcement Boundaries**:
  1. *Verification-Time Enforcement*: Both `validateReleaseAuthorization()` and `scripts/verify-release-authorization.ts` inspect `created_at`. Authorizations older than 24 hours are rejected (`EXPIRED_COMMIT_STATUS` / `EXPIRED_AUTHORIZATION_ATTESTATION`).
  2. *Active Revocation Tooling (`npm run revoke:release-auth`)*:
     - Uses safe argument execution (`execFileSync`) without shell command interpolation:
       ```bash
       npm run revoke:release-auth -- --sha <candidate_sha> --reason "<reason>"
       ```
     - Posts `state: failure` on `release/go-live-authorized`, immediately locking GitHub's PR merge gate server-side.
  3. *Code Mutation Invalidation*: Any new push to the PR changes `head.sha`, automatically invalidating previous statuses.
  4. *Un-revoked Inactivity*: If an authorized commit sits unmerged past 24 hours without a new push or active revocation, GitHub's native web UI merge button would still see the status as passing unless explicitly revoked. We do not claim automatic ruleset-level expiration by GitHub.

### Layer 5: Canary PR & Ruleset Verification
- Verified on disposable canary PR #66 and temporary ruleset ID `25095321`:
  - Confirmed `mergeable_state: 'blocked'` when status was absent.
  - Confirmed PR checks pass when `release/go-live-authorized: success` was posted.
  - Confirmed active revocation (`revoke:release-auth`) posted `state: failure` and immediately blocked merge gating.
  - All canary artifacts deleted; production ruleset `25079946` was completely untouched.

### Layer 6: Safe 4-Step Bootstrap Sequence
- **Deadlock Prevention**: Because `release-authorization.yml` is being introduced in PR #64, it does not yet exist on the default branch (`prod-release`). GitHub Actions does not allow `workflow_dispatch` on workflows not yet present on the default branch.
- **Sequence**:
  1. *Bootstrap Merge*: PR #64 is reviewed and merged into `prod-release` under the current ruleset (Fast CI, Semantic Search CI, Main / PR certification).
  2. *Registration Verification*: Owner verifies that `Release Authorization Attestation (No Deployment)` appears in GitHub Actions on `prod-release`.
  3. *Ruleset Activation*: Owner updates Ruleset `25079946` to add `release/go-live-authorized` to `required_status_checks`.
  4. *Ongoing Enforcement*: All subsequent PRs targeting `prod-release` are locked until explicit owner dispatch.

### Layer 7: Mandatory Agent Stop Rule
- All automated agents (Antigravity, Agency Agents, ChatGPT Work, etc.) operate under the strict constraint:
  - **NEVER execute `gh pr merge`, `git push origin prod-release`, `vercel --prod`, or `vercel promote` autonomously.**
  - An agent must prepare the release, run all CI checks, obtain staging verification evidence, present the final candidate SHA and diff to the user, and **STOP**.
  - Merging and production release require the user's explicit, real-time instruction in the active session.

---

## Emergency and rollback procedure

If an incident or regression occurs post-release:
1. **Instant Rollback**: Execute `vercel rollback` via Vercel CLI or Dashboard to point the production alias `https://aira-ai-2026.vercel.app` back to the previous verified stable deployment:
   - Baseline Deployment: `dpl_89joN6FnCocG3shaBB5rC33CeDRJ` (Commit: `b1635e132544d0772358cb463131d1e6cd4d40a9`).
2. **Reversible Fix**: Prepare a hotfix on a dedicated branch against `prod-release`.
3. **Database Safety**: Never run destructive down-migrations that drop tables or delete production data. Use forward-fix additive migrations.
4. **Attestation**: Run through the full release certification protocol before promoting any replacement deployment.
