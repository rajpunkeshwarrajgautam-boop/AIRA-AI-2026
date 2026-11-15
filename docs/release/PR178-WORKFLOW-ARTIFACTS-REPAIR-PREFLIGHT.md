# PR #178 — Production Workflow Artifacts Schema Drift Preflight & Guarded Procedure

**Scope:** Isolated, additive repair for `public.workflow_runs.artifacts` and production recovery safeguards.
This change does not authorize deployment, production SQL execution, or a merge of PR #178 / #179.

## Verified Discrepancy & Catalog Reconciliation (2026-11-15)

- Production Neon project `old-sky-50952395`, main branch `br-shiny-moon-b3vy9xj7`, PostgreSQL 18.7: `workflow_runs.artifacts` is absent. `knex_migrations` contains `010_workflow_runs_artifacts.ts`. At inspection, `workflow_runs` has **0 rows**.
- Staging Neon project `mute-frost-50372225` has `workflow_runs.artifacts` as JSONB.
- Prior migration 010 uses `table.jsonb('artifacts').defaultTo('[]')`; its `down()` drops the column. The independent 032 repair reproduces only the missing additive postcondition and refuses destructive rollback.
- PR #179 also contains `032_workspace_experience.ts` with onboarding and other schema changes. The two migration filenames differ; PR #183 / this hardening branch is completely decoupled from PR #179. This repair does **not** apply onboarding or mutate user data.

## Recovery & Safeguard Status

- **Encrypted Production Backup:** Created fresh AEAD AES-256-GCM encrypted backup `aira_prod_main_backup_20261115175000_fresh.dump.enc` (SHA256: `7d49ab20ffa199db3a6d3f26e62d1eecd27f90556f74d7eb49f1dc0380049877`).
- **Fail-Closed Passphrase Enforcement:** Removed all deterministic fallback passphrases from backup scripts (`scripts/prod-backup-and-restore-rehearsal.ts`, `scripts/validate-pg18-backup-restore.ts`). The scripts strictly require an explicit encryption secret and abort immediately if absent.
- **Independent Key Escrow:** Established an independent DPAPI-encrypted key escrow at `C:\Users\WORKSTATION\.aira_secure_keys\aira_prod_backup_passphrase_dpapi_encrypted.bin` with exclusive NTFS permissions (`NT AUTHORITY\SYSTEM` and owner `WORKSTATION` only; inheritance removed).
- **PostgreSQL 18 Restoration Parity:** 100% parity verified on isolated WSL PostgreSQL 18.7: 48 tables, 12,464 rows, 459 constraints (100 relational + 359 NOT NULL), 141 indexes, 3 sequences, 0 orphaned foreign keys.
- **Preservation:** Original backup archive `...131728.dump.enc` and rollback deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` are preserved intact.

## Guarded Execution Procedure (`scripts/run-guarded-migration-032.ts`)

### Exact Approved CLI Command Syntax
```bash
# Production Execution (strictly requires owner approval + authorization flag)
npx tsx scripts/run-guarded-migration-032.ts --target=production --authorize-production-migration-032-execute

# Approved Rehearsal Branch Execution
npx tsx scripts/run-guarded-migration-032.ts --target=rehearsal

# Disposable Test / Isolated CI Execution
npx tsx scripts/run-guarded-migration-032.ts --target=disposable_test
```

1. **Strict CLI Argument Validation:** Rejects any positional arguments, unrecognized flags, duplicate flags, conflicting flags, or missing target flags. Positional target specification is forbidden.
2. **Target Validation & Exact Host Parsing:** Parses the connection URL, strictly extracts hostname and endpoint prefix via `URL.hostname`. Verifies exact equality against production Neon endpoint `ep-withered-art-b36ox90b` (for production) or `ep-lively-truth-b3im2z2q` (for rehearsal). Rejects substring matches and spoofed domains.
3. **Pending Migration Quarantine & Catalog Fail-Closed:** Scans filesystem and database migration ledger. Fails closed if the migration directory or authorized migration file is missing, or if ANY unapplied migration exists other than `032_reconcile_workflow_run_artifacts.ts` (quarantining Workspace V3).
4. **Recorded Migration Schema Verification:** If migration 032 is recorded in `knex_migrations`, verifies that `workflow_runs` table exists, `artifacts` column is present, and column data type is `jsonb`. Fails closed with `[CORRUPT_SCHEMA_ERROR]` if recorded without valid schema.
5. **Session Advisory Lock & Knex Lock Coordination:** Acquires session advisory lock `pg_try_advisory_lock(1095325257, 32)` for mutual exclusion between runners, and checks `knex_migrations_lock` to prevent conflict with standard Knex migrations.
6. **Dedicated Backend Connection & Bounded Timeouts:** Enforces session-level and transaction-level bounded locking:
   ```sql
   SET LOCAL lock_timeout = '2s';
   SET LOCAL statement_timeout = '5s';
   ```
   If lock contention occurs, PostgreSQL aborts within 1-2 seconds with clean rollback.
7. **Atomic Execution:** Checks table existence, adds JSONB column with default `'[]'::jsonb`, and atomically inserts ledger row into `knex_migrations` inside the same transaction before committing.
8. **Rollback & Idempotency:** Automatically executes `ROLLBACK` on error. Re-running after completion is a clean idempotent no-op.
