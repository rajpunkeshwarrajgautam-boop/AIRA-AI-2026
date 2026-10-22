# AIRA AI 2026 — Tier B Release Authorization (Dedicated GitHub App)

**Status:** CODE ONLY; no GitHub App installed, no protected Environment configured, no production Ruleset changes, no production release authorized.

**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Protected production branch:** `prod-release`  
**Current production Ruleset:** `25079946`  
**Required approval context (planned):** `release/go-live-authorized`

## Why Tier B exists

The previous design published a commit status from the common `github-actions[bot]` identity before its attestation workflow had completed. Native GitHub Rulesets do not run `npm run verify:release-auth`; their enforcement is based on required status/check state and optionally a specific GitHub App source.

Tier B separates owner attestation and status publication:

1. `.github/workflows/release-authorization.yml` is dispatched only by the repository owner **on prod-release**. It has **no `statuses:write` and no App credentials**, and validates an open, non-draft, same-repository PR targeting prod-release, the exact head SHA, and the literal `GO LIVE <SHA>` phrase.
2. GitHub marks the attestation workflow run **completed**. A separate `workflow_run: completed` trigger starts `.github/workflows/release-authorization-publisher.yml` from the protected default branch.
3. The publisher checks out **only prod-release**, then validates the finished owner run and live PR through GitHub REST using a **read-only GITHUB_TOKEN**. It rejects stale/future runs, wrong actors, non-default branch, bad run identity, mismatched SHA or title, closed/draft/fork PRs, and wrong repo.
4. Only after the read-only validation succeeds, the publisher accesses the **release-gate Environment** and mints a repository-scoped **dedicated GitHub App installation token** with `permission-statuses: write`. It revalidates before emitting `release/go-live-authorized=success` on the exact PR HEAD. This preserves the source App identity.
5. A separate **owner-only** `release-authorization-revoke.yml` posts an App-issued **failure** status with exact `REVOKE <SHA>` input. The obsolete shared-bot revocation CLI now fails closed.
6. GitHub Ruleset 25079946 must, **after independent owner authorization**, require this exact context **with the new App integration ID** (not shared GitHub Actions integration 15368).

The App's token is never available to a pull-request build, the first owner-attestation workflow, or the publisher's read-only verification step. The App key must be an **Environment secret**, **not** a repository-wide secret.

## Explicit owner setup required (NOT PERFORMED)

These steps require the account owner and their separate authorization:

1. Create a dedicated GitHub App under GitHub **Settings → Developer settings → GitHub Apps** named/slugged **aira-release-gate** (or another unique slug if unavailable). Set repository permission **Commit statuses: Read & write**; metadata read is implicit. No repository administration, contents write, pull-request write, deployment or Actions write permission is required. If the GitHub Ruleset source picker requires a recently authored Check Run, assess a temporary limited **Checks: Read & write** permission and an App-issued canary check before adding the required check; do not broaden permissions without a reason.
2. Install the App **only** on `AIRA-AI-2026`. Record its App/integration ID, **Client ID**, and exact bot login (usually `<app-slug>[bot]`). Do not paste/download/upload the private-key PEM into chat, source files, or logs.
3. In the repository **Settings → Environments**, create the Environment named exactly **release-gate**. Restrict deployment branches to the protected branch **prod-release** (no tags, no arbitrary branches). Before activation, verify an untrusted PR workflow cannot access these Environment secrets.
4. Under the **release-gate Environment**, set nonsecret variable `AIRA_RELEASE_GATE_APP_CLIENT_ID` and secret `AIRA_RELEASE_GATE_APP_PRIVATE_KEY` to the App Client ID and GitHub-generated PEM. Keep this key out of repo-level secrets and all PR workflows. Pin and review external Actions dependencies as part of owner acceptance.
5. For manual read-only verification, set local environment variable `AIRA_RELEASE_GATE_APP_BOT_LOGIN` to the App bot login, e.g. `aira-release-gate[bot]`; `npm run verify:release-auth -- --pr <number> --sha <40-character-sha>` must reject absent or wrong App issuer. No credential is needed for this verifier.
6. Do a **disposable canary** on an unmerged candidate PR and verify that the owner attestation finishes before any App-issued approval. Test wrong SHA, non-owner, wrong branch, revoked status, cancellation, and source attribution. Do not merge any canary. Test actual GitHub Ruleset expected-source enforcement on a disposable protected target with owner authorization; current source workflow only issues approvals for prod-release and may require a canary-only workflow variant. Never claim this part is live-tested before the App exists.
7. Owner explicitly authorizes the **bootstrap merge of PR #64** into prod-release under current checks; this triggers normal Vercel production auto-deployment. **Not authorized by implementation work.**
8. Verify trusted workflows are registered on prod-release and App/Environment configuration works without approving a real production release. Perform the separate, approved canary acceptance.
9. Only after owner approval, add `release/go-live-authorized` to Ruleset 25079946 with **integration_id of the dedicated GitHub App**. Keep existing Fast CI, Semantic Search CI, Main / PR certification and strict up-to-date setting unchanged. Check source attribution and an unapproved PR's inability to merge.
10. Require fresh explicit owner authorization for every future production candidate. A green status alone is not evidence that the verifier ran at merge time; the trusted App publishing logic and expected-source Ruleset are the security boundary.

## Invariants and limitations

- **No automatic 24-hour TTL:** GitHub preserves successful statuses until a superseding status or new commit. The CLI verifier checks freshness; GitHub does not execute it at merge time. Owner revocation must be App-issued. A future time-based expiry automation requires separate design and authorization; no 24-hour merge-time guarantee is claimed.
- **No automatic cancellation revocation guarantee:** the split workflow emits success only after the original attestation run finishes, so cancellation/failure does not create a new success. Previously successful statuses on the same SHA remain until explicitly revoked.
- **No merges or deployment:** neither workflow merges, changes branches, runs migrations, edits domains, nor deploys intentionally. A separate authorized PR merge into prod-release may automatically trigger Vercel production.
- **No active App canary yet:** deterministic publisher tests exercise the actual validation/publishing functions with simulated GitHub API responses, not a live installed App.
- **Blast-radius control:** environment secrets confined to protected branch and a separate trusted workflow, App installed only on this repo, token explicitly `statuses:write`, no privilege to change code/rulesets/production databases.
- **Review boundary:** changing any protected workflow, publisher script, CI, or release policy through a merged PR can alter policy. Protect these paths with owner review/CODEOWNERS as appropriate.
- **Repo-owner administrative control:** the repository owner can change the App, environment or ruleset; this is not an immutable external veto.

## Branch-only acceptance evidence

`npm run test:release-auth:unit` — previous 52 authorization cases, adjusted for App issuer.  
`npm run test:release-auth:app` — separate deterministic App publisher test suite.  
`npm run typecheck`, `npm run lint`, `npm run build` and all three required GitHub CI jobs must pass on the **final** PR #64 SHA.

**Do not call Tier B active until the App is installed, the protected Environment configured, the bootstrap merge separately authorized and completed, and the Ruleset is verified to require the App's integration ID.**
