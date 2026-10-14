# AIRA AI 2026 — Explicit Production Release Authorization

**Status: GitHub production branch ruleset ACTIVE; separate Vercel deployment approval remains unverified.**

The production branch is `prod-release`. The production Vercel project is
`aira-ai-2026`, ID `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`.

## GitHub protections (independently verified 2026-10-14)

- GitHub Pro is active; the repository remains private.
- GitHub reports `prod-release.protected=true`.
- Ruleset `AIRA Production Protection`, ID `25079946`, is ACTIVE,
  matching exactly `refs/heads/prod-release`.
- No bypass actors are configured.
- Pull requests, conversation resolution, Fast CI, Semantic Search CI,
  Main / PR certification and branch-up-to-date checks are required.
- Force pushes and branch deletion are denied.
- Required approving reviews: 0 because there is currently one maintainer.
  This is an explicit accepted limitation: it does NOT enforce a second
  person's approval.
- Manual GO LIVE attestation is an audit checkpoint and not a platform
  deployment approval gate.
- Vercel Git-driven production deployment behavior still requires separate
  confirmation: merging into `prod-release` may trigger deployment.

## Remaining release-control work

1. Preserve the active GitHub ruleset and review its effective rules after any
   material CI or branch naming changes.
2. Verify Vercel's production branch, auto-deploy triggers, ignored-build
   policy and promotion authorizations so a merge alone cannot bypass the
   owner's explicit GO LIVE decision.
3. Add an independent reviewer as the team grows, then increase required
   approvals to 1 or more. Do not impose an impossible self-review gate on
   the sole maintainer.
4. Keep a known-good deployment for rollback and document the incident path.
5. Verify with an innocuous test branch that effective rules protect the
   intended production branch; never test unauthorized pushes directly
   against live `prod-release`.

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
