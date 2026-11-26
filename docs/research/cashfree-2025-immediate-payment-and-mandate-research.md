# Cashfree `2025-01-01` Immediate-Payment & Legacy TEST Mandate Research

**Research Date:** 2026-11-26  
**Target Baseline:** `rc/prod-billing-release-20261126` (`29cbe36b1f43088aa667c7176624d6dd375be8d8`) / Staging (`86d087731504017da849f1e75e70168abd5d471a`)  
**Scope:** (1) Legacy Cashfree TEST mandate `pur_527cb712ad4941c38d504314e7562bf3` / `1479133886088159744` resolution analysis; (2) Cashfree `2025-01-01` immediate-payment (`authorization_amount_refund: false`) specification vs actual codebase implementation.

---

## 1. Legacy Cashfree TEST Mandate Investigation

### Target Identifiers
- **Purchase / Merchant Subscription ID:** `pur_527cb712ad4941c38d504314e7562bf3`
- **Provider Subscription ID (`cf_subscription_id`):** `1479133886088159744`
- **Operator Principal:** `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` (`antigravitypower490@gmail.com`)
- **Billing Customer ID:** `cust_2a79b54106e04c9ab491e5be3aed6b97`

### Primary-Source Evidence Observed (Neon Staging `mute-frost-50372225`, branch `cert-pr163-entitlements-20261111`)
1. **Subscription Record (`subscriptions`):**
   - `status`: `pending` (blocks new checkouts on staging via `createSubscriptionCheckout` pending guard)
   - `gateway`: `cashfree`, `plan_id`: `plus`, `currency`: `INR`, `amount_minor_units`: `39900` (₹399)
   - `metadata.gateway_auth_status`: `ACTIVE`, `metadata.gateway_subscription_status`: `ACTIVE`
   - `metadata.authorization_amount`: `1` (₹1 legacy verification mandate), `metadata.authorizationAmountRefund`: `false`
   - `metadata.auth_payment_id`: `1479134207078244864`
   - `metadata.subscriptionFirstChargeTime`: `2026-11-26T00:00:00+05:30`
   - `metadata.nextScheduleDate`: `2026-11-26T00:10:00+05:30`
   - `metadata.reconciliationStatus`: `AWAITING_PAYMENT`
   - `metadata.status_checked_at`: `1795676121434` (`2026-11-26T06:55:21.434Z` / `12:25:21 IST`)
2. **Webhook History (`payment_gateway_events`):**
   - Only two events received:
     - `SUBSCRIPTION_PAYMENT_SUCCESS` (`2026-11-25T20:43:18+05:30`): `payment_type: "AUTH"`, `payment_amount: 1`, `payment_status: "SUCCESS"`, `cf_payment_id: "1479134207078244864"`, `authorization_details.authorization_amount_refund: false`, `upi_id: "8847544875@ptyes"`, `channel: "collect"`.
     - `SUBSCRIPTION_STATUS_CHANGED` (`2026-11-25T20:43:18+05:30`): `subscription_status: "ACTIVE"`, `plan_recurring_amount: 399`, `subscription_first_charge_time: "2026-11-26T00:00:00"`, `next_schedule_date: "2026-11-26T00:10:00"`.
   - **Zero** ₹399 `CHARGE` webhooks arrived after authorization or after `2026-11-26T00:10:00+05:30`.
3. **Reconciliation & Ledger State (`billing_audit_events`, `credit_accounts`, `billing_invoices`):**
   - 9 manual reconciliation calls (`SUBSCRIPTION_RECONCILIATION_ATTEMPTED`), most recently at `2026-11-26T06:55:21.434Z` (`12:25:21 IST`), queried Cashfree `GET /pg/subscriptions/pur_527cb712ad4941c38d504314e7562bf3` and `/payments` via `queryProviderSubscriptionStatus` (`apps/api/src/billing/payment-gateway-service.ts:3916-4045`) and returned `hasEvidence: false` (`reconciliationStatus: AWAITING_PAYMENT`).
   - Cashfree wallet `cacc_dfaad457fd144e56ac7d16798d872f8a`: **`100` credits** (`reserved_credits: 0`). Zero credits granted.
   - Razorpay wallet `cacc_1c5907bd499f4277ae2cb9dae50ecd51` (`cust_9e1e096ced03407aba9db0a71f6c3253`): **`7,600` credits** (`INV-2026-0001` intact).
   - `billing_invoices`: **0** Cashfree invoices.
4. **Why No Direct CLI Call to Cashfree TEST API Could Run From Workstation:**
   - Vercel Preview (`staging`) marks `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` as `Secret`, so `vercel env run` refuses to pull them (`! 12 Secret values cannot be pulled from the preview Environment`).
   - Note that `queryProviderSubscriptionStatus` (`payment-gateway-service.ts:3979`) skips `PENDING` or `FAILED` payments when computing `paidEvidence`. Therefore, while staging confirmed at `12:25:21 IST` that no ₹399 payment **succeeded**, an operator read-only check on Cashfree Sandbox Dashboard (or via masked TEST credentials) is required to confirm no ₹399 charge is currently `PENDING`/in-flight on `1479133886088159744` before authorizing cancellation.
5. **Cancellation Assessment:**
   - Based on staging DB + `12:25:21 IST` provider status check (`AWAITING_PAYMENT`, `0` credits granted, `0` invoices), no ₹399 payment succeeded. Likely reason no debit fired at `2026-11-26T00:10:00+05:30`: RBI e-mandate rules require at least a 24-hour pre-debit notification before a scheduled `CHARGE` (whereas auth occurred ~3h17m earlier at `20:43:18+05:30`), or sandbox did not trigger the scheduled debit.
   - Once the operator verifies in Cashfree Sandbox Dashboard that `/payments` for `1479133886088159744` has no `PENDING` ₹399 transaction and authorizes cancellation, it can be safely cancelled via `SettingsModal` (`POST /api/billing/subscriptions/pur_527cb712ad4941c38d504314e7562bf3/cancel-pending`) or Cashfree `POST /pg/subscriptions/pur_527cb712ad4941c38d504314e7562bf3/manage` (`{"action": "CANCEL"}`).

---

## 2. Cashfree `2025-01-01` Immediate-Payment Implementation vs Official Documentation

### Primary Sources Cited
1. Cashfree Subscriptions Overview & Create Subscription API (`x-api-version: 2025-01-01`): `https://docs.cashfree.com/docs/subscription-overview` and Cashfree API docs (`cashfree.com/docs`)
2. Local codebase:
   - `apps/api/src/billing/payment-gateway-service.ts` (L2432–3250, L3334–3735, L3916–4148, L5402–5556)
   - `apps/api/src/billing-routes.ts` (L32–49, L420–517, L602–698)
   - `src/components/PricingModal.tsx` & `src/components/SettingsModal.tsx`

### Verification Matrix

| Requirement | Official Cashfree `2025-01-01` Semantics | Current AIRA `29cbe36` Implementation | Status / Risk |
| :--- | :--- | :--- | :--- |
| **Full authorization amount (₹399 / ₹999)** | `authorization_details.authorization_amount` accepts major currency units (e.g., `399` or `999`) charged immediately during mandate setup (with AFA). | Sends `authorizationAmountMajor = Number((price.amountMinorUnits / 100).toFixed(2))` (`399` or `999`) (`payment-gateway-service.ts:2895,2926`). | **MATCHES** |
| **`authorization_amount_refund=false`** | Retains the initial `authorization_amount` instead of auto-refunding post-authorization. | Sends `authorization_amount_refund: false` (`L2927`) and strictly enforces non-refundable proof in `isCashfreeImmediatePaidAuth` (`L3385–3396`). | **MATCHES** |
| **Supported payment methods** | Supports `upi`, `card`, `enach`, `pnach` in `authorization_details.payment_methods`. | Restricts to `['upi', 'card']` (`L2928`) to align with instant online AFA authorization. | **MATCHES** |
| **Payment status semantics & AUTH vs CHARGE** | Auth transaction emits `SUBSCRIPTION_PAYMENT_SUCCESS` with `payment_type: "AUTH"` and `payment_status: "SUCCESS"`. `SUBSCRIPTION_STATUS_CHANGED` (`ACTIVE`) carries no payment proof on its own. | `isCashfreeImmediatePaidAuth` (`L3367–3420`) accepts `AUTH` **only** when `immediateAuthChargeExpected === true`, `payment_status` in `['SUCCESS','CAPTURED','PAID']`, `authorization_amount_refund === false`, exact amount > ₹1 (`> 100` minor units), and exact currency match. Status-only events record `SUBSCRIPTION_STATUS_RECORDED` without activating (`L1525–1583`). | **MATCHES (Fail-closed)** |
| **Retention as Cycle 1 fee & duplicate charge prevention** | Cashfree Subscriptions `2025-01-01` docs state `subscription_first_charge_time` (FCD) applies to `PERIODIC` plans and must be `< 14 days` from request date; if omitted, Cashfree schedules the first recurring charge automatically at `T+1` (UPI/Cards before 9 PM IST) or `T+2` (after 9 PM IST) / `T+4` (eNACH). | Keeps `subscription_first_charge_time` (`+1 month`) rather than omitting it (which would schedule Cycle 2 immediately at `T+1`/`T+2`), records warning telemetry if Cashfree returns `next_schedule_date` inside Cycle 1, AND enforces a fail-closed premature `CHARGE` guard (`DUPLICATE_CYCLE_PAYMENT_DETECTED`) so an unexpected Cycle 1 `CHARGE` after immediate non-refundable `AUTH` never double-grants Cycle 1 credits. **Note:** If Cashfree Sandbox returns HTTP 400 on `+1 month` FCD during live manual testing, switch Cashfree immediate Cycle 1 plans to `ON_DEMAND` or server-scheduled billing rather than omitting FCD on `PERIODIC`. | **MITIGATED IN CODE; LIVE SANDBOX CHECK RECOMMENDED** |
| **Refund & reversal handling** | Non-refundable `authorization_amount` refunds require explicit Refund API or merchant dashboard refund, emitting `REFUND_SUCCESS`/`REFUND_STATUS`. | `handleSubscriptionRefund` (`L6782–7007`) revokes unspent `credit_grants` for `purchaseId`, sets `authRefunded = true`, creates `billing_credit_notes`, and preserves invoice evidence (`L7367–7398`). | **MATCHES** |
| **Cancellation API version** | Cashfree `POST /pg/subscriptions/{id}/manage` supports `'x-api-version': '2025-01-01'` (`action: "CANCEL"`). | Callers at `L4122`, `L5153`, `L5488` send `'x-api-version': '2023-08-01'`. Worked for sandbox cancellation of `pur_a705cae8...`, though misaligned with `2025-01-01` used in `create` and `GET`. | **LOW / P3 ALIGNMENT** |
| **RBI e-mandate & pre-debit notification** | Automatic recurring debits require 24h pre-debit SMS/email notification (AFA-free up to ₹15,000 for UPI/cards). | Both ₹399 and ₹999 are well under the ₹15,000 RBI AFA-free recurring limit; `subscription_meta.notification_channel: ['EMAIL', 'SMS']` enabled (`L2933`). | **MATCHES** |
