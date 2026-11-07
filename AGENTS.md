# AIRA AI 2026 — Agent and Release Authority

This applies to automated coding agents, including Antigravity, Agency Agents,
ChatGPT Work, CI assistants and other development agents in this repository.

## Standing delegation for bounded code-only production releases
Repository owner `rajpunkeshwarrajgautam-boop` delegates routine engineering
decisions and code-only releases to the trusted release operator. Do **not**
request a separate human `GO LIVE <SHA>` phrase for each eligible release. This
delegation replaces the recurring owner-attestation step, **not** the protected
branch, CI, staging, isolation, security, or deployment verification gates.

Agents may complete assigned engineering tasks, feature-branch changes, CI,
staging/browser testing, safe release preparation and exact-SHA PR merges
without repeated human permission, subject to the following hard conditions:

- Target is exactly `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`, `prod-release`,
  Vercel project `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`, canonical URL
  `https://aira-ai-2026.vercel.app`. Never substitute infrastructure targets.
- The release operator independently verifies the **current** PR HEAD SHA,
  mandatory GitHub protections/CI, security scan, preview deployment and
  relevant genuine staging/browser acceptance. A green self-reported checklist
  or mocked E2E test alone is not sufficient evidence.
- The change has **no production DB migration, destructive data operation,
  secret rotation, auth/permission bypass, worker activation, infrastructure
  resource change, paid-tier upgrade, or new cloud spending**. Those operations
  remain outside standing delegation and require separately bounded authority.
- All material security, concurrency, persistence and regression findings are
  resolved and independently verified. On unresolved findings, **NO GO**;
  the operator may repair and recertify within the delegated engineering scope,
  but must not merge a failing candidate to save time.
- Before merge, record PR, exact SHA, CI run IDs, preview identity, rollback
  target and stop conditions. Use exact-head merge with branch protection
  enforced, never force-push or direct-push to production.
- After merge, confirm the Vercel deployment SHA and production health. If
  production verification fails, stop further releases, record an incident,
  and perform recovery only when the rollback method and target are verified.

The conservative `.github/workflows/autonomous-release.yml` handles eligible
**non-executable/static-only** PRs automatically with the protected-branch
release operator in `scripts/autonomous-release.mjs`. Other code-only PRs may
be released by a trusted engineering operator after independent evidence-based
review under the same standing delegation. No new owner decision is needed for
that bounded work. The legacy App-backed owner attestation remains available
for exceptional releases but is no longer the default process.

**Stop rather than expand authority** when the environment, database target,
migration set, cost, deletion scope, or security posture changes. Do not
weaken branch protections, silence a failing test, or invent release evidence.

Do not force push, use `git reset --hard` on someone else's workspace,
bypass CI, weaken authentication, disable release gates, or expose credentials.

## Release protocol
1. Inspect the live production SHA, branch, project and previous deployment.
2. Prepare a reviewable PR against `prod-release`.
3. Resolve all substantive findings; obtain mandatory CI, independent preview
   and live browser acceptance appropriate to the change.
4. Check scope against the standing delegation and record the exact SHA,
   Vercel preview, migrations (must be zero), risk and rollback target.
5. For a bounded code-only change, make the technical **GO/NO-GO** decision
   without an owner approval round-trip. For any out-of-scope production
   mutation, stop and request specific additional authority.
6. On GO, merge the exact SHA only through the protected PR route, monitor
   production and report evidence. Stop and freeze on the first failed gate.
7. Recover from incidents using a verified rollback plan; do not report a
   successful deployment before observing the live SHA and health.

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
2. A trusted operator may merge eligible, verified, code-only PRs under the
   standing delegation above. The automated operator is additionally limited
   to static-only, owner-authored PRs with exact-SHA checks. No actor may bypass
   GitHub ruleset `25079946` or merge an uncertified candidate.
3. Manual promotion via Vercel CLI (`vercel promote`) is strictly forbidden for agents.
4. **Separation of unit tests from release eligibility**:
   - `npm run test:release-auth:unit` runs in Fast CI to verify the authorization rules engine deterministically. Passing this test does NOT grant GO LIVE authorization.
   - The legacy owner-attested path remains available through `npm run verify:release-auth -- --pr <num> --sha <sha>` and dedicated GitHub App status. It is **not** evidence of the new autonomous path. Autonomous eligibility comes from the trusted operator's independent, current GitHub API checks and branch protection enforcement.
5. An agent must STOP at any out-of-scope mutation or failed gate. Bounded
   releases no longer wait for the owner to repeat a commit-specific phrase.

## Agent skills

### Issue tracker
GitHub Issues is the primary tracker for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels
Standard five-role triage vocabulary mapped to AIRA development workflows. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context domain modeling with root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
