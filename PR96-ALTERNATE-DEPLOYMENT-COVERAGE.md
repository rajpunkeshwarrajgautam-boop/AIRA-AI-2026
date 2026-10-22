# AIRA AI 2026 — PR #96 Alternate Deployment Coverage Audit

## 1. Scope of Deployment Surface

Permanent staging shares a single Vercel project (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`) and connects to permanent staging Neon (`mute-frost-50372225`, branch `br-autumn-star-b36dfu5w`, endpoint `ep-shiny-bird-b3xundyt`).

Vercel generates multiple routing aliases and immutable URLs for deployments. Every deployment with access to the staging `DATABASE_URL` environment variable constitutes a potential write-path entry point.

| Deployment Target / URL Type | Example URL | Codebase Version | Database Connection Role | Protection Mechanism During Maintenance |
| :--- | :--- | :--- | :--- | :--- |
| **Canonical Staging Domain** | `https://staging.virexaaiventures.com` | Current `staging` branch | `neondb_owner` / standard runtime | **Dual Layer**: Express Middleware (HTTP 503) + PostgreSQL Trigger (`55P03`) |
| **Staging Git Branch Alias** | `https://aira-ai-2026-git-staging-rajpunkeshwarrajgautam-boops-projects.vercel.app` | Current `staging` branch | `neondb_owner` / standard runtime | **Dual Layer**: Express Middleware (HTTP 503) + PostgreSQL Trigger (`55P03`) |
| **PR #96 Preview Alias** | `https://aira-ai-2026-git-feat-commercial-staging-integration-rajpunkeshwarrajgautam-boops-projects.vercel.app` | PR #96 HEAD | `neondb_owner` / standard runtime | **Dual Layer**: Express Middleware (HTTP 503) + PostgreSQL Trigger (`55P03`) |
| **Older Immutable Staging Deployments** | `https://aira-ai-2026-<hash>-rajpunkeshwarrajgautam-boops-projects.vercel.app` | Older commit SHAs (pre-PR #96) | `neondb_owner` (shares staging env) | **Authoritative Database Barrier**: PostgreSQL Trigger (`55P03`) + `default_transaction_read_only = on` |
| **Direct Serverless Function** | `/api/*` invoked directly | Deployment-specific | `neondb_owner` | Handled by respective deployment (Middleware if post-PR #96, DB trigger if pre-PR #96) |
| **Background / Cron Workers** | Invoked via scheduled event or webhook | Node / serverless | `neondb_owner` | **Authoritative Database Barrier**: PostgreSQL Trigger (`55P03`) |

---

## 2. Analysis of Older Immutable Deployment Vulnerability

### 2.1 The Threat Vector
Vercel preview and branch deployments produce immutable URLs that remain live and callable even after subsequent commits are merged. These deployments:
1. Retain the environment variables assigned to their preview scope (`DATABASE_URL` pointing to `ep-shiny-bird-b3xundyt`).
2. Run immutable serverless bundles built from previous Git commits that **do not contain** any newly added Express middleware.
3. Could receive requests from open browser tabs, automated scripts, or webhooks during the PR #96 cutover window.

### 2.2 Proof of Database-Level Coverage
Because all deployments connect to the same PostgreSQL host and database (`mute-frost-50372225` / `neondb`):
- When `scripts/staging-maintenance-control.ts --activate` is executed:
  1. `ALTER DATABASE neondb SET default_transaction_read_only = on` sets the default transaction mode for new connections to read-only.
  2. Idle pooler backends are terminated (`pg_terminate_backend`), forcing fresh connection checkout.
  3. The trigger `_aira_staging_maintenance_trigger` is active on tables:
     `BEFORE INSERT OR UPDATE OR DELETE ON <table>`
  4. When an older deployment executes Knex queries (e.g. `db('conversations').insert(...)`), the query hits PostgreSQL.
  5. The PostgreSQL trigger executes `_aira_enforce_staging_maintenance()`.
  6. The session lacks `current_setting('aira.privileged_token')`.
  7. PostgreSQL raises fatal exception `55P03` (`[STAGING_MAINTENANCE_BLOCKED] Operation denied: Permanent Staging database is in maintenance mode. Write path is locked.`).
  8. The write is rolled back immediately. Zero data is persisted.

---

## 3. Preparatory Actions & Owner Approval Scope

1. **Staging Configuration Only**:
   - The maintenance barrier operates strictly within Neon project `mute-frost-50372225`.
   - It requires NO project-wide Vercel settings changes that would affect Production (`old-sky-50952395`).
2. **Owner Action Required at Cutover Time**:
   - At Stage 3 of `scripts/staging-cutover-wizard.sh`, the repository owner enters `STAGING_DB_URL` and authorizes:
     `npx tsx scripts/staging-maintenance-control.ts --activate`.
   - The CLI prints the generated `AIRA_MAINTENANCE_BYPASS_TOKEN`.
   - The cutover wizard and migration runners consume this token to execute migrations 016–022 and historical identity import.
   - At Stage 8, upon completing real-browser acceptance, the owner deactivates the barrier via:
     `npx tsx scripts/staging-maintenance-control.ts --deactivate`.
