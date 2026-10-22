# AIRA AI 2026 — PR #96 Staging Cutover Readiness Certification

## 1. Release Certification Verdict

**Verdict**: **IMPLEMENTATION CERTIFIED — LIVE STAGING ACTIVATION APPROVAL REQUIRED**

### Rationale:
1. The staging maintenance barrier implementation, Express middleware, 5-gate write isolation engine, and cutover wizard/orchestrator scripts are fully implemented, typechecked, linted, built, and tested with **zero failures** across all 10 project test suites.
2. In accordance with strict repository policy (`AGENTS.md`) and task constraints, no automated agent may activate maintenance on live permanent staging, run live permanent migrations, or merge PR #96 into `staging` without explicit, real-time owner authorization for the exact commit SHA.
3. All code, tests, and documentation are ready for integration into PR #96 (`feat/commercial-staging-integration`).

---

## 2. Release Gates & Verification Scorecard

| Gate | Category | Description | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Gate 1** | Repository & Worktree | Verified correct worktree, clean working tree, branch `fix/pr96-staging-maintenance-barrier-20261022`. | **PASS** | `git rev-parse HEAD` = `f1765fa` |
| **Gate 2** | Production Isolation | Verified strict prohibition against production modification (`old-sky-50952395`). | **PASS** | `assertNonProductionTarget` enforced |
| **Gate 3** | Dual-Layer Barrier | Built PostgreSQL trigger + read-only barrier and Express middleware. | **PASS** | 26 automated unit/regression tests green |
| **Gate 4** | Older Deployment Coverage| Proven database-level blockage of older immutable Vercel deployment writes. | **PASS** | Empirical write probe tests green |
| **Gate 5** | 5-Gate Write Isolation | Upgraded `verify-staging-write-isolation.ts` asserting all 5 gates. | **PASS** | `npm run test:cutover-safety` 18/18 green |
| **Gate 6** | Cutover Automation | Updated `staging-cutover-wizard.sh` (Stages 3 & 8) and `staging-cutover-orchestrator.ts`. | **PASS** | Automated state machine verified |
| **Gate 7** | Quality Assurance | `typecheck`, `lint`, `build`, `test:secrets`, `test:db-isolation`, `test:release-auth:unit`, `test:auth-lifecycle`. | **PASS** | 100% test suites passed (0 errors) |
| **Gate 8** | Credential Hygiene | Tracked secrets scan confirms zero exposed credentials or tokens. | **PASS** | `npm run test:secrets` clean |

---

## 3. Inventory of Changed and Created Files

| File Path | Action | Description |
| :--- | :--- | :--- |
| `packages/db/src/security/staging-maintenance-barrier.ts` | **CREATED** | Core database maintenance barrier engine: trigger attachment, sentinel state, read-only defaults, and write probe verification. |
| `apps/api/src/middleware/staging-maintenance.ts` | **CREATED** | Express middleware intercepting mutating methods and mutating GET routes with HTTP 503 during maintenance. |
| `scripts/staging-maintenance-control.ts` | **CREATED** | Operator CLI for activating, deactivating, inspecting, and empirically verifying the maintenance barrier. |
| `test/staging-maintenance-barrier.test.ts` | **CREATED** | 26-test regression and security suite exercising both database and HTTP barrier layers. |
| `scripts/verify-staging-write-isolation.ts` | **MODIFIED** | Upgraded to enforce the 5 mandatory release gates (Identity, Barrier, Restriction, InFlight, Privileged). |
| `scripts/staging-cutover-orchestrator.ts` | **MODIFIED** | Updated Step 4 and Step 9 definitions for maintenance barrier activation and clean deactivation. |
| `scripts/staging-cutover-wizard.sh` | **MODIFIED** | Updated Stage 3 and Stage 8 to guide the owner through activating and deactivating the barrier. |
| `apps/api/src/index.ts` | **MODIFIED** | Mounted `createStagingMaintenanceMiddleware()` upstream of all authentication and mutating routes. |
| `packages/db/src/index.ts` | **MODIFIED** | Enhanced `runMigrations()` to support elevated transaction execution and re-exported barrier utilities. |
| `package.json` | **MODIFIED** | Registered `"test:maintenance-barrier": "npx tsx test/staging-maintenance-barrier.test.ts"`. |
| `.github/workflows/staging-deployment.yml` | **MODIFIED** | Added `Staging maintenance barrier & write isolation certification` step. |
| `test/staging-cutover-safety-gates.test.ts` | **MODIFIED** | Updated Test Group 5 assertions to validate the upgraded 5-gate write isolation engine. |

---

## 4. Operational Runbook for Live Staging Cutover

### Step 1: Pre-Cutover Verification
```bash
git fetch origin feat/commercial-staging-integration
git rev-parse HEAD
# Confirm local HEAD matches remote PR #96 HEAD
```

### Step 2: Create Fresh Neon Recovery Checkpoint
In Neon Console (`mute-frost-50372225`), create an instant point-in-time branch:
- Branch Name: `staging-backup-pre-pr96-<timestamp>`
- Parent Branch: `br-autumn-star-b36dfu5w` (main)

### Step 3: Activate Staging Maintenance Barrier
```bash
STAGING_DB_URL="<STAGING_DATABASE_URL>" \
AIRA_MAINTENANCE_OPERATOR="rajpunkeshwarrajgautam-boop" \
npx tsx scripts/staging-maintenance-control.ts --activate
```
*Note the printed `AIRA_MAINTENANCE_BYPASS_TOKEN`.*

### Step 4: Verify Effective Write Isolation Across All 5 Gates
```bash
STAGING_DB_URL="<STAGING_DATABASE_URL>" \
AIRA_MAINTENANCE_BYPASS_TOKEN="<BYPASS_TOKEN>" \
npx tsx scripts/verify-staging-write-isolation.ts "$STAGING_DB_URL" --token "$AIRA_MAINTENANCE_BYPASS_TOKEN"
```
*Must output `✓ [WRITE_ISOLATION_VERIFIED]` with PASS across all 5 gates.*

### Step 5: Merge PR #96 into Staging
- Merge PR #96 via GitHub web interface.
- Vercel build executes migrations 016–022.

### Step 6: Execute Controlled Historical Identity Import
```bash
AIRA_ALLOW_STAGING_LIVE_IMPORT=true \
AIRA_MAINTENANCE_BYPASS_TOKEN="<BYPASS_TOKEN>" \
SOURCE_DB_URL="<COMMERCIAL_PR92_DB_URL>" \
TARGET_DB_URL="<STAGING_DATABASE_URL>" \
npx tsx scripts/import-verified-commercial-identities.ts "$STAGING_DB_URL"
```

### Step 7: Verify Data Integrity
```bash
TARGET_DB_URL="<STAGING_DATABASE_URL>" \
AIRA_ALLOW_STAGING_LIVE_IMPORT=true \
npx tsx scripts/staging-cutover-orchestrator.ts --verify-integrity "$STAGING_DB_URL"
```

### Step 8: Perform Real-Browser Acceptance Testing
- Test Google/GitHub sign-in on `https://staging.virexaaiventures.com`.
- Verify credit wallet balance displays 100 credits.
- Stream chat message completion.

### Step 9: Deactivate Maintenance Barrier
```bash
STAGING_DB_URL="<STAGING_DATABASE_URL>" \
AIRA_MAINTENANCE_OPERATOR="rajpunkeshwarrajgautam-boop" \
npx tsx scripts/staging-maintenance-control.ts --deactivate
```

---

## 5. Rollback Procedure
If any fatal error occurs during schema migration or historical data import:
1. Revert staging commit on Git:
   `git revert HEAD -m 1 && git push origin staging`
2. Restore permanent staging Neon database from the pre-cutover checkpoint:
   - In Neon Console, restore branch `br-autumn-star-b36dfu5w` from checkpoint snapshot (LSN / Point-in-time).
3. Deactivate maintenance barrier if active:
   `STAGING_DB_URL="<STAGING_DATABASE_URL>" npx tsx scripts/staging-maintenance-control.ts --deactivate`
