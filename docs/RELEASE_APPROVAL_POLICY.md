# AIRA AI 2026 — Explicit Production Release Authorization

**Status: GitHub Pro ruleset ACTIVE (ID: 25079946); Vercel production branch tracking & deployment policy VERIFIED; Human GO LIVE authorization controls ENFORCED.**

The production branch is `prod-release`. The production Vercel project is
`aira-ai-2026`, ID `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`.

## GitHub protections (independently verified 2026-10-14)

- GitHub Pro is active; the repository remains private.
- GitHub reports `prod-release.protected=true`.
- Ruleset `AIRA Production Protection`, ID `25079946`, is ACTIVE,
  matching exactly `refs/heads/prod-release`.
- No bypass actors are configured (`bypass_actors: []`, `current_user_can_bypass: "never"`).
- Pull requests, conversation resolution, Fast CI, Semantic Search CI,
  Main / PR certification and branch-up-to-date checks are required.
- Force pushes and branch deletion are denied.
- Required approving reviews: 0 because there is currently one maintainer (`rajpunkeshwarrajgautam-boop`).
  This is an explicit accepted platform limitation: GitHub does not permit the sole maintainer
  to submit approving reviews on their own pull requests.
- Direct git push to `prod-release` is completely denied by GitHub server-side (HTTP 403).

## Vercel production deployment architecture (independently verified 2026-10-14)

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
- **Native Deployment Approvals**:
  - Vercel Hobby tier does **not** include enterprise/pro deployment approval gates or promotion role controls.
  - Consequently, **merging a pull request into `prod-release` triggers an automatic, unprompted production deployment**.
- **Production Build Database Safeguard**:
  - In `vercel.json`:
    ```json
    "buildCommand": "if [ \"$VERCEL_ENV\" = \"production\" ] || [ \"$VERCEL_GIT_COMMIT_REF\" = \"staging\" ]; then npm run db:verify:deploy || exit 1; fi; npm run build"
    ```
  - Before Vite build runs in production, `packages/db/src/scripts/verify-deploy.ts` checks that:
    1. `DATABASE_URL` is configured.
    2. All expected migrations in `packages/db/src/migrations/` have been executed in `knex_migrations`.
    3. All 9 core tables (`runs`, `run_events`, `workflow_definitions`, `workflow_runs`, `workflow_steps`, `tool_calls`, `conversations`, `conversation_messages`, `conversation_search_documents`) exist.
    4. pgvector extension and `embedding_vector` column are ready.
  - If any migration or table is missing, `verify-deploy.ts` exits with code 1, immediately failing the Vercel production build and aborting deployment.

## Strongest supported human GO LIVE authorization controls

Given the platform realities (sole maintainer on GitHub Pro, Hobby tier on Vercel):
The merge into `prod-release` is the single definitive production deployment trigger.
To ensure that no automated agent, script, or speculative run can ever deploy to production without explicit human authorization, the following multi-layer authorization controls are implemented and enforced:

### Layer 1: Server-side PR gate (GitHub Pro Ruleset 25079946)
- Direct pushes to `prod-release` are blocked by GitHub ruleset.
- Only pull requests can merge into `prod-release`.
- Mandatory status checks (`Fast CI`, `Semantic Search CI`, `Main / PR certification`) must all pass on the exact head commit.

### Layer 2: Human GO LIVE attestation workflow (`.github/workflows/release-authorization.yml`)
- Triggered exclusively by manual `workflow_dispatch` by repository owner `rajpunkeshwarrajgautam-boop` (`if: github.actor == github.repository_owner`).
- Mandatory inputs:
  1. `pr_number`: Numeric PR targeting `prod-release`.
  2. `candidate_sha`: Full 40-character commit SHA.
  3. `approval_phrase`: Must strictly equal `GO LIVE <candidate_sha>`.
- Workflow asserts:
  - Exact 40-char SHA regex match.
  - Exact phrase match.
  - PR exists, is open, targets `prod-release`, and `head.sha == candidate_sha`.
- Writes an immutable audit entry to GitHub Actions Step Summary.
- **Does not merge, migrate, or deploy.**

### Layer 3: Programmatic authorization guard (`test/release-authorization-guard.ts` & `npm run test:release-auth`)
- Validates the complete authorization matrix:
  1. Reject missing or malformed candidate SHA.
  2. Reject uppercase or truncated short SHA.
  3. Reject missing or incorrect approval phrase.
  4. Reject unauthorized non-owner actors.
  5. Reject PR targeting any branch other than `prod-release`.
  6. Reject closed or merged PRs.
  7. Reject stale authorizations where PR head SHA has moved.
  8. Reject failed, cancelled, or in-progress attestation runs.
  9. Accept only exact-matching, owner-dispatched, completed successful attestation runs.
- Tested across 12 isolated security and policy boundary test cases.
- Enforced as a required step in `Fast CI`.

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

