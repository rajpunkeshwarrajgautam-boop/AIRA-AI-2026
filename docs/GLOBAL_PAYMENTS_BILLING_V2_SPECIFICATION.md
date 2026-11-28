# AIRA AI 2026 — Global Payments & Billing Experience V2 Specification

**Document ID:** `SPEC-GLOBAL-BILLING-V2-2026-01`  
**Revision:** `1.0 (DESIGN & EXECUTION BASELINE)`  
**Status:** `APPROVED FOR ISOLATED V2 IMPLEMENTATION & DRAFT PR CERTIFICATION (STAGING RUNTIME & PROD STRICT HOLD UNTOUCHED)`  
**Date:** `2026-11-28`  
**Methodology:** `/agency-agents-orchestrator` + `/gsd-graphify` + `/agency-knowledge-graph-engineer` + `/to-spec` + `/implement-spec` + `/tdd` + `/agency-reality-checker` + `/verification-before-completion`

---

## 0. Verified Baseline, Open Staging Audits & Provenance Matrix

### 0.1 Verified Runtime, Git & Database Baseline (2026-11-28)
Read-only verification executed against live staging, GitHub, Vercel, and Neon PostgreSQL before starting V2:

| Reference | Observed State (`2026-11-28`) | Verification Method |
| :--- | :--- | :--- |
| **Canonical Staging Branch (`staging`)** | `5da4a4d1c0987de68e75eaddd24d60fab7c51264` (`PR #218` merged `2026-11-28T12:51:11Z`) | `git fetch origin staging` + `gh pr view 218` + `https://staging.virexaaiventures.com/api/version` |
| **Canonical Staging Deployment** | `dpl_4gu8wqpQssa6rFp82s5PYKzpVmGF` (`Ready`, aliased at `https://staging.virexaaiventures.com`) | `vercel inspect dpl_4gu8wqpQssa6rFp82s5PYKzpVmGF` + `/api/health` (`HEALTHY`, `database: REACHABLE`) |
| **Migration `036` Integrity** | `packages/db/src/migrations/036_gst_invoice_compliance_snapshots.ts` SHA-256 `b2077b1616762e4b00b734ca24cc3054c0e6fdc7e734a0b8c3c1a90145a64f4d` | Exact byte SHA-256 check on `origin/staging` |
| **Staging Neon Database** | Project `mute-frost-50372225`, branch `br-snowy-bonus-b32thjlz` (`ep-twilight-cherry-b3iz2oqv`, PG `18.7`, `36` applied migrations, `55` `public` tables, `5` historical invoices `INV-2026-0001..0005`, `0` rows in `billing_document_sequences`) | `BEGIN READ ONLY` catalog & ledger audit via `neon connection-string` |
| **Pre-Migration Checkpoint Branch** | `br-jolly-dust-b32gx2qo` (`staging-backup-pre-migration-036-20261128`, `current_state: "ready"`, `parent_lsn: "0/93FF550"`, `logical_size: 74,244,096` bytes, project PITR retention `21,600s` = 6h, `protected: false`, `neon snapshots list` = `[]`) | `neon branches list` + `neon projects get` + `neon snapshots list` |
| **Production Environment & PR #215** | `prod-release` (`f429d90a1f4322a0d362956fb9e55a38cb3b5508`), PR `#215` (`OPEN`, `isDraft: true`, head `fd2f8b9a...`), Neon `old-sky-50952395` | **UNTOUCHED — STRICT HOLD** |
| **Isolated V2 Feature Branch** | `feat/global-payments-billing-v2` branched cleanly from `origin/staging` (`5da4a4d1c0987de68e75eaddd24d60fab7c51264`) in worktree `global_payments_billing_v2` | Isolated PG18 (`5432`) + PG16 (`5433`) verified |

### 0.2 Section 24 Read-Only Staging Audit Findings (Preserved Without Mutating Staging)
1. **`aira_staging_runtime` Role Privileges Finding:**
   - Catalog inspection of `information_schema.role_table_grants` and `pg_default_acl` confirms `aira_staging_runtime` (`rolsuper: false`, `rolbypassrls: false`, `public CREATE: false`) currently holds **`SELECT`, `INSERT`, `UPDATE`, and `DELETE` on all `55` `public` tables**, plus `ALTER DEFAULT PRIVILEGES` granting `{aira_staging_runtime=arwd/neondb_owner}` on tables and `{aira_staging_runtime=rU/neondb_owner}` on sequences.
   - **Risk & Proposed Remediation (Not Applied Automatically):** Financial audit trails and immutable ledgers (`knex_migrations`, `knex_migrations_lock`, `billing_invoices`, `billing_credit_notes`, `billing_document_sequences`, `credit_transactions`, `billing_audit_events`, `payment_gateway_events`) should revoke `DELETE` (and `UPDATE` on strictly append-only audit/ledger tables `credit_transactions`, `billing_audit_events`, `payment_gateway_events`) from `aira_staging_runtime` once vetted against test cleanup/app queries.
2. **`38,400` Wallet vs `38,300` Grant Balance Reconciliation (`100` Credits Delta):**
   - Exact read-only account-by-account reconciliation across all `122` `credit_accounts` and `107` `credit_grants`:
     - Sum `credit_accounts.balance_credits` = `38,400`
     - Sum `credit_grants.remaining_credits` = `38,300` (`38,700` total granted; `400` expired across `4` expired `100`-credit welcome allotments on accounts that subsequently subscribed)
     - `121` of `122` accounts reconcile to **`0` difference**.
     - The **entire `100`-credit delta** comes from **one legacy fixture account**: `account_id = acc_legacy_1794642101513`, `customer_id = cust_legacy_1794642101430`, `principal_id = user_legacy_test_1794642101429` (`balance_credits = 100`, `lifetime_granted_credits = 100`, `0` rows in `credit_grants`, `0` rows in `credit_transactions`). Zero paid customer accounts exhibit any discrepancy.
3. **Checkpoint `br-jolly-dust-b32gx2qo` Protection Clarity:**
   - Recoverable point-in-time branch snapshot is `ready` (`parent_lsn: 0/93FF550`), **not** branch-protection-locked (`"protected": false`), and is not a standalone immutable Neon backup snapshot (`neon snapshots list = []`). Therefore it is accurately reported as a **recoverable non-locked point-in-time branch**.
4. **Historical Downloads & Cross-Account Isolation:**
   - `INV-2026-0001..0005` are intact in `billing_invoices`. Operator downloads remain confirmed for `INV-2026-0001`, `INV-2026-0002`, and `INV-2026-0005`; **`INV-2026-0003` and `INV-2026-0004` physical browser downloads remain PENDING** operator confirmation (do NOT repeat sandbox purchases).
   - Authenticated two-principal cross-account isolation on `GET /api/billing/invoices/:invoiceNumber/download` and `/credit-notes/:creditNoteNumber/download` is verified on staging PG18 integration tests (`404 NOT_FOUND` across accounts) and unauthenticated endpoints return `401` on live staging; genuine two-account browser/HTTP cookie replay on live `https://staging.virexaaiventures.com` remains operator-gated because AI agents do not mint Neon Auth user session tokens.

---

## 1. Provider International Capability Matrix (Evidence-Backed)

Every capability claim is segregated into `VERIFIED_SUPPORTED` / `SUPPORTED_WITH_ACCOUNT_ACTIVATION` / `UNVERIFIED_PROVIDER_GAP` / `UNCONFIGURED_BLOCKER`:

| Capability | Provider | Status | Evidence & Architectural Constraint |
| :--- | :--- | :--- | :--- |
| Domestic INR Recurring Subscriptions (UPI AutoPay, eMandate, Card) | **Razorpay** | `VERIFIED_SUPPORTED` | Official Razorpay Subscriptions API (`POST /v1/plans`, `POST /v1/subscriptions`); HMAC webhook `X-Razorpay-Signature`; sandbox proven (`INV-2026-0001/0004/0005`). |
| Domestic INR Recurring Subscriptions (UPI / eMandate Immediate Auth) | **Cashfree** | `VERIFIED_SUPPORTED` | Official Cashfree Subscriptions `2025-01-01` (`POST /pg/subscriptions`, `authorization_amount_refund: false`); sandbox proven (`INV-2026-0002/0003`). Requires 10-digit Indian phone (`6-9XXXXXXXXX`). |
| International **USD Recurring Card Subscriptions** | **Razorpay** | `SUPPORTED_WITH_ACCOUNT_ACTIVATION` | Official Razorpay International & Subscriptions docs confirm `POST /v1/plans` (`currency: "USD"`, minor units `799` / `1999`) + `POST /v1/subscriptions` support international Visa/Mastercard recurring billing; **UPI/eMandate is INR-only**. Settled in INR; supports Razorpay Dashboard FIRS / purpose codes. Live keys require Dashboard International Payments + Recurring Card activation (otherwise API rejects with `"Currency not supported"`). In V2, fail-closed capability gate `isInternationalUsdBillingEnabled()` + explicit card-only guidance (`AIRA_INTERNATIONAL_USD_BILLING_ENABLED` + live merchant activation). |
| International **USD Recurring Card Mandates** | **Cashfree** | `UNVERIFIED_FOR_CURRENT_CHECKOUT` | Official Cashfree IPG + Subscriptions docs describe `plan_currency: "USD"`, `authorization_details.payment_methods: ["card"]`, INR settlement + FIRS/FIRC. However, AIRA's current Cashfree integration requires a 10-digit Indian mobile number (`validateAndNormalizeIndianPhone`) and sandbox `USD` IPG activation on the current merchant credentials has not been executed. **V2 MUST NOT route global USD checkouts to Cashfree**; USD routes exclusively to verified card-recurring Razorpay path (or fails closed with honest capability notice if disabled). |
| Customer Payment Method Display (Masked Brand / Last4 / Masked UPI) | **Razorpay & Cashfree** | `SUPPORTED_VIA_WEBHOOK_DERIVATION` | Razorpay `payment.entity` provides `method`, `card: { last4, network, type, issuer }`, `vpa`; Cashfree `data.payment_method` / `data.payment_gateway_details` provides card/UPI instrument descriptors. Raw card PAN/CVV/OTP are **never** collected or stored by AIRA. Users update payment methods through re-authorization / Checkout flow or cancellation — AIRA does not fabricate a raw card vault form. |
| **True Binary PDF** Invoice & Credit Note Downloads | **AIRA Backend** | `IMPLEMENTED_IN_V2` | V1 only emitted A4 `text/html` (`pdfDownloadAvailable: false`). V2 adds deterministic zero-dependency pure-TypeScript binary A4 `%PDF-1.4` rendering (`GET /api/billing/invoices/:invoiceNumber/pdf` and `/credit-notes/:creditNoteNumber/pdf`, plus `?format=pdf` on `/download`) while preserving `/download` A4 HTML (`View / Print A4`) unchanged. |
| **Invoice Email Delivery** | **Transactional Email** | `UNCONFIGURED_BLOCKER` | Repository search + `vercel env ls` confirm **zero** SMTP / Resend / SendGrid / Postmark provider or credentials configured. V2 adds an authenticated fail-closed boundary (`POST /api/billing/invoices/:invoiceNumber/email` -> `503 EMAIL_DELIVERY_NOT_CONFIGURED`) and never renders fake `"Email sent"` confirmations. |

---

## 2. Problem Statement

Global and Indian subscribers currently encounter developer-centric accounting details (`Payment Partner: Razorpay / Cashfree` jargon, upfront 4-input Indian GSTIN grid, exposed internal supplier diagnostic text like `SAC 998315 Provisional Fixture`, `Place of Supply` warnings in summaries, raw lifecycle notices) immediately upon opening the Pricing or Billing views. International buyers (`$ USD`) have no localized country/billing-information flow, no personal vs. business toggle, no masked saved payment method view, and no binary PDF download option — while role boundaries (Guest vs. Free vs. Individual vs. Business vs. Former vs. Operator) are conflated across public and subscriber API payloads.

---

## 3. Solution

Deliver **AIRA Global Payments & Billing V2**: a ChatGPT/Claude-inspired, global-first commercial experience preserving 100% of AIRA's PostgreSQL ledger durability, UP (`09`) / Indian GST accuracy, domestic INR dual-gateway (`Razorpay` & `Cashfree`) lifecycle guarantees, and fail-closed production safety gates:
1. **Clean Role-Scoped & Country-Aware APIs:** Public `GET /api/billing/plans` stops exposing internal GST fixture readiness diagnostics to guests/anonymous users; authenticated `GET /api/billing/summary` and `GET/PUT /api/billing/profile` add normalized `country`, `accountType` (`individual` | `business`), `taxId`, masked provider-derived `paymentMethods`, and clean customer-facing `subscriptionLifecycle` without internal worker/outbox/database IDs.
2. **Unified Global Checkout & Progressive Disclosure:** Clean Free (`₹0` / `$0`), Plus (`₹399` / `$7.99`, `3,000` credits), and Pro (`₹999` / `$19.99`, `7,500` credits) selection; seamless currency/country alignment (`IN -> INR`, `Global -> USD`); hidden technical gateway jargon unless choosing an India payment rail (UPI Mandate vs Card/UPI); clean `Purchasing for a business` disclosure hiding GSTIN/VAT/Tax ID fields for personal buyers; fail-closed USD card routing via Razorpay with explicit live activation gating.
3. **True Binary PDF + Printable A4 HTML:** Real `application/pdf` binary invoices & credit notes alongside preserved printable A4 HTML, zero HTML-mislabeled-as-PDF, and an honest fail-closed email delivery boundary.
4. **Dedicated Clean Billing Center (`Settings -> Plan & Billing` & `Account & Billing`):** Organized into four crisp sections: **Your subscription**, **Payment methods**, **Billing history**, and **Billing information**, with role-appropriate views and light/dark parity.

---

## 4. Seams Architecture (`/to-spec`)

To keep modules deep and minimize cross-cutting churn, V2 concentrates changes at **4 explicit seams**:

1. **Seam 1 — Contracts & Global Country/Gateway Capability Registry:**
   - `packages/contracts/src/commercial.ts` (Zod schemas & TS types for `BillingAccountType`, `PaymentMethodSummary`, `GlobalBillingProfile`, `ProviderCapabilityDescriptor`, `GlobalCountryOption`)
   - `apps/api/src/billing/global-billing-catalog.ts` (ISO country catalog, default currency inference, provider-per-currency/method capability lookup)
   - *Catches:* Currency/country mismatch, unverified Cashfree USD routing, invalid country codes, missing capability status flags.
2. **Seam 2 — Tax, Masked Payment Method Extraction & Document Rendering:**
   - `apps/api/src/billing/tax-determination.ts` (International export zero-rated / LUT handling + B2B external Tax ID support; untouched Indian UP `09` 37-jurisdiction math)
   - `apps/api/src/billing/payment-gateway-service.ts` (webhook payment-method summary extractor storing only masked metadata `{ methodType, brand, last4, maskedUpi, gateway, displayLabel, updatedAt }`, never PAN/CVV/OTP; global billing profile merge; fail-closed international USD capability check)
   - `apps/api/src/billing/pdf-document-renderer.ts` + `apps/api/src/billing/gst-document-renderer.ts` (real binary A4 `%PDF-1.4` renderer + global/export-clean wording on non-IN receipts + sandbox watermarking + zero internal `usr_` leakage)
3. **Seam 3 — Role-Scoped & Principal-Isolated REST Endpoints:**
   - `apps/api/src/billing-routes.ts` (`GET /plans`, `GET /summary`, `GET/PUT /profile`, backward-compatible `GET/PUT /tax-profile`, `POST /checkout/subscription`, `GET /payment-methods`, `GET /invoices/:n/download`, `GET /invoices/:n/pdf`, `POST /invoices/:n/email`, `GET /credit-notes/:n/pdf`).
   - *Catches:* IDOR across accounts (`404`), guest leaks (`401`/`403`), operator readiness leaks (`403` for regular users), HTML mislabeled as PDF, forged client email/amount.
4. **Seam 4 — Customer-Facing Global UI Components:**
   - `src/components/PricingModal.tsx`, `src/components/SettingsModal.tsx` (`Plan & Billing` tab), `src/components/AccountBillingModal.tsx`, `src/lib/accountBillingTruth.ts`.
   - *Catches:* Raw accounting clutter, light/dark contrast defects, responsive overflow, unresolved checkout regressions, non-accessible controls.

---

## 5. User Stories

1. As a **Guest visitor**, I want to inspect AIRA Free, Plus, and Pro pricing in India (`₹ INR`) or Global (`$ USD`) without seeing internal supplier tax debug banners or fake balances, so that I understand plans clearly before signing in.
2. As an **Authenticated Free user in the United States (`US`)**, I want currency to reflect `$ USD` (`$7.99` Plus, `$19.99` Pro) with international card checkout and no Indian GST State/GSTIN prompts, so that checkout feels natural and global.
3. As an **Individual buyer in India (`IN`)**, I want simple INR pricing (`₹399` Plus, `₹999` Pro), clean payment choices (`Cards, UPI & NetBanking` or `UPI Mandate`), and only a required State/UT selector without seeing B2B GSTIN fields unless I opt in, so checkout takes seconds.
4. As a **Business customer in India**, I want to toggle "Purchasing for a business", enter my company name, address, and 15-character GSTIN (validated upfront), and receive GST-compliant invoices with B2B input-tax particulars, while keeping personal buyers uncluttered.
5. As a **Global Business subscriber outside India**, I want to toggle "Purchasing for a business" and record my legal business name, billing address, and VAT/EIN/Tax ID cleanly on my billing profile and export receipts.
6. As an **Active Plus or Pro subscriber**, I want a clean **Your subscription** card showing my plan, status badge (`Active` or `Cancels on <date>`), next billing date, and straightforward cancel/upgrade controls without raw cycle counters, webhook states, or internal IDs.
7. As a **Returning subscriber**, I want a **Payment methods** section displaying my verified masked payment method (e.g., `Visa •••• 4242` or `UPI ••••@okaxis`) derived strictly from verified provider events, with honest instructions to update via checkout or manage auto-renewal — without unsafe raw card input forms.
8. As any **Paying or Former subscriber**, I want **Billing history** to show my paid invoices and credit notes with both **View / Print A4** (HTML) and **Download PDF** (`application/pdf` binary) actions and clear sandbox labeling when in staging rehearsal.
9. As an **Authenticated subscriber**, I want **email invoice delivery** to fail cleanly or clearly state availability when no verified email transport exists rather than claiming an email was sent when none went out.
10. As a **Production release operator**, I want international USD production checkout and tax readiness to remain **fail-closed** unless explicit gateway USD approval, plan IDs, LUT, and statutory approvals are verified.

---

## 6. Implementation Decisions

- **Preserved Financial & Statutory Contracts:** Tier prices (`₹399`/`$7.99` Plus, `₹999`/`$19.99` Pro), monthly credit allocations (`3,000` Plus, `7,500` Pro), integer paise/cent math, migration `036` schema, FY sequence allocators, and historical `INV-2026-0001..0005` rows remain untouched.
- **Additive Schema Strategy (No Breaking Migrations):** Existing `billing_customers` (`billing_country`, `country_code`, `billing_legal_name`, `billing_address_line1..2`, `billing_city`, `billing_state_code`, `billing_postal_code`, `customer_gstin`, `tax_info`) and `billing_invoices` (`payment_method`, `issuance_snapshot`, `pdf_download_available`) + `subscriptions.metadata` are sufficient without risking destructive schema alterations; non-GST business Tax IDs and masked payment method summaries store cleanly inside structured `tax_info` / `issuance_snapshot` / `subscriptions.metadata` with optional nullable additive expand-only migration `037` ONLY if an indexed relational column is strictly needed. *(Decision: Keep migration `036` as latest clean baseline — store `accountType`, `taxId`, and masked `paymentMethodSummary` cleanly in structured existing JSONB + `billing_invoices.payment_method` column so zero unnecessary migration risk is introduced unless indexing becomes necessary!)*
- **Razorpay USD Checkout Integrity:** Keep USD checkout routed strictly to Razorpay (`currency === 'USD'` -> `'razorpay'`); reject explicit `cashfree` + `USD` requests with `400 VALIDATION_ERROR` or `503 BILLING_UNAVAILABLE` explaining Cashfree international USD is pending verification. In Razorpay error paths, detect `"Currency not supported"` / international activation rejections and surface clear operator-actionable messaging.
- **Role-Scoped Responses:**
  - `GET /api/billing/plans` returns `plans`, `countries`, `currencyOptions`, `billingStatus`, `checkoutAvailable`, `internationalUsdEnabled`, `providerCapabilities` (safe customer-facing flags), and `gstJurisdictions` — removing `taxConfigSummary` / provisional statutory internals from unauthenticated `/plans`.
  - `GET /api/billing/readiness` stays strictly `403` for non-operators (`401` if unauthenticated per middleware).
- **Backward Compatibility for Existing Tests & Flows:**
  - Preserve existing button labels (`Upgrade to Plus`, `Upgrade to Pro`, `View / Print A4`, `View / Print A4 Invoice`) and Cashfree SDK (`cashfree.subscriptionsCheckout({ ... redirectTarget: '_self' })`) + Razorpay SDK modal precedence (`determineCheckoutDispatchStrategy`).
  - Keep `PUT /api/billing/tax-profile` working alongside unified `PUT /api/billing/profile` so existing API clients/tests remain green.
  - Ensure `PricingModal` honors light/dark theme tokens (`bg-claude-surface-light dark:bg-stone-900` or accessible high-contrast tokens) and mobile responsive viewports (`375px`, `768px`, `1280px+`) cleanly!

---

## 7. Execution Phases (Dependency-Ordered)

- **Phase A (Completed):** Read-only baseline verification, Neon privilege/balance audit, Graph retrieval, V2 branch creation, baseline test certification (`77/77`), provider doc verification, and this V2 Spec.
- **Phase B:** Contracts & Global Country/Capability Catalog + Tax/Export refinement (`packages/contracts`, `global-billing-catalog.ts`, `tax-determination.ts`) via `/tdd`.
- **Phase C:** Payment Method Extraction, Global Profile Persistence, Cashfree USD Fail-Closed Guard, & International Razorpay Card Hardening (`payment-gateway-service.ts`, `commercial-billing-service.ts`, `billing-routes.ts`) via `/tdd`.
- **Phase D:** Deterministic Binary `%PDF-1.4` Invoice & Credit Note Renderer (`pdf-document-renderer.ts`), clean Export/Global HTML refinements (`gst-document-renderer.ts`), `/pdf` routes, & fail-closed `/email` boundary via `/tdd`.
- **Phase E:** Global-First Role-Scoped UI V2 (`PricingModal.tsx`, `SettingsModal.tsx`, `AccountBillingModal.tsx`, `accountBillingTruth.ts`) implementing all 6 customer experiences with responsive light/dark accessibility.
- **Phase F:** Comprehensive Verification: `lint`, `typecheck`, `build`, `test:secrets`, all existing CI billing/durability/security suites + new V2 unit/PG18/PG16/browser Playwright suite capturing screenshots across all 6 billing experiences in desktop & mobile + light/dark themes.
- **Phase G:** Independent specialist review + `/agency-reality-checker` + `/verification-before-completion` + incremental Graphify/knowledge sync + push `feat/global-payments-billing-v2` and open **Draft PR targeting `staging`** (verify exact-SHA CI & GitGuardian; do NOT merge or deploy).

---

## 8. Out of Scope
- Merging any PR into `staging` or `prod-release`, deploying to canonical `staging` or production, or modifying `PR #215` / Neon `old-sky-50952395`.
- Modifying migration `036` or mutating historical invoices `INV-2026-0001..0005`.
- Executing live real-money charges or live sandbox purchases on staging.
- Fabricating SMTP email delivery without configured provider credentials.
- Storing raw card PAN, CVV, expiry security codes, or OTPs anywhere in AIRA.
