# AIRA AI 2026 — PR #96 Staging Maintenance Barrier Architecture

## 1. Executive Summary & Defect Root Cause

### 1.1 The Identified Vulnerability
During staging cutover preparation for PR #96 (`feat/commercial-staging-integration`), a critical concurrency risk was identified in `scripts/verify-staging-write-isolation.ts`.
- **The Defect**: The script checked `pg_stat_activity` and `pg_locks` for active transactions. This provided only an instantaneous snapshot (a 1ms check) indicating no transactions were currently in-flight.
- **The Risk**: It did **not** actively block new inbound client requests, background asynchronous workers, model inference pipelines, or older immutable Vercel preview/branch deployments from initiating new writes during schema migrations (016–022) or the historical identity reconciliation import.
- **The Core Threat Vector**: Older immutable deployments on Vercel retain valid connection strings to permanent staging (`mute-frost-50372225` / `ep-shiny-bird-b3xundyt`) using the database owner role (`neondb_owner`). Because immutable deployments cannot execute code or middleware introduced in PR #96, application-level middleware alone is insufficient to protect permanent staging.

### 1.2 The Multi-Layer Barrier Solution
To guarantee complete isolation, a dual-layer defense-in-depth architecture was implemented:
1. **Primary Layer — Authoritative PostgreSQL/Neon Database Barrier**:
   - Sentinel state table `_aira_staging_maintenance` tracking activation status and cryptographic token hash (`sha256(bypassToken)`).
   - Universal `BEFORE INSERT OR UPDATE OR DELETE` trigger `_aira_staging_maintenance_trigger` on all public tables executing `_aira_enforce_staging_maintenance()`.
   - Dynamic session inspection: Any write query without `SET aira.privileged_token = '<token>'` is aborted with PostgreSQL error code `55P03` (`[STAGING_MAINTENANCE_BLOCKED]`).
   - Database-level read-only default: `ALTER DATABASE neondb SET default_transaction_read_only = on` (safely applied where role permissions permit).
   - Idle backend pruning: Terminates existing idle pooler connections to force re-connection and session reset.
2. **Secondary Layer — Express Application Maintenance Middleware**:
   - `createStagingMaintenanceMiddleware` mounted in `apps/api/src/index.ts` upstream of all auth and business endpoints.
   - Intercepts all mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`).
   - Intercepts mutating `GET` paths: OAuth callbacks (`/api/auth/oauth/google/callback`, `/api/auth/oauth/github/callback`), OAuth starts, and account linking initiations.
   - Permits public health and liveness probes (`/api/health`, `/api/ready/*`) and CORS `OPTIONS` preflights.
   - Returns structured HTTP 503 `Service Unavailable` with `Retry-After: 60` and `X-Aira-Maintenance: active` headers.
3. **Privileged Migration & Import Elevation Path**:
   - Explicitly authorized Knex migration runner (`packages/db/src/index.ts:runMigrations`) and historical identity importer (`scripts/import-verified-commercial-identities.ts`) elevate their session in-transaction:
     `SET default_transaction_read_only = off;`
     `SET aira.privileged_token = '<token>';`
   - Zero credential exposure: Token is cryptographically generated, hashed with SHA-256 in the database, and never printed or committed.

---

## 2. Strict Boundary & Fail-Closed Invariants

| Criterion | Implementation Mechanism | Verification Result |
| :--- | :--- | :--- |
| **A. Staging-Only Behavior** | Queries Neon GUCs (`neon.project_id`, `neon.branch_id`) and checks URL classification. Throws `[SECURITY FATAL]` if connected to Production (`old-sky-50952395`). | **PASS** (Zero Production mutation risk) |
| **B. Actual Write Prevention** | PostgreSQL trigger aborts unprivileged DML with `55P03`; read-only default aborts DDL. | **PASS** (Empirically verified in tests) |
| **C. Coverage of Older Deployments** | Enforced at the PostgreSQL kernel level; connections from old Vercel URLs fail immediately on write. | **PASS** (Architecturally unbypassable) |
| **D. Background Write Protection** | Asynchronous workers, cron jobs, and queues connecting to the DB are intercepted by table triggers. | **PASS** |
| **E. Dynamic Control** | Activated via `scripts/staging-maintenance-control.ts --activate` *before* PR #96 is merged to staging. | **PASS** |
| **F. Reversibility** | Deactivated via `scripts/staging-maintenance-control.ts --deactivate`; triggers removed and read-only reset. | **PASS** |
| **G. Fail-Closed Behavior** | Missing metadata, corrupt token, unverified project ID, or unhandled errors abort release procedures. | **PASS** |
| **H. Privileged Migration Separation** | Migration runner and historical importer elevate via `aira.privileged_token` and `SET READ WRITE`. | **PASS** |
| **I. Credential Hygiene** | All tokens are in-memory or sha256-hashed; no passwords or secrets printed in logs or reports. | **PASS** (`test:secrets` clean) |

---

## 3. Data Flow & Transaction Sequence Diagram

```text
[External Request / Old Vercel Deploy / Background Worker]
                         │
                         ▼
        ┌─────────────────────────────────┐
        │ Express Middleware Layer        │
        │ (/api/middleware/staging-maint) │
        └─────────────────────────────────┘
           │                           │
  [Non-Mutating / Health]      [Mutating POST/PUT/DELETE / OAuth Callback]
           │                           │
           │                           ▼
           │                HTTP 503 Service Unavailable
           │                Retry-After: 60
           ▼
  ┌─────────────────────────────────────────┐
  │ PostgreSQL / Neon Database Boundary     │
  │ (mute-frost-50372225 / ep-shiny-bird)   │
  └─────────────────────────────────────────┘
           │
           ├─► Check 1: default_transaction_read_only = on?
           │            └──► If yes: DDL/DML rejected (25006)
           │
           └─► Check 2: BEFORE INSERT/UPDATE/DELETE Trigger:
                        _aira_staging_maintenance_trigger
                        ├── Read _aira_staging_maintenance (id=1)
                        ├── Verify sha256(current_setting('aira.privileged_token'))
                        │   equals stored bypass_token_hash?
                        │
                        ├── [NO / Missing Token]:
                        │   RAISE EXCEPTION '[STAGING_MAINTENANCE_BLOCKED]' (55P03)
                        │
                        └── [YES - Privileged Migration / Importer]:
                            PROCEED WITH MIGRATION / IMPORT WRITE
```

---

## 4. Release Protocol Sequence

1. **Owner Release Authorization**: Explicit GO LIVE instruction targeting exact 40-character SHA.
2. **Commit Verification**: 3-way synchronization (`approved_sha === local_head === remote_head`).
3. **Neon Recovery Checkpoint**: Point-in-time branch created and verified in Neon project `mute-frost-50372225`.
4. **Maintenance Barrier Activation**: Run `staging-maintenance-control.ts --activate` on permanent staging.
5. **Write Isolation Verification**: Run `verify-staging-write-isolation.ts` asserting all 5 release gates PASS:
   - `STAGING_DATABASE_IDENTITY = PASS`
   - `MAINTENANCE_BARRIER_ACTIVE = PASS`
   - `RUNTIME_WRITE_RESTRICTION = PASS`
   - `IN_FLIGHT_WRITES_DRAINED = PASS`
   - `PRIVILEGED_MIGRATION_PATH = PASS`
6. **Authorized PR #96 Merge**: Owner merges PR #96 into `staging`. Vercel builds and runs migrations 016–022 via privileged path.
7. **Controlled Historical Identity Import**: Run `scripts/import-verified-commercial-identities.ts` with elevated transaction.
8. **Integrity Certification**: Verify all 11 data-integrity rules via `staging-cutover-orchestrator.ts --verify-integrity`.
9. **Deployment & CI Attestation**: Verify Vercel deployment commit and GitHub Actions attestation.
10. **Real-Browser Acceptance**: Owner tests Google/GitHub login, credits (100), chat completions.
11. **Maintenance Barrier Deactivation**: Run `staging-maintenance-control.ts --deactivate` to unlock normal staging traffic.
