# AIRA AI 2026 — Agent and Release Authority

This applies to automated coding agents, including Antigravity, Agency Agents,
ChatGPT Work, CI assistants and other development agents in this repository.

## Strict deployment authority
- NEVER infer permission to merge to `prod-release`, apply production Neon
  migrations, change live aliases, or move domains from a previous deployment.
- "Auto-proceeded", an internal review policy, a simulated approval, CI PASS,
  "Ready", or an unverified agent report are NOT user authorization.
- Obtain a fresh, explicit **GO LIVE** instruction for the exact SHA and
  target environment before every production-changing operation.
- Pause and request approval again if the SHA, database migration, project,
  domain or release target changes after authorization.
- Production approvals do not cascade to a later unrelated pull request.
- Production operations require a verified rollback target and passing,
  exact-commit CI and staging acceptance.
- Default to isolated branches and Neon staging for all code/database tests.
- Do not force push, use `git reset --hard` on someone else's workspace,
  bypass CI, weaken auth, or expose sensitive credentials.

## Release protocol
1. Inspect the live production SHA, branch, project and previous deployment.
2. Prepare a reviewable PR against `prod-release`.
3. Obtain successful mandatory CI and independent staging/browser acceptance.
4. Document the exact PR/head SHA, Vercel deployment, migrations and risks.
5. Request and wait for explicit GO LIVE approval.
6. Execute only those authorized changes, monitor post-release, report outcomes.
7. Roll back when authorized by incident policy or when the user expressly
   requests rollback. Never claim success before verification.

## Verified platform protection (2026-10-14)
GitHub Pro is active. Ruleset `AIRA Production Protection` (ID `25079946`)
is ACTIVE on `refs/heads/prod-release`, with NO bypass actors.
GitHub API verifies `prod-release.protected=true`, mandatory PRs,
conversation resolution, Fast CI, Semantic Search CI and Main / PR
certification, strict up-to-date checks, force-push and deletion denial.
Approval count is 0 (sole maintainer); this is NOT independent reviewer
approval or an explicit production deployment authorization.

Do NOT weaken this ruleset to merge a PR. If mandatory checks are missing,
repair CI and verify that the exact commit has run all required checks.

Vercel production Git deployment behavior must still be verified and
separately constrained. A green PR/CI or GitHub ruleset does NOT constitute
the user's GO LIVE authorization.
