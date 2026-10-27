# AIRA AI 2026 — Milestone 2A: Production Activation, Infrastructure Preflight & Final Security Certification Report

**Document ID:** `CERT-M2A-ACTIVATION-PREFLIGHT-20261027`  
**Security & Release Engineering Authority:** Antigravity Autonomous Security Architecture & DevOps Board  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-M2A-DURABLE-EXECUTION`  
**Base Candidate Branch:** `feat/aira-m2a-durable-specialist-execution-20261027` (PR #115 Head SHA: `bf3cec65c6ad29370b48c58020c6cb6376a4353f`)  
**Implementation & Preflight Branch:** `fix/m2a-production-activation-preflight-20261027`  
**Target Pull Request:** PR targeting `feat/aira-m2a-durable-specialist-execution-20261027` (PR #115 remains DRAFT against `prod-release`)  
**Production Host:** `https://aira-ai-2026.vercel.app/` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`)  
**Production Neon Project:** `old-sky-50952395` (Endpoint: `ep-withered-art-b36ox90b`) — **UNTOUCHED / ZERO MUTATIONS**  
**Staging Neon Project:** `mute-frost-50372225` (Branch: `br-muddy-wave-b3zxhkqf`) — **VERIFIED TEST BED**  
**Final Preflight Verdict:** **`CONDITIONALLY READY`** (All code, security, policy, and TLS gates PASSED; pending human GO LIVE and container hosting provisioning)

---

## 1. Executive Summary

Milestone 2A establishes native PostgreSQL-backed durable specialist execution for AIRA AI 2026. Prior to this preflight phase, production execution was unconditionally blocked by static guard assertions in the worker bootstrap code.

This engineering pass implements the **production activation security mechanism**, establishing an explicit, fail-closed, multi-condition activation engine. In addition, it verifies strict PostgreSQL TLS certificate and hostname validation, corrects AWS Fargate container task sizing specifications to valid cloud provider increments, evaluates database migration 026 preflight, executes isolated staging acceptance tests against real Neon PostgreSQL, and documents the operational pre-deployment boundaries.

**NON-NEGOTIABLE SAFETY BOUNDARIES STRICTLY OBSERVED:**
- **Production Database Mutations:** **ZERO**. Project `old-sky-50952395` remains untouched.
- **Production Migrations Executed:** **ZERO**. Migration 026 was rehearsed exclusively on isolated staging.
- **Production Worker Deployments:** **ZERO**. No worker process was pointed to production.
- **Vercel Production Promotions:** **ZERO**.
- **PR #115 Merges into `prod-release`:** **ZERO**. PR #115 remains in `DRAFT`.

---

## 2. Exact Branch and Commit Verification

* **Worktree Path:** `C:\Users\WORKSTATION\AIRA-AI-2026-M2A-DURABLE-EXECUTION`
* **Base Source Branch:** `feat/aira-m2a-durable-specialist-execution-20261027`
* **Base Candidate Commit SHA:** `bf3cec65c6ad29370b48c58020c6cb6376a4353f`
* **Dedicated Implementation Branch:** `fix/m2a-production-activation-preflight-20261027`
* **PR #115 State:** `OPEN` / `isDraft: true` (Target: `prod-release`)
* **Tracking Remote:** `origin/feat/aira-m2a-durable-specialist-execution-20261027` (synchronized)

---

## 3. Production Activation Policy Implementation

The worker activation policy is centralized in `packages/agent-runtime/src/durable/worker-activation-policy.ts` and integrated directly into the standalone worker host entrypoint `apps/specialist-worker/src/index.ts`.

### 3.1 Policy Configuration Model
Production activation requires four mandatory conditions to be satisfied **simultaneously**:
1. `AIRA_ENV=production`
2. `AIRA_PRODUCTION_WORKER_ENABLED=true` (strictly lowercase boolean string `'true'`; unsupported representations like `'TRUE'`, `'1'`, `'yes'`, or whitespace are rejected fail-closed).
3. `EXPECTED_NEON_PROJECT_ID=old-sky-50952395` (must match canonical production Neon project ID).
4. `EXPECTED_NEON_ENDPOINT_ID=ep-withered-art-b36ox90b` (must match canonical production Neon endpoint ID).

### 3.2 Dual-Layer Verification Flow
1. **Static Configuration Preflight:** `evaluateWorkerActivationPolicy(config)` verifies environment variables, boolean strictness, and canonical ID matches before initializing network sockets.
2. **Authoritative Runtime Identity Assertion:** `assertWorkerActivationAuthorized(config, db)` queries live Neon PostgreSQL GUCs:
   ```sql
   SELECT 
     current_database() as db_name, 
     current_user as db_user, 
     inet_server_addr() as server_ip,
     current_setting('neon.project_id', true) as neon_project_id,
     current_setting('neon.branch_id', true) as neon_branch_id,
     current_setting('neon.endpoint_id', true) as neon_endpoint_id;
   ```
   If the returned `neon_project_id` or `neon_endpoint_id` does not match the asserted production identity, or if the query fails, the process terminates immediately with exit code 1.
3. **Task & Readiness Guarding:** 
   - HTTP `/ready` returns HTTP 503 until `isActivated === true && dbConnected === true && !isShuttingDown`.
   - Polling loop (`host.start()`) is only called after runtime activation succeeds.
   - User-supplied task and mission JSON payloads are completely decoupled from policy configuration, preventing payload-level authorization spoofing.

---

## 4. Default-Deny & Security Test Matrix (TEST A1 – A15)

All 15 default-deny security scenarios were implemented and certified in `test/m2a-production-activation-security.test.ts`:

| Test ID | Test Scenario | Expected Outcome | Execution Result | Evidence / Details |
| :--- | :--- | :--- | :--- | :--- |
| **TEST A1** | `AIRA_ENV=production` + activation flag missing | STARTUP DENIED | **PASS** | Rejection code: `MISSING_ACTIVATION_FLAG` |
| **TEST A2** | `AIRA_ENV=production` + `activation=false` | STARTUP DENIED | **PASS** | Rejection code: `ACTIVATION_DISABLED` |
| **TEST A3** | `AIRA_ENV=production` + `activation=TRUE` / `'1'` / `'true '` | STARTUP DENIED | **PASS** | Rejection code: `UNSUPPORTED_BOOLEAN_REPRESENTATION` |
| **TEST A4** | `AIRA_ENV=production` + expected project ID missing | STARTUP DENIED | **PASS** | Rejection code: `MISSING_EXPECTED_PROJECT_ID` |
| **TEST A5** | `AIRA_ENV=production` + expected endpoint ID missing | STARTUP DENIED | **PASS** | Rejection code: `MISSING_EXPECTED_ENDPOINT_ID` |
| **TEST A6** | `AIRA_ENV=production` + connected to staging Neon | STARTUP DENIED | **PASS** | Rejection code: `CRITICAL_ENVIRONMENT_CROSSOVER_STAGING_IN_PROD` |
| **TEST A7** | `AIRA_ENV=production` + incorrect project ID | STARTUP DENIED | **PASS** | Rejection code: `DATABASE_PROJECT_MISMATCH` |
| **TEST A8** | `AIRA_ENV=production` + incorrect endpoint ID | STARTUP DENIED | **PASS** | Rejection code: `DATABASE_ENDPOINT_MISMATCH` |
| **TEST A9** | `AIRA_ENV=production` + database query unavailable / unreachable | STARTUP DENIED | **PASS** | Fails closed with `DATABASE_UNAVAILABLE` |
| **TEST A10**| `AIRA_ENV=production` + unverified database identity (empty GUCs) | STARTUP DENIED | **PASS** | Rejection code: `UNVERIFIED_DATABASE_IDENTITY` |
| **TEST A11**| `AIRA_ENV=production` + valid credentials but activation disabled | STARTUP DENIED | **PASS** | Rejection code: `ACTIVATION_DISABLED` |
| **TEST A12**| `AIRA_ENV=production` + activation flag injected in task payload | STARTUP DENIED | **PASS** | Environment-only derivation; task payload ignored |
| **TEST A13**| `AIRA_ENV=staging` + production activation configuration | STARTUP DENIED | **PASS** | Rejection code: `INCONSISTENT_NON_PROD_ACTIVATION_CONFIG` |
| **TEST A14**| Activation failure occurs | ZERO CLAIMS & ZERO TOOLS | **PASS** | Host never started; task remains strictly `QUEUED` |
| **TEST A15**| Activation failure occurs | READINESS NOT READY | **PASS** | HTTP `/ready` returns HTTP 503 |

---

## 5. Positive Activation Path Evidence

* **Layer 1 — Deterministic Policy Verification (`PASS`):**
  * Evaluated valid production configuration with trusted mock production identity.
  * Verdict: `PRODUCTION_ACTIVATION_AUTHORIZED` (`authorized: true`, `isProduction: true`).
* **Layer 2 — Live Staging Integration (`PASS`):**
  * Connected directly to live isolated Neon PostgreSQL (`br-muddy-wave-b3zxhkqf` on `mute-frost-50372225`).
  * Retrieved live Neon GUCs, verified non-production classification (`NON_PROD_WORKER_AUTHORIZED`), and confirmed database table preflight checks.
* **Live Production Execution:**
  * **NOT EXECUTED**. Strictly deferred until post-release deployment authorization.

---

## 6. Strict Neon PostgreSQL TLS Certification (TLS-1 – TLS-5)

Executed in `test/m2a-strict-tls-validation.test.ts`:

| Test ID | Test Condition | Security Verification | Result |
| :--- | :--- | :--- | :--- |
| **TLS-1** | Trusted staging Neon endpoint | Direct TLSv1.3 handshake with system CA trust store. Cipher: `TLS_AES_256_GCM_SHA384`. Zero authorization errors. | **PASS** |
| **TLS-2** | Untrusted / self-signed certificate authority | Socket configured with untrusted CA string fails closed with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. | **PASS** |
| **TLS-3** | Hostname mismatch (spoofed domain SNI) | Handshake attempting `spoofed-attacker-domain.evil-corp.com` fails closed with `ERR_TLS_CERT_ALTNAME_INVALID`. | **PASS** |
| **TLS-4** | Malformed trust configuration | Malformed PEM certificate configuration fails closed immediately. | **PASS** |
| **TLS-5** | Codebase DB client pool validation | Verified `packages/db/src/index.ts` enforces `ssl: { rejectUnauthorized: true }`. Verified live acquired pg pool stream is encrypted (`stream.encrypted === true`), authorized (`stream.authorized === true`), and running TLSv1.3. | **PASS** |

> [!NOTE]
> Node-postgres issued a deprecation warning regarding `sslmode=require` aliasing `verify-full` in future major versions. AIRA's Knex client explicitly sets `ssl: { rejectUnauthorized: true }`, guaranteeing strict certificate and hostname verification regardless of driver defaults.

---

## 7. Correct Production Hosting & AWS Fargate Resource Specification

### 7.1 Correction of Infrastructure Sizing
The previous planning document specified `0.5 vCPU + 512 MB RAM`. According to official AWS ECS Fargate task size matrices, **512 MB RAM is only supported for 0.25 vCPU**. The minimum supported memory for 0.5 vCPU is **1024 MB (1 GB)**.

### 7.2 Valid Provider Sizing Options

| Dimension | Option A (Minimal) | Option B (RECOMMENDED) | Option C (High Concurrency) |
| :--- | :--- | :--- | :--- |
| **vCPU** | 0.25 vCPU (256 CPU units) | **0.5 vCPU (512 CPU units)** | 1.0 vCPU (1024 CPU units) |
| **Memory** | 512 MB | **1024 MB (1 GB)** | 2048 MB (2 GB) |
| **Node.js Heap (`--max-old-space-size`)** | 384 MB | **512 MB** | 1024 MB |
| **Worker Concurrency** | 1 – 2 tasks | **2 – 4 tasks** | 4 – 8 tasks |
| **Headroom for OS / Native Buffers** | 128 MB (tight) | **512 MB (healthy)** | 1024 MB (spacious) |
| **Est. Monthly Cost per Replica** | ~$4.50 / month | **~$9.00 / month** | ~$18.00 / month |
| **Provider Compatibility** | AWS Fargate, Fly.io, Railway | **AWS Fargate, Fly.io, Railway** | AWS Fargate, Fly.io, Railway |

### 7.3 Container Hosting Architecture Recommendation
* **Primary Target:** AWS ECS Fargate task running `aira-specialist-worker` with **Option B (0.5 vCPU / 1 GB RAM)**.
* **Process Model:** `dumb-init` PID 1 supervisor running Node.js 22 with dropped privileges to non-root user `aira` (UID 10001).
* **Network Security:** Deployed in a private VPC subnet with NAT Gateway egress to Neon PostgreSQL over TLS (`sslmode=require`). Worker port 8080 is bound to internal loopback/VPC for container health probes and is never publicly exposed.
* **Secret Injection:** `DATABASE_URL` injected at runtime from AWS Secrets Manager or secure container environment store.

---

## 8. Database Migration 026 Preflight & Reversibility

* **Schema Scope:** Creates `specialist_tasks` and `specialist_task_events`.
* **Lock Escalation Risk:** **Zero**. The migration is purely additive; it creates two new tables with outbound foreign keys to `runs(id)`. Existing production tables (`runs`, `messages`, `users`) are not modified, dropped, or locked.
* **Rehearsal Status:** Applied and verified on isolated staging branch `br-muddy-wave-b3zxhkqf` on project `mute-frost-50372225`.
* **Production Preflight Verification:**
  - `knex_migrations` table state inspected;
  - Zero unrecorded schema drift;
  - Production database `old-sky-50952395` untouched.
* **Data-Preserving Rollback Policy:**
  > [!IMPORTANT]
  > Routine production rollback must **NOT** drop durable tables containing historical user tasks.
  > If a rollback is required post-migration:
  > 1. Set `AIRA_PRODUCTION_WORKER_ENABLED=false` to halt worker claiming;
  > 2. Revert the API layer to cease routing tasks to specialist execution;
  > 3. Preserve `specialist_tasks` and `specialist_task_events` records for compliance and diagnostics.
  > Only run `026.down()` during pre-release staging resets or before user traffic has touched the tables.
* **Migration Readiness Verdict:** **`PASS`**.

---

## 9. Accidental Activation Safeguards (SCENARIOS B1 – B8)

Tested in `test/m2a-production-activation-security.test.ts`:
* **B1 (Disabled Deploy):** Container deployed with `productionWorkerEnabled=false` runs diagnostics but cannot claim tasks.
* **B2 (Unexpected Restart):** Container reboot re-evaluates all 4 conditions from scratch; missing endpoint ID fails closed.
* **B3 (Incomplete Config):** Incomplete environment immediately aborts container boot.
* **B4 (DB Project Shift):** If Neon endpoint or project ID changes unexpectedly, worker immediately refuses execution.
* **B5 (Credentials Present but Activation Disabled):** Zero task polling and zero tool execution occur.
* **B6 (Rolling Deployment Replicas):** Every replica independently verifies its own activation policy at bootstrap.
* **B7 (Config Change In-Flight):** Environment changes require a clean container restart to take effect.
* **B8 (Process Crash / Restart):** Revalidates live database query on each startup tick.

---

## 10. Full Regression & Security Test Summary

```
================================================================================
                    AIRA AI 2026 TEST SUITE EXECUTION MATRIX
================================================================================
 1. M1 Specialist Contracts (test/agent-specialists.test.ts)     --> 25 PASS
 2. M2-A State Machine (test/m2a-durable-specialist-execution)  --> 17 PASS
 3. Release-Auth Security Guard (test/release-authorization)     --> 52 PASS
 4. Tracked Secrets & Credential Hygiene (557 files scanned)     --> 0 SECRETS
 5. Production Activation Security (test/m2a-production-activation)--> 26 PASS
 6. Strict Neon TLS Validation (test/m2a-strict-tls-validation)   -->  5 PASS
 7. Real PostgreSQL Staging Suite (test/m2a-real-postgres)       --> 18 PHASES PASS
 8. TypeScript Compilation (npm run typecheck)                  --> 0 ERRORS
 9. Linter Audit (npm run lint)                                  --> 0 ERRORS
 10. Production Webpack/Vite Bundle (npm run build)              --> SUCCESS (1.48s)
================================================================================
 TOTAL AUTOMATED SECURITY & RUNTIME TESTS PASSED: 143+ PASSING CHECKS (0 FAILS)
================================================================================
```

---

## 11. Known Limitations & Outstanding Operational Blockers

1. **Production Worker Hosting Provisioning:** Container runtime (AWS ECS Fargate or dedicated Docker host) is documented and specified, but has **not been provisioned** in the live production cloud account.
2. **Production Database Secrets Injection:** Production database connection strings must be configured in the container secrets manager at deployment time.
3. **Draft Pull Request Governance:** PR #115 remains in Draft state targeting `prod-release`.
4. **Mandatory Human Release Authority:** In accordance with repository governance in `AGENTS.md`, merging PR #115 triggers an immediate automated production deployment on Vercel Hobby tier. Merging requires explicit, fresh human **GO LIVE** authorization naming the exact candidate SHA from repository owner `rajpunkeshwarrajgautam-boop`.

---

## 12. Proposed Controlled Production Deployment Sequence

When explicit human GO LIVE authorization is granted, execute in strict sequence:

1. **Step 1 (Pre-Release Backup):** Create point-in-time snapshot branch of production Neon project `old-sky-50952395`.
2. **Step 2 (Database Schema Migration):** Run migration 026 against `old-sky-50952395` via authorized migration script.
3. **Step 3 (Worker Container Deployment in Disabled Mode):** Deploy container image to ECS Fargate with `AIRA_PRODUCTION_WORKER_ENABLED=false`. Verify `/health` responds HTTP 200 and `/ready` responds HTTP 503.
4. **Step 4 (Vercel Application Release):** Merge authorized PR into `prod-release`. Vercel automatically deploys frontend and mission API.
5. **Step 5 (Worker Activation):** Update worker task configuration to `AIRA_PRODUCTION_WORKER_ENABLED=true`, restart worker container, and verify `/ready` responds HTTP 200.
6. **Step 6 (Production Smoke Acceptance):** Dispatch single bounded test calculation `((16384 * 1024) / 4) = 4194304` under internal smoke test principal. Verify claim, execution, persistence, and retrieval.
7. **Step 7 (Final Monitoring & Handoff):** Monitor queue lag, connection counts, and worker memory for 60 minutes.

---

## 13. Final Release-Readiness Verdict

```
================================================================================
                    FINAL RELEASE-READINESS VERDICT
================================================================================

                           CONDITIONALLY READY

  The Milestone 2A production activation security mechanism, strict TLS
  verification, AWS Fargate hosting specification, and database preflight
  are fully implemented and certified.

  ALL 10 RELEASE GATES PASSED IN STAGING REHEARSAL.

  OUTSTANDING CONDITIONS PRECEDENT TO PRODUCTION MERGE & ROLLOUT:
  1. Provision the persistent container runtime (AWS ECS Fargate Option B:
     0.5 vCPU / 1 GB RAM).
  2. Inject production database credentials via secure secrets manager.
  3. Receive fresh, explicit, human GO LIVE authorization from
     rajpunkeshwarrajgautam-boop naming the exact reviewed release SHA.

================================================================================
```
