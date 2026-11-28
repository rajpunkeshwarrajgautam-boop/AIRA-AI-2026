# Cashfree Cycle 1 Sandbox Payment Simulation Research (`pur_527cb712ad4941c38d504314e7562bf3`)

**Date:** 2026-11-26  
**Target Subscription:** `pur_527cb712ad4941c38d504314e7562bf3` (`cf_subscription_id`: `1479133886088159744`)  
**Plan:** `plus` (`plan_cf_plus_inr_monthly`, `plan_type: PERIODIC`, `₹399 INR` monthly)  
**Staging Baseline:** `https://staging.virexaaiventures.com` (`commitSha: 0abbda139f47e57e2edc5dfab9ea0555bf3c5e83`)  

---

## 1. Official Cashfree Sandbox Simulation Procedure

Per Cashfree's primary API specification and Subscriptions FAQ:

- **Simulation Endpoint (Sandbox):** `POST https://sandbox.cashfree.com/pg/simulate`  
  Source: [Simulate Payment API Reference (`v2026-01-01`)](https://www.cashfree.com/docs/api-reference/payments/latest/simulation/simulate-payment)
- **Required Headers:**
  - `Content-Type: application/json`
  - `x-api-version: 2026-01-01` (default in current specification; `2025-01-01` and `2023-08-01` are documented previous versions)
  - `x-client-id: <CASHFREE_APP_ID>`
  - `x-client-secret: <CASHFREE_SECRET_KEY>`
  - Optional: `x-idempotency-key: <UUID>` (prevents duplicate simulation actions across retries)
  Source: [Simulate Payment API Reference (`v2026-01-01`)](https://www.cashfree.com/docs/api-reference/payments/latest/simulation/simulate-payment)
- **Required Request Body for Subscription Payments (`SUBS_PAYMENTS`):**
  ```json
  {
    "entity": "SUBS_PAYMENTS",
    "entity_id": "<payment_id>",
    "entity_simulation": {
      "payment_status": "SUCCESS",
      "payment_error_code": ""
    }
  }
  ```
  - **Critical identifier rule:** *"If the entity type is `PAYMENTS`, the `entity_id` will be the `cf_payment_id`. If the entity type is `SUBS_PAYMENTS`, the `entity_id` will be the `payment_id`."*  
  Source: [Simulate Payment API Reference (`v2026-01-01`)](https://www.cashfree.com/docs/api-reference/payments/latest/simulation/simulate-payment) & [Cashfree Subscriptions FAQs](https://www.cashfree.com/docs/payments/subscription/faq)

---

## 2. Eligibility of an `INITIALIZED` Periodic Subscription Payment

Cashfree's official Subscriptions FAQ explicitly forbids simulating `INITIALIZED` periodic charges and forcing early `INITIALIZED` → `PENDING` transitions:

> *"The payment must be in `PENDING` status for simulation to work. You can't simulate a payment in `INITIALIZED` status. For periodic subscriptions, the payment moves from `INITIALIZED` to `PENDING` on its scheduled billing date. Call the simulation API after that."*  
>  
> *"Can I force a PERIODIC subscription from `INITIALIZED` to `PENDING` in the sandbox environment? No. A `PERIODIC` subscription payment moves from `INITIALIZED` to `PENDING` only when its scheduled billing date arrives, and the sandbox environment does not support forcing this transition early."*  
Source: [Cashfree Subscriptions FAQs](https://www.cashfree.com/docs/payments/subscription/faq) & [Charge a Subscription](https://www.cashfree.com/docs/payments/subscription/charge)

**Implication for `1479133886088159744`:**
- `plan_cf_plus_inr_monthly` is configured as `plan_type: "PERIODIC"` (`subscription_first_charge_time: "2026-11-26T00:00:00+05:30"`, `next_schedule_date: "2026-11-26T00:10:00+05:30"`), recorded in staging gateway webhook `pge_57992aec83894367bc611e90be508a10`.
- While Cycle 1 remains in `INITIALIZED` status, `POST https://sandbox.cashfree.com/pg/simulate` is **ineligible** by Cashfree rule and will be rejected.
- Simulation with `entity: "SUBS_PAYMENTS"` is only eligible once Cashfree's periodic scheduler transitions Cycle 1 from `INITIALIZED` → `PENDING` and exposes the Cycle 1 `payment_id` via `GET /pg/subscriptions/1479133886088159744/payments`.

---

## 3. Authoritative Cycle 1 Identity & Observed Staging State (2026-11-26)

- **Staging Neon DB (`mute-frost-50372225` / `br-snowy-bonus-b32thjlz`):**
  - Principal: `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` (`antigravitypower490@gmail.com`)
  - Customer ID: `cust_2a79b54106e04c9ab491e5be3aed6b97`
  - Purchase ID: `pur_527cb712ad4941c38d504314e7562bf3`, status: `pending`, `reconciliationStatus: "AWAITING_PAYMENT"`
  - Cycle 0 AUTH recorded: `pge_112aa5b5f12f425690588bdc726bffb3` (`SUBSCRIPTION_PAYMENT_SUCCESS`, `payment_type: "AUTH"`, `payment_amount: 1`, `cf_payment_id: "1479134207078244864"`, `payment_id: "11363169_680_1795619475943"`).
  - Status recorded: `pge_57992aec83894367bc611e90be508a10` (`SUBSCRIPTION_STATUS_CHANGED`, `subscription_status: "ACTIVE"`, `next_schedule_date: "2026-11-26T00:10:00"`).
  - Credit account `cacc_dfaad457fd144e56ac7d16798d872f8a`: `balance_credits: 100`, `lifetime_granted_credits: 100`, `0` credit grants, `0` Cycle 1 webhooks, `0` invoices.
- **Live Staging Reconcile Check (`POST https://staging.virexaaiventures.com/api/billing/internal/reconcile-ambiguous`, 2026-11-26T18:24 IST):**
  - Returned `reconciled: false`, `status: "pending"`, `providerStatus: "ACTIVE"`, `hasAuthorizedMandate: true`, `paidEvidence: false` (`subscriptionFirstChargeTime: "2026-11-26T00:00:00+05:30"`, `nextScheduleDate: "2026-11-26T00:10:00+05:30"`, `planRecurringAmount: 399`).
- **Live Staging Financial Worker (`POST https://staging.virexaaiventures.com/api/billing/worker/process-outbox`):**
  - Returned `200 OK` (`ok: true`, `workerId: "wkr_061196188663"`, `durationMs: 2573`).
- **Raw Cycle 1 `payment_id` / `cf_payment_id` Gap:**
  - Direct call to `GET https://sandbox.cashfree.com/pg/subscriptions/1479133886088159744/payments` requires `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY`, which are marked `[SENSITIVE]` in Vercel staging (`vercel env pull` redacts them) and intentionally absent from local disk (`.env.staging.sandbox` contains placeholders; `scripts/run-cashfree-operator-secure.ps1` forbids disk persistence). Staging `/reconcile-ambiguous` does not surface raw unpaid `/payments` entries.

---

## 4. Expected Signed Webhook Events & Duplicate-Payment Prevention

- **Expected Webhook upon Cycle 1 Settlement:**
  - Cashfree fires `SUBSCRIPTION_PAYMENT_SUCCESS` with `payment_type: "CHARGE"`, `payment_amount: 399`, `payment_currency: "INR"`, `payment_status: "SUCCESS"`, `subscription_id: "pur_527cb712ad4941c38d504314e7562bf3"`, `cf_subscription_id: "1479133886088159744"`, and Cycle 1 `payment_id` / `cf_payment_id`.  
  Source: [Cashfree Subscription Webhooks](https://www.cashfree.com/docs/payments/subscription/webhooks)
- **AIRA Webhook & Idempotency Handling:**
  - `PaymentGatewayService.processCashfreeWebhook` (`apps/api/src/billing/payment-gateway-service.ts`) verifies the HMAC webhook signature, stores raw event deduplication in `payment_gateway_events`, extracts `payment_type === 'CHARGE'` + `actualPaymentId` (`cf_payment_id` / `payment_id`), and guards activation and tax invoice issuance via `idempotent_operations` keys (`<principalId>:cashfree:sub:<purchaseId>:pay:<paymentId>` and `inv_binding:<customerId>:<purchaseId>:cycle:<cycle>`).
- **Simulation API Idempotency:**
  - Passing `x-idempotency-key: <UUID>` to `POST https://sandbox.cashfree.com/pg/simulate` prevents duplicate simulation actions across request retries.
  - Because `1479133886088159744` is `PERIODIC` (not `ON_DEMAND`), `POST /pg/subscriptions/pay` must **not** be called, and no new subscription or payment request may be created.

---

## 5. Supported Sandbox Alternative & Immediate Unblock Options

1. **If testing the existing preserved mandate `1479133886088159744`:**
   - Operator queries `GET https://sandbox.cashfree.com/pg/subscriptions/1479133886088159744/payments` (`x-api-version: 2025-01-01` or `2026-01-01`) with staging TEST credentials (or checks Cashfree Merchant Dashboard -> Subscriptions -> `1479133886088159744` -> Payments).
   - Once Cycle 1 `payment_status` has transitioned to **`PENDING`**, simulate that exact Cycle 1 `payment_id` via `POST https://sandbox.cashfree.com/pg/simulate` (`entity: "SUBS_PAYMENTS"`, `entity_id: "<cycle1_payment_id>"`, `entity_simulation: { "payment_status": "SUCCESS", "payment_error_code": "" }`). If it is still `INITIALIZED`, Cashfree docs confirm it cannot be simulated or forced early via API.
2. **If immediate full payment testing without waiting for Cashfree's periodic scheduler is desired on a separate test cycle:**
   - Note that for AIRA's new PR `#213`/`#214` immediate Cycle 1 flow (already merged on staging `0abbda139f47e57e2edc5dfab9ea0555bf3c5e83`) or Cashfree's `ON_DEMAND` subscriptions (`POST /pg/subscriptions/pay` with `payment_type: CHARGE`), full immediate payment can be exercised without waiting for a periodic scheduler transition — whereas the preserved pre-PR#213 periodic mandate `pur_527cb712ad4941c38d504314e7562bf3` remains governed by Cashfree's periodic scheduler.
