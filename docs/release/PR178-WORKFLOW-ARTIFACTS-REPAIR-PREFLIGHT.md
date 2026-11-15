# PR #178 — production workflow artifacts schema drift preflight

**Scope:** isolated, additive fix for `public.workflow_runs.artifacts` only.
This change does not authorize deployment, production SQL, or a merge of PR #178 / #179.

## Verified discrepancy (2026-11-15)

- Production Neon project `old-sky-50952395`, main branch `br-shiny-moon-b3vy9xj7`, PostgreSQL 18: `workflow_runs.artifacts` absent. `knex_migrations` contains `010_workflow_runs_artifacts.ts`. At inspection, `workflow_runs` has **0 rows** (may change).
- Staging Neon project `mute-frost-50372225` has `workflow_runs.artifacts` as JSONB.
- Prior migration 010 uses `table.jsonb('artifacts').defaultTo('[]')`; its `down()` drops the column. The independent 032 repair reproduces only the missing additive postcondition and refuses destructive rollback.
- PR #179 also contains `032_workspace_experience.ts` with onboarding and other schema changes. The two migration filenames differ; evaluate version ordering and conflicts before merging either branch. This repair does **not** apply onboarding or mutate users.

## Recovery gate — presently BLOCKED

- At assessment time, the only available Neon snapshot was created 2026-10-25, not fresh enough for a 2026-11-15 release.
- An attempt to create `pre-pr178-artifacts-repair-20261115` failed: **HTTP 422, snapshots limit exceeded**. No snapshot was created.
- Production Neon has 10 branches (including archived branches) and the subscription branch limit is 10. Do not delete, repurpose or restore over an existing branch without explicit approval.
- Before any production schema change, free recovery capacity under an approved retention policy or increase plan capacity. Create and verify a **fresh** snapshot plus a new restored/branched copy. Compare migration ledger, row counts, column metadata, current SHA, and recovery timestamp. Rehearse migration and data checks on that restored copy. A 6-hour history-retention window is not a substitute for a verified fresh recovery point.
- Preserve rollback deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8`. An app rollback does not undo incompatible schema changes.

## Disposable SQL rehearsal (does not use Neon credentials)

The isolated PostgreSQL CI suite provisions a fresh PostgreSQL 16 container on an internal-only Docker network, with a random run-scoped database, no published ports and no persistent volumes. After migrations, a guarded test opens a transaction, temporarily drops the column, runs the isolated migration, verifies JSONB/default/nullability and row counts, runs it again for idempotency, tests that `down()` refuses deletion, then explicitly rolls the transaction back. The test rejects external/production database URLs and unexpected database roles. This verifies migration logic but is **not** equivalent to restored-current-production data validation.

## Required production execution plan (not authorized)

1. Require approved backup/recovery point and independent restore rehearsal, including exact timestamp and successful restore checks.
2. Lock migration target to verified production project/branch/database by independent connection and identity checks; reject staging/preview endpoints.
3. Schedule a controlled maintenance/worker compatibility window if existing workflow writes depend on `artifacts`.
4. On review and explicit approval, apply only the additive Knex migration through the normal migration runner; verify applied ledger row, JSONB column/default, pre/post row counts and workflow insert/reads.
5. Roll forward if validation fails, or restore under an approved recovery procedure. **Never** automatically run `down()` to drop artifacts, rewind migrations, or change onboarding state.
6. Re-run PR #178 strict required checks on its exact merge commit and perform production smoke tests only after separate release authorization.

**Status: migration implementation + disposable CI candidate only; production backup, restored-copy rehearsal and schema change remain BLOCKED.**
