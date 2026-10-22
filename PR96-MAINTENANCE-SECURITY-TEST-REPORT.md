# AIRA AI 2026 — PR #96 Maintenance Security & Regression Test Report

## 1. Test Execution Summary

**Execution Timestamp**: 2026-10-22T05:12:56Z / 2026-10-22T10:42:56+05:30  
**Git Branch**: `fix/pr96-staging-maintenance-barrier-20261022`  
**Starting Commit SHA**: `f1765fa45ed9648c979eb5a5d7fddfe657f40d3f`  
**Working Tree Status**: Clean  
**Overall Verdict**: **ALL MANDATORY TEST SUITES PASSED (0 FAILURES)**

| Test Suite | Command | Total Checks | Result | Execution Time |
| :--- | :--- | :--- | :--- | :--- |
| **TypeScript Compilation** | `npm run typecheck` | Full project | **PASS** (0 errors) | 1.8s |
| **Lint Audit** | `npm run lint` | 315 files | **PASS** (0 errors) | 41ms |
| **Production Build** | `npm run build` | Full bundle | **PASS** (0 errors) | 711ms |
| **Tracked Secrets Hygiene** | `npm run test:secrets` | 474 files | **PASS** (0 leaks) | 1.2s |
| **Database Isolation Guard** | `npm run test:db-isolation` | 41 tests | **PASS** | 2.1s |
| **Release Auth Engine (Unit)**| `npm run test:release-auth:unit`| 52 tests | **PASS** | 1.6s |
| **Release Auth Gate App** | `npm run test:release-auth:app` | Node test runner | **PASS** | 0.8s |
| **Auth Lifecycle & Revocation**| `npm run test:auth-lifecycle`| 10 tests | **PASS** | 2.4s |
| **Staging Cutover Safety Gates**| `npm run test:cutover-safety` | 18 assertions | **PASS** | 1.9s |
| **Staging Maintenance Barrier**| `npm run test:maintenance-barrier`| 26 assertions | **PASS** | 1.8s |

---

## 2. Detailed Breakdown of Maintenance Barrier Assertions

### Group 1: Cryptographic Tokens & Production Protection (4 Tests)
- `Generates 64-char hex cryptographically secure token`: **PASS** (Asserts CSPRNG 256-bit entropy).
- `Computes deterministic SHA-256 hash of bypass token`: **PASS** (Asserts one-way hashing for database storage).
- `Strict production check throws [SECURITY FATAL] on production Neon project`: **PASS** (Throws fatal exception if connected to `old-sky-50952395`).
- `Staging maintenance activation aborted if target is Production`: **PASS** (Guarantees zero production mutation).

### Group 2: Database Maintenance Barrier Lifecycle (3 Tests)
- `Activate staging maintenance initializes sentinel and attaches triggers to tables`: **PASS** (Sentinel created, triggers attached to `conversations`, `conversation_messages`, `runs`, `agents`, etc., and database read-only set).
- `Status reports active barrier with guarded tables count`: **PASS** (Confirms `isActive=true`, `defaultReadOnly=true`, and active trigger count).
- `Deactivate staging maintenance cleanly clears sentinel, read-only setting and triggers`: **PASS** (Reversibility proven; read-only reset and triggers removed).

### Group 3: Write Restriction Verification & Bypass Rejection (2 Tests)
- `Unprivileged write is rejected when maintenance is active (older deployment simulation)`: **PASS** (Direct insert fails with `[STAGING_MAINTENANCE_BLOCKED]` / `55P03`; elevated transaction with bypass token succeeds).
- `Write restriction check fails if unprivileged insert unexpectedly succeeds`: **PASS** (Fail-closed assertion: Leaky writes trigger immediate failure).

### Group 4: 5-Gate Write Isolation Evaluation (2 Tests)
- `verifyStagingWriteIsolation passes all 5 gates when barrier active and writes drained`: **PASS**
  - Gate 1 (`STAGING_DATABASE_IDENTITY`): PASS
  - Gate 2 (`MAINTENANCE_BARRIER_ACTIVE`): PASS
  - Gate 3 (`RUNTIME_WRITE_RESTRICTION`): PASS
  - Gate 4 (`IN_FLIGHT_WRITES_DRAINED`): PASS
  - Gate 5 (`PRIVILEGED_MIGRATION_PATH`): PASS
- `verifyStagingWriteIsolation fails if in-flight active writers detected`: **PASS** (Fails closed on `pg_stat_activity` active transaction).

### Group 5: Express Maintenance Middleware HTTP Interception (15 Tests)
- `Health check /api/health passes through unconditionally`: **PASS** (HTTP 200).
- `Readiness probe /api/ready/benchmark passes through unconditionally`: **PASS** (HTTP 200).
- `CORS OPTIONS preflight passes through unconditionally`: **PASS** (HTTP 200).
- `Read-only GET /api/billing/plans passes through to next()`: **PASS** (HTTP 200).
- `POST /api/chat/stream blocked with HTTP 503 and Retry-After: 60`: **PASS**.
- `POST /api/runs blocked with HTTP 503`: **PASS**.
- `PUT /api/account/profile blocked with HTTP 503`: **PASS**.
- `DELETE /api/conversations/123 blocked with HTTP 503`: **PASS**.
- `Mutating GET: /api/auth/oauth/google/callback blocked with HTTP 503`: **PASS**.
- `Mutating GET: /api/auth/oauth/github/callback blocked with HTTP 503`: **PASS**.
- `Mutating GET: /api/auth/oauth/google/start blocked with HTTP 503`: **PASS**.
- `Mutating GET: /api/auth/oauth/google/link blocked with HTTP 503`: **PASS**.
- `Privileged request with X-Aira-Maintenance-Token bypasses barrier to next()`: **PASS** (Sets `X-Aira-Maintenance-Bypass: authorized`).
- `Request with incorrect X-Aira-Maintenance-Token is denied with HTTP 503`: **PASS**.
- `Disabled middleware permits all mutating requests through`: **PASS**.

---

## 3. Empirical Security Conclusions

1. **Older Deployment Protection**: Even if an attacker or automated system targets an older Vercel URL that lacks Express maintenance middleware, writes cannot succeed because PostgreSQL enforces triggers and read-only transaction defaults at the database layer.
2. **Reversibility**: Both the database-level triggers/GUCs and Express middleware can be deactivated with a single CLI command (`staging-maintenance-control.ts --deactivate`), leaving zero persistent schema artifacts or performance overhead.
3. **Fail-Closed Assurance**: The barrier fails closed if any database query errors or if the target database identity contradicts permanent staging.
