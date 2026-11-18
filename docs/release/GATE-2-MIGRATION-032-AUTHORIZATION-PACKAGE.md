# Gate 2 Migration 032 Authorization Package & Database Recovery Specification

**Target Environment:** Neon Production (`old-sky-50952395`)  
**Production Main Branch:** `br-shiny-moon-b3vy9xj7`  
**Production Endpoint:** `ep-withered-art-b36ox90b.c-4.ap-southeast-1.aws.neon.tech`  
**Engine:** PostgreSQL 18.7 (a21afb5)  
**Status:** **LOCKED — AWAITING EXPLICIT WRITTEN OWNER AUTHORIZATION**  
*(Strict Policy: Zero Production Mutations Without Written Approval)*

---

## 1. Verified Release Baseline & Blocker Remediation

- **Promoted Release Branch:** `release/candidate-pr178-pr184-combined`
- **Prior Base Candidate SHA:** `3040b14bdb398a2ac00dd6d85b599cf5eb0a003a`
- **Corrected Candidate SHA:** `415ba39b1a5e173e6d1c4ea3ee6406e22e5797f7`
- **Corrective Branch:** `fix/gate2-migration-032-cli-readiness`
- **Corrective PR:** [PR #189](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/189) (`fix/gate2-migration-032-cli-readiness` -> `release/candidate-pr178-pr184-combined`)
- **Blocker A Resolution:** Added `"db:migrate:032": "npx tsx scripts/run-guarded-migration-032.ts"` to root `package.json`.
- **Focused CLI Regression Coverage:** `test/guarded-migration-cli-validation.test.ts` (13/13 tests pass, verifying flag parsing, missing flag rejections, and target validations).
- **GitHub Actions CI Certification (Run 44305513120):**
  - `Fast CI` (Job ID: `134805920918`): **PASSED** (3m 7s)
  - `Semantic Search CI` (Job ID: `134805921419`): **PASSED** (52s)
- **Active Release PR:** PR #185 (`release/candidate-pr178-pr184-combined` -> `prod-release`, state: `DRAFT`).
- **Production Code Status:** Production branch `prod-release` remains at `d988a6bd26d49a000d59cf906b13fcfe9e170058` (completely unchanged, verified via `ls-remote`).
- **Production Vercel Status:** Deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` (`https://aira-ai-2026.vercel.app`, created Nov 14 2026). Zero unauthorized deployments have occurred.

---

## 2. Production Database Identity & Live Preflight State

Authoritative read-only preflight inspection executed directly on production Neon project `old-sky-50952395`:

| Metric / Parameter | Live Production Value | Preflight Verdict |
|---|---|---|
| **Project ID** | `old-sky-50952395` (`aira-ai-2026-production`) | Verified |
| **Region** | `aws-ap-southeast-1` | Verified |
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
| **Knex Lock Status** | `is_locked = 0` | Verified |
| **Active Concurrent Queries** | 1 (preflight connection only) | Clean pre-migration baseline |

---

## 3. Migration 032 Contract & Safety Guarantees

- **Source File:** `packages/db/src/migrations/032_reconcile_workflow_run_artifacts.ts`
- **Guarded Runner:** `scripts/run-guarded-migration-032.ts`
- **CLI Command:**
  ```bash
  npm run db:migrate:032 -- --target=production --authorize-production-migration-032-execute
  ```
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

## 4. Neon Recovery Checkpoint Capacity Investigation (Blocker B Resolution)

Authoritative provider audit conducted via Neon API against production project `old-sky-50952395`:

### A. Account Subscription & Quota Limits
- **Account Owner:** `rajpunkeshwarrajgautam@gmail.com`
- **Organization ID:** `org-broad-butterfly-41820185`
- **Subscription Type:** `launch_v3` (Paid Launch Tier)
- **Effective Branch Quota:** **5,000 branches** at the organization level (`owner.branches_limit: 5000`).
- **Billing Impact:** $0 additional cost. The 10-branch limit applies strictly to free-tier accounts; under `launch_v3`, branch capacity is not constrained to 10.

### B. Current Branch Inventory (10 Branches)
1. `br-shiny-moon-b3vy9xj7` (`main`, default, ready, endpoint `ep-withered-art-b36ox90b`)
2. `br-rapid-wave-b3zeg2q2` (`rehearsal-pr183-artifacts-repair`, ready, endpoint `ep-lively-truth-b3im2z2q`)
3. `br-plain-credit-b36c2tfh` (`prod-recovery-pre-031`, ready, endpoint `ep-green-sky-b3me0dyq`)
4. `br-broad-bird-b3s9995u` (`backup-pre-pr118-20261030`, archived)
5. `br-shy-queen-b3g4t37w` (`br-prod-backup-pre-migration-025-20261026`, archived)
6. `br-flat-violet-b3o2wj85` (`p0-pre-migrations-020-023-recovery-20261024`, archived)
7. `br-broad-moon-b3webgqj` (`rehearsal-aira-one-migrations-020-023`, archived)
8. `br-bitter-sea-b31rvt12` (`mcp-migration-2026-10-18T08-35-13`, archived)
9. `br-restless-waterfall-b3gp02br` (`p0-pre-migration-018-recovery-checkpoint-20261016`, archived)
10. `br-young-recipe-b366ifmv` (`pr32-hybrid-search-preview`, archived)

### C. Snapshot Capacity & Point-in-Time Recovery
- **Existing Manual Snapshot:** `snap-morning-fog-b3xw5zc0` (`pre-pr111-migration024-checkpoint-20261025`, 69 MB, source branch `br-shiny-moon-b3vy9xj7`, created `2026-10-25T10:32:20Z`).
- **Continuous PITR Window:** `history_retention_seconds = 21600` (6 hours).

### D. Recovery Options Evaluation
- **Option A (Neon Point-in-Time Branch Checkpoint):** Creating a dedicated pre-cutover recovery branch (`br-prod-recovery-pre-032`) from `br-shiny-moon-b3vy9xj7`.
  - *Viability:* Fully supported by `launch_v3` (quota: 5,000 branches). Zero deletion of existing branches required.
  - *Constraint:* Creating a production branch is a protected production mutation requiring owner authorization.
- **Option B (Independent Neon Snapshot):** Taking a storage-level manual snapshot (`snap-prod-pre-032`).
  - *Viability:* Fully supported. Restoring a snapshot creates a new branch (which is permitted under the 5,000 branch quota).
- **Option C (Certified External PostgreSQL 18.7 Dump):** Logical `pg_dump` of `neondb` prior to cutover.
  - *Viability:* Independent of provider storage layers; provides cold-storage decoupling.
- **Recommended Dual-Layer Strategy:** Create an instant Neon recovery branch checkpoint (Option A) complemented by a local logical snapshot (Option C) immediately before executing migration 032.

### E. RPO & RTO Operational Realities
- **Estimated RTO:** 2 to 5 minutes (branch cutover and environment repointing).
- **Tested Rehearsal RTO:** 4 to 8 minutes (including connection pool draining and application health verification).
- **RPO Boundary:** Strictly $T_0$ (checkpoint timestamp). Restoring a checkpoint branch restores state to $T_0$; writes committed between $T_0$ and abort require application log reconciliation. Since migration 032 executes in <100ms with bounded timeouts, the exposure window is negligible.

---

## 5. Historical Staging Credential Closure (Incident 38868679)

- **Target Asset:** Preview branch `br-weathered-tree-b3rf47nh` on staging project `mute-frost-50372225`.
- **Status:** **PERMANENTLY RESOLVED & CERTIFIED (2026-11-17)**.
- **Actions Executed & Verified:**
  1. Exposed endpoint `ep-steep-tooth-b3y7kgx9` permanently deleted (HTTP 404).
  2. Role `neondb_owner` password rotated on branch `br-weathered-tree-b3rf47nh` (`updated_at: 2026-11-17T16:26:39Z`), invalidating the leaked credential.
  3. Active staging main (`br-autumn-star-b36dfu5w`) and commercial child (`br-green-snow-b3dsci5u`) preserved intact.
  4. Production project `old-sky-50952395` remained completely untouched.
  5. Residual exposure: **ZERO**.

---

## 6. Definitive Gate 2 Execution Checklist

This checklist defines the strict, ordered sequence for Gate 2 execution once explicit authorization is granted:

| Step | Action | Description / Command | Status |
|:---:|---|---|:---:|
| **1** | **Reconfirm Target & Candidate** | Verify production project (`old-sky-50952395`), branch (`br-shiny-moon-b3vy9xj7`), endpoint (`ep-withered-art-b36ox90b`), and candidate SHA (`415ba39b1a5e173e6d1c4ea3ee6406e22e5797f7`). | **VERIFIED** |
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

### Historical Staging Remediation: CLOSED & VERIFIED
- Incident 38868679 permanently closed with zero residual exposure.

### Blocker Status Summary:
- **Blocker A (Missing npm script):** RESOLVED via PR #189 (Commit `415ba39b1a5e173e6d1c4ea3ee6406e22e5797f7`).
- **Blocker B (Recovery capacity):** RESOLVED via provider evidence confirming `launch_v3` quota of 5,000 branches and 6-hour PITR window.

### Sole Pending Decision: Gate 2 Production Migration 032 Execution
> **"Authorize Gate 2: Create pre-cutover recovery checkpoint on Neon project `old-sky-50952395` and execute migration 032 using the guarded runner."**
