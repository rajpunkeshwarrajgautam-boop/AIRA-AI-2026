# AIRA AI 2026 — isolated staging deployment policy

## Scope and safety

This change targets only the `aira-ai-2026` Vercel project (ID `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`) and proposes a change to GitHub `staging`. **Do not merge this to `main` or promote it to production as part of staging remediation.** Do not modify `aira-ai-live`, `aira-ai.in`, `www.aira-ai.in`, DNS or production Neon (project `old-sky-50952395`).

## Deployment triggering vs CI

- Vercel builds frontend only: `npm run build`. No migrations run during the Vercel build.
- `git.deploymentEnabled` allows `staging` and preserves existing `main` production Git-deployment behavior; `"**": false` suppresses unmatched branch deploys. Vercel's documented matching rule allows a deployment when at least one matching rule is `true`.
- GitHub Actions still runs on all development `push` events and PRs targeting `main` or `staging`; frontend build and local isolated PostgreSQL migration/verification remain mandatory.
- **Important rollout limit:** Vercel can read `vercel.json` from the Git commit it deploys. This policy is not guaranteed to control preexisting feature branches that still carry older configuration. Apply the same deployment policy to those branches or use a separately verified project-level control; do not silently alter unrelated builder branches. A Vercel `READY` result is not staging certification.

## Separate mandatory live staging certification

On a `staging` push, `staging-db-readiness` runs after the regular CI jobs and before deployed staging acceptance. It:
1. Runs with the GitHub **protected environment `staging`**.
2. Requires the environment secret `AIRA_STAGING_DATABASE_URL`, which must point to the *same isolated staging Neon database* as the existing **Vercel Preview branch `staging` `DATABASE_URL`**. This GitHub secret is separate and must be provisioned without displaying or committing credentials.
3. Validates `VERCEL_ENV=preview`, `VERCEL_GIT_COMMIT_REF=staging`, the staging Neon hostname and database identity with `scripts/staging-db-guard.ts`.
4. Runs **read-only** `npm run db:verify:deploy` with semantic search enabled. It checks migration names, required tables and pgvector.
5. Blocks `staging-deployed` unless the live DB gate succeeds. Missing secret or schema means **BLOCKED**, not an implicit pass. No `npm run db:migrate` on the live staging target.

### Verified baseline, 2026-10-11

- Staging Neon project: `mute-frost-50372225`, branch `br-autumn-star-b36dfu5w` (display name `main`), database `neondb`.
- All **15 staging-source migrations (001 through 015)** are present in the staging database `knex_migrations` history.
- `vector` extension exists and `conversation_search_documents.embedding_vector` has type `vector`.
- Existing Vercel Preview `staging`-specific `DATABASE_URL` metadata is present and unchanged. Secret values were not read or printed.
- Builder migration files 016–019 are not part of the staging codebase and are not applied.

## Rollout and acceptance

1. Set protected GitHub environment `staging`, limit it to `staging` branch, and provision the **staging-only** `AIRA_STAGING_DATABASE_URL` secret. Never use the production Neon connection URL.
2. Review and merge this staging-policy PR to `staging` **only**. Avoid any `main` merge or production promotion.
3. Confirm exact SHA GitHub CI, `staging-db-readiness`, `staging-deployed` and deployed browser smoke tests all PASS.
4. Confirm the authorized Vercel Preview is `READY` for exactly the same `staging` SHA, never an old or moving alias.
5. Test suppression for a new non-integration development branch once that branch inherits the policy, and audit older feature branches separately.
6. Do not certify production readiness until full application capabilities, service-provider integrations, authentication and cloud worker E2E have independently passed.

No deployment or DB migration is required to review this policy PR. A staging release remains uncertified until all required gates have passed.
