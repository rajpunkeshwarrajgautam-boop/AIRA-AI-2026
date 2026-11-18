# AIRA AI 2026 — Post-release acceptance status and evidence register

**Audit date:** 2026-11-18 (UTC / IST). **Source of truth:** GitHub, Vercel and Neon live API & direct SQL queries, local PostgreSQL 18.7 disposable restore rehearsal, and live production endpoint audits.  
**Production URL:** https://aira-ai-2026.vercel.app  
**Technical deployment status:** LIVE / PROMOTED. **Production Baseline:** VERIFIED (PASS). **Encrypted Backup & Restore Parity:** VERIFIED (PASS). **Full authenticated end-to-end sign-off:** **BLOCKED (Awaiting Owner Interactive Authentication & Production Write Authorization)**.

---

## 1. Release identity and completed certification

| Component / Artifact | Status and Authoritative Identifier | Verdict |
|---|---|---|
| **PR #185** | MERGED at 2026-11-18T16:23:42Z (https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/185) | **PASS** |
| **Production Git HEAD** | `b5a27f391447b68448edf067cdb2ee62a598c264` (`prod-release`) | **PASS** |
| **Pre-merge candidate commit** | `4b2074776f790d23fa93fa320a52a4ceed361eeb` | **PASS** |
| **Production Vercel deployment** | `dpl_BTiLvhq77siuaz655zZARHdBKuBZ`: READY, 47s build, commit matches production HEAD | **PASS** |
| **Production alias binding** | `aira-ai-2026.vercel.app` actively assigned to `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` | **PASS** |
| **Production CI on prod-release** | GitHub Actions run `44346736429`: COMPLETED / SUCCESS at 2026-11-18T16:35:49Z (`Fast CI`, `Semantic Search CI`, `Main / PR certification` passed) | **PASS** |
| **Visual / Edge acceptance** | Production Edge visual acceptance: SUCCESS; deployed staging acceptance: SKIPPED under staging-only trigger | **PASS** |
| **Production Database (Neon)** | Project `old-sky-50952395`, main branch `br-shiny-moon-b3vy9xj7`: 32 applied migrations; migration `032_reconcile_workflow_run_artifacts.ts` applied exactly once; `workflow_runs.artifacts` = nullable `jsonb` default `'[]'::jsonb`; Knex lock = 0 | **PASS** |
| **Neon Recovery Checkpoint** | Branch `br-orange-art-b3vzajv0` (`pre-migration-032-checkpoint-20261118`), READY, parent `br-shiny-moon-b3vy9xj7`, parent LSN `0/1E912998` | **PASS** |
| **Encrypted Logical Backup** | `aira_prod_main_backup_20261118160905.dump.enc` (25,013,352 bytes, SHA-256 `c06ec3b00e833f1981f546b1e6bca940c86a75b00d3e622542523502e0c02e16`) | **PASS** |
| **Preserved Rollback Target** | `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` (commit `d988a6bd26d49a000d59cf906b13fcfe9e170058`), READY; application rollback target only | **PASS** |

---

## 2. Status of the Three Audit Items

### Item 1 — Post-merge exact-SHA production CI — COMPLETE (PASS)
- Verified run `44346736429` completed with `SUCCESS` on commit `b5a27f391447b68448edf067cdb2ee62a598c264`.
- All required checks (`Semantic Search CI`, `Fast CI`, `Main / PR certification`) passed.
- No further CI rerun is required without code modifications.

### Item 2 — Authenticated production acceptance — BLOCKED
Read-only production security smoke tests (7/7) passed on live deployment `dpl_BTiLvhq77siuaz655zZARHdBKuBZ`:
1. Security headers (CSP, HSTS `max-age=63072000`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`): **PASS**
2. Backend health & telemetry (`/api/health` HTTP 200, `database: REACHABLE`, `modelRouter: INITIALIZED`, `productionMockFallback: DISABLED`, version `2026.2.0`): **PASS**
3. Session fail-closed boundary (`/api/auth/session` returns 200 `{"status":"ANONYMOUS","user":null}`, zero user leak; `/api/auth/csrf` returns 401): **PASS**
4. Entitlements & Billing quotas fail-closed boundary (`/api/billing/entitlements` and `/api/billing/summary` return HTTP 401 Unauthorized for unauthenticated callers): **PASS**
5. Model routing fail-closed boundary (`/api/models` returns HTTP 401 Unauthorized for unauthenticated callers; providers registered: Groq, Gemini, NVIDIA): **PASS**
6. Streaming SSE security (`POST /api/chat/stream` returns HTTP 403 Forbidden without auth): **PASS**
7. Live database health (32 migrations applied, `artifacts` column JSONB, lock released): **PASS**

**Interactive Authenticated Tests Status:**
- **Test B1 (Google OAuth):** **BLOCKED**. Requires owner interactive sign-in in browser. Passwords, session cookies, OAuth secrets cannot and must not be handled by agents.
- **Test B2 (GitHub OAuth):** **BLOCKED**. Requires owner interactive sign-in in independent browser context.
- **Test C (Entitlements & Paid Quotas):** **BLOCKED**. Free and paid plan behavioral verification requires authenticated sessions. No paid production test principal has been provisioned; per policy, paid-plan acceptance cannot be certified using mocked responses or free accounts.
- **Test D (Real Model Inference & SSE):** **BLOCKED**. Requires explicit owner authorization for production write operations and model token consumption.
- **Test E (Autonomous Agent Execution):** **BLOCKED**. Requires explicit owner authorization for production task run.
- **Test F (Cross-Account Isolation):** **BLOCKED**. Depends on Account A test resources created in Test E.

### Item 3 — Rollback and backup evidence correction — INDEPENDENTLY VERIFIED (PASS)
- **Rollback Mechanics Clarification:** The preserved Vercel deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` is an **application-code** rollback target only. Rollback can affect availability and is subject to DNS/CDN cache propagation; no absolute 30-second guarantee is claimed. The preserved Neon checkpoint `br-orange-art-b3vzajv0` is a distinct **database** recovery point at LSN `0/1E912998`; it does not automatically reconcile transactions committed after its branch point. Reconciling post-checkpoint writes requires transaction logs and application reconciliation.
- **Independent Backup & Restore Parity Verification (Phase G):**
  - **Archive Path:** `C:\Users\WORKSTATION\AIRA_VAULT_REPLICA\aira_prod_main_backup_20261118160905.dump.enc`
  - **Archive Size:** 25,013,352 bytes
  - **SHA-256 Checksum:** `c06ec3b00e833f1981f546b1e6bca940c86a75b00d3e622542523502e0c02e16` (**EXACT MATCH**)
  - **Container Format:** AES-256-GCM AEAD (`AIRA_ENC` magic, 100k PBKDF2 iterations, valid auth tag)
  - **Decryption Integrity:** 100% byte integrity verified; plaintext size 25,013,300 bytes (23.85 MB), plaintext SHA-256 `4525d85a44d90e1b54a8df543d00dba7d990c2b1d9f46922a011ce760ce37e08`.
  - **Local PostgreSQL 18.7 Engine:** Tested against PostgreSQL 18.7 (Ubuntu 18.7-1.pgdg24.04+2) in isolated WSL instance.
  - **Restore Rehearsal Parity:** Restored into disposable database `aira_phase_g_val_*`. Verified 48 / 48 tables and 12,494 / 12,494 rows (**100.00% EXACT PARITY**).
  - **Relational Integrity:** 48 primary keys, 31 foreign keys, 14 unique constraints, 141 indexes, 3 sequences, 0 orphaned records.
  - **Teardown & Preservation:** Disposable database dropped cleanly; temporary decrypted file shredded; original encrypted archive preserved untouched.

---

## 3. Consolidated Authorization Request for Production Writes

To progress from **BLOCKED** to **COMPLETE** for Item 2 (Phases B through F), the following scoped authorization is submitted for owner approval:

1. **Test Principals:**
   - Account A: Google OAuth test account (owner signs in directly via browser).
   - Account B: GitHub OAuth test account (owner signs in directly via separate browser profile).
2. **Operations & Maximum Inference Scope:**
   - Maximum inference calls: 2 total (1 bounded request per account: prompt `"Reply with 'AIRA_2026_TEST_OK' and nothing else"`).
   - Target model: `groq:llama-3.3-70b-versatile` or `gemini-1.5-flash` (deterministic, lowest latency and cost).
   - Maximum agent execution: 1 single-step task (e.g. calculation or read-only text formatting) under Account A.
3. **Estimated Cost / Credit Cap:**
   - Under $0.001 total consumption across providers (well within free tier allowances).
4. **Cleanup Scope:**
   - Created test conversation and task records will be archived/soft-deleted post-verification.
   - Session sign-out will be executed for both accounts to revoke active session cookies.

---

## 4. Current Release Verdict

**Deployed production release:** VERIFIED LIVE  
**Gate 2 schema & migration 032:** VERIFIED PASS  
**Production exact-SHA CI:** VERIFIED PASS  
**Independent Backup & Restore Parity:** VERIFIED PASS  
**Authenticated End-to-End Product Acceptance:** **BLOCKED** (Awaiting Owner Interactive Authentication & Production Write Approval)

The production release remains stable, secure, and operational.
