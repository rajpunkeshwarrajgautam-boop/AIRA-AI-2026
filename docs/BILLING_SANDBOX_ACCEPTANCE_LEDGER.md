# AIRA AI 2026 — Billing Sandbox Acceptance Ledger & Release Evidence

**Last Updated:** 2026-11-27T00:01+05:30  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Canonical Staging:** `https://staging.virexaaiventures.com` (Vercel `dpl_GsipaYiU2bEZe6DhQXBJVUAY9dum`)  
**Certified Staging SHA:** `6c90c12930a23018ff02435a7832ca5bd0578b26` (PR `#217` merged & deployed)  
**Production Candidate SHA:** `fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` (PR `#215` — **DRAFT / STRICT HOLD**)  
**Staging Database:** Neon `mute-frost-50372225` / Branch `br-snowy-bonus-b32thjlz` (`cert-pr163-entitlements-20261111`)  

---

## 1. Consolidated 4-Combination Manual Acceptance Ledger

| # | Payment Gateway | Purchased Plan | Initial Payment | Provider Payment Status | Activation Result | Credits Granted | Final Wallet Balance | Invoice Number | Invoice Download Result | Next Renewal Date | Verified Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **Cashfree (TEST)** | **AIRA Plus (`plus`)** | **₹399.00 INR** (Immediate UPI Mandate Auth, non-refundable) | **`SUCCESS`** (`cf_payment_id: 1479479837022321152`, `payment_id: 11363169_999_1795701880542`) | **Immediate `active`** (`pur_411d4e047dd041dc8e7a61f705c3ce27`; ~2.5s after webhook receipt) | **+3,000** (`grant_b52ae89249e64973bc2cc29bc16068a6`, once) | **3,100** (`3,000` active Plus + `100` expired Free welcome grant `grant_09c5538ca4004390bbc8ec8085f9630f` awaiting next post-PR#217 lazy sweep; `0` spent) | **`INV-2026-0002`** (Paid, ₹338.14 + ₹60.86 IGST = ₹399) | **PASS** (Operator HTML download verified; `200 text/html`) | **2026-12-26** (`next_schedule_date: 2026-12-26T00:10:00`; period end `2026-12-26T19:32:18.998+05:30`) | Operator manual flow + Staging DB (`cust_2a79b54106e04c9ab491e5be3aed6b97`, `pge_149cd45ce26e453a941ea46f0a4a8b4f`, `ctx_2c569f94397f4571a66427e676cff6a5`) | **PASS** |
| **2** | **Cashfree (TEST)** | **AIRA Pro (`pro`)** | **₹999.00 INR** (Immediate UPI Mandate Auth, non-refundable) | **`SUCCESS`** (`cf_payment_id: 1479507718292207616`, `payment_id: 11363169_972_1795708527957`) | **Immediate `active`** (`pur_b19205cdaa624b82ac99d4cc1150c484`; `2,307 ms` after webhook receipt) + **Cancellation Retention PASS** (`Active until 26 Dec 2026`, `Automatic renewal: Cancelled`) | **+7,500** (`grant_97db8211226142ad9ceb5e35bccfa0d3`, once) | **7,500** (`7,600` initial minus `100` legitimately expired 30-day welcome grant via `ctx_7cfeef37452048febf7c7c7399aa02b7`; `0` spent) | **`INV-2026-0003`** (Paid, ₹846.61 + ₹152.39 IGST = ₹999.00) | **PENDING_OPERATOR_DOWNLOAD** (Awaiting operator download confirmation) | **2026-12-26** (`Automatic renewal: Cancelled`; paid period ends `2026-12-26T21:25:16.172+05:30`) | Operator screenshots + Staging DB (`cust_dbfaef1d12024ea99ee860ee4bfc5b77`, `pge_e72f9639354d419db4915b41ee1488ba`, `ctx_64152f1a3c434e4d913f2cf8d14fe94f`, `ctx_7cfeef37452048febf7c7c7399aa02b7`) | **BACKEND_PASS + Cancellation PASS (Download Pending)** |
| **3** | **Razorpay (TEST)** | **AIRA Plus (`plus`)** | **₹399.00 INR** (Immediate UPI Mandate Auth, `39900` minor) | **`captured`** (`pay_U4stOZvo0wNj9t`, `sub_U4st6RSpGba6c3`, `order_U4st7C5iMqBbDl`, `inv_U4st75HAxlbR8H`) | **Immediate `active`** (`pur_ad3ac94100294b6192c41e10cb29fa9b`; `1,896 ms` after `invoice.paid` receipt; `cancel_at_period_end: true` scheduled via `bae_1cf6996c04834e2c9774d82dcdc61ea0`, paid access retained) | **+3,000** (`grant_b063f75c1f2c4950bc38d52f7c3d8460`, once) | **3,000** (`0` -> `3,000` after `100` legitimately expired 30-day welcome grant `grant_55807196c55648879c2de1859814f579` via `ctx_cd588bab850a413badec2a5353913287`; `0` spent) | **`INV-2026-0004`** (Paid, ₹338.14 + ₹60.86 IGST = ₹399.00) | **PENDING_OPERATOR_DOWNLOAD** (Awaiting operator download confirmation) | **2026-12-26** (`cancel_at_period_end: true`; paid period ends `2026-12-26T22:50:49.275+05:30`) | Operator screenshot + Staging DB (`usr_29d7e8a9-f8bd-4685-ac58-97e585efa2b0`, `cust_546b027724104cd094ee756b72d6051c`, `pge_39817a045a234424b2a870a2df8f193f`, `ctx_f38f01937b65449598d04971ee9b551a`, `snap_45aa510a812c48ceb3bf04e192fc4d16`) | **BACKEND_PASS (Download Pending)** |
| **4** | **Razorpay (TEST)** | **AIRA Pro (`pro`)** | **₹999.00 INR** (Immediate UPI Intent Mandate, `99900` minor) | **`captured`** (`pay_U4twwS5Qgtwwjx`, `sub_U4twkqY56bWzRs`, `order_U4twlZk8AOpCre`, `inv_U4twlTgY0VY0oq`) | **Immediate `active`** (`pur_9dff97f99a434153bdf698c7c548b2cc`; `2,161 ms` after `invoice.paid` receipt; `paid_count: 1 / 12`, `remaining_count: 11`) | **+7,500** (`grant_46d4f6123c5247139d35d04332173999`, once) | **7,500** (`0` baseline after welcome expiry + `7,500` Pro grant; `0` spent) | **`INV-2026-0005`** (Paid, ₹846.61 + ₹152.39 IGST = ₹999.00) | **PASS** (Operator download confirmed on staging) | **2026-12-26** (`charge_at: 1798223400` / `2026-12-26T00:00:00+05:30`; period end `2026-12-26T23:52:58.683+05:30`) | Operator manual flow + Staging DB (`usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c`, `cust_d6c10d8b7bc343bc9c648cb372403baa`, `pge_c5711f68aaf746a8b287ee68b4136f60`, `ctx_83d20e3c216441a188f8401c8ac7430d`, `inv_6b04356ed3944b718df2132c9c21bb82`) | **PASS** |

---

## 2. Preserved Backend Evidence — Cashfree Plus (`pur_411d4e047dd041dc8e7a61f705c3ce27`)

Read-only inspection of Staging Neon (`mute-frost-50372225` / `br-snowy-bonus-b32thjlz`) established:

- **Customer & Purchase Identity (Sanitized):**
  - Principal ID: `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` (`cust_2a79b54106e04c9ab491e5be3aed6b97`, India / `INR`)
  - Purchase ID: `pur_411d4e047dd041dc8e7a61f705c3ce27` (`plan_id: "plus"`, `price_id: "price_plus_inr"`, `status: "active"`, `cancel_at_period_end: false`)
  - Prior unpaid checkout `pur_527cb712ad4941c38d504314e7562bf3` was cleanly cancelled (`SUBSCRIPTION_CANCELLED`, `bae_92641593808f40cfa6dc344f91291e6e`, `pge_eda970b8497a49c8a8498b9ee66b2db4`) prior to creating `pur_411d4e047dd041dc8e7a61f705c3ce27`.
- **Cashfree Provider Subscription & Payment Identifiers:**
  - Provider Subscription ID (`cf_subscription_id`): `1479479253703686656` (`plan_cf_plus_inr_monthly`, `providerApiVersion: "2025-01-01"`)
  - Payment Identifiers: `cf_payment_id` / `gateway_payment_id`: `1479479837022321152`; `payment_id`: `11363169_999_1795701880542`; `cf_txn_id`: `1479479837441809920`; `cf_order_id`: `1479479837164985856`
- **Authoritative Full-Payment & Non-Refundable Auth Evidence:**
  - Webhook `pge_149cd45ce26e453a941ea46f0a4a8b4f` (`SUBSCRIPTION_PAYMENT_SUCCESS`): `payment_type: "AUTH"`, `payment_amount: 399`, `payment_currency: "INR"`, `payment_status: "SUCCESS"`, `payment_group: "upi"` (`collect`).
  - Authorization details: `authorization_amount: 399`, `authorization_status: "ACTIVE"`, `authorization_amount_refund: false` (non-refundable full first-cycle auth; `immediateAuthPaid: true`, `expectedFirstPaymentAmountMinor: 39900`, `expectedAuthorizationAmountRefund: false`).
- **Signed Webhook Processing History (`payment_gateway_events`):**
  1. `pge_bd1f3688eaa64ffca5700c8d5cf83ca0` — `SUBSCRIPTION_STATUS_CHANGED` (`signature_valid: true`, `processed: true`, `error: null`, received `2026-11-26T19:34:49.105+05:30`, processed `2026-11-26T19:34:52.712+05:30`, `SUBSCRIPTION_STATUS_RECORDED`).
  2. `pge_149cd45ce26e453a941ea46f0a4a8b4f` — `SUBSCRIPTION_PAYMENT_SUCCESS` (`signature_valid: true`, `processed: true`, `error: null`, received `2026-11-26T19:34:49.110+05:30`, processed `2026-11-26T19:35:02.379+05:30`).
- **Credit Ledger & Grant Identity:**
  - Wallet Account `cacc_dfaad457fd144e56ac7d16798d872f8a`: `balance_credits: 3100`, `reserved_credits: 0`, `lifetime_granted_credits: 3100`, `lifetime_spent_credits: 0`.
  - Grant `grant_b52ae89249e64973bc2cc29bc16068a6`: `3,000` credits (`grant_type: "subscription_monthly"`, `rollover_capped: true`, `expires_at: 2026-12-26T19:32:18.998+05:30`, idempotency key `grant_cashfree:sub:pur_411d4e047dd041dc8e7a61f705c3ce27:pay:1479479837022321152`) on top of welcome grant `grant_09c5538ca4004390bbc8ec8085f9630f` (`100`).
  - Transaction `ctx_2c569f94397f4571a66427e676cff6a5`: `GRANT`, `+3000`, `balance_before: 100`, `balance_after: 3100`.
- **Invoice Ownership & Payment Association:**
  - `inv_num:INV-2026-0002` + `inv_binding:cust_2a79b54106e04c9ab491e5be3aed6b97:pur_411d4e047dd041dc8e7a61f705c3ce27:cycle:1` (`payload_hash: "1479479837022321152"`, owned by `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`) + audit event `bae_02953c3adabc49599d9ecb4c1c95c591` (`TAX_INVOICE_ISSUED`, `date: "2026-11-26"`, `totalAmount: 399`, `taxableBase: 338.14`, `gstAmount: 60.86`, `igstAmount: 60.86`, `sacCode: "998431"`, `status: "Paid"`).
- **Provider Renewal Schedule & Activation Latency:**
  - Provider renewal schedule: `subscription_first_charge_time: "2026-12-26T00:00:00"`, `next_schedule_date: "2026-12-26T00:10:00"`; `current_period_end: 2026-12-26T19:32:18.998+05:30`.
  - Checkout created `2026-11-26T19:32:18.998+05:30` → Activated `2026-11-26T19:34:51.612+05:30` (`152.614s` end-to-end including user UPI simulation; **`2,507 ms`** from webhook receipt `19:34:49.105+05:30` to subscription activation; `13,269 ms` full payment webhook completion at `19:35:02.379+05:30`).
- **Entitlement Verification Scope Note:**
  - Code-defined `plus` entitlements in `packages/contracts/src/commercial.ts` (`dailyStandardChatLimit: 50`, `complimentaryReasoningBoosts: 50`, `maxProjects: 10`, `monthlyPremiumCredits: 3000`) plus `entitlement_snapshots` row `snap_540b9c4e33e148888483d61dc872aa3f` (`2026-11-26`, `daily_standard_chat_count: 1`) align with the operator's UI verification (`3,100` credits, `50` daily chats, `50` reasoning boosts, `10` projects).
- **Duplicate Check & Non-Blocking Observation:**
  - Exactly `1` active subscription (`pur_411d4e047dd041dc8e7a61f705c3ce27`), `1` `+3000` credit grant/txn, `1` invoice (`INV-2026-0002`), zero duplicate payment obligations. *(Non-blocking metadata observation: `metadata.reconciliationStatus` remained `"AWAITING_PAYMENT"` after `bae_4517753db4054aea949290164e4422ff` while `status` is `"active"` and `immediateAuthPaid` is `true`.)*

---

## 3. Isolated Test Accounts & Readiness Matrix (Current Status at `6c90c129`)

Existing staging accounts inspected read-only in `br-snowy-bonus-b32thjlz`:

| Account Email | Principal ID | Customer ID | Login Method | Current Credits | Subscriptions / State | Enrollment Status (`AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS`) | Assignment / Preservation Status |
|---|---|---|---|---:|---|---|---|
| `antigravitypower490@gmail.com` | `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` | `cust_2a79b54106e04c9ab491e5be3aed6b97` | Google OAuth | 3,100 | `pur_411d4e047dd041dc8e7a61f705c3ce27` (**Active Cashfree Plus**, `INV-2026-0002` PASS) | ENROLLED | **PRESERVE (Cashfree Plus PASS)** |
| `rajpunkeshwarrajgautam@gmail.com` | `neon_user_e215766f-e719-431f-ad08-154a28ef83b4` | `cust_dbfaef1d12024ea99ee860ee4bfc5b77` | Google / GitHub OAuth | 7,500 | `pur_b19205cdaa624b82ac99d4cc1150c484` (**Cashfree Pro Cancelled — Active until 2026-12-26**, `INV-2026-0003`) | ENROLLED | **PRESERVE (Cashfree Pro + Cancellation PASS)** |
| `virexaiventures@gmail.com` | `usr_29d7e8a9-f8bd-4685-ac58-97e585efa2b0` | `cust_546b027724104cd094ee756b72d6051c` | Google OAuth | 3,000 | `pur_ad3ac94100294b6192c41e10cb29fa9b` (**Active Razorpay Plus**, `INV-2026-0004`) | ENROLLED | **PRESERVE (Razorpay Plus BACKEND_PASS)** |
| `kpveovfji@a.1charlottewalker.asia` | `usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c` | `cust_d6c10d8b7bc343bc9c648cb372403baa` | Google OAuth | 7,500 | `pur_9dff97f99a434153bdf698c7c548b2cc` (**Active Razorpay Pro**, `INV-2026-0005` Download PASS) | ENROLLED | **PRESERVE (Razorpay Pro PASS)** |
| `sdrafgerfsfwf@gmail.com` | `neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7` | `cust_9e1e096ced03407aba9db0a71f6c3253` | Google OAuth | 7,600 | `pur_8150add7f93743e38138b5617f727188` (`active` Pro), `pur_f7a7df9d...` (`pending` Plus) | ENROLLED | **DO NOT REUSE** (Historical `INV-2026-0001` preserved) |

> **Enrollment Gate & Phase Closure (`6c90c129` / `dpl_GsipaYiU2bEZe6DhQXBJVUAY9dum`):** All `7` enrolled staging principals (`6` baseline/prior + `usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c`) completed staging verification with zero cross-account contamination and strict Production isolation intact. All four manual gateway × tier sandbox purchase combinations have now been executed and verified.

---

## 4. Deferred Production Invoice & GST Configuration Requirements

Observed in `INV-2026-0002` (`bae_02953c3adabc49599d9ecb4c1c95c591`) and `apps/api/src/billing-routes.ts` (`GET /api/billing/invoices/:invoiceNumber/download`, lines 368–412) — **deferred until final merchant/tax configuration phase** (do not modify `INV-2026-0001` / `INV-2026-0002` or billing design during manual acceptance):

1. **Verified Supplier Legal Name:** Currently `Virexa AI Ventures Private Limited` — confirm exact legal entity registration name.
2. **Supplier GSTIN:** Currently absent (`taxComplianceStatus: "PROVISIONAL_PENDING_GSTIN"`; template supports `invoice.supplierGstin` when configured).
3. **Registered Business Address:** Not yet included on the downloadable HTML invoice header (`billing-routes.ts` lines 385–396).
4. **Customer Billing Details:** Legal/billing name, billing email/address, and optional customer GSTIN (for B2B) are not rendered.
5. **Principal Identifier Privacy:** `billing-routes.ts` line 398 currently prints `<strong>Customer Principal:</strong> ${escapeHtml(principal.userId)}` — remove or replace internal auth principal identifiers with customer-facing billing identity on production invoices.
6. **Place of Supply & CGST/SGST vs IGST Determination:** Currently defaults to `placeOfSupply: "UNKNOWN"` and always taxes via `IGST 18%` (`taxableBase: 338.14`, `gstAmount: 60.86`, `igstAmount: 60.86`); configure state/place-of-supply resolution so intra-state supplies split into `CGST (9%) + SGST (9%)` and inter-state into `IGST (18%)` (plus export/LUT handling for non-India/USD).
7. **Verified SAC Classification & Rate:** Currently hardcoded `SAC 998431` / `18%` (`SAC_998431_2026_v1`) — verify SAC code & rate with tax counsel.
8. **Compliant Invoice Numbering & Statutory Particulars:** Sequential financial-year tax invoice numbering, POS/state code, reverse-charge indicator, HSN/SAC summary, and digital/authorized signatory block.
9. **Subscription Billing Period & Payment Reference:** Include explicit service period (`current_period_start` to `current_period_end`), payment gateway reference / transaction ID (`cf_payment_id` / `razorpay_payment_id`), and order/subscription reference.
10. **Printable Layout & Sandbox Distinction:** Add explicit `SANDBOX / NON-TAX RECEIPT` watermark/badge when `isSandbox === true` so sandbox receipts are visibly distinguished from live statutory production tax invoices, and refine print CSS (`@media print` / A4 formatting).

---

## 5. Fail-Closed Preflight, Observations A & B & Enrollment Checkpoint (`2026-11-26T20:25+05:30`)

### 5.1 Verified Fail-Closed Staging Preflight
- **Vercel Project & Staging Identity:** Project `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`, org `team_0IZkX9o2Ab319UsAPW9oq1SL`), Preview (`staging`), live deployment `dpl_2tpewiuxAXiuErtW5mtwkEEDMv7d` serving `https://staging.virexaaiventures.com` at `commitSha: "0abbda139f47e57e2edc5dfab9ea0555bf3c5e83"`, `/api/health: HEALTHY` (`database: REACHABLE`), `/api/billing/plans`: `billingStatus: "sandbox_rehearsal"`, `checkoutAvailable: true`.
- **Production Isolation:** `vercel env ls --environment production` contains zero gateway billing secrets or `AIRA_COMMERCIAL_BILLING_ENABLED`; PR `#215` remains Draft / **STRICT HOLD**.
- **Neon Staging (`mute-frost-50372225` / `br-snowy-bonus-b32thjlz`):** Migrations verified through `035_subscription_cancellation_and_invoice_outbox.ts`.
  - `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` (`antigravitypower490@gmail.com`): `pur_411d4e047dd041dc8e7a61f705c3ce27` (`active`, Cashfree Plus), `balance_credits: 3100` — **PRESERVED**.
  - `neon_user_e215766f-e719-431f-ad08-154a28ef83b4` (`rajpunkeshwarrajgautam@gmail.com`): Google + GitHub OAuth (`email_verified: true`), `cust_dbfaef1d12024ea99ee860ee4bfc5b77`, `100` credits, `0` subscriptions — **CLEAN FOR TEST 1 (Cashfree Pro)**.
  - `usr_29d7e8a9-f8bd-4685-ac58-97e585efa2b0` (`virexaiventures@gmail.com`): Google OAuth (`email_verified: true`), `cust_546b027724104cd094ee756b72d6051c`, `100` credits, `0` subscriptions — **CLEAN FOR TEST 2 (Razorpay Plus)**.
  - `usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c` (`kpveovfji@a.1charlottewalker.asia`): Not enrolled (awaiting explicit owner confirmation of ownership & authentication capability).

### 5.2 Investigation Findings — Observations A & B (No Code Changes Required)
- **Observation A (`metadata.reconciliationStatus: "AWAITING_PAYMENT"` on active `pur_411d4e047dd041dc8e7a61f705c3ce27`):** Verified across `apps/`, `src/`, and `packages/` (`rg -n "reconciliationStatus"`) that all 7 occurrences in the codebase are writes inside `apps/api/src/billing/payment-gateway-service.ts`; **zero runtime/UI/entitlement/renewal readers exist**. `executeInitialSubscriptionActivation` sets SQL `status: 'active'`, `fulfilledCycle`, `initialPaymentId`, `lastPaymentId`, and `immediateAuthPaid: true`. Zero impact on renewal fulfillment, credit expiry/allocation, entitlements, customer UI, or duplicate-payment prevention.
- **Observation B (`2026-12-26T00:10:00` provider debit vs `2026-12-26T19:32:18.998+05:30` `current_period_end`):** `createSubscriptionCheckout` sends `subscription_first_charge_time` at `+1 month` IST (`2026-12-26T19:32:18+05:30`), and Cashfree's `PERIODIC` engine schedules its batch debit at `00:10:00` IST on that calendar date (~19h 22m before `current_period_end`). Verified in `payment-gateway-service.ts`: (1) `isPrematureCycle1Payment` (`L1920-1935`) uses a `fiveDaysMs` threshold (`periodEndMs > now + 5d`), so a 19h-early Cycle 2 debit passes cleanly and is **not** blocked; (2) Cycle 2 renewal anchors `periodStart` strictly to `Number(purchaseRecord.current_period_end)` (`L2036-2037`) when explicit bounds are absent, preserving full Cycle 1 duration and seamless credit rollover; (3) Customer UI (`src/components/SettingsModal.tsx:1291`) formats date to calendar day (`26 Dec 2026 IST`), matching both timestamps. Non-blocking; no code modification required.

### 5.3 Enrollment Gate Checkpoint (`STOP — Sensitive Var Preservation`)
- `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS` on Vercel `Preview (staging)` is stored as `type: "sensitive"` (`hasValue: false` in `vercel env ls --format json`; `.env.staging.sandbox` redacts it as `"[SENSITIVE]"`).
- Per fail-closed policy (never overwrite a `Sensitive` variable with an unverified/incomplete list), direct CLI overwrite is paused cleanly pending owner execution/confirmation of the wizard at `enroll-staging-principals-wizard.ps1`, followed by exact-SHA redeploy of `dpl_2tpewiuxAXiuErtW5mtwkEEDMv7d` (`0abbda139f47e57e2edc5dfab9ea0555bf3c5e83`) before starting **Test 1 (Cashfree Pro)**.

---

## 6. Verified Backend Evidence — Cashfree Pro (`pur_b19205cdaa624b82ac99d4cc1150c484`) & Staging Redeployment (`2026-11-26T21:30+05:30`)

### 6.1 Exact Staging Redeployment Confirmation (`dpl_DQfsibzBRcu5riKJdhAnjn3kdfhh`)
- Even though local Vercel CLI exited with an authorization notice after triggering redeploy, direct Vercel API and live runtime inspection confirm:
  - **Deployment ID:** `dpl_DQfsibzBRcu5riKJdhAnjn3kdfhh` (`readyState: "READY"`, `target: "preview"`, `gitSource.ref: "staging"`, `gitSource.sha: "0abbda139f47e57e2edc5dfab9ea0555bf3c5e83"`, `projectId: "prj_FZLU4vBIYSsBn28AI6drkpD5WfbH"`, `ownerId: "team_0IZkX9o2Ab319UsAPW9oq1SL"`).
  - **Canonical Host Aliasing:** `https://staging.virexaaiventures.com` points to `dpl_DQfsibzBRcu5riKJdhAnjn3kdfhh` (`https://aira-ai-2026-3aakrzaid-rajpunkeshwarrajgautam-boops-projects.vercel.app`), `/api/version` confirms `commitSha: "0abbda139f47e57e2edc5dfab9ea0555bf3c5e83"` & `environment: "staging"`, `/api/health` confirms `HEALTHY` / `READY` / `database: REACHABLE`, and `/api/billing/plans` confirms `billingStatus: "sandbox_rehearsal"` & `checkoutAvailable: true`.

### 6.2 Cashfree Pro Acceptance Verification (`pur_b19205cdaa624b82ac99d4cc1150c484`)
Read-only inspection of Staging Neon (`mute-frost-50372225` / `br-snowy-bonus-b32thjlz`) established:
- **Customer & Subscription Ownership:** `neon_user_e215766f-e719-431f-ad08-154a28ef83b4` (`rajpunkeshwarrajgautam@gmail.com`) → `cust_dbfaef1d12024ea99ee860ee4bfc5b77`. **Exactly 1 subscription row** exists (`pur_b19205cdaa624b82ac99d4cc1150c484`, `plan_id: "pro"`, `price_id: "price_pro_inr"`, `status: "active"`, `currency: "INR"`, `amount_minor_units: 99900`, `cancel_at_period_end: false`).
- **Provider Identifiers & Initial Payment Evidence:**
  - `cf_subscription_id`: `1479507678932858880` (`plan_cf_pro_inr_monthly`, `providerApiVersion: "2025-01-01"`).
  - `cf_payment_id`: `1479507718292207616`; `payment_id`: `11363169_972_1795708527957`; `cf_txn_id`: `1479507718687530496`; `cf_order_id`: `1479507718423289344`; `payment_type: "AUTH"`; `payment_amount: 999` (`INR`, `SUCCESS`, `payment_group: "upi"` collect); `authorization_amount: 999`; `authorization_status: "ACTIVE"`; `authorization_amount_refund: false`; `immediateAuthPaid: true`.
- **Signed Webhooks (`payment_gateway_events`):**
  1. `pge_9ea1c467ca5a4a8b80951da5ff88965a` — `SUBSCRIPTION_STATUS_CHANGED` (`signature_valid: true`, `processed: true`, `error: null`, received `1795708536213` = `21:25:36.213+05:30`, processedAt `1795708539671`, audit `bae_8dd4f6cf5f0f48e195adeea31deef32f` at `1795708538526`).
  2. `pge_e72f9639354d419db4915b41ee1488ba` — `SUBSCRIPTION_PAYMENT_SUCCESS` (`signature_valid: true`, `processed: true`, `error: null`, received `1795708536220` = `21:25:36.220+05:30`, processedAt `1795708548677`, audit `bae_6755574ec63d44d59e939aa19c6f15c2` at `1795708538527`).
  3. Concurrent auto-reconcile event `bae_12018696b8484c78af7c48f34be1cc19` (`1795708549024`) caused zero duplicate fulfillment, grants, or invoices.
- **Activation Latency:**
  - Checkout created `21:25:16.172+05:30` → Activated `21:25:38.527+05:30` (**`2,307 ms` / ~2.31s** from `SUBSCRIPTION_PAYMENT_SUCCESS` webhook receipt; **`6,441 ms` / ~6.44s** to credit grant commit `21:25:42.661+05:30`; **`22.36s`** end-to-end from checkout initiation including user UPI sandbox approval).
- **Credit Account & Ledger (`credit_accounts`, `credit_grants`, `credit_transactions`):**
  - Wallet `cacc_138f5f0e0196423c84e60cf1a0d7ef28`: `balance_credits: 7600`, `reserved_credits: 0`, `lifetime_granted_credits: 7600`, `lifetime_spent_credits: 0`.
  - **Exactly 1** `+7,500` monthly grant: `grant_97db8211226142ad9ceb5e35bccfa0d3` (`subscription_monthly`, `rollover_capped: true`, `expires_at: 1798300516172` = `2026-12-26T21:25:16.172+05:30`, idempotency key `grant_cashfree:sub:pur_b19205cdaa624b82ac99d4cc1150c484:pay:1479507718292207616`), on top of `grant_4ded29331b8e4031b2ed9159766bad72` (`100`).
  - Transaction `ctx_64152f1a3c434e4d913f2cf8d14fe94f`: `GRANT`, `+7500`, `balance_before: 100`, `balance_after: 7600`.
- **Entitlements & Renewal Schedule:**
  - Code-verified `pro` contract (`packages/contracts/src/commercial.ts:193-237`): `150` daily chats, `200` monthly reasoning boosts, `unlimited` projects (`-1`), `7,500` monthly premium credits.
  - Provider renewal: `subscription_first_charge_time: "2026-12-26T00:00:00"`, `next_schedule_date: "2026-12-26T00:10:00"`; `current_period_end: 1798300516172` (`2026-12-26T21:25:16.172+05:30`).
- **Invoice `INV-2026-0003` (`billing_invoices` row `inv_97e220f0af394277998de6b9dcb15b88`):**
  - **Exactly 1** paid invoice issued for `pur_b19205cdaa624b82ac99d4cc1150c484` / `cust_dbfaef1d12024ea99ee860ee4bfc5b77`, `billing_event_id: "1479507718292207616"`, `plan_tier: "pro"`, `currency: "INR"`, `total_amount: 999.00`, `taxable_base: 846.61`, `gst_amount: 152.39`, `igst_amount: 152.39`, `sac_code: "998431"`, `taxRate: 0.18`, `status: "Paid"` (arithmetic exact: `846.61 + 152.39 = 999.00`), `tax_compliance_status: "SANDBOX_REHEARSAL"`. Download result remains **`PENDING_OPERATOR_DOWNLOAD`** until operator download evidence is supplied.

### 6.3 Preserved Cashfree Plus & Test 2 Readiness Check
- **Cashfree Plus Preserved:** `pur_411d4e047dd041dc8e7a61f705c3ce27` (`active`, `plus`), `balance_credits: 3100`, `INV-2026-0002` (`399.00`, `Paid`) confirmed completely intact.
- **Test 2 (`Razorpay Plus`) Readiness:** `virexaiventures@gmail.com` (`usr_29d7e8a9-f8bd-4685-ac58-97e585efa2b0`, Google OAuth `oa_f2e45ee0-7e7e-42c3-9999-dda77d338ee5`, `email_verified: true`) maps to `cust_546b027724104cd094ee756b72d6051c`, wallet `cacc_237c16a11b264b64a4395529fd7ba9c4` (`100` credits, `0` spent), **0 subscriptions**, **0 invoices**, and `0` active BFF sessions. **PAUSED** until the paid cancellation period-end retention fix is certified on staging.

---

## 7. Paid Subscription Cancellation & Credit Lifecycle Remediation (`2026-11-26T22:07+05:30`)

### 7.1 Observed Staging Defect & Verified Root Cause
- **Trigger:** Operator cancelled Cashfree Pro subscription `pur_b19205cdaa624b82ac99d4cc1150c484` (`cf_subscription_id: 1479507678932858880`, payment `1479507718292207616`, `INV-2026-0003` ₹999 Paid). Account immediately downgraded to `AIRA Free` (`15` chats/day, `5` boosts, `3` projects) and hid `Active Subscription Management`, despite zero refunds, valid paid period until `2026-12-26T21:25:16.172+05:30`, and `7,600` unspent credits.
- **Root Cause:**
  1. Cashfree `POST /pg/subscriptions/{id}/manage { action: 'CANCEL' }` immediately cancelled the provider mandate and delivered signed webhook `pge_ac086e88315b4d028933a83f5f736f69` (`SUBSCRIPTION_STATUS_CHANGED` `CANCELLED`).
  2. `PaymentGatewayService.handleSubscriptionCancelled` updated `status: 'cancelled'` and unconditionally overwrote `cancel_at_period_end: false`.
  3. `CommercialBillingService.getActiveSubscription`, `getBillingPeriodStartDate`, `reserveStandardChat`, `tryConsumeReasoningBoost`, `resolveCallerTier`, and `PaymentGatewayService.getCustomerBillingLifecycleState` filtered strictly on `status IN ('active', 'authenticated')`, ignoring paid un-refunded period-end access until `current_period_end`.
  4. `SettingsModal.tsx` and `PricingModal.tsx` hid subscription management whenever `activePlanId === 'free'` or `summary` lacked period-end cancellation metadata.
  5. `CommercialBillingService` lacked transactional credit-grant expiration sweeps (`expires_at <= now`) and FIFO grant consumption across `credit_grants`.

### 7.2 Preserved Database Records & Implemented Fix
- **Database Integrity Preserved:** Zero SQL overrides were applied to Staging Neon (`pur_411d4e047dd041dc8e7a61f705c3ce27` and `pur_b19205cdaa624b82ac99d4cc1150c484` financial records untouched; `INV-2026-0002` and `INV-2026-0003` preserved).
- **Remediation Summary (Cashfree & Razorpay Unified):**
  - Separated provider recurring mandate state (`status: 'cancelled'` blocking any future charges) from already-paid entitlement retention (`hasPaidPeriodEntitlement`, retaining Pro/Plus entitlements until `current_period_end` unless refunded or unpaid). Once deployed to staging, `pur_b19205cdaa624b82ac99d4cc1150c484` automatically resumes Pro entitlements until `2026-12-26` with automatic renewal cancelled and zero manual SQL edits.
  - Enforced atomic `expireStaleCreditGrants` & FIFO `credit_grants` settlement without disturbing held reservations (`reserved_credits`) or unrelated welcome/top-up credits, plus proportional partial-refund credit adjustment.
  - Blocked late recurring charges across all webhook paths (`subscription.charged`, `invoice.paid`, `payment.captured`, `order.paid`) once cancellation is requested/confirmed, and prevented duplicate same-tier checkout during an active/cancelled paid period (while permitting tier upgrades such as Plus → Pro).
  - Updated `SettingsModal.tsx` and `PricingModal.tsx` to display all 6 lifecycle states cleanly (`Active and renewing`, `Active with renewal cancelled`, `Expired`, `Payment pending`, `Refunded`, `Cancellation pending or failed`), including `"AIRA Pro — Active until <date>"`, `"Automatic renewal: Cancelled"`, and `"No further recurring payments will be charged for this subscription"`.
- **Verification:** `17`-scenario PG18 regression suite (`test/subscription-cancellation-lifecycle.test.ts`), `146/146` billing/recurring/invoice PG18 & webhook assertions, `53/53` `test:remediations` assertions, `41/41` `test:db-isolation` checks, `test:secrets`, `db:verify:deploy`, `oxlint`, `tsc`, and `vite build` passed.
- **Staging Deployment & Certification (`2026-11-26T22:31+05:30`):**
  - **PR Merged:** `#217` → `staging` at commit `6c90c12930a23018ff02435a7832ca5bd0578b26`.
  - **CI & Pipeline Runs:** `Permanent Staging Pipeline` (`45862199434`) & `CI` (`45862199788`: `Fast CI`, `Semantic Search CI`, `Payment durability`, `Main / PR certification`, `Deployed staging acceptance`) all passed.
  - **Live Runtime Verified:** `https://staging.virexaaiventures.com/api/version` confirms `commitSha: "6c90c12930a23018ff02435a7832ca5bd0578b26"` (`https://aira-ai-2026-pxnsewyrp-rajpunkeshwarrajgautam-boops-projects.vercel.app`), `/api/health` = `HEALTHY`/`READY`/`database: REACHABLE`, `/api/billing/plans` = `billingStatus: "sandbox_rehearsal"`, `checkoutAvailable: true`.
  - **Customer Recovery Result for `pur_b19205cdaa624b82ac99d4cc1150c484`:** Without any SQL mutation, signing into `rajpunkeshwarrajgautam@gmail.com` on `https://staging.virexaaiventures.com` now automatically resolves **AIRA Pro — Active until 26 Dec 2026**, **Automatic renewal: Cancelled**, `7,600` spendable credits (subsequently updated to `7,500` after welcome credit expiry sweep; see Section 8.2), `150` daily chats, `200` boosts, unlimited projects, and `INV-2026-0003`.

---

## 8. Razorpay Plus Acceptance, Credit Expiry Audit & Final Test Readiness (`2026-11-26T23:07+05:30`)

### 8.1 Verified Backend Evidence — Razorpay Plus (`pur_ad3ac94100294b6192c41e10cb29fa9b`)

Read-only inspection of Staging Neon (`mute-frost-50372225` / `br-snowy-bonus-b32thjlz`) on certified staging SHA `6c90c12930a23018ff02435a7832ca5bd0578b26` established:

- **Customer & Subscription Ownership:**
  - Customer: `usr_29d7e8a9-f8bd-4685-ac58-97e585efa2b0` (`virexaiventures@gmail.com`, Google OAuth, `email_verified: true`) → `cust_546b027724104cd094ee756b72d6051c` (`IN` / `INR`).
  - Exactly `1` subscription row: `pur_ad3ac94100294b6192c41e10cb29fa9b` (`plan_id: "plus"`, `price_id: "price_plus_inr"`, `status: "active"`, `cancel_at_period_end: false`, `gateway: "razorpay"`, `fulfilledCycle: 1`).
  - Razorpay `notes` bind `principal_id: usr_29d7e8a9-f8bd-4685-ac58-97e585efa2b0`, `customer_id: cust_546b027724104cd094ee756b72d6051c`, `purchase_id: pur_ad3ac94100294b6192c41e10cb29fa9b`. *(Note: Operator-entered Razorpay test checkout contact inside the provider payload shows `rajpunkeshwarrajgautam@gmail.com` / `+918810777573`; AIRA entitlement & invoice ownership remain strictly isolated to `virexaiventures@gmail.com`.)*
- **Provider Subscription & Payment Identifiers:**
  - `gateway_subscription_id`: `sub_U4st6RSpGba6c3` (`plan_id: "plan_U4st65LCV0tiDv"`, `checkoutUrl: "https://rzp.io/rzp/94PMcrf"`).
  - `initialPaymentId` / `lastPaymentId`: `pay_U4stOZvo0wNj9t` (`status: "captured"`, `amount: 39900` minor / `₹399.00 INR`, `method: "upi"`, `vpa: "testuser@razorpay"`, `order_id: "order_U4st7C5iMqBbDl"`, `invoice_id: "inv_U4st75HAxlbR8H"`, `token_id: "token_U4stPQtVvtwti2"`).
- **Signed Webhook Processing (`payment_gateway_events`):**
  - `5` signed webhooks received and verified for `sub_U4st6RSpGba6c3` / `pay_U4stOZvo0wNj9t` (all `signature_valid: true`, `processed: true`, `error: null`):
    1. `pge_39817a045a234424b2a870a2df8f193f` (`invoice.paid`, received `1795713675758`, processed `1795713687942`) — primary activation `bae_3d7ede0aa8924f678c3feb871e6e7188` (`SUBSCRIPTION_ACTIVATED`) and tax invoice `INV-2026-0004` (`bae_fb42f5aca0e9407d93587957a8f64ea5`).
    2. `pge_9c85925b1aa8409eb9083a8ce7c9b337` (`payment.captured`, received `1795713674999`, processed `1795713689216`).
    3. `pge_732a695d1cf141a992c9fbabb47ccbc9` (`order.paid`, received `1795713675387`, processed `1795713690550`).
    4. `pge_1d41f07ac31e445396fbd947830b7fe4` (`subscription.activated`, received `1795713680011`, processed `1795713691878`, idempotent `bae_a06edc7b98324c45bac551d81caedc87`).
    5. `pge_0482ab74c637431290fe5de741392fe3` (`subscription.charged`, received `1795713681360`, processed `1795713693198`, idempotent `bae_9278cd7af30d42cc8890bbcab2ab6581`).
  - Companion payment/order acknowledgments caused zero duplicate activations, grants, or invoices.
- **Activation Latency:**
  - Checkout created: `1795713649275` (`2026-11-26T22:50:49.275+05:30`) → Activated: `1795713677654` (`2026-11-26T22:51:17.654+05:30`).
  - End-to-end including user UPI flow: `28,379 ms` (`28.38s`); webhook receipt (`1795713675758`) to activation commit: **`1,896 ms` (~1.90s)**; activation to credit grant commit (`1795713681773`): **`4,119 ms` (~4.12s)** (`6,015 ms` from `invoice.paid` receipt to credit grant).
- **Credit Grant, Wallet Accounting & Entitlements:**
  - Wallet `cacc_237c16a11b264b64a4395529fd7ba9c4`: `balance_credits: 3000`, `reserved_credits: 0`, `lifetime_granted_credits: 3100`, `lifetime_spent_credits: 0`.
  - Exactly `1` `+3,000` grant `grant_b063f75c1f2c4950bc38d52f7c3d8460` (`idempotencyKey: "grant_razorpay:sub:pur_ad3ac94100294b6192c41e10cb29fa9b:pay:pay_U4stOZvo0wNj9t"`, `expires_at: 1798305649275` = `2026-12-26T22:50:49.275+05:30`), txn `ctx_f38f01937b65449598d04971ee9b551a` (`GRANT`, `+3000`, `balance_before: 0`, `balance_after: 3000`).
  - `entitlement_snapshots` row `snap_45aa510a812c48ceb3bf04e192fc4d16` (`2026-11-26`): `daily_standard_chat_count: 1` (aligns with operator screenshot `49/50`, `50/50` boosts, `10` projects).
- **Invoice `INV-2026-0004` (`inv_cf89fca2f73943a3a521958e2a939720`) & Renewal Schedule:**
  - `billing_event_id: "pay_U4stOZvo0wNj9t"`, `plan_tier: "plus"`, `currency: "INR"`, `total_amount: "399.00"`, `taxable_base: "338.14"`, `gst_amount: "60.86"`, `igst_amount: "60.86"`, `sac_code: "998431"`, `status: "Paid"`, `tax_compliance_status: "SANDBOX_REHEARSAL"`. Download status: **`PENDING_OPERATOR_DOWNLOAD`**.
  - Period: `1795713677654` to `1798305649275` (`2026-12-26T22:50:49.275+05:30`); Razorpay `charge_at: 1798223400` (`2026-12-26T00:00:00+05:30`), `total_count: 12`, `remaining_count: 11`, `paid_count: 1`.

### 8.2 Credit Balance Expiry Investigation (`7,600 -> 7,500` & `3,100 -> 3,000` — No Accounting Defect)

Both `100`-credit reductions are **legitimate 30-day Free welcome-grant expirations** enforced by PR `#217` (`expireStaleCreditGrants` + `expires_at: now + 30d` in `commercial-billing-service.ts`), **not** a bug or double deduction:

- **Cashfree Pro (`cust_dbfaef1d12024ea99ee860ee4bfc5b77`, `7,600 -> 7,500`):** Welcome grant `grant_4ded29331b8e4031b2ed9159766bad72` (`100` credits, created `2026-10-20` / `1792519447800`) expired on **`2026-11-19T22:14:07.800+05:30`** (`1795111447800`). When the operator refreshed Settings after PR `#217` deployed (`2026-11-26T22:41:06.788+05:30` / `1795713066788`), `expireStaleCreditGrants` atomically recorded `ctx_7cfeef37452048febf7c7c7399aa02b7` (`EXPIRE`, `-100`, `7600 -> 7500`). Unexpired Pro grant `grant_97db8211226142ad9ceb5e35bccfa0d3` (`7,500`, expires `2026-12-26`) remains completely intact.
- **Razorpay Plus (`cust_546b027724104cd094ee756b72d6051c`, `3,100` expected `-> 3,000`):** Welcome grant `grant_55807196c55648879c2de1859814f579` (`100` credits, created `2026-10-23` / `1792761638753`) expired on **`2026-11-22T17:30:38.753+05:30`** (`1795353638753`). At `2026-11-26T22:49:52.230+05:30` (`1795713592230`, 57s before checkout), `expireStaleCreditGrants` recorded `ctx_cd588bab850a413badec2a5353913287` (`EXPIRE`, `-100`, `100 -> 0`); checkout then granted `+3,000` (`0 -> 3,000`).
- **Cashfree Plus (`cust_2a79b54106e04c9ab491e5be3aed6b97`, still `3,100`):** Welcome grant `grant_09c5538ca4004390bbc8ec8085f9630f` (`100` credits, created `2026-10-20` / `1792513278107`) also expired on `2026-11-19` (`1795105278107`), but no post-PR `#217` lazy sweep has run for that account yet (`3,000` Plus grant valid until `2026-12-26`).
- Zero usage deductions, zero held reservations (`reserved_credits: 0`), and zero double-deductions occurred on Staging Neon. *(Non-blocking deferred code-audit observations noted without interrupting release: `Free` welcome grants currently tag `grant_type: 'subscription_monthly'` rather than `'promotional'`, and if a credit reservation were ever `HELD` across exact grant expiry and later settled against another grant, `settleReservation` filters `expires_at > now` so the prior expired grant could stay unzeroed until its expiry sweep.)*

### 8.3 Preserved Cancellation PASS & Outstanding Manual Confirmations

- **Cashfree Pro Cancellation Retention (`MANUAL_PASS`):** Operator staging verification confirmed `AIRA Pro — Active until 26 December 2026`, `Automatic renewal: Cancelled`, full Pro limits retained, and `7,500` spendable credits after legitimate `-100` welcome expiry.
- **Pending Operator Invoice Downloads:** `INV-2026-0003` (Cashfree Pro ₹999) and `INV-2026-0004` (Razorpay Plus ₹399) remain `PENDING_OPERATOR_DOWNLOAD`.
- **Test 4 (`Razorpay Pro ₹999`) Verified Account Readiness (`2026-11-26T23:39+05:30`):** Owner confirmed control of `kpveovfji@a.1charlottewalker.asia` (`usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c`), verified read-only on Staging Neon (`cust_d6c10d8b7bc343bc9c648cb372403baa`, Google OAuth `oa_e1073d49-17f1-4508-a29a-3447a2e5a1e6`, active session `sNhxQ4oahXR_sE4YAQTHbdETxR17gBEcV4gtIlCedeo`, `0` subscriptions, `0` invoices, `0` audit events, and `0` credits after `ctx_3298e26fa2a54d71b6ddfe715ce590f0` expired the `100`-credit welcome grant `grant_beb0c1525f85490c92976839d72f2981` from `2026-10-23`). Next allocated invoice number verified from `billing_invoice_number_seq` (`last_value: 4`, `is_called: true`) is **`INV-2026-0005`**, and expected post-activation wallet balance is **`7,500`**. Draft PR `#215` remains on **STRICT HOLD**.

### 8.4 Updated Enrollment Wizard & Preserved Targeted Final-Release Checks (`2026-11-26T23:39+05:30`)

- **Enrollment Wizard Reused & Updated (`enroll-staging-principals-wizard.ps1`):**
  - Updated baseline target strictly to `6c90c12930a23018ff02435a7832ca5bd0578b26` and `dpl_8JqL4dTSzgafu3BdWqUvCdZtYZED` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` / `team_0IZkX9o2Ab319UsAPW9oq1SL`, Preview `staging` only), and removed the prior block on `usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c` only after owner confirmation + read-only Neon verification succeeded.
  - Enforces automatic preservation of all `6` existing principals (`neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`, `neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7`, `neon_user_96134b8f-a5af-420c-bc38-09ad11c69568`, `neon_user_3b0d4f63-89c4-458a-b341-ebc93258f907`, `neon_user_e215766f-e719-431f-ad08-154a28ef83b4`, `usr_29d7e8a9-f8bd-4685-ac58-97e585efa2b0`), appends only `usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c` (`7th` principal) upon interactive owner approval, checks Production isolation + TEST gateway vars + Neon preservation, and recovers cleanly via `/v6/deployments` if Vercel CLI exits non-zero after creating a deployment ID.
  - Verified **`13/13` tests PASS** in PowerShell `5.1.26100.9818` (`enroll-staging-principals-wizard.Tests.ps1`, non-mutating).
- **Preserved Targeted Final-Release Checks (Before Production Promotion):**
  1. Credit reservations `HELD` across grant expiry (`settleReservation` vs expired grant cleanup in `apps/api/src/billing/commercial-billing-service.ts`).
  2. Free welcome grant `grant_type` classification (`'subscription_monthly'` at `commercial-billing-service.ts:135` vs `'promotional'`) and applicable refund handling.
  3. Durable recovery or refund processing for genuinely captured late payments arriving after subscription cancellation.
  4. Previously reported entitlement regression checks across plan tiers and cancellation states.
  5. Actual recurring Cycle 2+ renewal verification.
  6. Clean integration of PR `#217` (`6c90c12930a23018ff02435a7832ca5bd0578b26`) into the production release candidate PR `#215` (currently `fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` — **DRAFT / STRICT HOLD**).

---

## 9. Final Razorpay Pro Acceptance (`pur_9dff97f99a434153bdf698c7c548b2cc`) & Sandbox Closure (`2026-11-27T00:01+05:30`)

### 9.1 Verified Backend Financial Evidence — Razorpay Pro (`₹999`)

Read-only inspection of Staging Neon (`mute-frost-50372225` / `br-snowy-bonus-b32thjlz`) on live deployment `dpl_GsipaYiU2bEZe6DhQXBJVUAY9dum` (`6c90c12930a23018ff02435a7832ca5bd0578b26`) confirmed:

- **Subscription Ownership:**
  - Customer: `usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c` (`kpveovfji@a.1charlottewalker.asia`, Google OAuth verified) → `cust_d6c10d8b7bc343bc9c648cb372403baa` (`IN` / `INR`).
  - Exactly `1` subscription row: `pur_9dff97f99a434153bdf698c7c548b2cc` (`plan_id: "pro"`, `price_id: "price_pro_inr"`, `status: "active"`, `cancel_at_period_end: false`, `gateway: "razorpay"`, `fulfilledCycle: 1`).
  - Provider `notes` bind `principal_id: usr_af4d0ca7-915c-4bd3-a086-03bebde5dd2c`, `customer_id: cust_d6c10d8b7bc343bc9c648cb372403baa`, `purchase_id: pur_9dff97f99a434153bdf698c7c548b2cc`. *(Provider test checkout contact contains operator entry `rajpunkeshwarrajgautam@gmail.com` / `+918810777573`; AIRA entitlement & invoice ownership remain strictly isolated to `kpveovfji@a.1charlottewalker.asia`.)*
- **Authoritative Captured Payment & Provider Subscription:**
  - `gateway_subscription_id`: `sub_U4twkqY56bWzRs` (`plan_U4twkSwfDBoCiR`, `checkoutUrl: "https://rzp.io/rzp/vaEuXlB3"`).
  - `initialPaymentId` / `lastPaymentId`: `pay_U4twwS5Qgtwwjx` (`status: "captured"`, `captured: true`, `amount: 99900` minor / `₹999.00 INR`, `method: "upi"`, `upi.flow: "intent"`, `vpa: "testuser@razorpay"`, `order_id: "order_U4twlZk8AOpCre"`, `invoice_id: "inv_U4twlTgY0VY0oq"`, `token_id: "token_U4twxIaDe1OXyb"`, `rrn: "001000100002"`, `upi_transaction_id: "npci_txn_id_for_U4twwS5Qgtwwjx"`, `amount_refunded: 0`).
- **Signed Webhooks (`payment_gateway_events`):**
  - `5` signed events verified (`signature_valid: true`, `processed: true`, `error: null`):
    1. `pge_e61d84d80eee452791d30ef93022a413` (`payment.captured`, received `1795717397232`, processed `1795717411406`) → idempotent `bae_b080bb16ff9048b0a9449a79f11867ac`.
    2. `pge_c5711f68aaf746a8b287ee68b4136f60` (`invoice.paid`, received `1795717397645`, processed `1795717410083`) → primary activation `bae_996dd79efe544da0911c04916ac797e2` (`SUBSCRIPTION_ACTIVATED`) and invoice `bae_6467ae5918a449d99b9f8d1a1fa6bb33` (`TAX_INVOICE_ISSUED` **`INV-2026-0005`**).
    3. `pge_51dd16bc10bf4d0a965342c52373af5b` (`order.paid`, received `1795717397841`, processed `1795717412706`) → idempotent `bae_35c4d2e4281a4d8b94115eb6a15e48d8`.
    4. `pge_7fe7eb32f16b42ad9830998b63d3ae61` (`subscription.activated`, received `1795717402240`, processed `1795717414024`) → idempotent `bae_9a5cb5e59c2c48438221d6bdf5e151be`.
    5. `pge_3d7dc53d396c48a6a5cafffcf97bcd07` (`subscription.charged`, received `1795717402550`, processed `1795717415354`) → idempotent `bae_09761c0161ac41169633fda196c003af`.
- **Activation Latency:**
  - Checkout created `1795717378683` (`2026-11-26T23:52:58.683+05:30`) → `invoice.paid` receipt `1795717397645` → `SUBSCRIPTION_ACTIVATED` + `INV-2026-0005` commit `1795717399806` (**`2,161 ms` / ~2.16s** from `invoice.paid` receipt) → `+7,500` credit grant commit `1795717403975` (**`4,169 ms` / ~4.17s** post-activation; **`6,330 ms`** from `invoice.paid` receipt; **`21,123 ms` / ~21.12s** end-to-end including UPI flow).
- **Credit Allocation & Wallet Integrity:**
  - `cacc_01b9d8882b53437e95b0a718c9ceb3e4`: `balance_credits: 7500`, `reserved_credits: 0`, `lifetime_granted_credits: 7600`, `lifetime_spent_credits: 0`.
  - Exactly `1` `+7,500` grant `grant_46d4f6123c5247139d35d04332173999` (`idempotencyKey: "grant_razorpay:sub:pur_9dff97f99a434153bdf698c7c548b2cc:pay:pay_U4twwS5Qgtwwjx"`, `expires_at: 1798309378683` = `2026-12-26T23:52:58.683+05:30`), txn `ctx_83d20e3c216441a188f8401c8ac7430d` (`GRANT`, `+7500`, `balance_before: 0`, `balance_after: 7500`). Zero usage events or reservations.
- **Invoice, Cycle Count, Schedule & Duplicate Prevention:**
  - Invoice **`INV-2026-0005`** (`inv_6b04356ed3944b718df2132c9c21bb82`): `billing_event_id: "pay_U4twwS5Qgtwwjx"`, `plan_tier: "pro"`, `currency: "INR"`, `total_amount: "999.00"`, `taxable_base: "846.61"`, `gst_amount: "152.39"`, `igst_amount: "152.39"`, `sac_code: "998431"`, `status: "Paid"`, `tax_compliance_status: "SANDBOX_REHEARSAL"`. Download confirmed **PASS**. `billing_invoice_number_seq` `last_value = 5, is_called = true`.
  - Renewal & Cycle Count: `current_period_end: 1798309378683` (`2026-12-26T23:52:58.683+05:30`); Razorpay `sub_U4twkqY56bWzRs` `status: "active"`, `charge_at: 1798223400` (`2026-12-26T00:00:00+05:30`), **`total_count: 12`**, **`paid_count: 1`**, **`remaining_count: 11`**.
  - Zero duplicate subscriptions (`1`), zero duplicate invoices (`1`), zero duplicate grants.

### 9.2 Phase Closure & Next Phase Summary (GST Statutory Invoice Configuration)

- **4-Combination Sandbox Purchase Phase Status:** All `4` combinations have passed end-to-end backend financial & webhook acceptance on staging (`INV-2026-0002` & `INV-2026-0005` downloads `PASS`; `INV-2026-0003` & `INV-2026-0004` downloads remain `PENDING_OPERATOR_DOWNLOAD`). Zero code defects identified in payment fulfillment; Draft PR `#215` remains on **STRICT HOLD** pending the Section 8.4 release checks and the Production GST Invoice configuration requirements in Section 4 (`billing-routes.ts:368-412` & `billing_invoices`).
