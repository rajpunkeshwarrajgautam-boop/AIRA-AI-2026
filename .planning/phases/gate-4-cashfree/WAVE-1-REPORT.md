---
phase: GATE-4-CASHFREE-SANDBOX-ACCEPTANCE
wave: 1
status: PASS
certified_at: 2026-11-23T09:32:00.000Z
strategy: OPTION_1_DEDICATED_AUTHENTICATED_TEST_PRINCIPAL
principal_id: neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a
customer_id: cust_2a79b54106e04c9ab491e5be3aed6b97
wallet_id: cacc_dfaad457fd144e56ac7d16798d872f8a
starting_balance: 100
subscriptions_count: 0
invoices_count: 0
---

# AIRA AI 2026 — Gate 4 Cashfree Wave 1 Certification Report

## 1. Executive Summary

Wave 1 of Gate 4 Cashfree Sandbox Acceptance is **CERTIFIED PASS**.
Under Option 1, the user interactively authenticated a dedicated, distinct Google account on staging (`https://staging.virexaaiventures.com`). Staging Neon database queries authoritatively confirm the active session, billing customer record, initial 100-credit wallet, and complete zero-subscription isolation from the existing Razorpay Pro customer.

---

## 2. Verified Account & Identity Association

- **Authenticated Principal ID**: `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`
- **User Display Name**: `elliot anderson`
- **Masked Identity**: `an***@gmail.com`
- **OAuth Provider**: Google (`oa_legacy_405d465b-f200-4d4f-b5a3-24da3f07ac22`)
- **Active BFF Session**: ID starting `OcM_OTDA...`, created at `2026-11-23T09:28:24.308Z` (session duration: 30 days, expires `2026-12-23T09:28:24.308Z`).
- **Billing Customer ID**: `cust_2a79b54106e04c9ab491e5be3aed6b97` (Currency: `INR`, Country: `IN`).
- **Credit Account ID**: `cacc_dfaad457fd144e56ac7d16798d872f8a`
- **Starting Wallet Balance**: Exactly **100 credits** (`grant_09c5538ca4004390bbc8ec8085f9630f`, Free tier welcome allotment).
- **Existing Subscriptions**: Exactly **0** subscriptions.
- **Existing Invoices**: Exactly **0** invoices.
- **Payment Events**: Exactly **0** payment gateway events.

---

## 3. Verified Razorpay Customer Isolation (Option 1 Proof)

- **Razorpay Customer ID**: `cust_9e1e096ced03407aba9db0a71f6c3253` (`neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7`)
- **Active Pro Subscription**: `pur_8150add7f93743e38138b5617f727188` (`status: 'active'`)
- **Pending Plus Subscription**: `pur_f7a7df9df9394797b64fe57d1c96ff83` (`status: 'pending'`)
- **Paid Invoice**: Exactly 1 invoice `INV-2026-0001` (Total ₹999.00, GST ₹152.39).
- **Credit Balance**: Exactly **7,600 credits** (100 welcome + 7,500 Pro grant).
- **Isolation Status**: **100% UNTOUCHED & ISOLATED**.

---

## 4. Current Staging Security Posture

- **Staging Commit**: [`467f554d6a2f7f9630b088fb412fadaa2b47c925`](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/commit/467f554d6a2f7f9630b088fb412fadaa2b47c925)
- **Staging Billing State**: `"billingStatus": "checkout_disabled"`, `"checkoutAvailable": false`
- **Rehearsal State**: Deactivated (`AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED=false`)
- **Production Status**: `main`, `prod-release`, PR #196, and Production Neon (`old-sky-50952395`) remain on **STRICT HOLD**.

---

## 5. Wave 2 Readiness & Requirements

Wave 2 will configure the exact-ID rehearsal enrollment and sandbox credentials:
1. Verify Cashfree sandbox credentials contract (`CASHFREE_APP_ID` starting with `TEST`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV=TEST`).
2. Enroll exact principal ID `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` into `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS`.
3. Activate temporary rehearsal flag `AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED=true`.
4. Verify rehearsal fence admits exclusively `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` while all other users remain fail-closed on `checkout_disabled`.
