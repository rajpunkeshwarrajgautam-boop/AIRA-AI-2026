# AIRA AI 2026 — Production Certification Audit

**Audit date:** 2026-10-10  
**Decision:** **NOT CERTIFIED — BLOCKERS REMAIN**  
**Scope:** GitHub Actions, Vercel deployment metadata, Neon database metadata and read-only checks.  
**No production domain, database data or project settings were modified.**

## Source / deployment identity

- Repository: `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`
- Default branch: `main`
- Inspected main SHA: `20439a972cc71c0146ec1fdcbf4f7959781d3db0`
- Main CI: [run 38033559403](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38033559403), **SUCCESS**, three jobs
- Inspected staging SHA: `ed9cab86239ec4fcd7ad4d46b415338b3c3f4045`
- Staging CI: [run 38036965928](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38036965928), **FAILURE**, three jobs passed; deployed staging acceptance failed
- Vercel project: `aira-ai-2026` / `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`
- Preview deployment: `dpl_J8bf2ZPnZaL8on1AP4DkkdnsWonX`, **READY**, Git branch `staging`, Git SHA `ed9cab86239ec4fcd7ad4d46b415338b3c3f4045`
- Preview URL: https://aira-ai-2026-n9dqzwb2g-rajpunkeshwarrajgautam-boops-projects.vercel.app/
- Existing rollback Vercel project: `aira-ai-live`, still owns `aira-ai.in` and `www.aira-ai.in`

## Certification matrix

| Gate | Status | Evidence / limitations |
| --- | --- | --- |
| Main Fast CI | PASS | Main run 38033559403 |
| Main semantic-search CI | PASS | Main run 38033559403 |
| Main integration / E2E certification | PASS in CI | Main run 38033559403; test environment, **not production runtime** |
| Staging Fast CI | PASS | Staging run 38036965928 |
| Staging semantic search | PASS | Staging run 38036965928 |
| Staging integration / E2E certification | PASS in CI | Staging run 38036965928, local CI environment |
| Exact SHA Vercel deployment metadata | PASS (inspection) | Preview READY at the checked staging SHA through Vercel deployment detail |
| GitHub staging Vercel attestation | BLOCKED | Job 114170091424: `VERCEL_TOKEN` absent from Actions; fails closed before live tests |
| Deployed staging desktop/mobile acceptance | NOT TESTED | Skipped following failed attestation; protected preview also denied connected fetch (403) |
| Neon staging schema (read only) | PASS (basic) | Separate project `mute-frost-50372225`, PostgreSQL 18.6, 15 applied migrations, pgvector installed; 23 tables |
| Neon production schema (read only) | PASS (basic) | Separate project `old-sky-50952395`, PostgreSQL 18.6, 15 applied migrations, pgvector installed; 23 tables |
| Live auth, AI chat, provider research, agents, workflows, browser actions | NOT TESTED | No authenticated end-to-end production test evidence |
| Dependency vulnerability review | FAIL / UNRESOLVED | `npm ci` in staging acceptance logged 11 vulnerabilities (2 moderate, 9 high); no package-level disposition established |
| Protected default branch / required checks | UNRESOLVED | GitHub branch metadata reports `main.protected=false`; protection administrative endpoint unavailable to connection (403) |
| Production deployment certification | NOT CERTIFIED | Build READY is not runtime certification |
| Rollback project continuity | PASS (metadata) | `aira-ai-live` project and existing custom domains still present |
| Domain cutover | NOT AUTHORIZED | Domain must remain on existing project until separate approval |

## Root cause of latest staging failure

- Failing step: **Attest Vercel Preview exact staging SHA**
- GitHub Actions runner log: `VERCEL_TOKEN: ` (empty)
- Script assertion: `VERCEL_TOKEN repository secret is required for Vercel attestation`
- Thus this is a credential/configuration blocker **before** Playwright reaches the preview. Do not remove or skip the attestation to make CI green.
- `VERCEL_TEAM_ID` is also empty in runner logs; the script currently has a fixed fallback ID, so its absence is **not** the direct failure.

## Remediation on PR #38

Branch: `fix/staging-certification-fixture-20261010`, based on staging SHA `ed9cab86...`.

1. Preserve LaTeX delimiters by passing the staging fixture as a `page.evaluate` argument using `String.raw` rather than injecting an escaped JavaScript string; avoids silent fixture corruption.
2. Require explicit `VERCEL_GIT_COMMIT_REF === staging` before the isolated staging database migration.

These changes must pass their own PR CI and deployed staging acceptance before they are merged and certified.

## Required credentials and operational actions

1. Configure GitHub Actions **repository secret** `VERCEL_TOKEN` with appropriately scoped access to Vercel team `team_0IZkX9o2Ab319UsAPW9oq1SL`, project `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`, and deployment listing / metadata inspection.
2. Configure GitHub Actions **repository variable** `VERCEL_TEAM_ID=team_0IZkX9o2Ab319UsAPW9oq1SL` explicitly (rather than relying on the source-code fallback).
3. Since protected Vercel previews use SSO, configure repository secret `VERCEL_AUTOMATION_BYPASS_SECRET` as appropriate for the protected preview test. Keep all credentials out of logs, commits and documentation.
4. Verify the GitHub Actions run can attest the READY immutable preview at the **exact expected commit**, then execute browser acceptance in desktop and mobile modes.
5. Triage the 9 high-severity dependency findings; distinguish exploitable production dependencies from non-runtime development packages and remediate as needed. Do not disable audits to hide findings.
6. Configure protected-branch required checks and suitable review / release controls for `main` once available with repository administration permissions.
7. Perform authenticated production-candidate runtime testing: real chat, auth, persistence, research providers, workflows, AIRA Bot, security and browser actions.
8. Keep `aira-ai.in` and `www.aira-ai.in` on `aira-ai-live` until full certification and separate cutover authorization.

## Release decision

**NOT CERTIFIED — BLOCKERS REMAIN.**

This document records an observed checkpoint, not a release attestation. Do not reinterpret GitHub CI success, Vercel READY, mocked provider tests or schema presence as proof of all live capabilities.
