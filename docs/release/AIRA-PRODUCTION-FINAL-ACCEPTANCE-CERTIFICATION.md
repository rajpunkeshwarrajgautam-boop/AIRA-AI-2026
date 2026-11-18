# AIRA AI 2026 — Production Final Acceptance & Certification Report

**Document Version:** 1.0.0  
**Audit Timestamp:** 2026-11-18T17:00:00Z / 2026-11-18 22:30 IST  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Production URL:** `https://aira-ai-2026.vercel.app`  
**Production HEAD Commit:** `b5a27f391447b68448edf067cdb2ee62a598c264`  
**Production Deployment ID:** `dpl_BTiLvhq77siuaz655zZARHdBKuBZ`  
**Preserved Rollback Deployment ID:** `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` (Commit `d988a6bd26d49a000d59cf906b13fcfe9e170058`)  
**Certification Status:** **PHASE A & G PASS; FULL END-TO-END PRODUCT ACCEPTANCE BLOCKED**

---

## 1. Executive Summary & Verdict

Following the authorized execution of Gate 2 (migration 032) and Gate 3 (production promotion and Vercel deployment), this evaluation audited the production environment against the required release gates.

1. **Production Infrastructure Baseline:** **PASS**. Exact commit `b5a27f391447b68448edf067cdb2ee62a598c264` is deployed to Vercel production deployment `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` and bound to `https://aira-ai-2026.vercel.app`. CI run `44346736429` on `prod-release` passed all checks. Neon production database is at 32 migrations with `workflow_runs.artifacts` as JSONB and locks released.
2. **Independent Encrypted-Backup & Restore Parity:** **PASS**. Archive `aira_prod_main_backup_20261118160905.dump.enc` verified against SHA-256 `c06ec3b00e833f1981f546b1e6bca940c86a75b00d3e622542523502e0c02e16` (25,013,352 bytes). Isolated restore rehearsal in local PostgreSQL 18.7 achieved 100.00% exact parity (48/48 tables, 12,494/12,494 rows).
3. **Read-Only Production Security & API Surface:** **PASS**. All 7 core smoke tests passed (strict CSP, HSTS, XFO, nosniff, anonymous session isolation, HTTP 401/403 fail-closed protection on endpoints `/api/auth/csrf`, `/api/billing/entitlements`, `/api/billing/summary`, `/api/models`, and `/api/chat/stream`).
4. **Interactive Authenticated Account Acceptance (Google & GitHub OAuth, Entitlements, Inference, SSE, Agent Execution, Cross-Account Isolation):** **BLOCKED**. In accordance with operating restrictions, agents cannot request or handle credentials, passwords, session tokens, or OAuth secrets, and must not execute production writes without explicit authorization.

**Final Certification Verdict: BLOCKED (Awaiting Owner Interactive Sign-In & Write Approval)**

---

## 2. Production Baseline Verification Matrix (Phase A)

| Target Component | Expected Baseline Value | Observed Live State | Verdict |
|---|---|---|---|
| **Production Git Branch** | `prod-release` | `prod-release` | **PASS** |
| **Production Git Commit** | `b5a27f391447b68448edf067cdb2ee62a598c264` | `b5a27f391447b68448edf067cdb2ee62a598c264` | **PASS** |
| **Vercel Production Deployment** | `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` | `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` (● Ready, 47s build) | **PASS** |
| **Production Domain Alias** | `aira-ai-2026.vercel.app` | Points to `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` | **PASS** |
| **Production CI Run** | `44346736429` on `prod-release` | SUCCESS (Semantic Search, Fast CI, Main/PR certification: passed) | **PASS** |
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

An independent validation of the pre-migration production encrypted backup was executed:

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

## 4. Authenticated Acceptance Test Matrix (Phases B through F)

| Test ID | Test Category & Description | Expected Behavior | Observed Result / Status | Verdict |
|---|---|---|---|---|
| **B1** | Google OAuth Flow (Account A) | PKCE redirect, consent, session creation, persistent identity, clean sign-out | Requires owner interactive sign-in in browser; agent prohibited from accessing credentials | **BLOCKED** |
| **B2** | GitHub OAuth Flow (Account B) | Separate OAuth consent, independent principal identity, zero cross-account session leak | Requires owner interactive sign-in in separate browser profile | **BLOCKED** |
| **C1** | Free-Plan Entitlements | Server-enforced model access, rate limits, credit limits | `/api/billing/entitlements` returns HTTP 401 for anonymous; authenticated test pending | **BLOCKED** |
| **C2** | Paid-Plan Entitlements | Enforced tier limits, paid model availability, upgrade boundary | No paid test account provisioned; mocks strictly prohibited by release policy | **BLOCKED** |
| **D1** | Real Model Inference (Account A) | One bounded prompt, provider routing (`groq` / `gemini` / `nvidia`), actual token usage | Health confirms providers registered & mock fallback disabled; write approval pending | **BLOCKED** |
| **D2** | Real Model Inference (Account B) | One bounded prompt under Account B, independent usage recording | Write approval pending | **BLOCKED** |
| **D3** | SSE Streaming Lifecycle | Valid SSE event framing, delta tokens, terminal event | `/api/chat/stream` returns HTTP 403 fail-closed for unauthenticated requests | **BLOCKED** |
| **D4** | SSE Stream Cancellation | Client disconnect / abort terminates upstream inference and releases permits | Requires dedicated cancellation test under active stream; cannot infer from completion | **BLOCKED** |
| **E1** | Autonomous Agent Execution | Bounded single-step task, correct principal ownership, persisted run & artifact | Health confirms tool runtime & approval kernel initialized; write approval pending | **BLOCKED** |
| **E2** | Task Cancellation & Cleanup | Dedicated cancellable run can be interrupted mid-flight without orphan locks | Requires separately authorized cancellable task | **BLOCKED** |
| **F1** | Cross-Account Data Isolation | Account B attempts read of Account A conversation/task; returns 401/403/404 | Depends on Account A resources created in D/E | **BLOCKED** |
| **F2** | Cross-Account SSE Isolation | Account B attempts subscription to Account A stream; rejected fail-closed | Depends on Account A stream active | **BLOCKED** |
| **S1** | Production Security Headers | CSP, HSTS `max-age=63072000`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` | Headers present and strictly validated on live production URL | **PASS** |
| **S2** | Backend Health API | HTTP 200, database reachable, modelRouter initialized, mock fallback disabled | `/api/health` returns HTTP 200, status `HEALTHY`, readiness `READY` | **PASS** |
| **S3** | Session Fail-Closed Boundary | Unauthenticated requests return anonymous session with null user | `/api/auth/session` returns 200 `{"status":"ANONYMOUS","user":null}`, 0 user leak | **PASS** |
| **S4** | CSRF Protection Boundary | Unauthenticated CSRF endpoint rejects request | `/api/auth/csrf` returns HTTP 401 Unauthorized | **PASS** |
| **S5** | Billing API Fail-Closed Boundary | Protected billing endpoints reject unauthenticated caller | `/api/billing/entitlements` & `/api/billing/summary` return HTTP 401 | **PASS** |
| **S6** | Model Router Fail-Closed Boundary | Models endpoint requires authentication; router telemetry verified | `/api/models` returns HTTP 401; telemetry confirms Groq, Gemini, NVIDIA | **PASS** |
| **S7** | Chat Stream Fail-Closed Boundary | Streaming endpoint rejects unauthenticated POST | `/api/chat/stream` returns HTTP 403 Forbidden | **PASS** |

---

## 5. Rollback Target & Recovery Architecture Clarification

1. **Application Rollback (Vercel):**
   - Target Deployment: `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` (Production HEAD prior to PR #185 merge).
   - Scope: Rolls back client and serverless application code only.
   - Timing & SLA: Subject to DNS/Edge cache invalidation; does not guarantee a zero-second or fixed 30-second window.
   - Command:
     ```powershell
     npx vercel rollback dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8
     ```
2. **Database Recovery (Neon PostgreSQL 18):**
   - Target Checkpoint: `br-orange-art-b3vzajv0` (`pre-migration-032-checkpoint-20261118`).
   - Boundary: Fixed at Parent LSN `0/1E912998` (point immediately prior to migration 032).
   - Reconciliation Requirement: Re-pointing the endpoint to the checkpoint branch does not restore writes committed to `br-shiny-moon-b3vy9xj7` after LSN `0/1E912998`. Any subsequent committed user data must be reconciled from transaction logs.

---

## 6. Findings, Severity & Risk Register

| ID | Finding | Severity | Status | Mitigation / Resolution |
|---|---|---|---|---|
| **F-01** | Missing `db:migrate:032` npm script in root package.json | Medium | **RESOLVED** | Implemented via PR #189; invoked guarded TypeScript runner; certified in CI. |
| **F-02** | GitGuardian historical incident count resolution | Low | **RESOLVED** | All 31 incidents verified resolved/closed; check passed in CI. |
| **F-03** | Paid-plan test principal unavailable in production | Low | **OPEN (ACCEPTED RISK)** | Paid features remain protected by fail-closed backend entitlement checks; paid acceptance marked BLOCKED per release policy. |
| **F-04** | Interactive OAuth authentication requires physical owner browser interaction | Low | **OPEN (PROCEDURAL)** | In accordance with zero-credential exposure policy, owner must sign in directly. |

---

## 7. Consolidated Authorization Request & Next Actions for Owner Sign-off

Before executing any production test writes, the following consolidated authorization scope is submitted for explicit owner approval:

1. **Test Accounts & Sign-in Scope:**
   - Account A: Google OAuth test principal (Owner signs in via browser).
   - Account B: GitHub OAuth test principal (Owner signs in via separate browser profile).
   - Sign-out verification: Both accounts will undergo explicit `/api/auth/signout` to verify session termination.

2. **Proposed inference operations — NOT AUTHORIZED:**
   - **Baseline:** At most 2 real-model requests (1 from each isolated, owner-authenticated test account), after approval. Use prompt `Reply with 'AIRA_2026_TEST_OK' and nothing else`.
   - **Model selection:** Select only a model verified in the production router and accessible for the relevant account at execution time. Preferred candidate: `groq:openai/gpt-oss-120b`, subject to live availability, rate limits and entitlements. Do not assume the registered provider has successfully served inference. `groq:llama-3.3-70b-versatile` was retired on Groq Free/Developer plans on 2026-08-16; `gemini:gemini-1.5-flash` is an obsolete fallback. Use `gemini:gemini-2.5-flash` only after confirming it is available through the configured account and router.
   - **Published reference prices, not account-specific billing:** Groq GPT-OSS 120B standard $0.15 / 1M input tokens, $0.60 / 1M output tokens (https://console.groq.com/docs/models); Google Gemini 2.5 Flash paid standard $0.30 / 1M text input tokens, $2.50 / 1M output tokens including thinking tokens (https://ai.google.dev/gemini-api/docs/pricing). Recheck before usage, especially provider surcharges and provider-specific free quotas.
   - **Cost bound:** **USD $0.05 is a PROPOSED owner-approval ceiling, not an approved or technically enforced spending limit.** Prompt token counts and hidden/system/tool/metadata/thinking output are unknown until measured. Before execution, bound inputs, `max_output_tokens`, retries, fallbacks and agent/tool calls; obtain owner approval for the complete maximum call count and provider spend. If enforcement is unavailable, stop and report BLOCKED instead of asserting a hard cap.
   - **Coverage exception:** An additional SSE-abort generation and a cancellable agent task may consume model tokens and create records beyond the 2 baseline calls. Do not include them inside the 2-call approval without explicit accounting and additional approval. Free/paid quota-exhaustion tests may consume further usage and must have their own approved limits.

3. **Agent & Cancellation Execution Scope:**
   - 1 bounded read-only agent execution under Account A (e.g. string formatting).
   - 1 separately controlled SSE stream abort test (client abort during generation) to verify permit release.
   - 1 separately controlled cancellable task test to verify execution cancellation without orphan locks.

4. **Expected Production Database Effects — estimates only, NOT AUTHORIZED:**
   - OAuth login, session refresh and sign-out may create or revoke identity/session records. Conversations, messages, usage and credit ledgers, workflow runs, artifacts and cancellation events may be created or modified by test accounts. These are **production customer-data tables**, even when rows are owned by dedicated test principals.
   - No fixed row count is established by the existing evidence. Obtain endpoint-level write impact and expected cardinality from audited source code; explicitly approve the maximum allowed writes. Never claim `zero customer tables touched`.
   - Cross-account probes are **read-only negative authorization tests**. Never mutate another tenant's records. Do not delete or archive test rows without separate specific cleanup authorization, validated ownership and retention considerations.

5. **Cleanup & Retention:**
   - Test conversation and task records will be soft-deleted/archived immediately post-verification.
   - Sessions will be terminated and cookies invalidated.
   - Checkpoint branch `br-orange-art-b3vzajv0` and encrypted backup remain permanently preserved.
