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
is ACTIVE on `refs/heads/prod-release`.
GitHub API verifies `prod-release.protected=true`, mandatory PRs,
conversation resolution, Fast CI, Semantic Search CI and Main / PR
certification, strict up-to-date checks, force-push and deletion denial.
Approval count is 0 (sole maintainer); this is NOT independent reviewer
approval or an explicit production deployment authorization.
Note: "Zero bypass guarantees" must not be claimed; repository administrators
retain organization-level management rights. The ruleset prevents accidental
non-PR pushes and enforces CI gates before merge.

Do NOT weaken this ruleset to merge a PR. If mandatory checks are missing,
repair CI and verify that the exact commit has run all required checks.

## Verified Vercel production release architecture & controls (2026-10-14)
Live Vercel API and project inspection confirm the following configuration:
- Project: `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`)
- Organization: `team_0IZkX9o2Ab319UsAPW9oq1SL` (rajpunkeshwarrajgautam-boop's projects)
- Account tier: `Hobby` (Personal account)
- Tracked production branch: `prod-release`
- Canonical production URL: `https://aira-ai-2026.vercel.app`
- Auto-deploy: `gitProviderOptions.createDeployments: "enabled"`
- Ignored build step: `[ "$VERCEL_GIT_COMMIT_REF" = "main" ] && exit 0 || exit 1`
  (Pushes to `main` are ignored with exit 0; pushes/merges to `prod-release` exit 1 and build immediately)
- Native deployment approval: NOT supported on Hobby tier (requires Enterprise/Pro).
- Build database gate: `vercel.json` enforces `npm run db:verify:deploy` on production builds
  prior to `npm run build`. Builds fail and abort if Neon PostgreSQL migrations or schemas are missing.

### Strict release consequence & deployment reality:
Because Vercel triggers a production deployment automatically upon receiving any commit on `prod-release`:
1. **Merging a PR into `prod-release` IS the live production deployment trigger.**
   Production deployment controls are NOT natively enforceable inside Vercel on the Hobby tier.
   Upstream PR merge gating on GitHub is the primary barrier preventing unauthorized production deployment.
2. No agent, automated script, or CI process may merge any PR into `prod-release` without prior,
   explicit, human GO LIVE authorization from repository owner `rajpunkeshwarrajgautam-boop`.
3. Manual promotion via Vercel CLI (`vercel promote`) is strictly forbidden for agents.
4. **Separation of unit tests from live authorization**:
   - `npm run test:release-auth:unit` runs in Fast CI to verify the authorization rules engine deterministically. Passing this test does NOT grant GO LIVE authorization.
   - Authoritative live verification is executed via `npm run verify:release-auth -- --pr <num> --sha <sha>`, which verifies GitHub API dual evidence: authentic owner workflow run (`rajpunkeshwarrajgautam-boop`), matching commit status `release/go-live-authorized=success` from trusted issuer `github-actions[bot]`, verified provenance linkage (`target_url` points to run ID on authorized repository), temporal correlation anti-replay check (<=15m delta), and <24h freshness. Active revocation is available via `npm run revoke:release-auth`.
5. An agent must STOP and present all verified evidence, awaiting human authorization.

## Agent skills

### Issue tracker
GitHub Issues is the primary tracker for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels
Standard five-role triage vocabulary mapped to AIRA development workflows. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context domain modeling with root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
