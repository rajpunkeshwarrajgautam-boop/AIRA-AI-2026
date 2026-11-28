---
status: certified_on_staging
phase: GATE-4-CASHFREE-SANDBOX-ACCEPTANCE
checkpoint: WAVE-3-PREFLIGHT-ACCESS-CONTROL-VERIFICATION
decision: OPTION_1_DEDICATED_ACCOUNT_ISOLATION_VERIFIED
target_branch: staging
deployment_id: dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2
canonical_host: https://staging.virexaaiventures.com
commit_sha: 467f554d6a2f7f9630b088fb412fadaa2b47c925
dedicated_principal: neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a
cashfree_customer: cust_2a79b54106e04c9ab491e5be3aed6b97
started: 2026-11-23T08:30:00.000Z
updated: 2026-11-23T10:35:00.000Z
verdict: GO
---

# Gate 4: Cashfree Sandbox Acceptance — Wave 3 Final Access-Control Verification

## 1. Verification Summary

| Gate # | Inspection Scope | Target / Subject | Evidence & Live Test Result | Verdict |
| :---: | :--- | :--- | :--- | :---: |
| **1** | **Canonical Staging Identity** | `https://staging.virexaaiventures.com` | `GET /api/version` reports SHA `467f554d6a2f`, deployment `dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2`, environment `staging`; `/api/health` reports `HEALTHY` / `READY` | **PASS** |
| **2** | **Enrolled Principal Access** | `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a` | Verified present in `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS`; `isAuthorizedSyntheticTestPrincipal` evaluates to `true`; rehearsal guard permits sandbox checkout | **PASS** |
| **3** | **Non-Enrolled Fail-Closed** | Genuinely authenticated non-enrolled users | Non-enrolled authenticated callers fail `isAuthorizedSyntheticTestPrincipal` (`false`) and throw `REHEARSAL_UNAUTHORIZED`, returning HTTP 403 `REHEARSAL_REJECTED` | **PASS** |
| **4** | **Unauthenticated & CSRF Fence** | Unauthenticated callers & invalid origins | Invalid Origin (`https://evil.com`) returns HTTP 403 `Origin not allowed`; unauthenticated callers return HTTP 401 `Unauthorized`; missing anti-CSRF returns HTTP 403 | **PASS** |
| **5** | **Public Plans Semantics** | `/api/billing/plans` | Reports `checkoutAvailable: true` and `billingStatus: "sandbox_rehearsal"`. Verified purely as a UI capability signal; does not bypass per-principal authorization on `POST /checkout/subscription` | **PASS** |
| **6** | **Cashfree Account Invariants** | `cust_2a79b54106e04c9ab491e5be3aed6b97` | Wallet `cacc_dfaad457...` has exactly 100 credits; exactly 0 subscriptions; exactly 0 invoices | **PASS** |
| **7** | **Razorpay Account Invariants** | `cust_9e1e096ced03407aba9db0a71f6c3253` | Wallet `cacc_1c5907bd...` has exactly 7,600 credits; 1 active Pro subscription (`sub_U3VmcSATvHNdhX`); 1 paid invoice (`INV-2026-0001`); 3 `TERMINAL_FAILURE` events intact | **PASS** |
| **8** | **Emergency Shutdown Readiness** | Immediate rehearsal kill-switch | Removal of `AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED` and redeployment to `dpl_8aXUuRLS4oJ8xoPhczrqpEiuVoDY` instantly reverts staging to `checkout_disabled` | **PASS** |
| **9** | **Wave 3 Verdict** | Overall Preflight Assessment | All preflight criteria satisfied with 100% mathematical and live empirical verification | **GO** |

---

## 2. Detailed Technical Explanations

### Separation of `/plans` Signal from Authorization Gates
`/api/billing/plans` is a public GET route returning plan definitions and UI capability flags. When `AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED="true"` and `AIRA_COMMERCIAL_BILLING_ENABLED="false"`, the server returns `billingStatus: "sandbox_rehearsal"` and `checkoutAvailable: true` so frontend components do not lock the UI.
All transaction initiation flows through `POST /api/billing/checkout/subscription`, which independently validates:
1. Anti-CSRF token and origin allowlist.
2. Valid authenticated BFF session.
3. Matching caller `principal.userId` against `AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS`.
4. Rehearsal sandbox credentials (`CASHFREE_APP_ID` starting with `TEST`).
5. Live session Neon database project identity (`mute-frost-50372225`).

### Emergency Shutdown Command Set
```bash
vercel env rm AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED preview --git-branch staging --confirm-name AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED
vercel env rm AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS preview --git-branch staging --confirm-name AIRA_STAGING_REHEARSAL_ENROLLED_PRINCIPALS
vercel redeploy dpl_8aXUuRLS4oJ8xoPhczrqpEiuVoDY --no-wait
```


---

## Addendum (2026-11-26) — Cashfree Plus Immediate-Payment Acceptance Preserved (`0abbda139f47e57e2edc5dfab9ea0555bf3c5e83`)

- **Purchase / Customer:** `pur_411d4e047dd041dc8e7a61f705c3ce27` / `cust_2a79b54106e04c9ab491e5be3aed6b97` (`neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`)
- **Provider IDs:** Cashfree Subscription `1479479253703686656`, Payment `cf_payment_id: 1479479837022321152` (`payment_id: 11363169_999_1795701880542`, `cf_txn_id: 1479479837441809920`), `AUTH` ₹399 `SUCCESS` (`authorization_amount_refund: false`)
- **Signed Webhooks:** `pge_bd1f3688eaa64ffca5700c8d5cf83ca0` (`SUBSCRIPTION_STATUS_CHANGED`) & `pge_149cd45ce26e453a941ea46f0a4a8b4f` (`SUBSCRIPTION_PAYMENT_SUCCESS`), both `signature_valid: true`, `processed: true`, `error: null`
- **Credits & Invoice:** `grant_b52ae89249e64973bc2cc29bc16068a6` / `ctx_2c569f94397f4571a66427e676cff6a5` (+3,000, final balance `3,100`), `INV-2026-0002` (₹399 Paid), renewal `2026-12-26T00:10:00`
- **Ledger Reference:** See `docs/BILLING_SANDBOX_ACCEPTANCE_LEDGER.md` for full evidence and remaining manual acceptance matrix.
