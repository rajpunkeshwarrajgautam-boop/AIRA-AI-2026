# AIRA AI 2026 — Payment & Commercial Billing Subsystem Intel (V2 Synchronized)
**Recorded At:** `2026-11-28T22:45:00+05:30`
**Staging Baseline SHA:** `5da4a4d1c0987de68e75eaddd24d60fab7c51264` (`https://staging.virexaaiventures.com`)
**V2 Candidate Branch:** `feat/global-payments-billing-v2` (`SPEC-GLOBAL-BILLING-V2-2026-01`)
**Knowledge Graph:** `53` nodes, `65` edges (`SHA-256: 02e7cc90bb6ed84663ebe143d550d0a4c2fac45e7c2ac8b31c84e827f0f67c49`)

## 1. Global Payments & Billing V2 Architecture Additions
- **Country & Capability Catalog (`apps/api/src/billing/global-billing-catalog.ts`):**
  - Maps `IN -> INR` (`['card', 'upi', 'emandate']`) and 27+ global countries `-> USD` (`['card']`).
  - Publishes explicit provider capability matrix (`domesticInrRazorpay`, `domesticInrCashfree`, `internationalUsdRazorpay`, `internationalUsdCashfree: UNVERIFIED_FOR_CURRENT_CHECKOUT`, `binaryPdfDownload`, `invoiceEmailDelivery: UNCONFIGURED_BLOCKER`).
  - Rejects explicit Cashfree USD checkouts with HTTP `400 UNSUPPORTED_INTERNATIONAL_GATEWAY`.
- **Genuine Binary A4 `%PDF-1.4` Renderer (`apps/api/src/billing/pdf-document-renderer.ts`):**
  - Hermetic pure-TypeScript `%PDF-1.4` generator serving `application/pdf` on `/api/billing/invoices/:invoiceNumber/pdf` and `/credit-notes/:creditNoteNumber/pdf` (plus `?format=pdf`), alongside preserved printable A4 HTML on `/download` (`View / Print A4`).
  - Export zero-rated USD invoices render cleanly as Commercial/Sandbox Export Invoices under LUT (`IGST Act Sec 2(6)`) without Indian provisional GST noise.
- **Masked Provider Payment Methods & Global Profile (`apps/api/src/billing/payment-gateway-service.ts`, `commercial-billing-service.ts`, `billing-routes.ts`):**
  - Extracts strictly masked `PaymentMethodSummary` (`brand`, `last4`, `maskedUpi`, `mandateStatus`, `displayLabel`) from verified gateway webhooks (never raw PAN/CVV/OTP).
  - `/api/billing/profile` persists `country`, `accountType` (`individual` | `business`), freeform non-India region/state (respecting 4-char `billing_state_code` column limit), optional B2B GSTIN (India), and Tax/VAT/EIN ID (Global).
  - `POST /api/billing/invoices/:n/email` enforces ownership (`404`) and fails closed (`503 EMAIL_DELIVERY_NOT_CONFIGURED`) until mail transport is provisioned (`blk_u5_transactional_email`).
- **Customer-Facing UI V2 (`PricingModal.tsx`, `SettingsModal.tsx`, `AccountBillingModal.tsx`):**
  - Hides internal GST diagnostic fixtures (`taxConfigSummary`, `SAC 998315`, `Provisional Fixture`) from public `/plans` and customer footers.
  - Progressive disclosure by country/currency in `PricingModal` (capture-phase Escape isolation so nested Settings stays open), and 4 clean cards in `SettingsModal`: `Your subscription`, `Payment methods`, `Billing information`, `Billing history`.

## 2. Preserved Baseline Invariants & Staging Audit Closures
- **Production Strict Hold:** PR `#215` (`fd2f8b9a...`), `prod-release`, and Neon `old-sky-50952395` untouched and on STRICT HOLD (`U1–U6`).
- **Historical Staging Preservation:** Migration `036` (`b2077b16...`), `36` applied migrations, `55` tables, and `INV-2026-0001..0005` untouched.
- **Staging Wallet vs Grant Reconciliation (Read-Only):** `121/122` credit accounts reconcile identically to `0`; the sole `+100` delta (`38,400` vs `38,300`) belongs to legacy fixture `acc_legacy_1794642101513` (`user_legacy_test_1794642101429`).
- **Staging Runtime Role & Checkpoint Risk (Documented):** `aira_staging_runtime` still holds `pg_default_acl` (`arwd` on tables / `rU` on sequences), and `br-jolly-dust-b32gx2qo` is an unprotected PITR branch (`6h` retention); proposals documented in `SPEC-GLOBAL-BILLING-V2-2026-01` without mutating staging.
