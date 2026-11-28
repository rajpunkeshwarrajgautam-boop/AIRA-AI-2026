---
phase: GATE-4-CASHFREE-SANDBOX-ACCEPTANCE
checkpoint: WAVE-2-CONTROLLED-ACTIVATION-CERTIFICATION
verdict: GO
certified_at: 2026-11-23T10:22:00.000Z
staging_sha: 467f554d6a2f7f9630b088fb412fadaa2b47c925
deployment_id: dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2
deployment_url: https://aira-ai-2026-gpa6l2wyn-rajpunkeshwarrajgautam-boops-projects.vercel.app
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

# AIRA AI 2026 — Gate 4 Cashfree Wave 2 Controlled Activation Report

## 1. Executive Summary & Wave 3 Verdict: GO

Per explicit operator authorization, **Gate 4 Cashfree Wave 2 Controlled Staging-Only Activation** has been executed, deployed, and verified with zero defects and zero cross-account or production bleed.

- **Vercel Preview Configuration**: `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS` was set strictly and exclusively to `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`. `AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED` was set to `"true"`. `AIRA_COMMERCIAL_BILLING_ENABLED` remains `"false"`, and `CASHFREE_ENV` remains `"TEST"`.
- **Deterministic Redeployment**: Certified staging commit `467f554d6a2f7f9630b088fb412fadaa2b47c925` was redeployed to Vercel as **`dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2`**.
- **Live Canonical Alias**: `https://staging.virexaaiventures.com` verified live serving deployment `dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2` with `billingStatus: "sandbox_rehearsal"`.
- **Access Control & Fail-Closed Fence**: Unauthenticated endpoints reject with `401 Unauthorized` / `403 Forbidden (CSRF)`. Un-enrolled principals are rejected with `403 Forbidden` (`REHEARSAL_UNAUTHORIZED`). All 63 security fence assertions passed.
- **Financial Invariants Intact**: Staging Neon queries verify Cashfree customer (`cust_2a79b541...`) has exactly 100 credits, 0 subscriptions, and 0 invoices. The existing Razorpay Pro customer (`cust_9e1e096c...`) remains 100% untouched with 7,600 credits, 1 paid invoice (`INV-2026-0001`), and 3 historical `TERMINAL_FAILURE` events intact.

**Wave 3 Recommendation: GO** (Ready for controlled Cashfree recurring subscription checkout session initiation).

---

## 2. Deployment & Configuration Identity Matrix

| Dimension | Target Specification | Live Verified Evidence | Verification Status |
| :--- | :--- | :--- | :---: |
| **Vercel Project** | `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` (`aira-ai-2026`) | Verified via Vercel CLI & API | **MATCH** |
| **Target Scope** | Preview environment, branch `staging` | Verified via Vercel environment variable settings | **MATCH** |
| **Git Commit SHA** | `467f554d6a2f7f9630b088fb412fadaa2b47c925` | `curl /api/version` reports `commitSha: "467f554d6a2f..."` | **MATCH** |
| **Deployment ID** | Deterministic redeploy | **`dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2`** (`READY`) | **MATCH** |
| **Deployment URL** | Vercel preview host | `https://aira-ai-2026-gpa6l2wyn-rajpunkeshwarrajgautam-boops-projects.vercel.app` | **MATCH** |
| **Canonical Alias** | `https://staging.virexaaiventures.com` | Verified serving deployment `dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2` | **MATCH** |
| **Enrolled Principals** | `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS` | ID `mdMOL8FREZ58jMsG`: `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` exclusively | **MATCH** |
| **Rehearsal Flag** | `AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED` | ID `W0ISL9KAsBVUEHX6`: `"true"` (Vercel Preview, gitBranch `staging`) | **MATCH** |
| **Commercial Billing** | `AIRA_COMMERCIAL_BILLING_ENABLED` | ID `5JhzB1vQKoxduAPl`: `false` (Vercel Preview, gitBranch `staging`) | **MATCH** |
| **Cashfree Env** | `CASHFREE_ENV` | ID `wx1A3GxBNGdt5s1f`: `"TEST"` (Vercel Preview, gitBranch `staging`) | **MATCH** |
| **Cashfree Credentials** | `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` | IDs `nXfC5oFZ2hmgxcqv`, `hFNIsEaemxCnBSCn` (TEST-mode prefix confirmed) | **MATCH** |

---

## 3. Live Staging Endpoint Verification Evidence

Live HTTP requests to `https://staging.virexaaiventures.com`:

### 1. `/api/version`
```json
HTTP/1.1 200 OK
{
  "status": "ok",
  "version": "1.0.0",
  "commitSha": "467f554d6a2f7f9630b088fb412fadaa2b47c925",
  "deploymentUrl": "https://aira-ai-2026-gpa6l2wyn-rajpunkeshwarrajgautam-boops-projects.vercel.app",
  "environment": "staging"
}
```

### 2. `/api/health`
```json
HTTP/1.1 200 OK
{
  "status": "HEALTHY",
  "appState": "HEALTHY",
  "readiness": "READY",
  "database": "REACHABLE",
  "productionMockFallback": "DISABLED",
  "version": "2026.2.0"
}
```

### 3. `/api/billing/plans`
```json
HTTP/1.1 200 OK
{
  "billingStatus": "sandbox_rehearsal",
  "checkoutAvailable": true,
  "featuresCertified": true
}
```

### 4. `/api/billing/entitlements` (Unauthenticated)
```json
HTTP/1.1 401 Unauthorized
{
  "error": "Unauthorized",
  "message": "Unauthorized: No valid principal found on request context"
}
```

### 5. `/api/billing/checkout/subscription` (Unauthenticated / Missing Anti-CSRF)
```json
HTTP/1.1 403 Forbidden
{
  "error": "CSRF validation failed: missing origin or anti-CSRF verification"
}
```

---

## 4. Security Fence & Automated Isolation Test Suite

Execution of `npx tsx --test test/staging-sandbox-rehearsal-security.test.ts test/gate4-upgrade-button-checkout-flow.test.ts`:

- **Total Suites**: 15 suites
- **Total Tests**: 63 assertions
- **Passed**: 63 (100%)
- **Failed**: 0
- **Duration**: 665.46 ms

### Key Security Assertions Verified:
1. **Production Fence**: Rehearsal permanently blocked when `VERCEL_ENV=production` or `AIRA_COMMERCIAL_BILLING_ENABLED=true`.
2. **Infrastructure Fence**: Rehearsal permanently blocked on branches other than `staging` (e.g. `main`, `prod-release`, or arbitrary PR branches).
3. **Database Fence**: Rehearsal panics and aborts if connected to Production Neon (`old-sky-50952395`) or Commercial PR #92 branch. Permits exclusively staging Neon (`mute-frost-50372225`).
4. **Credential Hardening**: Live gateway keys (`rzp_live_*` or production Cashfree App IDs) trigger fatal security panics.
5. **Exact Principal Allowlist**: Strict rejection of weak identifiers, non-enrolled accounts, or client-supplied synthetic flags.
6. **Statutory Invoice Sequence Gap Audit**: Sequence verified gapless (`AUDIT_VERIFIED_GAPLESS`).

---

## 5. Live Staging Neon Database Financial Invariants

Authoritative query execution against Staging Neon (`ep-twilight-cherry-b3iz2oqv.c-4.ap-southeast-1.aws.neon.tech/neondb`, branch `br-snowy-bonus-b32thjlz`):

### 1. Database Connection & Neon GUCs
- `current_db`: `neondb`
- `neon.project_id`: `mute-frost-50372225` (Staging Neon project)
- `neon.branch_id`: `br-snowy-bonus-b32thjlz` (Staging Neon branch)

### 2. Dedicated Cashfree Test Principal
- **User**: `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` (`elliot anderson`, `antigravitypower490@gmail.com`)
- **Customer**: `cust_2a79b54106e04c9ab491e5be3aed6b97` (principal: `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`)
- **Wallet**: `cacc_dfaad457fd144e56ac7d16798d872f8a`
  - `balance_credits`: **100**
  - `lifetime_granted_credits`: **100**
  - `lifetime_spent_credits`: **0**
- **Subscriptions Count**: **0**
- **Invoices Count**: **0**

### 3. Untouched Razorpay Pro Customer Invariants
- **Customer**: `cust_9e1e096ced03407aba9db0a71f6c3253` (principal: `neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7`)
- **Wallet**: `cacc_1c5907bd499f4277ae2cb9dae50ecd51`
  - `balance_credits`: **7,600** (100 welcome + 7,500 Pro grant)
- **Active Subscription**: `pur_8150add7f93743e38138b5617f727188` (`plan_id: pro`, `status: active`, `gateway_subscription_id: sub_U3VmcSATvHNdhX`)
- **Invoices**: Exactly 1 paid invoice (`inv_3b3f73eb85134f2689c56ed8bdd6b744`, `invoice_number: INV-2026-0001`, `status: Paid`, amount: `₹999.00`)
- **Terminal Failure Webhook Events**: Exactly 3 historical records preserved under approved Option A:
  1. `evt_rzp_bc567a15d4a679994408de82c03ada57`
  2. `evt_rzp_b1d309930b3483c3179f4db225b36f95`
  3. `evt_rzp_a1326e79685d48bf54ff109e6c8078f7`

---

## 6. Emergency Shutdown & Rollback Readiness

The emergency shutdown procedure was verified in the preflight check and remains armed:

1. **Immediate Shutdown Command**:
   ```bash
   vercel env rm AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED preview --git-branch staging --confirm-name AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED
   vercel env rm AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS preview --git-branch staging --confirm-name AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS
   vercel redeploy dpl_8aXUuRLS4oJ8xoPhczrqpEiuVoDY --no-wait
   ```
2. **Rehearsal Invalidation**: Removes the rehearsal flag and enrollment list, redeploying the baseline deployment where `billingStatus` reverts to `checkout_disabled`.

---

## 7. Wave 3 Action Plan (Next Authorized Wave)

Upon explicit operator authorization:
1. **Task 3.1: Create Cashfree Subscription Checkout Session**:
   - Call `POST /api/billing/checkout/subscription` as dedicated principal `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` with `{ "planTier": "pro", "currency": "INR", "gateway": "cashfree" }`.
   - Verify Cashfree Subscriptions API returns sandbox `authLink` and creates `pending` subscription in database.
2. **Task 3.2: Sandbox Payment Authorization**:
   - Complete interactive sandbox e-mandate authorization via Cashfree sandbox checkout UI.
   - Record `cf_subscription_id` and initial payment transaction reference.
