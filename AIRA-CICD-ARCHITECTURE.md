# AIRA AI 2026 — Dual Permanent CI/CD Pipeline Architecture

## 1. Executive Architecture Summary

AIRA AI 2026 operates a dual-track CI/CD pipeline architecture designed to eliminate recurring infrastructure setup (no need to repeatedly create Vercel projects, Neon databases, OAuth applications, or local repository worktrees for individual features).

```
                      +---------------------------------------+
                      |       Developer Feature Branch        |
                      +-------------------+-------------------+
                                          |
                                    git push / PR
                                          v
+-----------------------------------------------------------------------------------+
|                        PREVIEW & INTEGRATION PIPELINE                              |
|                                                                                   |
|  Trigger: PR targeting staging, main, or prod-release                             |
|                                                                                   |
|  [Fast CI]                                                                        |
|    * npm ci & tracked-secrets-hygiene scan (zero credential exposure)             |
|    * oxlint & tsc --noEmit typecheck                                              |
|    * Frontend & asset build (Vite + React 19)                                     |
|    * Database migration & deploy contract check (Postgres 18 service container)  |
|    * Database isolation & environment crossover guard (test:db-isolation)         |
|    * Unit, API, Router, Workflow, Model Routing, and Security regression suites   |
|                                                                                   |
|  [Semantic Search CI]                                                             |
|    * pgvector integration & conversation semantic search certification            |
|                                                                                   |
|  [Main / PR Certification]                                                        |
|    * Deep integration, recovery, identity, session auth & startup certification  |
|    * Headless Playwright browser responsive acceptance suites                     |
+-----------------------------------------------------------------------------------+
                                          |
                            PR Reviewed & Merged to staging
                                          v
+-----------------------------------------------------------------------------------+
|                     PERMANENT STAGING PIPELINE (Automatic)                        |
|                                                                                   |
|  Trigger: push to branch 'staging'                                                |
|  GitHub Environment: 'staging' (Custom branch policy: staging branch only)        |
|                                                                                   |
|  Sequence:                                                                        |
|    1. Exact commit SHA verification                                               |
|    2. Preflight validation & database isolation verification                     |
|       - Target DB: Neon Staging mute-frost-50372225 (main br-autumn-star-b36dfu5w)|
|       - Strict rejection of Production DB (old-sky-50952395)                      |
|       - Protection of Commercial PR #92 branch (br-green-snow-b3dsci5u)          |
|    3. Migration compatibility check against Staging schema                        |
|    4. Vercel deployment verification (prj_FZLU4vBIYSsBn28AI6drkpD5WfbH)           |
|    5. Live Health check & API smoke tests (staging.virexaaiventures.com)          |
|    6. Staging certification artifact generation & upload                          |
+-----------------------------------------------------------------------------------+
                                          |
                        Release Candidate Selected for Prod
                                          v
+-----------------------------------------------------------------------------------+
|                    PROTECTED PRODUCTION PIPELINE (Owner Gated)                    |
|                                                                                   |
|  Target Branch: prod-release                                                      |
|  GitHub Ruleset: AIRA Production Protection (ID 25079946)                         |
|  Canonical URL: https://aira-ai-2026.vercel.app/                                  |
|  Production Neon: old-sky-50952395 (br-shiny-moon-b3vy9xj7)                       |
|                                                                                   |
|  Mandatory Release Gate Sequence:                                                 |
|    1. Exact 40-character immutable commit SHA selection                           |
|    2. Pull Request targeting prod-release (open, non-draft, clean diff)          |
|    3. Verified CI check runs on exact candidate SHA:                              |
|       - Fast CI == success                                                        |
|       - Semantic Search CI == success                                             |
|       - Main / PR certification == success                                        |
|    4. Verified Staging Certification report for release candidate                 |
|    5. Production Database Isolation & non-destructive migration audit             |
|    6. Cryptographic Owner GO LIVE Attestation:                                    |
|       - Owner dispatches: .github/workflows/release-authorization.yml             |
|         Inputs: pr_number, candidate_sha, approval_phrase: "GO LIVE <sha>"        |
|       - Dedicated GitHub App publisher mints token and publishes status:           |
|         context: 'release/go-live-authorized' = success (fresh <24h)              |
|    7. Controlled Production Vercel Deployment & exact SHA matching                |
|    8. Live Health check, smoke tests & automated rollback verification            |
+-----------------------------------------------------------------------------------+
```

---

## 2. Infrastructure Identity & Separation Matrix

| Dimension | Preview / CI | Permanent Staging | Production |
| :--- | :--- | :--- | :--- |
| **Git Branch** | Feature branch (`feat/*`, `fix/*`, `infra/*`) | `staging` | `prod-release` |
| **GitHub Environment** | None (read-only PR context) | `staging` | `Production` / `release-gate` |
| **Vercel Project** | `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`) | `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`) | `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`) |
| **Canonical Domain** | Ephemeral `*vercel.app` or local | `staging.virexaaiventures.com` | `aira-ai-2026.vercel.app` |
| **Vercel Alias** | `aira-ai-2026-git-<branch>-*.vercel.app` | `aira-ai-2026-git-staging-*.vercel.app` | `aira-ai-2026.vercel.app` |
| **Neon Project** | Ephemeral / Docker `postgres:18` | `mute-frost-50372225` (`aira-ai-2026-staging`) | `old-sky-50952395` (`aira-ai-2026-production`) |
| **Neon Branch** | Isolated PR branch / Service container | `main` (`br-autumn-star-b36dfu5w`) | `main` (`br-shiny-moon-b3vy9xj7`) |
| **Primary Endpoint** | Service container / Isolated compute | `ep-shiny-bird-b3xundyt` | `ep-withered-art-b36ox90b` |
| **Commercial PR #92** | Isolated branch `br-green-snow-b3dsci5u` | **EXCLUDED** from generic staging | **EXCLUDED** from production |
| **Release Authority** | Automatic CI execution | Automatic on `staging` push | Explicit Owner GO LIVE only |

---

## 3. Workflow File Specifications

### 3.1 `.github/workflows/ci.yml` (Updated)
- **Role**: Reusable continuous integration pipeline for all active development.
- **Triggers**:
  - `push: branches: [main, prod-release, staging, 'infra/**', 'feat/**', 'fix/**', 'cert/**']`
  - `pull_request: branches: [main, prod-release, staging]`
  - `workflow_dispatch`
- **Jobs**:
  1. `fast`: Fast CI (Node 24, Postgres 18 service, secrets hygiene, lint, typecheck, build, DB migration contract, DB isolation check `test:db-isolation`, unit/API/security tests).
  2. `semantic-search`: Semantic Search CI (Postgres 18 + pgvector service, migration, semantic search certification).
  3. `certify`: Main / PR certification (integration, recovery, identity, session auth, Playwright responsive E2E). Condition: triggers on all PRs, and pushes to `main`, `prod-release`, and `staging`.

### 3.2 `.github/workflows/staging-deployment.yml` (Created)
- **Role**: Permanent Staging pipeline automating validation, environment verification, migration compatibility, Vercel staging deployment, and smoke certification.
- **Triggers**:
  - `push: branches: [staging]`
  - `workflow_dispatch: inputs: candidate_sha`
- **Environment**: `staging`
- **Concurrency**: `staging-pipeline-execution` (cancel-in-progress: false)
- **Key Steps**:
  - Full Fast CI preflight
  - Staging preflight check (`npx tsx scripts/validate-staging-pipeline.ts preflight`)
  - Database isolation check ensuring target is `mute-frost-50372225` `main` branch
  - Staging health and smoke test execution (`npx tsx scripts/validate-staging-pipeline.ts smoke`)
  - Staging certification artifact upload (`aira-staging-certification`)

### 3.3 `.github/workflows/production-release-gate.yml` (Created)
- **Role**: Protected Production Release gate and readiness verification engine.
- **Triggers**: `workflow_dispatch` on `prod-release` with `pr_number`, `candidate_sha`, `mode: [dry_run, enforce]`.
- **Key Steps**:
  - Validates 40-character candidate SHA
  - Validates PR targeting `prod-release`
  - Validates mandatory check runs (`Fast CI`, `Semantic Search CI`, `Main / PR certification`)
  - Validates database isolation & migration safety
  - Validates cryptographic owner GO LIVE status (`release/go-live-authorized`)
  - Generates Production Readiness report and summary

---

## 4. Reusable Feature Development Workflow

This permanent pipeline establishes an efficient development lifecycle that completely eliminates repetitive resource provisioning:

1. **Local Development**:
   - Check out `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`.
   - Create feature branch (`feat/<name>` or `fix/<name>`).
   - Run local tests: `npm run typecheck`, `npm run lint`, `npm run test:secrets`, `npm run test:db-isolation`.
   - Zero local database creation needed; tests run against local PostgreSQL or mock adapters.

2. **Pull Request & Automated Preview CI**:
   - Push feature branch to origin.
   - Open Pull Request targeting `staging` (for staging integration) or `prod-release` (for release PRs).
   - CI immediately executes `Fast CI`, `Semantic Search CI`, and `Main / PR certification`.
   - Vercel automatically generates an isolated branch preview URL (`aira-ai-2026-git-<branch>-*.vercel.app`).

3. **Staging Integration & Permanent Staging Deployment**:
   - Merge approved PR into `staging`.
   - `.github/workflows/staging-deployment.yml` automatically triggers on `staging`.
   - Evaluates preflight database isolation, runs migrations against Neon Staging (`mute-frost-50372225`), verifies Vercel staging deployment at `staging.virexaaiventures.com`, runs smoke tests, and uploads `aira-staging-certification` artifact.

4. **Production Release Promotion**:
   - Open Release PR from `staging` (or verified branch) targeting `prod-release`.
   - Verify all 3 mandatory CI checks pass on the exact PR HEAD commit.
   - Run Production Release Gate dry-run (`npx tsx scripts/verify-production-release-readiness.ts`).
   - Repository owner `rajpunkeshwarrajgautam-boop` reviews and authorizes by dispatching `release-authorization.yml` (`GO LIVE <candidate_sha>`).
   - GitHub App publisher verifies attestation and posts commit status `release/go-live-authorized = success`.
   - PR is merged into `prod-release`, triggering live production deployment to `https://aira-ai-2026.vercel.app/`.
