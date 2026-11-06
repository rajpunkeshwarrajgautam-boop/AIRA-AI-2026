# AIRA AI 2026 — Agent and Release Authority

This applies to automated coding agents, including Antigravity, Agency Agents,
ChatGPT Work, CI assistants and other development agents in this repository.

## Agent autonomy and scoped production authority
Agents may complete an owner-assigned engineering task end to end within its stated
scope, without repeatedly asking for approval for each command. This includes
repository inspection, feature-branch edits and pushes, CI, staging and disposable
database rehearsals, read-only production diagnostics, release documentation,
backup integrity verification, and other non-destructive preflight work.
Preserve staging and production isolation, secrets, and existing workloads.

A task request, CI PASS, an internal review, an agent report, or "Ready" is
**not** by itself authorization for a live production mutation.

The sole release authority is repository owner `rajpunkeshwarrajgautam-boop`.
Before the **first** production-changing action in a cutover, obtain one
explicit, bounded owner authorization identifying:
- The exact PR number, full 40-character candidate HEAD SHA, target branch,
  environment, project/database identity, and deployment domain.
- Each authorized production operation in order, including the specific
  migration filenames, infrastructure resources, and worker activation stage.
- The verified backup/restore evidence, rollback target and stop conditions.
- Any spending limit, cloud account upgrade, deletion or irreversible cleanup
  explicitly authorized; such actions are never implied by a software GO LIVE.
- The authorization window and the responsible operator.

Once owner authorization is recorded, agents may perform **only its enumerated
operations in the approved order** without requesting redundant permission at
each substep. Mandatory workflow attestation and trusted App-issued commit status
must pass **before PR merge and production deployment**. Branch protections,
preflight health checks, and stop conditions remain binding at every stage.
Do not bypass a guard merely because a human message appears to approve release.
A later pull request or release SHA never inherits an earlier approval.

**Pause and obtain new explicit authority** if the SHA changes, the authorized
window expires, the target environment/project/domain or migration set changes,
the cost/scope grows, a destructive action was not authorized, the backup or
rollback plan fails, or any release gate becomes red. Never silently expand
authorization or substitute another infrastructure target.

Do not force push, use `git reset --hard` on someone else's workspace,
bypass CI, weaken authentication, disable release gates, or expose credentials.

## Release protocol
1. Inspect the live production SHA, branch, project and previous deployment.
2. Prepare a reviewable PR against `prod-release`.
3. Obtain successful mandatory CI and independent staging/browser acceptance.
4. Document the exact PR/head SHA, Vercel deployment, migrations and risks.
5. Present one exact-SHA, bounded GO LIVE decision covering the intended cutover;
   include any production migrations, worker activation, and deployment steps.
6. After valid owner approval, execute only the listed operations in order.
   Verify the live dual-evidence release gate before merging; monitor
   post-release and report outcomes. Stop at the first failed gate.
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
   - Authoritative live verification is executed via `npm run verify:release-auth -- --pr <num> --sha <sha>`, which verifies GitHub API dual evidence: authentic owner workflow run (`rajpunkeshwarrajgautam-boop`), matching commit status `release/go-live-authorized=success` from the dedicated GitHub App issuer specified by `AIRA_RELEASE_GATE_APP_BOT_LOGIN` (for example, `aira-release-gate[bot]`; **not** `github-actions[bot]`), verified provenance linkage (`target_url` points to run ID on authorized repository), temporal correlation anti-replay check (<=15m delta), and <24h freshness. Active revocation is available via `npm run revoke:release-auth`.
5. An agent must STOP at the first unauthorized production mutation and present
   verified evidence. Following valid, bounded authorization, execute the
   approved cutover steps without redundant re-approval; stop on any material
   deviation or failed gate.

## Agent skills

### Issue tracker
GitHub Issues is the primary tracker for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels
Standard five-role triage vocabulary mapped to AIRA development workflows. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context domain modeling with root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
