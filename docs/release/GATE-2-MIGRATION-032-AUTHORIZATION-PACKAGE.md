# Gate 2 Migration 032 Authorization Package & Database Recovery Specification

**Target Environment:** Neon Production (`old-sky-50952395`)  
**Main Branch:** `br-shiny-moon-b3vy9xj7`  
**Endpoint:** `ep-withered-art-b36ox90b.c-4.ap-southeast-1.aws.neon.tech`  
**Engine:** PostgreSQL 18.7 (a21afb5)  
**Status:** **LOCKED — AWAITING EXPLICIT WRITTEN OWNER AUTHORIZATION**  
*(Strict Policy: Zero Production Mutations Without Written Approval)*

---

## 1. Verified Gate 1 Completion Baseline

- **Promoted Release Branch:** `release/candidate-pr178-pr184-combined`
- **Certified Candidate SHA:** `3040b14bdb398a2ac00dd6d85b599cf5eb0a003a`
- **Promotion Status:** COMPLETE. Verified via GitHub `ls-remote` reference inspection (pure fast-forward, 19 commits ahead, 0 behind).
- **Execution Report:** `docs/release/GATE-1-CANDIDATE-PROMOTION-EXECUTION-REPORT.md` (Commit: `ffe6b582aeba875742563b37daa7dfccf0a21709`).
- **Production Code Status:** Production branch `prod-release` remains at `d988a6bd26d49a000d59cf906b13fcfe9e170058` (completely unchanged).

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
  ALTER TABLE workflow_runs ADD COLUMN artifacts JSONB DEFAULT '[]';
  ```
- **Safety Properties:**
  1. **Bounded Locking:** `SET LOCAL lock_timeout = '2s'` ensures that if any lock contention occurs on `workflow_runs`, the statement immediately fails closed rather than queuing behind application traffic.
  2. **Bounded Statement Timeout:** `SET LOCAL statement_timeout = '5s'`.
  3. **Advisory Lock Protection:** Acquires dual session-level advisory locks (`AIRA` ASCII `1095325257`, key `32`) via `pg_try_advisory_lock` to prevent concurrent migration attempts.
  4. **Idempotency:** Checks `hasColumn('workflow_runs', 'artifacts')` before executing DDL.
  5. **Expand-Only & Non-Destructive:** Column is nullable with default `[]`. `down()` strictly throws an exception to prohibit dropping data or tables.

---

## 4. Production Recovery Checkpoint Procedure

Before invoking the guarded migration runner, a fresh recovery checkpoint must be captured:

### A. Pre-Cutover Checkpoint Creation
```bash
neon branches create --project-id old-sky-50952395 --name pre-migration-032-checkpoint
```

### B. Recovery Checkpoint Integrity Verification
1. Inspect checkpoint metadata via Neon API:
   ```bash
   neon api /projects/old-sky-50952395/branches
   ```
2. Verify branch `pre-migration-032-checkpoint` is in `ready` state, parent is `br-shiny-moon-b3vy9xj7`, and parent LSN is recorded.

---

## 5. RPO and RTO Specifications & Operational Realities

- **Recovery Point Objective (RPO):** Point-in-time recovery snapshot boundary ($T_0$). Restoring a snapshot branch restores data strictly to $T_0$. Any transaction committed to `main` between $T_0$ and a rollback initiation will **not** be present in the snapshot branch and must be reconciled from application logs or telemetry.
- **Recovery Time Objective (RTO):** Estimated at **2 to 5 minutes** total cutover time:
  - Neon branch metadata initialization: ~10 seconds (instant copy-on-write fork).
  - Vercel `DATABASE_URL` environment variable re-pointing and deployment: ~2 to 4 minutes.
- **Lock Duration:** Rehearsal-measured at < 50ms on isolated environments. Live production table is currently 40 kB with 0 rows, guaranteeing minimal lock hold time.

---

## 6. Migration Compatibility & Ordering Strategy

- **Backward Compatibility:** Because `artifacts` is added as a nullable JSONB column with default `[]`, the currently deployed production application (`d988a6bd`) will continue operating normally with zero schema errors.
- **Forward Compatibility:** The promoted release candidate (`3040b14b`) safely expects `artifacts` to exist and serialize to/from JSON.
- **Deployment Ordering:** Database Migration 032 must be executed and verified **prior to** Gate 3 production deployment.

---

## 7. Failure, Abort, and Rollback Criteria

1. **Abort Preconditions:**
   - Preflight detects endpoint host is not `ep-withered-art-b36ox90b`.
   - Table `workflow_runs` is absent.
   - Advisory lock `(1095325257, 32)` cannot be acquired within 2 seconds.
2. **Rollback Decision Triggers:**
   - Statement timeout (5s) or lock timeout (2s) is tripped.
   - Post-migration column verification fails to detect `artifacts`.
   - Production API error rates on `/api/workflows` spike above 0%.
3. **Rollback Action:**
   - Revert connection strings to `pre-migration-032-checkpoint` if schema corruption occurs.
   - Reconcile post-$T_0$ records from application telemetry.

---

## 8. Exact Guarded Migration Execution Command

When authorized, Gate 2 will be executed with the exact guarded CLI command:
```bash
npm run db:migrate:032 -- --target=production --authorize-production-migration-032-execute
```

---

## 9. Post-Migration Verification Queries

Immediately after execution, the runner and release engineer verify:
```sql
-- 1. Verify ledger advancement
SELECT name, batch, migration_time FROM knex_migrations WHERE name LIKE '%032%';

-- 2. Verify column definition
SELECT column_name, data_type, is_nullable, column_default 
FROM information_schema.columns 
WHERE table_name = 'workflow_runs' AND column_name = 'artifacts';

-- 3. Verify row integrity
SELECT count(*) FROM workflow_runs;
```

---

## 10. Gate 2 Approval Request

Execution stops here. To proceed with Gate 2, the owner must provide explicit written authorization:

> **"Authorize Gate 2: Create pre-cutover recovery checkpoint on Neon project `old-sky-50952395` and execute migration 032 using the guarded runner."**
