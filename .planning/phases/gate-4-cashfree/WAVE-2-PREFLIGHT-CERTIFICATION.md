---
phase: GATE-4-CASHFREE-SANDBOX-ACCEPTANCE
checkpoint: WAVE-2-PREFLIGHT-CERTIFICATION
verdict: GO
certified_at: 2026-11-23T09:38:00.000Z
staging_sha: 467f554d6a2f7f9630b088fb412fadaa2b47c925
canonical_url: https://staging.virexaaiventures.com
target_db: ep-twilight-cherry-b3iz2oqv.c-4.ap-southeast-1.aws.neon.tech/neondb
target_branch: br-snowy-bonus-b32thjlz
dedicated_principal_id: neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a
billing_customer_id: cust_2a79b54106e04c9ab491e5be3aed6b97
wallet_id: cacc_dfaad457fd144e56ac7d16798d872f8a
starting_credits: 100
subscriptions_count: 0
invoices_count: 0
razorpay_customer_status: UNTOUCHED_ISOLATED
---

# AIRA AI 2026 — Gate 4 Cashfree Wave 2 Preflight Certification

## 1. Executive Decision: GO

Independent inspection and verification of Wave 1 outcomes and Wave 2 safety controls confirm that all preflight criteria are **100% satisfied**.

The dedicated test principal (`neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`) is authoritatively provisioned, associated with its Google OAuth account, initialized with 100 welcome credits, and holds zero subscriptions. The existing Razorpay Pro customer records (`cust_9e1e096ced03407aba9db0a71f6c3253`) remain completely untouched in Staging Neon.

The exact-principal rehearsal allowlist, mutual exclusion rules, test credential validators, and emergency shutdown procedures are fully certified.

**Wave 2 Preflight Verdict: GO**

---

## 2. Gate-by-Gate Verification Matrix

| Gate # | Inspection Dimension | Target / Identifier | Live Verified Evidence | Verdict |
| :---: | :--- | :--- | :--- | :---: |
| **1** | **Staging Git SHA & Deployment** | `467f554d6a2f7f9630b088fb412fadaa2b47c925` | `git rev-parse origin/staging` matches exact squash-merge SHA; canonical URL `https://staging.virexaaiventures.com` is `HEALTHY` (v2026.2.0) | **PASS** |
| **2** | **Dedicated Principal & OAuth Association** | `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` | Direct Google OAuth (`oa_legacy_405d465b-f200-4d4f-b5a3-24da3f07ac22`), active BFF session `OcM_OTDA...` created `2026-11-23T09:28:24.308Z`, customer `cust_2a79b54106e04c9ab491e5be3aed6b97` | **PASS** |
| **3** | **Free Entitlements & Initial State** | `cust_2a79b54106e04c9ab491e5be3aed6b97` | Wallet `cacc_dfaad457fd144e56ac7d16798d872f8a` has exactly **100 credits** (`grant_09c5538ca4004390bbc8ec8085f9630f`); **0 subscriptions**, **0 invoices**, **0 payment events** | **PASS** |
| **4** | **Razorpay Customer Isolation** | `cust_9e1e096ced03407aba9db0a71f6c3253` | Pro subscription `pur_8150add7f93743e38138b5617f727188` (`active`), 1 invoice `INV-2026-0001` (Paid), balance **7,600 credits**, 3 Option A `TERMINAL_FAILURE` events intact | **PASS** |
| **5** | **Cashfree TEST Credentials** | Rehearsal Credential Guard | Enforces `^TEST[a-zA-Z0-9]+$` for `CASHFREE_APP_ID`, `CASHFREE_ENV === 'TEST'`. Live keys or production environment trigger immediate fatal security panics | **PASS** |
| **6** | **Exact Principal Allowlist** | `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS` | Allowlist fails closed for all un-enrolled users, weak identifiers, client flags, or revoked accounts (`test/staging-sandbox-rehearsal-security.test.ts` lines 231–277) | **PASS** |
| **7** | **Mutual Exclusion Invariant** | Rehearsal vs Commercial Billing | `AIRA_COMMERCIAL_BILLING_ENABLED === 'true'` immediately causes rehearsal checks to return `false` / abort (`test/staging-sandbox-rehearsal-security.test.ts` lines 114–120) | **PASS** |
| **8** | **Emergency Shutdown Procedure** | Kill Switch & Recovery | Setting `AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED=false` instantly disables rehearsal checkout across all endpoints, returning `checkout_disabled` | **PASS** |
| **9** | **Production Safe Harbor** | `main`, `prod-release`, PR #196, Prod DB | Zero production mutations, zero production credentials in staging runtime; Prod Neon `old-sky-50952395` on **STRICT HOLD** | **PASS** |

---

## 3. Wave 2 Action Sequence

Upon authorization:
1. **Enrollment**: Set `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS = 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a'`.
2. **Rehearsal Activation**: Set `AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'true'`.
3. **Fence Verification**:
   - Verify un-enrolled requests receive 503 `BILLING_UNAVAILABLE` or `checkout_disabled`.
   - Verify authenticated sessions for `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` are admitted to sandbox checkout.
4. **Transition to Wave 3**: Initiate Cashfree recurring subscription checkout via Subscriptions API.
