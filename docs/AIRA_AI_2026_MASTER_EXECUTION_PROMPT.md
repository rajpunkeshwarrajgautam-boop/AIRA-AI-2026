# AIRA AI 2026 — Master Execution Prompt & Release Controls

## Operating Directive for All Automated Agents

This document forms the authoritative operational contract for automated coding agents (Antigravity, Agency Agents, ChatGPT Work, and CI automation) executing implementation, verification, and release tasks in the AIRA AI 2026 ecosystem.

---

## 1. GitHub Pro Ruleset Enforcement (`prod-release`)

Production stability is enforced server-side by GitHub Pro rulesets:

- **Ruleset Name**: `AIRA Production Protection`
- **Ruleset ID**: `25079946`
- **Target Condition**: `refs/heads/prod-release`
- **Enforcement Status**: `ACTIVE`
- **Enforced Rules**:
  - `deletion`: Direct deletion of `prod-release` is denied.
  - `non_fast_forward`: Force pushes to `prod-release` are denied.
  - `pull_request`: Direct pushes are denied (HTTP 403). All changes must arrive via pull request with conversation resolution required.
  - `required_status_checks`: Strict policy enabled. Mandatory checks required:
    1. `Fast CI`
    2. `Semantic Search CI`
    3. `Main / PR certification`
- **Bypass Configuration**: `bypass_actors: []`, `current_user_can_bypass: "never"`.
- **Maintainer Limitation Notice**:
  The repository has a single maintainer (`rajpunkeshwarrajgautam-boop`). Under GitHub's model, a PR author cannot review or approve their own pull request. Therefore `required_approving_review_count` is set to `0`. This is an accepted platform constraint and does NOT grant automated agents permission to merge.

---

## 2. Vercel Production Approval & Deployment Architecture

Live inspection of Vercel project `aira-ai-2026` via authenticated API confirms:

- **Project ID**: `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`
- **Organization**: `team_0IZkX9o2Ab319UsAPW9oq1SL` (`rajpunkeshwarrajgautam-boop's projects`)
- **Account Tier**: `Hobby` (Personal account)
- **Tracked Production Branch**: `prod-release`
- **Canonical Production URL**: `https://aira-ai-2026.vercel.app`
- **Baseline Stable Deployment**: `dpl_89joN6FnCocG3shaBB5rC33CeDRJ` (Commit: `b1635e132544d0772358cb463131d1e6cd4d40a9`)
- **Git Deployment Setting**: `createDeployments: "enabled"`
- **Ignored Build Step Policy**:
  ```bash
  [ "$VERCEL_GIT_COMMIT_REF" = "main" ] && exit 0 || exit 1
  ```
  - Commits on `main` exit 0 (Vercel cancels the build).
  - Commits on `prod-release` exit 1 (Vercel builds and deploys immediately).

### The Critical Vercel Hobby Constraint:
Native Vercel Deployment Approvals and Promotion Protections are enterprise/pro features not present on the Hobby tier.
Because Vercel automatically builds and deploys any commit merged into `prod-release`, **merging a pull request into `prod-release` IS the live production deployment trigger.**

### Database Schema Safeguard:
In `vercel.json`:
```json
"buildCommand": "if [ \"$VERCEL_ENV\" = \"production\" ] || [ \"$VERCEL_GIT_COMMIT_REF\" = \"staging\" ]; then npm run db:verify:deploy || exit 1; fi; npm run build"
```
Production builds run `packages/db/src/scripts/verify-deploy.ts` before building frontend assets.
If `DATABASE_URL` is unconfigured, migrations are unapplied, any of the 9 core tables is missing, or pgvector extension is uninitialized, the build fails with exit code 1 and aborts the production deployment.

---

## 3. Human GO LIVE Authorization Controls

To eliminate the risk of automated or accidental deployment, releases require explicit owner-level authorization:

### Protocol Specifications:
1. **No Inferred Authority**:
   - Passing CI checks, green preview builds, or prior session approvals never constitute authorization.
   - Every release candidate requires fresh authorization for its exact 40-character SHA.
2. **Owner Attestation Workflow**:
   - Location: `.github/workflows/release-authorization.yml`
   - Trigger: Manual `workflow_dispatch` restricted to `github.actor == github.repository_owner` (`rajpunkeshwarrajgautam-boop`).
   - Required Inputs:
     - `pr_number`: Open PR targeting `prod-release`.
     - `candidate_sha`: Full 40-character lowercase hex SHA.
     - `approval_phrase`: Exact string `GO LIVE <candidate_sha>`.
   - Execution: Asserts PR state, target branch, and HEAD match; generates an immutable step summary.
3. **Programmatic Guard**:
   - Location: `test/release-authorization-guard.ts`
   - Script: `npm run test:release-auth`
   - Test Coverage: 12 isolated security & policy boundary tests verifying fail-closed behavior across all input permutations.
   - Fast CI Integration: Executed as a required check in `Fast CI`.

---

## 4. Operational Invariants for Agents

1. **NEVER auto-merge to `prod-release`**:
   Agents must never run `gh pr merge`, `git merge`, or `git push origin prod-release`.
2. **NEVER execute production promotions**:
   Agents must never invoke `vercel promote` or manual production redeploys.
3. **NEVER alter production secrets or databases**:
   Agents must never run migrations directly against production Neon PostgreSQL outside authorized release procedures.
4. **STOP and report for explicit authorization**:
   When a release candidate passes all tests, preview checks, and CI gates, the agent must output the verified evidence, candidate SHA, and rollback target, and **PAUSE** for the user's explicit GO LIVE instruction.
