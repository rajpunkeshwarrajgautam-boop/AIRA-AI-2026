# AIRA AI 2026 — PR #171 Release Certification and Residual Gates

**Certification date:** 13 November 2026  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Pull request:** [#171](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/171)  
**Candidate code SHA independently exercised before this document commit:** `227a33f933e9a9a065d9bc43b71a4f523a28c71b`  
**Production baseline SHA:** `f989d9352d581398cbbc4e6a97af34f897387fb2`  
**Decision:** **NO GO for production merge. Draft PR remains open.**

> This is a point-in-time certification record. The final PR HEAD after documentation commits must be verified separately using the actual GitHub checks. A green Preview build does not equal OAuth, paid-plan, account-isolation or remote MCP egress certification. Do not downgrade unresolved release gates to “PASS” in a later summary.

## Engineering work preserved and completed

The underlying PR implements the audit remediation for SEC-01, SEC-02, SEC-03, UX-01 through UX-05, API-01, OPS-01 and HARDEN-01. Follow-up security corrections added verified operator and tenant boundaries to the MCP API and tool gateway; redacted configuration, URL, connection and execution errors; required user approval for externally sourced tool effects; and introduced regression tests. Production remote HTTP/SSE MCP remains disabled before DNS or transport construction because the SDK’s connection-time DNS and redirects are not yet bound to a verified egress policy.

Further continuation added:

1. A dedicated PR-only deployed-preview certification workflow: `.github/workflows/pr171-preview-live-acceptance.yml`, using `scripts/attest-pr171-preview.mjs`. The workflow attests the current PR HEAD against the Vercel branch alias, polls during preview propagation, tests deployed readiness and response headers, and runs headless Microsoft Edge at desktop and mobile viewports. Its GitHub token is read-only, and it does not need model, database or OAuth credentials.
2. A bounded, read-only PostgreSQL connection probe through `createDatabaseReadinessProbe` in `apps/api/src/runtime-readiness.ts`, integrated into `/api/health` and `/api/ready`. It executes `SELECT 1`, de-duplicates requests, caches short-lived results, times out, and never publishes DB-driver exception text. Tests cover concurrency, timeout and recovery.
3. Real deployed Edge screenshot capture in `artifacts/pr171-deployed-browser/` (GitHub Actions artifacts), plus a structured acceptance ledger at `artifacts/pr171-preview-acceptance.json`.
4. An actual Vercel **Preview-only, branch-scoped sensitive** `DATABASE_URL` for the exact PR branch, bound to an existing, non-default Neon testing branch and its staging-only runtime role. No production Vercel variable, production Neon resource or production data was changed.

## Verified deployment and database identity

| Field | Observed / controlled identity |
| --- | --- |
| Vercel project | `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` |
| Preview branch | `fix/security-entitlement-ux-remediation-20261113` |
| Neon project | `mute-frost-50372225` |
| Isolated Neon branch | `br-snowy-bonus-b32thjlz` (non-default, non-primary) |
| Runtime database / role | `neondb` / `aira_staging_runtime` |
| Deployed preview for tested code | `dpl_HooUXVVzJmgFAWwssAdr8jBXa3e5` |
| Immutable preview URL | `https://aira-ai-2026-g1t38gzv9-rajpunkeshwarrajgautam-boops-projects.vercel.app` |
| Production deployment | **Not performed**; baseline preserved |

On the code candidate `227a33f9`, deployed `/api/version` returned HTTP 200 with the exact commit SHA; `/api/health` returned `HEALTHY` / `READY` with the live PostgreSQL probe reporting `REACHABLE`; and `/api/ready` returned HTTP 200 with `READY`. The readiness proof is more than a configured URL: it requires an actual SELECT to complete. These probes do not prove multi-tenant runtime transactions or authenticated inference execution.

## Executed checks and artifact references

- [Deployed Edge, health, HTTP security and guest acceptance — GitHub Actions run 43448666430](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43448666430): **PASS** for `227a33f9`. Actual Edge 1440×900 desktop and 390×844 mobile exercised guest synthetic chat display, mathematics, scrolling, layout and viewport. Deployed Vercel SHA, health, readiness, security headers and structured anonymous MCP denial verified. Screenshots and JSON ledger uploaded by this workflow.
- [Earlier deployed failure — run 43447749510](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43447749510): the probe correctly observed DB readiness PASS but its unauthenticated MCP assertion was too narrow (the global principal middleware returns `error: "Unauthorized"` rather than the route-level `AUTHENTICATION_REQUIRED`). This was corrected to accept only known application JSON denial codes; **authorization was not weakened**.
- [Source-level CI and Main / PR certification](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions): Fast CI, Semantic Search CI, isolated PostgreSQL tests, GitGuardian, and local Playwright acceptance ran through required checks on earlier verified SHAs. Check the final documentation HEAD independently; passing previous SHA jobs is not enough.
- `.github/workflows/ci.yml` includes the real DB-readiness probe tests. These are unit tests; they do not substitute for deployed authenticated OAuth validation.

## Eleven audit findings — evidence distinctions

| Finding | Code / regression condition | Remaining real acceptance |
| --- | --- | --- |
| SEC-01 | MCP management stdio and operator authorization guarded | Google/GitHub user-and-operator negative API cases |
| SEC-02 | MCP tenant ownership, execution-time authorization and redaction in code and negative tests | Real two-account MCP config and tool isolation |
| SEC-03 | **Remote HTTP/SSE MCP intentionally disabled in public production/Vercel runtimes** | Secure connection-time IP binding, TLS/SNI, redirects, proxy/SSE/reconnect coverage before re-enable |
| UX-01, UX-02, UX-03 | Guest Agent messaging, model tier routing and entry-point gating updated in source and regression tests | Genuine authenticated model selection and tier UX |
| API-01 | Minimum required tier derived from commercial contracts, not hardcoded Pro | Direct API requests from real Free, Plus and Pro identities |
| UX-04 | Help Center/provider claims corrected in source | Full deployed authenticated walkthrough |
| UX-05 | Billing unavailable distinct from verified Free | Live payment-provider failure and recovery with real account |
| OPS-01 | Registered-versus-live provider status and live DB readiness guarded; deployed SELECT succeeds | Authenticated long-running agent/worker and upstream model verification |
| HARDEN-01 | Deployed CSP, HSTS, nosniff, framing and no-store headers observed | Authenticated cookies, CORS/CSRF and SSE compatibility at final SHA |

## Mandatory remaining gates — no fabricated PASS

1. **Genuine Google and GitHub OAuth-backed two-principal staging:** NOT EXECUTED for the final candidate. Required: real sign-in/callback, persistence, refresh, logout, revocation and cross-account switching, IDOR across conversations/memory/projects/files/MCP/runs/approvals/SSE and cancellation.
2. **Authoritative Guest / Free / Plus / Pro commercial matrix:** source and local tests exist; **not executed end-to-end with four genuine subscription identities**. Do not change customer entitlements or paid billing for test convenience.
3. **Real authenticated model inference/SSE/agent tool execution:** not verified against the candidate using two real users, their quota ledgers, agent persistence, cancellation and non-mock provider output.
4. **Remote customer MCP:** deliberately unavailable on production/Vercel until outbound transport guarantees address pinning, HTTPS/SNI, redirect handling and no bypass across all SDK paths. Do not silently enable this transport.
5. **Final exact-SHA release certification:** after any documentation/code commit, verify the new PR HEAD, required protected branch checks, Vercel exact-SHA preview and deployment acceptance. The permanent `Deployed staging acceptance` job on `ci.yml` remains intentionally staging-branch-only; the separate PR preview workflow actually runs and must PASS.

The available ChatGPT browser connection can only **read** open tabs. The full authorized interactive Microsoft Edge debugging and real OAuth account sessions on the user's Windows desktop are not controllable through that connector. The CI Edge guest acceptance was genuine deployed browser execution, not a claim of successful OAuth sessions.

## Release boundary and rollback

The repository's `AGENTS.md` standing release delegation requires not only code-only CI but **genuine staging/browser, account isolation and security acceptance**. Merging PR #171 into protected `prod-release` automatically triggers Vercel production deployment. The operational rollback reference is the still-running production commit `f989d9352d581398cbbc4e6a97af34f897387fb2`; verify its live deployment ID before any release.

**No production merge, production migration, production environment mutation, secret rotation or production paid-tier change was made.** The only configuration change was a branch-specific Vercel Preview database variable, scoped to the pre-existing isolated staging Neon branch.

**Final disposition: DRAFT / NO GO** until genuinely authenticated OAuth + plan matrix + tenant/inference acceptance and relevant security obligations are observed, and the final exact SHA passes all mandatory checks. The operator must not merge or claim a fully certified production release while these gates are unresolved.
