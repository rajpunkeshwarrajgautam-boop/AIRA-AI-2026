# Gate 2 Migration 032 Authorization Package & Database Recovery Specification

**Target Environment:** Neon Production (`old-sky-50952395`)  
**Production Main Branch:** `br-shiny-moon-b3vy9xj7`  
**Production Endpoint:** `ep-withered-art-b36ox90b.c-4.ap-southeast-1.aws.neon.tech`  
**Engine:** PostgreSQL 18.7 (a21afb5)  
**Status:** **LOCKED — AWAITING EXPLICIT WRITTEN OWNER AUTHORIZATION**  
*(Strict Policy: Zero Production Mutations Without Written Approval)*

---

## 1. Verified Gate 1 Completion Baseline

- **Promoted Release Branch:** `release/candidate-pr178-pr184-combined`
- **Certified Candidate SHA:** `3040b14bdb398a2ac00dd6d85b599cf5eb0a003a`
- **Promotion Status:** COMPLETE. Verified via GitHub `ls-remote` reference inspection (pure fast-forward, 19 commits ahead, 0 behind prior base `3ec1947a`).
- **Active Release PR:** PR #185 (`release/candidate-pr178-pr184-combined` -> `prod-release`, state: `DRAFT`, head: `3040b14b`).
- **Production Code Status:** Production branch `prod-release` remains at `d988a6bd26d49a000d59cf906b13fcfe9e170058` (completely unchanged, verified via `ls-remote`).
- **Production Vercel Status:** Deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` (`https://aira-ai-2026.vercel.app`, created Nov 14 2026). Zero unauthorized deployments have occurred.
- **CI / Quality Gates:** All mandatory checks passed on candidate SHA `3040b14b` (Run `44116320686`, Run `44116332554`, Run `44116332711` all green).
- **Execution Report:** `docs/release/GATE-1-CANDIDATE-PROMOTION-EXECUTION-REPORT.md` (Commit: `ffe6b582aeba875742563b37daa7dfccf0a21709`).

---

## 2. Production Database Identity & Live Preflight State

Authoritative read-only preflight inspection executed directly on production Neon project `old-sky-50952395`:

| Metric / Parameter | Live Production Value | Preflight Verdict |
|---|---|---|
| **Database Name** | `neondb` | Verified |
| **Connecting Role** | `neondb_owner` | Verified (`can_insert: true, can_update: true, can_select: true`) |
| **PostgreSQL Version** | `PostgreSQL 18.7 (a21afb5)` | Verified |
| **Continuous PITR Window** | `21600` seconds (6 hours) | Verified |
| **Applied Migrations** | **31** applied (`001` through `031_autonomous_agent_tasks.ts`) | Verified |
| **Migration 032 in Ledger** | **Absent** (`knex_migrations` count = 31) | Verified (Ready to apply) |
| **Target Table Existence** | `workflow_runs` exists in schema `public` | Verified |
| **Target Column Existence** | `workflow_runs.artifacts` is **Absent** | Verified (Drift confirmed, reconcilable) |
| **Table Row Count** | **0** rows | Verified (Empty table) |
| **Table Relation Size** | **40 kB** | Verified (Minimal lock footprint) |
| **Active Concurrent Queries** | 1 (preflight connection only) | Clean pre-migration baseline |

---

## 3. Migration 032 Contract & Safety Guarantees

- **Source File:** `packages/db/src/migrations/032_reconcile_workflow_run_artifacts.ts`
- **Guarded Runner:** `scripts/run-guarded-migration-032.ts`
- **Schema Mutation:**
  ```sql
  ALTER TABLE workflow_runs ADD COLUMN artifacts JSONB DEFAULT '[]'::jsonb;
  ```
- **Safety Properties:**
  1. **Bounded Locking:** `SET LOCAL lock_timeout = '2s'` ensures that if any lock contention occurs on `workflow_runs`, the statement immediately fails closed rather than queuing behind application traffic.
  2. **Bounded Statement Timeout:** `SET LOCAL statement_timeout = '5s'`.
  3. **Advisory Lock Protection:** Acquires session-level advisory locks (`AIRA` ASCII `1095325257`, key `32`) via `pg_try_advisory_lock` to prevent concurrent migration attempts.
  4. **Knex Migration Lock Table:** Acquires exclusive row lock in `knex_migrations_lock` (`is_locked = 1`).
  5. **Quarantine & Scope Protection:** Rejects unexpected unapplied migrations; strictly forbids Workspace V3 (`032_workspace_experience.ts`).
  6. **Idempotency:** Checks `hasColumn('workflow_runs', 'artifacts')` before executing DDL.
  7. **Expand-Only & Non-Destructive:** Column is nullable with default `[]`. `down()` strictly throws an exception to prohibit dropping data or tables.
  8. **Pre-Commit Verification:** Verifies column existence, type `jsonb`, default `'[]'`, `is_nullable = YES`, row count preservation, and ledger entry *before* issuing `COMMIT`.

---

## 4. Disaster Recovery Assurance, PITR Configuration & Operational Realities

### A. RPO and RTO Specifications
- **Tested Recovery Timings:** Rehearsal test suite (`test/recovery-migrations-026-031-rehearsal.test.ts`) verified that forward and backward schema transformations execute in `< 50ms` in memory.
- **Estimated Recovery Timings:**
  - Neon branch metadata initialization: ~10 seconds (instant copy-on-write fork).
  - Vercel `DATABASE_URL` environment variable re-pointing and deployment: ~2 to 4 minutes.
  - Overall Estimated RTO: **2 to 5 minutes** total cutover time.
- **Recovery Point Objective (RPO) Realities & Limits:**
  - RPO is strictly the point-in-time recovery snapshot boundary ($T_0$).
  - Restoring a snapshot branch restores state strictly to $T_0$.
  - **Crucial Limit:** Any transaction committed to `main` between checkpoint capture ($T_0$) and a rollback decision ($T_1$) will **not** be present in the snapshot branch and must be reconciled from application logs or telemetry.
  - A pre-migration checkpoint does **not** guarantee zero data loss for writes that occur after $T_0$.
- **Unknown Operational Behavior:** Full production disaster recovery under live active user traffic has not been executed on production `old-sky-50952395`.

### B. Maintenance Barrier & Write Handling
- Because `workflow_runs` is currently empty (0 rows, 40 kB), the DDL operation hold time is estimated at `< 50ms`.
- If high concurrency occurs at cutover time, the `lock_timeout = '2s'` fail-closed boundary prevents transaction queue pileup.
- For maximum safety during Gate 2 execution, non-essential background worker executions should be paused or run during low-traffic windows.

---

## 5. Historical Neon Preview Credential Investigation (Incident 38868679)

### A. Asset & Infrastructure Identification
- **Project:** `mute-frost-50372225` (`aira-ai-2026-staging`, separate from production `old-sky-50952395`)
- **Branch Name:** `pr90-p1-6-7-preview-isolated`
- **Branch ID:** `br-weathered-tree-b3rf47nh`
- **Parent Branch:** `br-autumn-star-b36dfu5w` (`main` on staging, LSN: `0/1EA1750`)
- **Child Branch:** `br-green-snow-b3dsci5u` (`pr92-commercial-platform-isolated`, created 2026-10-19T16:36:26Z)
- **Endpoint ID:** `ep-steep-tooth-b3y7kgx9` (`ep-steep-tooth-b3y7kgx9.c-4.ap-southeast-1.aws.neon.tech`)

### B. Verified Provider Remediation State (Certified 2026-11-17)
1. **Endpoint Deletion:** `ep-steep-tooth-b3y7kgx9` permanently deprovisioned and deleted (verified HTTP 404; absent from project endpoint inventory). Public hostname unmapped from DNS/proxy.
2. **Password Invalidation:** Role `neondb_owner` password on `br-weathered-tree-b3rf47nh` rotated via Neon API (timestamp advanced from `2026-10-10T08:00:12Z` to `2026-11-17T16:26:39Z`), permanently invalidating the exposed password hash.
3. **Child Preservation:** Child branch `br-green-snow-b3dsci5u` (`pr92-commercial-platform-isolated`) preserved intact, state `ready`, retaining its own endpoint `ep-ancient-sound-b3drtnp5` and credentials (`updated_at: 2026-10-19T16:50:31Z`).
4. **Parent Branch Preserved:** `br-weathered-tree-b3rf47nh` remains as a headless, zero-compute storage node, satisfying Neon's parent-child storage ancestry.
5. **Production Project Isolation:** Production project `old-sky-50952395` remained 100% untouched and outside the operation's scope.
6. **Residual Exposure:** **ZERO**.

---

---

## 6. Definitive Gate 2 Execution Checklist

This checklist defines the strict, ordered sequence for Gate 2 execution once explicit authorization is granted:

| Step | Action | Description / Command | Authorization Status |
|:---:|---|---|:---:|
| **1** | **Reconfirm Target & Candidate** | Verify production project (`old-sky-50952395`), branch (`br-shiny-moon-b3vy9xj7`), endpoint (`ep-withered-art-b36ox90b`), and candidate SHA (`3040b14bdb398a2ac00dd6d85b599cf5eb0a003a`). | **VERIFIED** |
| **2** | **Recheck Ledger & Schema** | Run read-only query confirming 31 applied migrations, 032 absent, and `workflow_runs.artifacts` absent. | **VERIFIED** |
| **3** | **Inspect Active Connections** | Confirm active query count on `neondb` is $\le 2$ and no concurrent DDL holds locks on `workflow_runs`. | **VERIFIED** |
| **4** | **Establish Maintenance / Write Procedure** | Ensure operational window is active and background workflows are quiet. | **READY** |
| **5** | **Capture Recovery Checkpoint** | Create fresh point-in-time recovery branch on production:<br>`neon branches create --project-id old-sky-50952395 --name pre-migration-032-checkpoint` | **LOCKED (Needs Approval)** |
| **6** | **Verify Checkpoint Readiness** | Query Neon API to verify `pre-migration-032-checkpoint` is in `ready` state and parent LSN matches current main. | **LOCKED** |
| **7** | **Execute Guarded Migration** | Run guarded runner command:<br>`npm run db:migrate:032 -- --target=production --authorize-production-migration-032-execute` | **LOCKED (Needs Approval)** |
| **8** | **Verify Column Definition** | Query schema to verify `workflow_runs.artifacts` exists as nullable JSONB with default `[]`. | **LOCKED** |
| **9** | **Verify Migration Ledger** | Verify `knex_migrations` contains exactly 32 records, with 032 recorded in latest batch. | **LOCKED** |
| **10** | **Verify Data Integrity** | Query `workflow_runs` row count and verify zero rows were altered or dropped. | **LOCKED** |
| **11** | **Inspect Runtime Health** | Inspect backend error logs and connection pool status to confirm zero connection errors. | **LOCKED** |
| **12** | **Record Final Database State** | Commit final migration execution record and verification output to repository release docs. | **LOCKED** |
| **13** | **Stop Before Gate 3** | Lock all subsequent actions. Request separate owner authorization for Gate 3 production deployment. | **LOCKED** |

---

## 7. Abort Conditions & Operator Recovery Runbook

1. **Pre-Execution Abort Conditions:**
   - Preflight detects endpoint host is not `ep-withered-art-b36ox90b`.
   - Migration 032 is unexpectedly present in `knex_migrations`.
   - `workflow_runs` table is absent.
   - Advisory lock `(1095325257, 32)` or Knex migration lock cannot be acquired within 2 seconds.
   - Unexpected unapplied migration files detected in repository.

2. **Mid-Execution Rollback Decision Triggers:**
   - PostgreSQL returns lock timeout (`lock_timeout = '2s'` tripped) or statement timeout (`5s` tripped).
   - Post-DDL verification check fails to detect column `artifacts` as JSONB.
   - Row count in `workflow_runs` changes during execution.

3. **Emergency Rollback Procedure:**
   - The guarded runner automatically issues `ROLLBACK` on any error and releases advisory and Knex locks.
   - If catastrophic database corruption occurs, point Vercel connection string to recovery checkpoint:
     `DATABASE_URL=postgresql://neondb_owner:[SECRET]@ep-recovery-[ID].c-4.ap-southeast-1.aws.neon.tech/neondb`
   - Reconcile any post-$T_0$ application writes from application telemetry.

---

## 8. Gate Authorization Status & Pending Owner Decision

### Historical Staging Remediation: CLOSED & VERIFIED (2026-11-17)
- Role `neondb_owner` password rotated on `br-weathered-tree-b3rf47nh` (`updated_at: 2026-11-17T16:26:39Z`).
- Endpoint `ep-steep-tooth-b3y7kgx9` permanently deleted (HTTP 404).
- Child branch `br-green-snow-b3dsci5u` preserved intact and operational.
- Incident 38868679 permanently closed with zero residual exposure.

### Sole Pending Decision: Gate 2 Production Migration 032 Execution
> **"Authorize Gate 2: Create pre-cutover recovery checkpoint on Neon project `old-sky-50952395` and execute migration 032 using the guarded runner."**
