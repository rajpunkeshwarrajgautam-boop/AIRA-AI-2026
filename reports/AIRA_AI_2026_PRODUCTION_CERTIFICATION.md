# AIRA AI 2026 — Production Release Certification

**Audit date:** 2026-10-10  
**Decision: NOT CERTIFIED — BLOCKERS REMAIN**

This report replaces historical readiness claims with the observations below. PR #38 remains open and unmerged because mandatory deployed and application certification gates do not pass. Main and staging were not advanced. Domains `aira-ai.in` and `www.aira-ai.in`, and backup project `aira-ai-live`, were not modified. No Neon database migration was executed; CI migrated its own ephemeral databases. Live production API tests created small certification records through normal authenticated application endpoints; existing records were not deleted.

## Continuation evidence — 10 October 2026

**Verified code SHA: `f2b21a7704ec0c652542969114215068e357fb31`.** PR [#38](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/38) still targets staging on the original repair branch. Actions [38065902944](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38065902944) completed **SUCCESS** on this SHA. Fast CI (`114253373564`), Semantic Search CI (`114253373383`), Main / PR certification (`114253701195`), Dependency Security (`114253373602`) and Tailwind Visual Regression (`114253373520`) all passed. Deployed staging acceptance (`114254263395`) was **SKIPPED**, so workflow-level SUCCESS is not production certification. Earlier source run [38065225731](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38065225731) also passed on approval-fix SHA `e1f0e19facbdcd839739336257f63d7e0916f13b`, with deployed acceptance skipped.

### Dependency and visual repair — resolved in source

The five high Tailwind findings are resolved by a complete Tailwind/PostCSS 4.3.3 migration, lockfile regeneration, explicit source discovery, retained custom theme, preflight compatibility and utility updates. The full dependency graph audit in final CI reports **zero vulnerabilities**. No dependency exclusion or audit waiver was used.

Real Chromium compared compiled baseline `f2e9e36b2fac6ab0e524b606ed9253b89176ffe0` against the candidate: 12 home/composer comparisons at 390, 1024 and 1440 pixels, light and dark themes. Final artifact **`11674482909`**, `tailwind-visual-evidence`, contains before/after/diff PNGs and metrics, digest `sha256:09762014fc99b9edff9a14c739b5ebc641bc60d0f8e2fe44fc28aeb65886ec70`. Downloaded metrics show maximum changed-pixel ratio **0.298861%** and maximum composer geometry change **0 px**, within unchanged 1% / 2 px thresholds. Earlier failures led to an actual responsive line-height correction; thresholds were not relaxed. UI comparison uses controlled API fixtures and blocked external requests. It certifies these UI states, not live authentication, providers or the production browser runtime.

### Runtime and authorization repairs — passed source regressions

| Commit | Change |
| --- | --- |
| `83a408219a52533e49d6ef1b572f762ab189e91a` | Tailwind migration and mandatory real-browser visual job |
| `5af7c4698bc8af54ec9226bd648bf83c78633cd1` | Settle animation springs before screenshot comparison |
| `eeeebbfa75978579ff65649f767f5f818e171e5b` | Responsive line height; cron-parser API; remove duplicate scheduling claim; principal-bound automation owner; authenticated cron endpoint |
| `a4523a30c1cfe8c396580f4cb40d8299ede7b9ad` | Forward deterministic cycle time into schedule evaluation |
| `5c40c57f1f77e59835957c6186c2fe25bb7e35ba` | API regressions for owner spoofing, cross-owner trigger and guest cron denial |
| `e1f0e19facbdcd839739336257f63d7e0916f13b` | Approval actor ownership and resolved-by propagation; valid ALLOW decisions resume workflows; principal role shape |
| `eed9879c3caa7873ea3b6204451b5c3281dbb044` | Readable composer placeholder and separate API compiler diagnostic evidence |
| `f2b21a7704ec0c652542969114215068e357fb31` | Browser destination, DNS, redirect and subresource policy; TLS verification enabled |

Scheduled-claim regression uses real ephemeral PostgreSQL repositories and deterministic child execution fixtures. It verifies exactly one claim across stale/concurrent ticks; it does not prove an external scheduler or live AI execution. Cron requires a configured `CRON_SECRET` of at least 32 characters and uses timing-safe bearer comparison. Missing configuration returns 503, unauthorized access 401. Cron authorization is separate from guest workspace sessions.

Approval regressions verify wrong-owner decisions do not mutate state, correct actor identity is propagated, ALLOW_ONCE resumes an approved workflow, and REJECT stays rejected. Browser regressions cover private/reserved addresses, mixed DNS results and private redirects. Loopback fixtures are permitted only in local test environments without Vercel deployment metadata. DNS validation/connect time-of-check-to-time-of-use and rebinding remain unresolved; network egress isolation or connection pinning is still required for complete browser security certification.

### New live automation evidence — functional failure

At `https://aira-ai-2026.vercel.app`, guest-authenticated creation of disabled MANUAL fixture `auto_f43b43b4` returned 201. Trigger returned 200 / TRIGGERED, run `run_bc2b6d43-e`; automation record `autorun_1791646921849_681` and API readback reported COMPLETED. Read-only production SQL confirmed COMPLETED, content length 186 and three tool results. **All three tool calls failed**: calculator input lacked required `expression`; two subsequent calls lacked `repo.read` permission. The harmless calculator objective was not fulfilled. COMPLETED is lifecycle metadata, not successful task execution. Agent tool generation/recovery and objective-success reporting therefore remain blockers. Fixture stays disabled and cannot schedule future work. This evidence does not attest the serving commit or any repair deployment.

### Newly clarified release blockers

- Target Vercel team is visible, but project `aira-ai-2026` is absent from the connected team's listing; lookup returns 404. Listing shows the untouched backup `aira-ai-live` and an unrelated project. This establishes a connection/resource-identity problem, not that the target was deleted. Do not recreate it or operate on the backup. Latest code's GitHub Vercel status was PENDING at inspector `2VH8LLSYgLyGX9yBJzNfHfKVsSEV`; direct lookup of corresponding deployment `dpl_2VH8LLSYgLyGX9yBJzNfHfKVsSEV` returned 404. Earlier approval SHA's GitHub Vercel status reports FAILURE at `dpl_9o7t1moLCyu891jBgWQCV4K63Q1S`. Failure logs remain inaccessible, as do original failed deployment `dpl_FoGytvK4T9jZqKiwcEFHS2r4yhNa` logs. None is attested READY.
- Missing staging Actions credentials remain unresolved; exact-SHA deployed acceptance has no passing result. Restore authorized target-project access and configure account secrets in supported settings before retrying. An isolated premerge deployment path is still required without weakening the staging migration guard.
- Main/staging metadata still reports `protected=false`. Administrative protection reads are denied to the integration. Ruleset API additionally reports a private-repository plan restriction: "Upgrade to GitHub Pro or make this repository public to enable this feature." An administrator must resolve plan eligibility and configure protections. This audit does not change billing or make the repository public.
- Root TypeScript references cover frontend/Vite, not the API runtime. A separate API/imported-package compiler diagnostic still fails with **82 diagnostics**, even with strict mode disabled. See [API diagnostic evidence](AIRA_AI_2026_API_TYPECHECK_DIAGNOSTICS.md). Proper API project configuration, contract repairs and a mandatory API typecheck are outstanding; source CI's existing Typecheck step does not certify the backend.
- Account login, independently successful Tavily execution, broad agent missions, live cron delivery/recovery, deployed approval behavior, production screenshots/actions and exact live deployment attestation remain unverified. Exa retrieval and basic deterministic workflow results below are narrower evidence.
- AIRA Bot PR #18 remains unintegrated with conflicts. Its production design requires a dedicated Docker worker/runner; production local-provider fallback is rejected. No authorized worker host/runtime access is established. Resolve integration and exercise isolated non-root containers, resources, persistence/restart, lease fencing, terminal/path restrictions, authenticated runner access and outbound network policy before enabling it. CI browser installation does not provision a deployed Bot/browser worker.

The historical sections below are retained for traceability. In particular, the historical five-high audit failure is superseded by the zero-vulnerability final source audit above. Deployment and application blockers are not superseded.

## Source and Actions evidence

| Item | Verified identity / result |
| --- | --- |
| Main | `20439a972cc71c0146ec1fdcbf4f7959781d3db0` |
| Main Actions | [38033559403](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38033559403): SUCCESS on that SHA |
| Staging | `ed9cab86239ec4fcd7ad4d46b415338b3c3f4045` |
| Staging Actions | [38036965928](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38036965928): FAILURE. Failed jobs rerun as attempt 2; deployed acceptance job `114240586391` still fails because `VERCEL_TOKEN` is absent. Other three jobs passed. |
| Historical PR #38 | `5e5ac6fd14bf0f50fc9b355ea94f54ebdc9083ce`; [38059897693](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38059897693) SUCCESS, but deployed staging acceptance was SKIPPED; Vercel commit status FAILURE. This is not release certification. |
| First repair commit | `08290e3acadaa94456a37544178e91444f306f40` |
| First repair Actions | PR [38061754892](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38061754892) and push [38061751738](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38061751738): FAILURE. Fast CI, Semantic Search CI and Main/PR certification PASS. Dependency Security FAILS with five high findings; deployed acceptance SKIPPED. |
| Runtime repair commit | `89cda885a3368ee4aeec9825ac5d004b5a634677` |
| Runtime repair Actions | Push [38062712860](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38062712860): FAILURE; Fast CI and Semantic Search CI PASS, Dependency Security FAIL, Main/PR and deployed staging SKIPPED on this feature-branch push. PR [38062716013](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/38062716013): FAILURE; Fast CI, Semantic Search CI and Main/PR certification PASS, Dependency Security FAIL, deployed staging SKIPPED. Fast CI logs confirm 16 policy tests passed and lifecycle regression passed. |

Main and staging branch metadata both reported `protected=false`. The connected GitHub App cannot read or configure administrative branch-protection endpoints (403). Administrators must configure required checks before release; this audit did not bypass protections.

## Changes on existing PR #38

- Retained the existing deployed math fixture correction.
- Added a staging-only build policy that rejects missing branch/environment metadata, production and unrelated preview branches, unexpected hosts/databases/protocols/ports, missing credentials and unsafe TLS settings before running migrations.
- Runtime uses the permitted staging pooler URL; migrations use the validated direct staging endpoint. Optional `DATABASE_URL_UNPOOLED` must independently pass exact-host checks. Error messages do not include credentials.
- Added 16 database-policy regression cases, executed in Fast CI.
- Updated vulnerable resolvable dependency chains through exact overrides for `@grpc/grpc-js@1.13.6` and `postcss-selector-parser@7.1.6`. Regenerated the lockfile.
- Added a mandatory full-dependency `npm audit --audit-level=high` job; deployed staging acceptance depends on it. No exclusions or bypasses were added.
- Registered deferred agent execution with Vercel `waitUntil`, using `@vercel/functions@3.9.11`, while retaining asynchronous responses. Added a lifecycle regression to Fast CI.

The lifecycle repair is source-level mitigation of a request-lifetime risk, **not a verified deployed resolution**. The live research run eventually completed after intermediate RUNNING/QUEUED observations. Detached `setImmediate` execution is an identified hosting risk; deployment logs are unavailable and the observed delay is not proof of a specific root cause. Vercel lifetime tracking is bounded by the function timeout and does not replace a durable worker. See [official Functions API](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package).

Local validation: build, typecheck, lint and all 16 policy tests passed. The lifecycle regression passed with Node plus the tsx import loader; invoking the tsx CLI itself was blocked by this workspace's IPC socket permissions. Existing lint warnings remain. Production-mode staging build correctly rejected the environment before child commands.

## Historical security gate failure — resolved by continuation

Initial install/audit: 11 findings (9 high, 2 moderate). After dependency repairs: **5 high**, no moderate, in the Tailwind 3 development dependency chain (`braces`, `chokidar`, `fast-glob`, `micromatch`, `tailwindcss`). Runtime-only `npm audit --omit=dev --audit-level=moderate` passed with zero vulnerabilities; this does not override the full-graph mandatory gate.

No patched braces release was available in the inspected registry. Dependabot PR #23 only bumps Tailwind 3 to 4 without the associated PostCSS/configuration/CSS migration. A deliberate migration with visual regression verification is required before merging it. Complete application security certification, including all tenant-sensitive execution paths, remains unfinished.

## Vercel identity and access

Target project: `aira-ai-2026`, project ID `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`, team `team_0IZkX9o2Ab319UsAPW9oq1SL`.

Historical handoff deployment `dpl_J8bf2ZPnZaL8on1AP4DkkdnsWonX` was previously READY at staging SHA `ed9cab86239ec4fcd7ad4d46b415338b3c3f4045`. **Its current status could not be re-attested**: connected project/deployment listing calls return 403 and deployment lookup returns 404. Current project settings, environment configuration and deployment logs are therefore unverified.

Original PR head had Vercel status FAILURE at [deployment inspector](https://vercel.com/rajpunkeshwarrajgautam-boops-projects/aira-ai-2026/GWkrt7Cs67TLAU2xxsx93CmWCFXx). GitHub's Vercel commit status on runtime repair SHA `89cda885a3368ee4aeec9825ac5d004b5a634677` reports **FAILURE** for deployment `dpl_FoGytvK4T9jZqKiwcEFHS2r4yhNa` ([inspector](https://vercel.com/rajpunkeshwarrajgautam-boops-projects/aira-ai-2026/FoGytvK4T9jZqKiwcEFHS2r4yhNa)). This is a commit-status observation, not a direct deployment/log inspection. Failure cause remains unconfirmed.

Required account action: reconnect Vercel to the intended team/project; configure GitHub repository secret `VERCEL_TOKEN`, variable `VERCEL_TEAM_ID` for the team above, and protected-preview bypass secret `VERCEL_AUTOMATION_BYPASS_SECRET` where protection is enabled. Enter secrets directly through authorized account settings, never in issues or this report. [Issue #39](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/issues/39) remains open. The available connector cannot set Actions secrets or branch protection.

The staging-only build guard intentionally rejects arbitrary PR preview branches. A safe isolated premerge preview certification path is still needed; do not weaken the database guard to permit PR migrations into production or shared staging.

## Neon read-only verification

| Environment | Project / branch | Observed database |
| --- | --- | --- |
| Staging | `mute-frost-50372225` / `br-autumn-star-b36dfu5w` | PostgreSQL 18.6 (c021049); 15 applied migrations (001–015 matching source); pgvector 0.8.6; 23 public base tables |
| Production | `old-sky-50952395` / `br-shiny-moon-b3vy9xj7` | PostgreSQL 18.6 (c021049); same 15 migrations; pgvector 0.8.6; 23 public base tables |

Queries inspected server version, migrations, extension version, schema and the test research run. Neither database contains AIRA Bot tables. Matching migration metadata is not a backup/restore or destructive-migration certification. No destructive SQL or schema changes were executed.

## Real deployed functionality

Production tested URL: **https://aira-ai-2026.vercel.app**. Exact serving commit/deployment remains unattested because Vercel access is blocked. These results concern the existing live service, not the undeployed repair commits.

| Check | Actual result / limits |
| --- | --- |
| Health/readiness | `GET /api/health` 200 JSON HEALTHY, version 2026.2.0; `GET /api/ready` 200 JSON READY. |
| Unauthorized API access | Agents, automations and runs returned 401 without a session. |
| Guest authentication | Two independent `POST /api/auth/session` calls returned authenticated guest sessions with Secure/HttpOnly cookies. Real account/Firebase login was not verified. |
| Conversation persistence | Sync/readback of `cert-20261010-8a20b6bd-a2c0-4da9-a011-b5519d77dab4` matched content; the second guest's read returned 404. Basic persistence/isolation PASS. |
| AI chat | Supported `aira-auto` request returned SSE routing_decision, content_delta and done with answer `4`. PASS for this real inference. Initial obsolete explicit model ID produced an error; it is not evidence that supported chat failed. |
| Research / Exa | Run `run_25a6642a-4` created successfully. Database tool evidence names Exa and contains five PostgreSQL documentation URLs, including `https://www.postgresql.org/docs/18/release-18.html`. Actual Exa retrieval PASS. |
| Research completion | Observed RUNNING, then QUEUED with five citations and zero content; subsequent read-only production query confirmed COMPLETED, content length 4,935 and five citations. Eventual persistence/completion PASS for this run. Completion latency, rendered answer grounding and recovery behavior remain unverified. |
| Tavily | No independent successful Tavily execution observed. NOT VERIFIED. |
| Agent/automation availability | Authenticated lists returned one default agent and zero automations. This is not agent or scheduled-automation execution certification. |
| Workflow execution | `wfrun_run_04dea332-9` returned 201 COMPLETED; dependent calculator steps both COMPLETED with outputs 4 and 30. Basic real tool workflow PASS; broader AI, recovery, approvals and scheduling remain unverified on deployment. |
| Browser navigation | example.com navigation returned title Example Domain, HTTP 200 and DOM text. Source permits HTTP-fetch fallback; this proves retrieval only. |
| Browser screenshot | `SCREENSHOT_NOT_AVAILABLE`, runtimeUnavailable true. Interactive browser functionality FAIL. |
| AIRA Bot | Absent from main/staging/PR #38 and their database schema. PR #18 remains open with merge conflicts at `85da07fedf224c9d091fa3b38db6b7117b262413`. Integration and certification required. |
| Search capabilities | API reports lexical, pgvector, embedding provider and hybrid READY; capability metadata is not an end-to-end semantic search test. |

Historical staging URL tested: **https://aira-ai-2026-n9dqzwb2g-rajpunkeshwarrajgautam-boops-projects.vercel.app**. Health/readiness requests returned HTTP 200 HTML, not the required API JSON. This does not pass deployed staging acceptance. Protection-aware exact-SHA workflow must pass once credentials are configured.

## Release blockers and required next evidence

1. Preserve the now-passing full-graph dependency audit and visual migration gate. Repair the separate API compiler findings and add mandatory backend typechecking; complete tenant-sensitive application security certification and browser network isolation.
2. Restore intended Vercel access and configure CI credentials safely. Certify an exact-SHA isolated preview, then staging, with passing attestation and deployed acceptance; do not waive either.
3. Verify the runtime lifetime repair on an exact-SHA deployment, rendered research grounding and failure/recovery behavior; independently exercise Tavily (Exa retrieval and eventual completion were observed).
4. Provision and verify the real browser runtime (screenshots and interactive actions).
5. Resolve PR #18 integration conflicts and certify AIRA Bot; verify real account authentication, agents, scheduling and tenant isolation across execution APIs. Repair and re-test the live automation objective failure; do not use COMPLETED as proof of successful tool execution.
6. Configure required branch checks and complete application security review. Verify production's exact deployment identity and all mandatory live gates before domain cutover.

**No domain cutover is authorized by this report. NOT CERTIFIED — BLOCKERS REMAIN.**
