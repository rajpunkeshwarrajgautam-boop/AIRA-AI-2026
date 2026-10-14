# AIRA AI 2026 — Explicit Production Release Authorization

**Status: pending platform-enforced production guardrail.**

The production branch is `prod-release`. The production Vercel project is
`aira-ai-2026`, ID `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`.

## Current constraints (verified 2026-10-14)

- GitHub reports `prod-release` as **unprotected**.
- Repository is private, and GitHub's API returns HTTP 403 with
  "Upgrade to GitHub Pro or make this repository public to enable this feature."
- The current GitHub MCP GitHub App cannot mutate branch protection/rulesets.
- GitHub Actions succeeding does NOT block a direct push to an unprotected
  branch. A push can independently trigger a Vercel production build.
- The separate manual attestation workflow only creates a reviewable
  authorization checkpoint; it does not enforce production deployment.

## Owner action needed before declaring release controls complete

1. Keep the repository private. Upgrade the applicable GitHub owner plan to
   **GitHub Pro** for a personal repository or **GitHub Team** for an organization
   if necessary. Do not make the source code public merely for protection.
2. Open GitHub repo Settings → Branches or Rules → Rulesets.
3. Protect `prod-release`, require pull requests, require 1+ qualified
   approving review(s), successful **Fast CI**, **Semantic Search CI**, and
   **Main / PR certification** on the exact candidate (verify job names).
4. Disallow force pushes and branch deletion; enforce for administrators.
5. Verify that Vercel's Production Branch and Git auto-deploy behavior
   cannot promote unreviewed commits without a separately authorized release.
   GitHub alone cannot impose a human GO LIVE requirement on Vercel.
6. Re-read the effective GitHub ruleset; verify an unauthorized direct push
   is rejected safely on a disposable canary/test branch before considering
   production protected.
7. Keep a known-good deployment for rollback and a documented incident path.

## Human approval attestation

The workflow `.github/workflows/release-authorization.yml` can be manually
dispatched by the repository owner with the exact PR number and HEAD SHA and
a matching phrase `GO LIVE <40-character-SHA>`.

It validates a *read-only* attestation against current GitHub PR metadata and
writes an audit summary. **It does not merge, migrate or deploy.** Its success
alone is not proof of authorization from the user in an unrelated agent session.

Each agent must independently see/obtain current user approval for the exact
release and ensure all environmental restrictions are followed.

## Emergency and rollback

If a security leak is discovered, fail closed in a reviewed staging patch,
request expedited promotion authorization, and monitor an exact SHA.
Do not blindly run an old database `down()` migration that republishes data.
