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

## GitHub Free limitation
This PRIVATE repository currently cannot enforce branch protection/rulesets
under the current GitHub plan. These agent instructions and CI checks are
valuable controls but NOT platform-level protections. The repository owner
must enable GitHub Pro/Team (or an eligible plan) and configure required
branch rules to truly block unauthorized direct pushes.

Production release automation must not be wired to manual approval workflows
until actual branch protections and Vercel deployment settings are verified.

Do not report production branch protection as PASS while GitHub says
`prod-release.protected=false`.
