# AIRA AI 2026 — Production Acceptance & Corrective Certification Report

**Document Version:** 3.0.0 (Hardened & Truthful Certification)  
**Audit Timestamp:** 2026-11-18T18:30:00Z / 2026-11-19 00:00 IST  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Production URL:** `https://aira-ai-2026.vercel.app`  
**Production HEAD Commit:** `b5a27f391447b68448edf067cdb2ee62a598c264`  
**Production Deployment ID:** `dpl_BTiLvhq77siuaz655zZARHdBKuBZ`  
**Vercel Project ID:** `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`  
**Preserved Rollback Deployment ID:** `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` (Commit `d988a6bd26d49a000d59cf906b13fcfe9e170058`)  
**Neon Production Database:** `old-sky-50952395` / branch `br-shiny-moon-b3vy9xj7`  
**Neon Recovery Checkpoint:** `br-orange-art-b3vzajv0` (LSN `0/1E912998`)  
**Certification Status:** **BLOCKED (Awaiting Second Independent Test Principal & Paid Test Principal)**

---

## 1. Executive Summary & Authoritative Verdict

Following the authorized execution of Gate 2 (guarded migration 032) and Gate 3 (production promotion to `prod-release` on Vercel deployment `dpl_BTiLvhq77siuaz655zZARHdBKuBZ`), comprehensive end-to-end acceptance testing was performed and rigorously audited.

In accordance with strict production engineering integrity rules prohibiting false-positive assertions or synthetic mocks, the acceptance suite (`scripts/production-acceptance-suite.ts`) and regression verification suite (`test/production-acceptance-harness.test.ts`) have been hardened.

### Summary of Certified Subsystems:
1. **Production Infrastructure & Deployment Baseline:** **PASS**. Exact commit `b5a27f391447b68448edf067cdb2ee62a598c264` is live on `https://aira-ai-2026.vercel.app`. CI run `44346736429` on `prod-release` passed all checks (`Semantic Search CI`, `Fast CI`, `Main / PR certification`). Neon database is at 32 migrations with migration 032 active, `workflow_runs.artifacts` as JSONB default `'[]'::jsonb`, and Knex locks released.
2. **Encrypted Pre-Migration Backup & Restore Parity (Phase G):** **PASS**. Archive `aira_prod_main_backup_20261118160905.dump.enc` verified against SHA-256 `c06ec3b00e833f1981f546b1e6bca940c86a75b00d3e622542523502e0c02e16` (25,013,352 bytes). Disposable restore rehearsal in local PostgreSQL 18.7 achieved 100.00% exact parity (48/48 tables, 12,494/12,494 rows, zero referential violations).
3. **Read-Only API Surface & Health:** **PASS**. All security headers (strict CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`) and liveness endpoints verified.
4. **OAuth Authentication & Multi-Provider Linking:** **PASS**. Google OAuth and GitHub OAuth both authenticate successfully in Microsoft Edge with valid HttpOnly session cookies and CSRF tokens. Multi-provider linking is verified.
5. **Session Reload Persistence:** **PASS**. Authenticated sessions survive full browser reloads.
6. **Free-Tier Quota & Entitlements:** **PASS**. Quotas resolved server-side for free tier (15 daily chats).
7. **Bounded Real Model Inference SSE Streaming:** **PASS**. Prompt `"Reply with 'AIRA_2026_TEST_OK' and nothing else"` routed to `aira-fast` emitted full SSE lifecycle (`run_started` -> `routing_decision` -> `model_provenance` -> `content_delta`* -> `done` with `[DONE]`). Content reconstructed and confirmed.
8. **Controlled SSE Stream Abort (Client-Side):** **PASS**. Client abort via `AbortController` trapped cleanly with zero dangling connections.
9. **Autonomous Agent Execution & Migration 032 Schema:** **PASS**. Single-step workflow task executed and verified the `artifacts` JSONB column. Cancellable task entered `WAITING_FOR_APPROVAL` via non-destructive definition and cancelled successfully (HTTP 200, status `CANCELLED`).
10. **Session Revocation:** **PASS**. Sign-out endpoint invalidates server-side session and returns `ANONYMOUS`.
11. **Budget Ceiling Compliance:** **PASS**. Consumed 50 tokens (~$0.000030 USD), well within the authorized USD $0.05 limit.

### Remaining Release-Blocking Certification Items:
1. **Distinct-Principal Cross-Tenant Isolation:** **BLOCKED**. Both provided test accounts (Google and GitHub) resolve to the identical Neon user ID (`neon_user_c0fc8caa-a796-482c-9db8-c54e09e8a2b8`). A single user principal cannot certify cross-tenant resource isolation. Probing non-existent resources (`wf_foreign_isolated_probe`) only proves 404 Not Found, not tenant boundary isolation.
2. **Paid-Plan Acceptance:** **BLOCKED**. No paid test principal has been provisioned in production. In accordance with zero-mock policies, paid tier live acceptance cannot be certified until a paid test account is provided.
3. **Server-Side Upstream Worker Lease Cancellation:** **UNVERIFIED/BLOCKED**. Requires internal worker telemetry to confirm upstream model provider process termination on client abort.

**Final Certification Verdict: BLOCKED (Awaiting Second Independent Test Principal & Paid Test Principal)**

---

## 2. Production Baseline Verification Matrix

| Target Component | Expected Baseline Value | Observed Live State | Verdict |
|---|---|---|---|
| **Production Git Branch** | `prod-release` | `prod-release` | **PASS** |
| **Production Git Commit** | `b5a27f391447b68448edf067cdb2ee62a598c264` | `b5a27f391447b68448edf067cdb2ee62a598c264` | **PASS** |
| **Vercel Production Deployment** | `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` | `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` (● Ready, 47s build) | **PASS** |
| **Vercel Project ID** | `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` | `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` (Verified via Vercel CLI) | **PASS** |
| **Production Domain Alias** | `aira-ai-2026.vercel.app` | Points to `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` | **PASS** |
| **Production CI Run** | `44346736429` on `prod-release` | SUCCESS (`Fast CI`, `Semantic Search CI`, `Main / PR certification` passed) | **PASS** |
| **Neon PostgreSQL Project** | `old-sky-50952395` | Connected (`ap-southeast-1`) | **PASS** |
| **Neon Production Branch** | `br-shiny-moon-b3vy9xj7` | PostgreSQL 18.7 (a21afb5) | **PASS** |
| **Migration Ledger Count** | Exactly 32 migrations | 32 migrations in `knex_migrations` | **PASS** |
| **Migration 032 Status** | Present exactly once | ID 33, Batch 8, `032_reconcile_workflow_run_artifacts.ts` | **PASS** |
| **`workflow_runs.artifacts`** | Nullable JSONB, default `'[]'::jsonb` | Type: `jsonb`, Nullable: `YES`, Default: `'[]'::jsonb` | **PASS** |
| **Knex Migration Lock** | Released (`is_locked = 0`) | `is_locked = 0` | **PASS** |
| **Neon Checkpoint Branch** | `br-orange-art-b3vzajv0` | `pre-migration-032-checkpoint-20261118`, state `ready`, LSN `0/1E912998` | **PASS** |
| **Preserved Rollback Target** | `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` | Ready in Vercel project `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` | **PASS** |

---

## 3. Independent Encrypted-Backup & Restore Parity Certification (Phase G)

- **Archive Location:** `C:\Users\WORKSTATION\AIRA_VAULT_REPLICA\aira_prod_main_backup_20261118160905.dump.enc`
- **File Size:** `25,013,352` bytes
- **SHA-256 Checksum:** `c06ec3b00e833f1981f546b1e6bca940c86a75b00d3e622542523502e0c02e16` (**EXACT MATCH**)
- **Container Format:** AES-256-GCM AEAD (`AIRA_ENC` magic header, 16-byte salt, 12-byte IV, 16-byte auth tag, 25,013,300 bytes ciphertext)
- **Decryption Integrity:** Authenticated successfully using approved escrowed passphrase (100k PBKDF2 iterations); plaintext dump size: `25,013,300` bytes (23.85 MB); SHA-256: `4525d85a44d90e1b54a8df543d00dba7d990c2b1d9f46922a011ce760ce37e08`.
- **Target Engine:** Local PostgreSQL 18.7 (Ubuntu 18.7-1.pgdg24.04+2 in WSL) with `pgvector` extension.
- **Disposable Database Rehearsal:** `aira_phase_g_val_*`
- **Restoration Command:** `sudo -u postgres pg_restore --no-owner --no-privileges -d "<isolated_db>" "<decrypted_dump>"`
- **Restoration Parity Results:**
  - Audited Tables: **48 / 48** (100.00% table presence)
  - Restored Rows: **12,494 / 12,494** (100.00% row count parity)
  - Primary Keys: **48**
  - Foreign Keys: **31**
  - Unique Constraints: **14**
  - Indexes: **141**
  - Sequences: **3**
  - Referential Parity: **PASS** (0 orphaned records)
- **Teardown & Isolation:** Disposable database dropped cleanly; temporary decrypted plaintext file shredded from disk; original encrypted archive preserved untouched.

---

## 4. Hardened Acceptance Test Matrix & Categorical Status

| Test ID | Test Category & Description | Expected Behavior | Observed Result / Status | Verdict |
|---|---|---|---|---|
| **Phase 1a** | OAuth Authentication (Google) | Authenticate Profile A via Google | Authenticated; user ID `neon_user_c0fc8caa...`; valid session cookie & CSRF token | **PASS** |
| **Phase 1b** | OAuth Authentication (GitHub) | Authenticate Profile B via GitHub | Authenticated; user ID `neon_user_c0fc8caa...`; valid session cookie & CSRF token | **PASS** |
| **Phase 1c** | Multi-Provider Account Linking | Multiple OAuth providers link to single account | Verified: User account links both `[google, github]` providers | **PASS** |
| **Phase 1d** | Distinct-Principal Identification | Test accounts represent distinct user principals | **BLOCKED**: Both profiles resolve to identical user ID (`neon_user_c0fc8caa...`). Cannot certify multi-tenant boundaries. | **BLOCKED** |
| **Phase 1e** | Session Reload Persistence | Sessions survive browser page reload | Both profiles reloaded; `status: AUTHENTICATED` preserved | **PASS** |
| **Phase 2a** | Free Tier Entitlements Verification | Resolve plan quotas server-side | Plan tier `free`, daily chat limit 15 verified for primary context | **PASS** |
| **Phase 2b** | Paid Tier Entitlements Acceptance | Validate Pro/Enterprise tier features | **BLOCKED**: No paid test principal provisioned in production. Synthetic mocks prohibited. | **BLOCKED** |
| **Phase 3a** | Real Model Inference (Account A) | Bounded inference with real provider | Latency 7,729 ms, model `aira-fast`, SSE stream reconstructed with exact content `"AIRA_2026_TEST_OK"` and terminal `[DONE]` | **PASS** |
| **Phase 3b** | Real Model Inference (Account B) | Bounded inference with real provider | Latency 7,321 ms, model `aira-fast`, SSE stream reconstructed with exact content `"AIRA_2026_TEST_OK"` and terminal `[DONE]` | **PASS** |
| **Phase 4** | Controlled SSE Stream Abort | Client aborts stream mid-flight | Client `AbortController.abort()` executed after first chunk; `AbortError` handled cleanly. Server worker lease release: UNVERIFIED/BLOCKED. | **PASS (Client)** / **BLOCKED (Server Telemetry)** |
| **Phase 5a** | Single-Step Workflow Task (Migration 032) | Create workflow run and verify artifacts column | Run `wfrun_run_e9eaa9f5-4` created (HTTP 201); JSONB `artifacts` column initialized cleanly | **PASS** |
| **Phase 5b** | Workflow Task Cancellation | Cancel human-approval pending workflow | Run `wfrun_run_7770e6c7-3` created with harmless definition (`sideEffectLevel: 'READ'`); cancelled via `POST /api/workflows/runs/:id/cancel` (HTTP 200, `CANCELLED`) | **PASS** |
| **Phase 6.1** | Distinct Cross-Account Isolation | Non-owner attempts to read another user's workflow | **BLOCKED**: Caller and owner share identical principal. Probing unowned dummy IDs is rejected as invalid proof. | **BLOCKED** |
| **Phase 6.2** | Ownership Forgery Defense | Client attempts to forge `principalId` in POST body | `POST /api/workflows/runs` rejected forgery with HTTP 400 (Bad Request) | **PASS** |
| **Phase 6.3** | Anonymous Resource Protection | Unauthenticated client queries workflow run | `GET /api/workflows/runs/wfrun_run_e9eaa9f5-4` returned HTTP 401 (Unauthorized) | **PASS** |
| **Phase 6.4** | Legitimate Owner Access | Authenticated owner queries own workflow run | `GET /api/workflows/runs/wfrun_run_e9eaa9f5-4` returned HTTP 200 with full run data | **PASS** |
| **Phase 7** | Session Revocation & Invalidation | Sign-out invalidates server-side session | `POST /api/auth/sign-out` returned HTTP 200; subsequent session queries returned `{"status":"ANONYMOUS","user":null}` | **PASS** |
| **Phase 8** | Spending Guard Compliance | Enforce budget ceiling across entire test suite | Consumed 50 tokens (~$0.000030 USD), well within the authorized USD $0.05 limit | **PASS** |

---

## 5. Harness Remediation Details (6 Key Engineering Fixes)

1. **P0 Tenant Isolation Truthfulness:**
   - Modified `scripts/production-acceptance-suite.ts` to compute `validateDistinctPrincipals(accountA.userId, accountB.userId)`.
   - When accounts share a principal, Phase 1d and Phase 6.1 are explicitly recorded as `BLOCKED`.
2. **P0 Cross-Account Resource Probing Integrity:**
   - Eliminated fabricated probe identifier `wf_foreign_isolated_probe`.
   - Probing non-existent IDs is flagged as invalid proof of tenant boundaries in `validateCrossAccountProbe`.
3. **P1 Full SSE Stream Reconstruction & Error Detection:**
   - Implemented `parseAndReconstructSseStream` to parse events, reconstruct content deltas, and verify terminal `[DONE]` events.
   - Asserts exact expected content `"AIRA_2026_TEST_OK"`, verifies `run_started`, and checks for absence of `event: error`.
4. **P1 Dynamic Pre-Dispatch Budget Guard & Token Accounting:**
   - Removed hardcoded token counts (`trackUsage(14, 4)`).
   - Added `preDispatchBudgetGuard` before request dispatch.
   - Computes dynamic token counts and cost tagged as `ESTIMATED`.
5. **P1 Safe Human-Approval Workflow Definition:**
   - Replaced `sideEffectLevel: 'DESTRUCTIVE'` with `sideEffectLevel: 'READ'` in `createHarmlessApprovalWorkflowDefinition`.
   - Retained `approvalRequired: true` to trigger `WAITING_FOR_APPROVAL` safely without destructive operations.
6. **P1 Scope Boundary Qualification:**
   - Explicitly classified paid-tier testing as `BLOCKED (No paid test principal provisioned)`.
   - Distinguished client-side SSE abort (`PASS`) from upstream worker lease cancellation (`UNVERIFIED/BLOCKED`).

---

## 6. Regression Test Suite Execution

A dedicated unit and regression test suite was created in `test/production-acceptance-harness.test.ts` to mathematically verify every remediated function in isolation:

```
▶ AIRA Production Acceptance Harness Remediation
  ▶ validateDistinctPrincipals (P0)
    ✔ must block isolation certification when both OAuth providers map to the identical principal ID
    ✔ must pass distinct-principal validation when user IDs are genuinely independent
    ✔ must block isolation certification when either user ID is missing or undefined
  ✔ validateDistinctPrincipals (P0)
  ▶ validateCrossAccountProbe (P0)
    ✔ must reject probes when accounts share identical principal
    ✔ must reject fabricated or unowned probe targets like wf_foreign_isolated_probe
    ✔ must accept valid cross-principal probe when callers are distinct and resource is legitimate
  ✔ validateCrossAccountProbe (P0)
  ▶ parseAndReconstructSseStream (P1)
    ✔ must correctly reconstruct full token stream and confirm terminal done event
    ✔ must detect truncated streams missing terminal [DONE]
    ✔ must capture and flag stream errors (event: error)
    ✔ must separate thinking_delta from content_delta
  ✔ parseAndReconstructSseStream (P1)
  ▶ preDispatchBudgetGuard & calculateTokenUsageAndCost (P1)
    ✔ must permit inference when projected cost is within budget ceiling
    ✔ must reject inference when current spend is already at or near ceiling
    ✔ must dynamically compute token usage and mark accountingType as ESTIMATED
  ✔ preDispatchBudgetGuard & calculateTokenUsageAndCost (P1)
  ▶ createHarmlessApprovalWorkflowDefinition (P1)
    ✔ must configure non-destructive sideEffectLevel and require human approval
  ✔ createHarmlessApprovalWorkflowDefinition (P1)
✔ AIRA Production Acceptance Harness Remediation
ℹ tests 14 | suites 6 | pass 14 | fail 0 | cancelled 0 | skipped 0
```

---

## 7. Action Items to Achieve Full Sign-Off

To clear the remaining `BLOCKED` gates and achieve 100% full production certification:

1. **Provide Independent Second Test Account:**
   - Provision a second Google or GitHub account that is **not** linked to `rajpunkeshwarrajgautam@gmail.com`.
   - Run cross-account read-only probe from Account B targeting `wfrun_run_e9eaa9f5-4` owned by Account A to certify 403 Forbidden cross-tenant isolation.
2. **Provision Paid Test Principal (Optional for General Release, Required for Paid Scope):**
   - Assign Pro/Enterprise tier to an isolated test account in production database or billing portal.
   - Run paid model allowlist probe and elevated quota verification.
3. **Preserve All Safety Resources:**
   - Keep recovery branch `br-orange-art-b3vzajv0` preserved.
   - Keep encrypted archive `aira_prod_main_backup_20261118160905.dump.enc` preserved.
   - Keep rollback deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` preserved.
