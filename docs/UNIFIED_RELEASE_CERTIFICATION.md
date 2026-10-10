# AIRA AI 2026 — Unified Release Certification

## Baseline and branch policy
- Production is `main` only. Baseline audited 2026-10-10: `20439a972cc71c0146ec1fdcbf4f7959781d3db0`.
- `staging` is the sole shared integration branch; `feat/*` and `fix/*` PRs target staging.
- Changes reach main only by deliberate, reviewed promotion from a **certified** staging SHA.
- A Vercel Preview is NOT production and must never use a production `DATABASE_URL`.
- Preserve old `aira-ai-live` and custom domains for rollback; DNS cutover is independent.
- No existing capability can be marked PASS solely because unit or localhost E2E passes.

## Mandatory release gates (record SHA and run IDs)
1. `Fast CI`, `Semantic Search CI`, `Main / PR certification` all pass on exact staging HEAD.
2. Vercel Preview deployment reaches READY for that exact commit and is checked by immutable URL.
3. Staging uses a **clean, separate Neon database/project** (migrations applied, pgvector installed, no production customer data). No development/test traffic to primary branch.
4. A **deployed** browser test passes desktop and mobile. `npm run test:staging:deployed` requires `STAGING_BASE_URL`, an immutable Preview URL, and optional `VERCEL_AUTOMATION_BYPASS_SECRET`; fail closed if SSO blocked.
5. Live system tests separately verify streaming, authentication/session restore, hybrid lexical/semantic retrieval, research with citations, UI scroll, math, clipboard, files, workflows, agents, browser actions, provider failure and tenant isolation. A missing capability is BLOCKED/NOT CERTIFIED, not PASS.
6. Staging deployment SHA must be verified through Vercel metadata against GitHub staging HEAD. Passing the UI test on a different SHA is invalid.
7. Release acceptance requires recorded human review plus rollback rehearsal to the previous immutable Vercel deployment.
8. After promotion, re-run production smoke and inspect runtime error rates. If it fails, restore previous deployment; leave custom domain unchanged.

## Enforcement limitations to resolve
- GitHub reports `main` is **not protected**; private repository rulesets require a plan/feature upgrade. These documented gates are procedural until mandatory checks/merge restrictions can be enforced in GitHub. Do not describe them as enforced.
- Vercel custom environments are unavailable on the current account; use a branch-scoped Preview with an isolated staging `DATABASE_URL` or provision a separate staging project.
- Existing Neon Preview branches clone production data. Do not use them as persistent staging or copy production data without an explicit isolation/sanitization decision.
- Real Tavily and Exa credentials are Production-only. A staging research acceptance requires separately scoped test keys or explicit permission to use usage-limited provider credentials.
- CI's existing browser E2E is local Vite. The new deployed acceptance is additional, not a replacement.
- One-off manual workflow green states do not prevent direct pushes while branch protection remains unavailable.

## Deferred research-quality work
Once staging is operational and gates proven, implement together on staging: freshness-aware ranking, publisher-date extraction and provenance, requested citation-count alignment, and claim-to-evidence quality verification. Run full regression before any production promotion.
