# AIRA AI 2026 — Production GST Invoicing & Commercial Billing Specification

**Document ID:** `SPEC-GST-BILLING-2026-01`  
**Revision:** `2.1 (PHASE 0 CORRECTED SPECIFICATION & EXECUTION BASELINE)`  
**Status:** `APPROVED FOR STAGING T0–T8 IMPLEMENTATION (PRODUCTION STRICT HOLD — TAX/AMENDMENT SIGN-OFF REQUIRED)`  
**Date:** `2026-11-28`  
**Methodology:** `/agency-agents-orchestrator` pipeline + `/implement-spec` + `/tdd`  
**Supersedes:** Revision `2.0` (`2026-11-28`)

---

## 0. Certified Baseline, Branch Setup & Divergence Report

Read-only inspection of GitHub (`rajpunkeshwarrajgautam-boop/AIRA-AI-2026`) and Vercel (`staging.virexaaiventures.com`) plus isolated local repository verification on `2026-11-28` confirms:

| Reference | Observed Live State (`2026-11-28`) | Baseline Match / Divergence |
| :--- | :--- | :--- |
| **Canonical Staging Branch (`staging`)** | `6c90c12930a23018ff02435a7832ca5bd0578b26` (`2026-11-26T16:48:48Z`, GH Deployment `8091204461` `success`) | **CURRENT & EXACT MATCH** |
| **Canonical Staging Deployment** | `dpl_GsipaYiU2bEZe6DhQXBJVUAY9dum` (`Ready`, `2026-11-26T23:45:11+05:30`, aliased at `https://staging.virexaaiventures.com`) | **CURRENT & EXACT MATCH** |
| **Production Branch (`prod-release`)** | `f429d90a1f4322a0d362956fb9e55a38cb3b5508` (`2026-11-20T08:57:58Z`) | Unchanged (Production remains untouched) |
| **Production Draft PR (`#215`)** | `OPEN`, `isDraft: true`, branch `rc/prod-billing-release-20261126`, head `fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` | **UNTOUCHED & STRICT HOLD — DIVERGED:** `behind_by: 3` commits (`PR #217`) and `ahead_by: 1` unique hardening commit vs merge base `0abbda13`. |
| **Dedicated Non-Prod Integration Branch** | `feat/gst-invoicing-commercial-20261128` branched cleanly from `6c90c12930a23018ff02435a7832ca5bd0578b26` | Active pre-approval staging branch (`T0`–`T8`). Preserves non-conflicting PR `#215` hardenings (outbox CAS fencing, `isInternationalUsdBillingEnabled`, readiness closure tests) without altering PR `#215`. |
| **Migration Numbering & Parity Registry** | Migrations `001`–`035` verified (`035_subscription_cancellation_and_invoice_outbox.ts` is latest); `scripts/rehearse-disposable-restore.ts` tracks 52 tables | **`036_gst_invoice_compliance_snapshots.ts`** verified conflict-free next slot (`rehearse-disposable-restore.ts` & `verify-deploy.ts` updated alongside `036`). |
| **Other Recent Preview Deployments** | Preview builds `7523c640` & `895b356d` (`2026-11-27T19:39Z`) | Preview-only; `staging` (`6c90c129`) & `dpl_GsipaYiU2bEZe6DhQXBJVUAY9dum` unaffected. |
| **Preserved Financial Ledger** | `docs/BILLING_SANDBOX_ACCEPTANCE_LEDGER.md` (`INV-2026-0002`..`INV-2026-0005`, all 4 sandbox purchase combinations passed) | **PRESERVED UNTOUCHED** — no historical mutations or sandbox re-runs. |
| **Neon DB Isolation Verified** | Production Neon (`old-sky-50952395` / `br-shiny-moon-b3vy9xj7`) & Staging Neon (`mute-frost-50372225` / `br-autumn-star-b36dfu5w`) strictly untouched during implementation | Development & regression verification run strictly against isolated local PostgreSQL `18.7` (`127.0.0.1:5432`) and ephemeral CI containers. |

> **Governance Gate:** Tasks `T0`–`T8` execute strictly on `feat/gst-invoicing-commercial-20261128` against isolated PostgreSQL `18.7`. Permanent staging deployment & migration require explicit owner authorization after Phase 6 certification. `T9` and all Production actions remain strictly prohibited.

---

## 1. Truth & Provenance Matrix

To preserve audit clarity, every fact in this specification is strictly classified into one of four categories:

### 1.1 Owner-Confirmed Company & Financial Baseline Facts
- **Legal Entity Name:** `VIREXA AI VENTURES PRIVATE LIMITED`
- **Trade Name:** `VIREXA AI VENTURES`
- **GSTIN:** `09AAMCV4678C1ZV` *(Validated mathematically: State `09` Uttar Pradesh, PAN slice `AAMCV4678C`, Mod-36 checksum `'V'` = valid)*
- **PAN:** `AAMCV4678C`
- **CIN:** `U58201UP2026PTC250225`
- **Incorporation Date:** `16 July 2026`
- **GST Registration Effective Date:** `15 August 2026`
- **GST Registration Status / Taxpayer Type:** `Active` / `Regular`
- **Principal Place of Business:** `2/290, Gomti Nagar, Virat Khand, Lucknow, Uttar Pradesh, 226010, India`
- **Supplier State Code:** **`09` (Uttar Pradesh)** — *the legacy `07` (Delhi) assumption across code, readiness, and owner wizard must be removed completely from supplier defaults.*
- **Billing Support Email:** `virexaiventures@gmail.com`
- **GSTR-3B & Commercial Revenue Baseline:**
  - `August 2026 GSTR-3B`: Filed, zero outward supplies, zero GST liability.
  - `September 2026 GSTR-3B`: Filed, zero outward supplies, zero GST liability.
  - `October–December 2026`: Quarterly return filing under **QRMP** (Quarter Return Monthly Payment).
  - Zero commercial invoices issued and zero commercial revenue received since incorporation (`FY 2026-27` commercial series starts cleanly at `00001`).
  - Sandbox transactions (`INV-2026-0002..0005`) are non-commercial test records and do not count as taxable supply or consume production serial sequences.
- **E-Invoicing Expectation:** Not expected to apply at launch (`AATO <= ₹5 crore` expected given zero revenue since incorporation), subject to formal statutory applicability confirmation (`AIRA_EINVOICE_IRN_REQUIRED=false` unless turnover crosses threshold).
- **GST Portal Draft Status:** `SAC 998315` (*Hosting and information technology infrastructure provisioning services*) is saved in a **GST non-core amendment draft** (original three goods HSN entries unchanged). **The draft amendment has NOT been submitted or authenticated; application completion deadline is `13 December 2026`.**

### 1.2 Verified Statutory Requirements & Clarifications (Indian GST Framework)
Verified against official Government of India sources (`indiacode.nic.in`, `taxinformation.cbic.gov.in`, `einvoice1.gst.gov.in`, `gst.gov.in`):
1. **Separation of Payment Confirmation vs Statutory Invoice Timing (`CGST Sec 31`, `Sec 31(5)`, `Sec 13(2)`, `Rule 47`, `Rule 50`/`51`):**
   - **Authoritative Payment Confirmation (Technical):** Cryptographically verified gateway webhooks (`payment.captured`, `invoice.paid`, `SUBSCRIPTION_PAYMENT_SUCCESS`) prove money movement only.
   - **Statutory Invoice Timing (Legal):** Monthly subscriptions constitute **continuous supply of services** (`Sec 31(5)`), requiring tax invoice issuance on/before contract due date or payment receipt (`Sec 31(5)(b)`), supporting **Cycle 1 immediate activation**, **advance-payment receipt** (`Sec 13(2)` / `Rule 50`), and **Cycle 2+ renewal windows** (`Rule 47` 30-day ceiling). Temporary `₹1` mandate authorizations that are not kept as service consideration are **not** taxable supplies and must never emit Tax Invoices; captured pre-supply payments refunded before service provisioning require Refund Voucher semantics (`Sec 31(3)(e)` / `Rule 51`), whereas post-invoice refunds require `Sec 34` Credit Notes.
2. **CGST Rule 46 (Tax Invoice Particulars & FY Consecutive Serial):** Mandatory supplier name, full address, GSTIN; consecutive FY-unique serial number `<= 16` chars (`A-Z`, `0-9`, `-`, `/`, resetting April 1 IST); issue date; recipient GSTIN/name/address for B2B (`Rule 46(d)`); B2C State/address if `>= ₹50,000` (`Rule 46(e)`) or requested (`Rule 46(f)`); SAC & description; taxable value; rate and CGST/SGST/UTGST/IGST amounts; Place of Supply; reverse charge (`No`).
3. **Electronic Authentication Limitation (`CGST Rule 46(q)` Proviso & IT Act, 2000):** Although `Rule 46(q)` proviso waives physical signature/DSC where an electronic invoice complies with the **Information Technology Act, 2000**, displaying a printed electronic attestation notice on the HTML document does **not by itself prove statutory electronic authentication compliance**. Actual legal compliance (DSC vs IT Act integrity/audit controls) remains explicitly subject to formal CA/legal sign-off (`U2`).
4. **CGST Rule 46 + Notif. No. 78/2020-CT (HSN/SAC Digits):** Minimum `4` digits B2B for `AATO <= ₹5 Cr` (`6` digits `> ₹5 Cr`); using full **`6`-digit SAC** satisfies both regimes.
5. **CGST Act Sec 34 & Rule 53(1A) (Credit Notes):** FY-unique consecutive serial `<= 16` chars; supplier & recipient details; **original invoice serial number & date**; taxable base, tax rate, and tax credited per component; statutory `GSTR-1` declaration deadline **30th November** following FY end (`Sec 34(2)` / `Sec 37(3)`).
6. **IGST Act Sec 12(2) (Domestic Place of Supply):** B2B takes recipient GSTIN state (`Sec 12(2)(a)`). B2C takes recipient address/state on record (`Sec 12(2)(b)(i)`); only when address is absent does it fall back to **supplier's state** (`Sec 12(2)(b)(ii)`). Silently assigning `UNKNOWN` to `IGST` violates Sec 12(2)(b)(ii).
7. **CGST Rule 48(4)-(5) & Notif. No. 14/2020-CT (E-Invoicing / Dynamic QR):** IRP IRN + signed QR mandatory for B2B/Exports if `AATO > ₹5 Cr` in any FY since `2017-18`; B2C Dynamic QR applies if `AATO > ₹500 Cr`. Actual applicability must be formally verified and attested before launch (`U2`).
8. **CGST Act Sec 36 & Sec 37 (`QRMP` / `GSTR-1` / Voided Serials / `72`-Month Retention):** Records must be retained immutably for `72 months` from annual return due date. Cancelled/voided serial numbers must **never be reused or deleted**; they must remain preserved as `VOIDED`/`CANCELLED` audit records for `GSTR-1 Table 13` disclosure. Under `QRMP`, B2B invoices (`Table 4`) / credit notes (`Table 9B`) may be reported monthly via **IFF** or quarterly in `GSTR-1`, with B2C (`Table 7`) and HSN (`Table 12`) reported quarterly.

### 1.3 Finalized Engineering Decisions
1. **Launch Scope:** Strict domestic **INR-only** commercial launch (`AIRA_INTERNATIONAL_USD_BILLING_ENABLED=false`). Non-INR transactions fail closed.
2. **Pricing Model & Provisional Fixtures:** GST-inclusive retail pricing of **`₹399.00` (AIRA Plus)** and **`₹999.00` (AIRA Pro)** computed in integer paise from externalized configuration (`SAC 998315` and `18%` rate are used **solely as explicitly provisional sandbox test fixtures**; never represent the unsubmitted GST draft amendment as approved or active).
3. **Configurable Supplier & Tax Engine:** Remove hardcoded `'07'` Delhi supplier state and `'998431'` SAC defaults from tax computation, readiness, and provisioning scripts. Default non-prod/config templates to **`VIREXA AI VENTURES PRIVATE LIMITED`**, supplier state **`09` (Uttar Pradesh)**, registered Lucknow address, PAN `AAMCV4678C`, CIN `U58201UP2026PTC250225`, email `virexaiventures@gmail.com`, and externalized `AIRA_SUPPLIER_SAC_CODE` / `AIRA_SUPPLIER_SAC_DESCRIPTION` / `AIRA_GST_RATE_PERCENT`.
4. **Three Distinct Production Authorization Gates (Fail Closed):** Production distinguishes **Gate A — Code Deployment** (`prod-release` deploy with `AIRA_COMMERCIAL_BILLING_ENABLED=false`), **Gate B — Merchant & Statutory Provisioning** (`LIVE` Razorpay/Cashfree credentials, `09AAMCV4678C1ZV`, UP `09`, registered Lucknow address, approved `AIRA_SUPPLIER_SAC_APPROVED=true`, verified rounding/refund/auth/e-invoice `AIRA_FINANCE_TAX_SIGNOFF=true`), and **Gate C — Commercial Billing Activation** (explicit owner `GO LIVE` flipping `AIRA_COMMERCIAL_BILLING_ENABLED=true`). Production commercial billing **MUST FAIL CLOSED** unless all three gates are satisfied.
5. **Mandatory Customer State/UT & Optional B2B GSTIN:** Require Billing State/UT selection (37 active GST State/UT jurisdictions) at checkout/profile before paid subscription creation; offer optional B2B GSTIN, Legal Name, and Business Address fields with format + state-prefix + Mod-36 checksum validation. Eliminate silent `UNKNOWN -> IGST` fallback permanently.
6. **CGST / SGST / UTGST / IGST Determination:** Supplier (`09` UP) vs Destination: same state `09` -> `CGST + SGST`; another state/UT -> `IGST`; architecture also supports `CGST + UTGST` (`04, 26, 31, 35, 38`) if supplier state ever expands/changes, and rejects merged code `25`.
7. **Immutable Issuance-Time Snapshots:** Freeze complete supplier, customer, jurisdiction, period (`current_period_start`–`current_period_end`), payment reference/method, invoice timing basis (`CONTINUOUS_SUPPLY_CYCLE_SETTLEMENT | ADVANCE_PAYMENT_RECEIPT | RENEWAL_CYCLE`), SAC/tax config version, and tax breakdown columns inside PostgreSQL (`036` additive migration) at settlement/refund time.
8. **FY-Aware Consecutive Atomic, Auditable Numbering & Voided Serial Policy:** Allocate numbers scoped by `(document_scope, financial_year)` in `Asia/Kolkata` (`April 1 – March 31`) inside PostgreSQL transactions (`INSERT ... ON CONFLICT DO UPDATE`):
   - Production Tax Invoice: **`INV/26-27/00001`** (`15` chars `<= 16`)
   - Production Credit Note: **`CN/26-27/00001`** (`14` chars `<= 16`)
   - Non-Tax / Sandbox Isolation: **`SBX/26-27/00001`** (`15` chars) and **`SCN/26-27/00001`** (`15` chars), preserving historical `INV-2026-0001..0005` untouched without migrating or renumbering them.
   - **Voided / Cancelled Serial Numbers:** Rolled-back transactions never commit sequence increments; once committed, a serial number is **never deleted or reused**. Any voided/annulled document retains `document_status = 'VOIDED'` (with audit trail & `GSTR-1 Table 13` visibility) and/or paired `Sec 34` Credit Note.
9. **Privacy, Honest Format Advertising & Sandbox Labeling:** Remove internal `Customer Principal: usr_...` and infrastructure metadata from downloaded customer documents; enforce cross-account & cross-tenant access denial; **do NOT advertise binary PDF downloads (`pdf_download_available: false`) unless an actual verified binary `application/pdf` generator is implemented and tested**—instead expose verified **A4 Printable HTML (`printableDocumentAvailable: true`, `@page { size: A4 }`, `"View / Print A4 Document"`)**; stamp non-production documents with a prominent **`SANDBOX REHEARSAL RECEIPT — NOT A VALID TAX INVOICE`** watermark/banner.
10. **Statutory Timing, `§8.4` Durability & Fail-Closed Lifecycle:**
    - Separate verified payment capture webhooks from statutory tax-invoice timing rules (continuous supply Cycle 1 & Cycle 2+ renewals, advance payments, and non-invoiced temporary `₹1` authorizations).
    - Resolve all `§8.4` ledger & entitlement items (`settleReservation` across expiry, welcome-grant `'promotional'` classification, refund isolation, durable late-payment recovery & Credit Note linkage, Cycle `2+` renewal windows, webhook replay/entitlement regression `adversarial-entitlements` Scenario 17).

### 1.4 Unresolved Statutory & Owner Approvals (Blocks Live Production Activation ONLY)
1. **U1 — GST Portal Non-Core Amendment Submission & Acceptance (`Deadline: 13 Dec 2026`):** Draft adding `SAC 998315` must be formally submitted and authenticated on the GST portal before `SAC 998315` can be treated as active production registration scope.
2. **U2 — CA Final Tax Confirmation:** Written confirmation from virexa's Chartered Accountant ratifying:
   - `SAC 998315` vs alternative classification (`998319` / `998439`) for AI SaaS subscriptions (`₹399` / `₹999` GST-inclusive);
   - Standard **`18%`** GST rate (`9% CGST + 9% SGST` intra-UP, `18% IGST` inter-state);
   - Minor-unit rounding policy (`taxablePaise = Math.round(totalPaise * 10000 / 11800)`, `gstPaise = totalPaise - taxablePaise`; specifically for `₹999.00` = `₹846.61` + `₹152.39` inter-state IGST vs `₹76.19` + `₹76.20` OR parity `₹846.60` + `₹76.20 + ₹76.20` intra-state UP — **Note: because Supplier is in `09` UP and UP customers will encounter `₹999.00` intra-state split immediately at launch, this `±1 paisa` Pro intra-state rounding rule MUST be confirmed by the CA before flipping `AIRA_FINANCE_TAX_SIGNOFF=true`!**);
   - Formal written applicability sign-off on `AATO <= ₹5 Cr` e-invoicing exemption (`Rule 48(4)`), IT Act 2000 electronic authentication (`Rule 46(q)`), refund Credit Note policy (`Terms / Refund Policy` consistency), and `QRMP` (`GSTR-1` / `IFF`) export requirements.
3. **U3 — Starting Production Sequence Sanity Check:** Owner re-affirms immediately prior to `GO LIVE` that still zero external commercial invoices were issued after `2026-11-28`, confirming `00001` as the exact starting serial in `FY 2026-27`.
4. **U4 — Future Production Environment Provisioning & Final `GO LIVE`:** Live Razorpay/Cashfree merchant KYC + `LIVE` keys/plan IDs + production Vercel tax env vars + explicit owner `GO LIVE` authorization.

---

## 2. Problem Statement

Customers purchasing AIRA Plus (`₹399`) or AIRA Pro (`₹999`) need legally compliant, privacy-safe, downloadable Indian GST Tax Invoices (and linked Credit Notes upon refund) backed by accurate supplier identity (`VIREXA AI VENTURES PRIVATE LIMITED`, Lucknow `09`, `09AAMCV4678C1ZV`), correct Place of Supply jurisdiction, consecutive Financial-Year serial numbers (`INV/26-27/00001`), and immutable financial records—without leaking internal user IDs, misclassifying supplies to Delhi `07` or unverified `SAC 998431`, defaulting unknown jurisdictions silently to IGST, or allowing production billing to execute while tax configuration remains unapproved.

## 3. Solution

Upgrade AIRA's billing subsystem into a fail-closed, Financial-Year-scoped GST invoicing engine driven by verified supplier configuration, mandatory billing State/UT capture with optional B2B GSTIN support, complete 37-jurisdiction `CGST/SGST/UTGST/IGST` determination, additive SQL snapshot persistence (`migration 036`), privacy-clean A4 printable HTML Tax Invoice and Rule 53(1A) Credit Note views, sandbox receipt watermarking, and resolved `§8.4` financial ledger durability invariants.

## 4. User Stories (`/to-spec`)

1. As a **B2C subscriber in Uttar Pradesh (`09`)**, I want my `₹399` Plus or `₹999` Pro checkout to recognize my UP state and emit an A4 downloadable Tax Invoice showing `VIREXA AI VENTURES PRIVATE LIMITED`, `09AAMCV4678C1ZV`, Lucknow address, my name and UP state, `CGST (9%) + SGST (9%)`, billing period dates, and payment reference, so that I receive an accurate domestic receipt without internal IDs exposed.
2. As a **B2C subscriber outside Uttar Pradesh (e.g., Maharashtra `27` or Chandigarh `04`)**, I want selecting my billing State/UT during checkout to calculate `IGST (18%)` correctly against Virexa's UP (`09`) registration and freeze that jurisdiction permanently on my invoice, so that my invoice reflects true inter-state tax treatment.
3. As a **B2B customer claiming Input Tax Credit**, I want to optionally enter and validate my 15-character GSTIN, business name, and registered address at checkout or in Settings Billing Profile, so that my invoice (`is_b2b = true`) displays both GSTINs and qualifies for `GSTR-1` / `IFF` & `GSTR-2B` matching.
4. As a **B2B customer with an invalid GSTIN or retired state code (`25`)**, I want immediate pre-checkout validation rejection (`400 INVALID_GSTIN`), so that broken tax invoices are never generated.
5. As a **refunded customer**, I want full or partial gateway refunds to automatically issue a downloadable Rule 53(1A) Credit Note (`CN/26-27/00001`) referencing my original invoice serial and date with exact proportional tax component reversals, so that my accounting records remain balanced.
6. As a **monthly recurring subscriber entering Cycle 2+ or crossing April 1 FY rollover**, I want renewal webhooks to generate fresh consecutive Tax Invoices under the active Financial Year series (`INV/27-28/00001` on April 1) for the new service window without mutating Cycle 1 invoices.
7. As a **staging operator / tester**, I want sandbox purchases to allocate separate `SBX/26-27/...` receipts clearly stamped `SANDBOX REHEARSAL RECEIPT — NOT A VALID TAX INVOICE` while preserving existing `INV-2026-0002..0005` history untouched.
8. As a **customer whose late webhook payment captures after subscription cancellation**, I want durable automatic refund/recovery tracking and linked reconciliation without silent uninvoiced cash capture or duplicate active subscriptions.
9. As an **AI platform user with held reservations across Free welcome-credit expiry**, I want `settleReservation` and promotional welcome grants to settle cleanly without balance corruption or wrongful paid-credit revocation on refunds.
10. As the **repository owner / release operator**, I want production readiness checks and production billing endpoints to **fail closed** if `SAC 998315` approval, `AIRA_FINANCE_TAX_SIGNOFF`, verified `09AAMCV4678C1ZV` matching `09`, or registered Lucknow address is absent, so unapproved tax invoices can never go live.

---

## 5. Implementation Decisions & Testing Seams (`/to-spec`)

### 5.1 Core Architectural & Schema Contracts

- **Canonical Tax Determination Module (`tax-determination`):**
  - Replace hardcoded `07` Delhi & `998431` defaults with verified `VIREXA AI VENTURES PRIVATE LIMITED` (`09` UP) defaults and runtime env overrides (`AIRA_GST_REGISTRATION_MODE`, `AIRA_SUPPLIER_NAME`, `AIRA_SUPPLIER_TRADE_NAME`, `AIRA_SUPPLIER_GSTIN`, `AIRA_SUPPLIER_PAN`, `AIRA_SUPPLIER_CIN`, `AIRA_SUPPLIER_ADDRESS`, `AIRA_SUPPLIER_STATE_CODE`, `AIRA_SUPPLIER_EMAIL`, `AIRA_SUPPLIER_SAC_CODE`, `AIRA_SUPPLIER_SAC_DESCRIPTION`, `AIRA_SUPPLIER_SAC_APPROVED`, `AIRA_GST_RATE_BPS`, `AIRA_EINVOICE_IRN_REQUIRED`, `AIRA_FINANCE_TAX_SIGNOFF`).
  - Expand `INDIAN_STATE_CODES` to all `37` active GST jurisdictions (`01`–`38` excluding `25`, plus `97` Other Territory), tagging `isUtgst: true` for `04, 26, 31, 35, 38`.
  - Implement strict `isValidGstin(gstin)` (regex + active state map + PAN consistency optional helper + Mod-36 check character).
  - Enforce Place of Supply per `IGST Sec 12(2)`: `B2B GSTIN -> B2C State on record -> fail-closed missing state on production checkout (or explicit Sec 12(2)(b)(ii) supplier state `09` only if explicitly invoked under documented non-checkout fallback)`. **Zero `UNKNOWN -> IGST` path.**
  - Enforce integer-paise reverse GST math + configurable odd-paisa intra-state rounding strategy (`ROUND_HALF_UP_PARITY` vs `FLOOR_REMAINDER`) governed by CA decision `U2`.
  - Enforce domestic `INR`-only currency check; non-INR throws `UNSUPPORTED_EXPORT_TAX_CURRENCY` while `AIRA_INTERNATIONAL_USD_BILLING_ENABLED !== 'true'`.

- **Backward-Compatible Migration `036_gst_invoice_compliance_snapshots.ts`:**
  - Create table `billing_document_sequences (document_scope, financial_year, last_number, updated_at, PRIMARY KEY(document_scope, financial_year))`.
  - Add nullable / defaulted snapshot columns to `billing_customers`, `billing_invoices`, and `billing_credit_notes`:
    - `billing_customers`: `billing_legal_name`, `billing_address_line1`, `billing_address_line2`, `billing_city`, `billing_state_code`, `billing_postal_code`, `billing_country`, `customer_gstin`, `gstin_validated_at`.
    - `billing_invoices`: `financial_year`, `document_kind`, `document_status` (`ISSUED | VOIDED | CANCELLED`), `voided_at`, `void_reason`, `invoice_timing_basis` (`CONTINUOUS_SUPPLY_CYCLE_SETTLEMENT | ADVANCE_PAYMENT_RECEIPT | RENEWAL_CYCLE`), `is_sandbox`, `billing_period_start`, `billing_period_end`, `tax_rate_percent`, `cgst_rate`, `sgst_rate`, `utgst_amount`, `utgst_rate`, `igst_rate`, `tax_calculation_snapshot`, `supplier_trade_name`, `supplier_address`, `supplier_state_code`, `supplier_pan`, `supplier_cin`, `supplier_email`, `customer_name`, `customer_email`, `customer_address`, `customer_state_code`, `customer_gstin`, `is_b2b`, `reverse_charge`, `pos_basis`, `sac_description`, `payment_method`, `gateway_order_id`, `gateway_payment_id`, `irn`, `irn_ack_no`, `irn_ack_date`, `signed_qr_code`.
    - `billing_credit_notes`: `financial_year`, `document_status` (`ISSUED | VOIDED`), `is_sandbox`, `original_invoice_date`, `reason`, `taxable_base`, `gst_amount`, `cgst_amount`, `sgst_amount`, `utgst_amount`, `igst_amount`, `tax_rate_percent`, `sac_code`, `place_of_supply`, `supplier_trade_name`, `supplier_address`, `supplier_state_code`, `customer_name`, `customer_address`, `customer_state_code`, `customer_gstin`, `is_b2b`, `statutory_gstr1_cutoff`, `irn`, `irn_ack_no`, `irn_ack_date`, `signed_qr_code`.
  - **Zero mutations** to `INV-2026-0001..0005` rows; guard `down()` identically to migration `033` against dropping populated financial records.

- **Document Allocation & Honest Format Advertising:**
  - IST FY resolver computes `"2026-27"` (`"26-27"`) from Apr 1 `00:00:00+05:30` to Mar 31 `23:59:59.999+05:30`.
  - Sequence scope isolates production (`INV/26-27/00001`, `CN/26-27/00001`) from sandbox (`SBX/26-27/00001`, `SCN/26-27/00001`), non-registered (`RCP/...`), and composition (`BOS/...`). Voided committed serials retain `document_status = 'VOIDED'` and are never recycled.
  - `billing-routes` adds `GET/PUT /api/billing/tax-profile`, extends `POST /api/billing/checkout/subscription` to require Billing State/UT (plus optional validated GSTIN/address), hardens `GET /api/billing/invoices/:invoiceNumber/download` (strips `usr_...` completely, renders A4 print CSS + Rule 46 fields + Sandbox watermark), and adds `GET /api/billing/credit-notes` + `.../download` (Rule 53(1A)).
  - **Honest PDF Advertising Policy:** Because binary `application/pdf` rendering is not enabled (`text/html` A4 printable output only), `pdfDownloadAvailable` stays `false` (paired with `printableDocumentAvailable: true`), and API/UI never claim `"Download PDF"` unless a verified binary PDF generator is added and tested.
  - **GSTR-1 / IFF (`QRMP`) Compatibility:** Invoice & credit-note snapshot columns expose exact fields required for quarterly `GSTR-1` / monthly `IFF` export queries (`B2B Table 4`, `B2C Table 7`, `Credit Notes Table 9B`, `HSN Table 12`, `Cancelled Table 13`).

- **Outstanding Financial Safety Fixes Retained:**
  - Rebase/merge PR `#217` (`6c90c129`) cleanly so cancellation retention & lazy expiry fixes are intact.
  - Classify Free welcome grants cleanly as `grant_type: 'promotional'` while preserving existing user balances.
  - Fix `settleReservation` vs expired `credit_grants` edge cases so reservations held across expiry settle accurately.
  - Harden late-payment-after-cancellation webhook path (`late_payment_superseded_recovery`) with automated/outbox refund reconciliation & Credit Note linkage if an invoice was issued.
  - Verify Cycle `2+` renewal webhook invoice generation (`cycleNumber >= 2`, fresh period bounds, FY numbering).

### 5.2 Testing Seam Decisions (`/to-spec`)
Following `/to-spec` ("prefer existing seams, test external behavior at highest boundary"):
1. **Tax & FY Engine Seam (`tax-determination` public functions):** Pure input-output contract tests verifying all 37 codes, UP intra-state vs inter-state splits, UTGST vs SGST, B2B GSTIN Mod-36 checksum & state override, Sec 12(2)(b)(ii) behavior, fail-closed unapproved SAC/registration guards, IST FY rollover (`Mar 31 23:59:59` -> `Apr 01 00:00:00`), and multi-step refund proportional rounding.
2. **PostgreSQL 18 Billing & Webhook Transactional Seam (`PaymentGatewayService` + `CommercialBillingService` against real PG 18):** Verify concurrent `INV/26-27/00001..N` allocation without gaps or duplicates, rollback safety, immutable invoice/credit-note snapshots persisting across subsequent profile edits, preserved historical `INV-2026-0002..0005` readability, Cycle 2+ renewal invoice generation, `settleReservation` across expiry, `'promotional'` grant refund isolation, and late-capture recovery.
3. **HTTP Billing Routes Seam (`createBillingRoutes` + UI render integration):** Verify auth ownership enforcement (`403`/`404`), absence of `usr_...` in invoice/credit-note HTML, mandatory Billing State/UT & GSTIN validation on checkout, Sandbox watermark presence, Credit Note download endpoint, and fail-closed `ProductionReadinessService` behavior.

---

## 6. Dependency-Ordered Implementation Task Graph

### Gate & Tax-Approval Classification Legend
- **`SAFE_BEFORE_TAX_APPROVAL`:** Can be implemented, tested in PG 18 CI, and deployed to **Staging** immediately without waiting for GST portal amendment acceptance (`13 Dec 2026`) or final CA rate/rounding sign-off (uses fail-closed config flags).
- **`BLOCKED_ON_TAX_APPROVAL`:** Production configuration / activation **strictly blocked** until `U1` (GST `SAC 998315` amendment), `U2` (CA written confirmation + Cycle `₹999` rounding rule), `U3` (sequence `00001` check), and `U4` (live merchant KYC + `GO LIVE`).

```
T0 (Baseline Sync 6c90c129) ──► T1 (Migration 036 Schema) ──┬──► T2 (Tax Engine & Fail-Closed Config) ──┐
                                                            ├──► T4 (FY Atomic Numbering & Snapshots) ─┼──► T5 (API & A4 Invoice/CN Routes) ──► T6 (Frontend Checkout & Settings UI)
                                                            └──► T3 (Sec 8.4 Ledger & Webhook Safety) ──┘
                                                                                                             │
                                                                                                             ▼
T9 (Prod Readiness & Owner GO LIVE) ◄── [U1+U2+U3+U4 Tax Gates] ◄── T8 (Staging E2E & Release Gates) ◄── T7 (PG 18 Regression Suite)
```

| Task ID | Task Title & Dependencies | Scope & Concrete Acceptance Criteria | Tax Approval Gate |
| :--- | :--- | :--- | :---: |
| **`T0`** | **Branch Baseline, Divergence Inspection & PR `#215` Non-Conflicting Hardening** *(No deps)* | Branch `feat/gst-invoicing-commercial-20261128` cleanly from certified `staging` (`6c90c129`); verify PR `#215` (`fd2f8b9a`) untouched; port non-conflicting PR `#215` hardenings (outbox CAS fencing, `isInternationalUsdBillingEnabled`, `production-readiness-closure.test.ts`); verify migration `036` slot & local PG `18.7` isolation. **AC:** Zero divergence missing from `6c90c129`, PR `#215` untouched, baseline Scenario 17 root cause reproduced cleanly. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T1`** | **Additive Migration `036` (`036_gst_invoice_compliance_snapshots.ts`)** *(Deps: `T0`)* | Add `billing_document_sequences`, `document_status`, `voided_at`, `void_reason`, `invoice_timing_basis`, and snapshot/tax columns across `billing_customers`, `billing_invoices`, `billing_credit_notes`; update `scripts/rehearse-disposable-restore.ts` & `verify-deploy.ts`. **AC:** Forward migration succeeds on PG 18; `INV-2026-0001..0005` untouched; `down()` blocks destructive drop when financial rows exist. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T2`** | **Jurisdiction Engine, GSTIN Validator & Configurable Supplier Defaults** *(Deps: `T0`)* | Update `tax-determination` to `VIREXA AI VENTURES PRIVATE LIMITED`, UP state `09` (remove `07` Delhi fallback everywhere), full `37`-code State/UT map (`UTGST` for `04, 26, 31, 35, 38`, reject `25`), Mod-36 GSTIN check, `IGST Sec 12(2)` (`no UNKNOWN->IGST`), externalized SAC/rate (`998315` / `18%` **explicitly provisional sandbox fixtures**), INR-only guard, configurable rounding policy, and IST Financial Year helper. **AC:** Unit tests verify `100%` of state/UT codes, invalid GSTIN rejection, `Mar 31`/`Apr 01` FY boundary, and fail-closed errors when `AIRA_SUPPLIER_SAC_APPROVED !== 'true'` or `AIRA_FINANCE_TAX_SIGNOFF !== 'true'` in production. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T3`** | **Retained `§8.4` Financial Ledger, Welcome-Grant & Entitlement Regressions** *(Deps: `T0`, `T1`)* | Reproduce & fix: (a) `settleReservation` across expired `credit_grants` (deducting expired held grant & sweeping released remainder); (b) Free welcome grants classified `grant_type: 'promotional'` & isolated from paid refund revocation; (c) durable `late_payment_superseded_recovery` refund/Credit Note linkage; (d) Cycle `2+` renewal service windows; (e) `adversarial-entitlements` Scenario 17 reproduction & fix. **AC:** Failing TDD test reproduces each defect first; all PG 18 & entitlement tests pass with zero regressions. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T4`** | **FY Consecutive Numbering, Immutable Snapshots, Voided Serials & Rule 53(1A) Credit Notes** *(Deps: `T1`, `T2`, `T3`)* | Wire atomic `allocateDocumentNumber` in `payment-gateway-service` (`INV/26-27/00001`, `CN/26-27/00001`, sandbox `SBX/26-27/00001`, `SCN/26-27/00001`) with explicit voided-serial retention (`never reuse`); freeze full Rule 46/53 snapshots & `invoice_timing_basis`; separate gateway settlement verification from statutory timing; implement proportional multi-refund Credit Note paise reconciliation; keep `pdf_download_available: false` (honest A4 HTML). **AC:** PG 18 concurrency test yields gap-free IDs `<= 16` chars; snapshots immune to later edits; Cycle 2+ emits Cycle 2 invoice; `INV-2026-0001..0005` untouched. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T5`** | **Billing Profile API, Checkout State Validation & A4 Invoice/Credit Note Endpoints** *(Deps: `T2`, `T4`)* | Add `GET/PUT /api/billing/tax-profile`; enforce mandatory State/UT + optional validated GSTIN/address on `POST /api/billing/checkout/subscription` (plus fail-closed IRN gate); update `GET /api/billing/invoices/:invoiceNumber/download` (remove `usr_...` & infra metadata, render A4 Rule 46 HTML from issuance snapshot, honest IT Act disclaimer, **`SANDBOX REHEARSAL RECEIPT`** watermark, no false PDF claims); add `GET /api/billing/credit-notes` & `.../download`. **AC:** Cross-account/tenant denial (`403`/`404`); HTML renders strictly from snapshot; zero `usr_...`. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T6`** | **Checkout & Settings UI Compliance Upgrades** *(Deps: `T5`)* | Update `PricingModal` (mandatory State/UT selector, optional B2B GSTIN/business drawer, live GST-inclusive split notice, remove hardcoded `SAC 998431`) and `SettingsModal` (Billing/GST Profile editor, Credit Note download controls, honest `"View / Print A4 Invoice"` copy, light/dark responsiveness, sandbox badge, accurate renewal/cancellation status). **AC:** `vite build`, `typecheck`, `oxlint`, and UI tests pass cleanly. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T7`** | **PostgreSQL 18 Financial Integrity, Concurrency & Regression Suite** *(Deps: `T2`–`T6`)* | Run full PG 18 & API billing suite (`commercial-gst-tax`, `invoice-concurrency-integrity`, `invoice-crash-recovery-postgres`, `production-readiness-closure`, `billing-subscription-readiness`, `outbox-cancellation-and-invoice-rehearsal`, `payment-durability-postgres`, `adversarial-entitlements`, `subscription-cancellation-lifecycle`, `rehearse-disposable-restore`, etc.). **AC:** Zero failures, zero suppressed tests, zero secret leaks. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T8`** | **Readiness Auditor, 3-Gate Separation & Staging Review Package** *(Deps: `T6`, `T7`)* | Update `ProductionReadinessService` & `production-owner-wizard.ps1` separating **Code Deploy / Merchant & Tax Provisioning / Commercial Billing Activation (`GO LIVE`)** gates, removing `07`/`998431`, validating `09AAMCV4678C1ZV` <-> `09` + `AAMCV4678C`, Lucknow address, `AIRA_SUPPLIER_SAC_APPROVED`, `AIRA_FINANCE_TAX_SIGNOFF`, and `AIRA_EINVOICE_IRN_REQUIRED`. Complete independent reviewer + Reality Checker sign-off and halt cleanly at permanent Staging deployment approval gate. **AC:** Reviewed staging candidate ready; zero permanent staging/prod mutations. | `SAFE_BEFORE_TAX_APPROVAL` |
| **`T9`** | **Statutory Approval Gate & Production Release Cutover (`GO LIVE`)** *(Deps: `T8` + `U1` + `U2` + `U3` + `U4`)* | **Hard External Blockers:** GST `SAC 998315` non-core amendment submitted & approved (`<= 13 Dec 2026`), written CA sign-off (SAC, rate, rounding, refund, authentication, e-invoicing), Gate B LIVE merchant KYC/env provisioning, Gate C explicit owner `GO LIVE`. | **`BLOCKED_ON_TAX_APPROVAL`** |

---

## 7. Exact Affected Files & Proposed Migrations

| Category | Exact Path | Required Change Summary |
| :--- | :--- | :--- |
| **Migration (New)** | `packages/db/src/migrations/036_gst_invoice_compliance_snapshots.ts` | Additive `billing_document_sequences`, customer billing/GST columns, immutable invoice & Rule 53(1A) credit-note snapshot columns, voided serial columns |
| **DB Verification & Parity** | `packages/db/src/scripts/verify-deploy.ts`, `scripts/rehearse-disposable-restore.ts` | Verify `billing_document_sequences`, `billing_invoices`, `billing_credit_notes` schema & 53-table restore parity |
| **Tax Engine** | `apps/api/src/billing/tax-determination.ts` | `09` UP supplier defaults, `37`-code State/UT + `UTGST`, GSTIN Mod-36 check, `Sec 12(2)`, externalized SAC/rate (`998315`/`18%` provisional only), fail-closed tax gates, FY helper |
| **Billing Service** | `apps/api/src/billing/payment-gateway-service.ts` | Atomic FY sequence allocator (`INV/26-27/...`, `CN/26-27/...`, `SBX/...`), voided serial preservation, snapshot persistence, proportional refund tax math, `pdf_download_available: false` (honest A4 HTML), Cycle 2+ & late-capture recovery + PR `#215` outbox CAS fencing |
| **Credit Ledger** | `apps/api/src/billing/commercial-billing-service.ts` | `settleReservation` across expired grants, welcome-grant `grant_type: 'promotional'`, billing tax profile CRUD helpers |
| **Billing API & Entry** | `apps/api/src/billing-routes.ts`, `apps/api/src/index.ts` | `/api/billing/tax-profile`, checkout State/GSTIN validation & B2B IRN guard, `isInternationalUsdBillingEnabled()`, A4 HTML invoice download (strip `usr_...`, Sandbox watermark), credit note list/download endpoints |
| **Readiness Engine** | `apps/api/src/billing/production-readiness.ts` | 3-gate separation (Code Deploy / Merchant & Tax Provisioning / Commercial Activation), validate `VIREXA AI VENTURES PRIVATE LIMITED`, `09AAMCV4678C1ZV` <-> `09` + PAN, Lucknow address, `AIRA_SUPPLIER_SAC_APPROVED`, `AIRA_EINVOICE_IRN_REQUIRED` |
| **Frontend Checkout & Settings** | `src/components/PricingModal.tsx`, `src/components/SettingsModal.tsx` | State/UT selector, optional B2B GSTIN/address inputs, Credit Note download UI, honest A4 printable button copy, remove hardcoded `SAC 998431` copy |
| **Owner Wizard** | `scripts/production-owner-wizard.ps1` | Remove `07` Delhi & `998431` defaults; collect/verify UP `09`, `09AAMCV4678C1ZV`, PAN/CIN, Lucknow address, `virexaiventures@gmail.com`, `SAC` approval, `FINANCE_TAX_SIGNOFF`, and 3-gate activation hold |
| **Docs / ADR** | `docs/adr/0002-payment-gateway-webhook-and-gst-model.md`, `docs/BILLING_SANDBOX_ACCEPTANCE_LEDGER.md` | Keep ADR aligned on UTGST/FY/Sec 12(2)/proportional credit note decisions; append verification evidence later without mutating existing records |
| **Tests (Update & Add)** | `test/commercial-gst-tax.test.ts`, `test/invoice-concurrency-integrity.test.ts`, `test/invoice-crash-recovery-postgres.test.ts`, `test/invoice-payment-evidence-regression.test.ts`, `test/outbox-cancellation-and-invoice-rehearsal.test.ts`, `test/payment-durability-postgres.test.ts`, `test/billing-subscription-readiness.test.ts`, `test/production-readiness-closure.test.ts`, `test/cashfree-razorpay-recurring-lifecycle.test.ts`, `test/account-billing-modal-render.test.ts`, `test/razorpay-companion-webhook-correlation.test.ts`, `test/integration/entitlements/adversarial-entitlements.test.ts`, plus new GST/Rule 53(1A)/FY/§8.4 PG18 tests | Comprehensive seam-based automated regression coverage (see §8) |

---

## 8. Acceptance Criteria & Regression Test Matrix

| Seam / Suite | Verification Command / Target | Mandatory Assertions (`PASS` Gate) |
| :--- | :--- | :--- |
| **Pure Tax & FY Seam** | `test/commercial-gst-tax.test.ts` (expanded) | All `37` active codes (`01`–`38` excl `25`, `97`); `09` UP -> `9% CGST + 9% SGST`; other State/UT -> `18% IGST`; `04/26/31/35/38` UT supplier test -> `CGST + UTGST`; `09AAMCV4678C1ZV` passes & bad checksums fail; `Sec 12(2)(b)(ii)` never defaults `UNKNOWN -> IGST`; IST `Mar 31 23:59:59` (`26-27`) vs `Apr 01 00:00:00` (`27-28`); fail-closed when `SAC_APPROVED`/`FINANCE_SIGNOFF` false; proportional partial-refund paise reconciliation (`sum === original`). |
| **PG 18 Invoice Concurrency & Recovery** | `npm run test:invoice-concurrency` & `npm run test:invoice-crash-recovery` | Concurrent settlements allocate unique gap-free `INV/26-27/00001..N` (`<= 16` chars); transaction rollback does not leak gaps; `Cycle 2+` gets new sequential number & dates; `INV-2026-0002..0005` untouched; immutable snapshots immune to later profile edits. |
| **PG 18 Payment, Cancellation & `§8.4` Durability** | `npm run test:payment-durability` & `test/subscription-cancellation-lifecycle.test.ts` & `test/outbox-cancellation-and-invoice-rehearsal.test.ts` | Full/partial refunds emit `CN/26-27/...` with Rule 53(1A) tax breakdown; `promotional` welcome grants isolated from paid refund revocation; `settleReservation` across expired grant leaves valid balance; captured late payments route durably to refund/recovery. |
| **API Auth, A4 HTML & Privacy** | `test/invoice-payment-evidence-regression.test.ts`, `npm run test:remediations` | Cross-principal invoice/CN download rejected (`403`/`404`); HTML contains **zero** `usr_...`; Sandbox rows display **`SANDBOX REHEARSAL RECEIPT — NOT A VALID TAX INVOICE`**; Production Tax Invoice & Credit Note HTML render Rule 46/53 fields cleanly. |
| **Readiness & Secrets Hygiene** | `test/production-readiness-closure.test.ts`, `test/billing-subscription-readiness.test.ts`, `npm run test:secrets` | Fails closed on missing `09` UP config, `998431`/`07` mismatch, unapproved SAC, or missing `AIRA_FINANCE_TAX_SIGNOFF`; passes only when verified UP config + live merchant creds + tax approvals are all present; zero leaked secrets. |
| **Frontend Build, Typecheck & Lint** | `npm run typecheck`, `npm run lint`, `npm run build`, `test/account-billing-modal-render.test.ts` | Zero TypeScript, `oxlint`, or Vite bundle errors; UI collects mandatory State/UT & validates optional B2B GSTIN cleanly; `test:recurring-subscriptions` passes (`Razorpay` & `Cashfree`). |

---

## 9. Readiness Verdicts & Recommended Next-Phase Capabilities

### Implementation Readiness Verdict: **READY FOR SAFE PRE-APPROVAL TASKS (`T0`–`T8`)**
The engineering design, backward-compatible migration (`036`), jurisdiction rules, immutable snapshot contract, API/UI seams, `§8.4` financial safety fixes, and PG 18 regression plan are completely specified. Tasks **`T0` through `T8`** can execute cleanly on a dedicated integration branch up through full Staging certification without mutating Production or relying on unapproved SAC/tax values (enforced by fail-closed readiness gates).

### Production Readiness Verdict: **BLOCKED — STRICT HOLD (`T9` NOT READY FOR `GO LIVE`)**
Live commercial billing in Production remains strictly **NO-GO** until all of the following external/statutory gates close:
1. **GST Non-Core Amendment (`SAC 998315`):** Must be submitted, authenticated, and approved on the GST portal (deadline **`13 December 2026`**) — currently only a saved unsubmitted draft.
2. **Written CA Confirmation (`U2`):** Signed approval of `SAC 998315`, `18%` rate on GST-inclusive `₹399`/`₹999`, `₹999` UP intra-state `±1 paisa` rounding rule, `AATO <= ₹5 Cr` e-invoicing status, and refund Credit Note terms.
3. **Branch & `§8.4` Remediation Execution (`T0`–`T8`):** PR `#215` synchronized with `6c90c129`, all `T0`–`T8` tasks implemented, reviewed, and green on Staging + PG 18 CI.
4. **Live Gateway KYC, Production Env Provisioning & Owner `GO LIVE` (`U3`–`U4`).**

### Recommended Installed Skills & Agents for Next Implementation Phase
*(Selected strictly from verified installed definitions)*
- **Pipeline Coordinator:** Skill [`agency-agents-orchestrator`](file:///C:/Users/WORKSTATION/.gemini/config/skills/agency-agents-orchestrator/SKILL.md) (for Dev ↔ QA loop control) OR GSD phase runner [`gsd-execute-phase`](file:///C:/Users/WORKSTATION/.gemini/config/skills/gsd-execute-phase/SKILL.md) with agent [`gsd-executor`](file:///C:/Users/WORKSTATION/.gemini/config/agents/gsd-executor.md).
- **Schema & PG 18 Safety:** Skill [`postgres-patterns`](file:///C:/Users/WORKSTATION/.gemini/config/skills/postgres-patterns/SKILL.md) + specialist review agent [`database-reviewer`](file:///C:/Users/WORKSTATION/.gemini/config/agents/database-reviewer.md).
- **Payments, Tax & Backend Implementation:** Skills [`tdd`](file:///C:/Users/WORKSTATION/.agents/skills/tdd/SKILL.md) & [`implement`](file:///C:/Users/WORKSTATION/.agents/skills/implement/SKILL.md), with domain/architecture patterns from [`agency-payments-billing-engineer`](file:///C:/Users/WORKSTATION/.gemini/config/skills/agency-payments-billing-engineer/SKILL.md) and [`agency-backend-architect`](file:///C:/Users/WORKSTATION/.gemini/config/skills/agency-backend-architect/SKILL.md) (plus statutory review sanity-check via [`agency-tax-strategist`](file:///C:/Users/WORKSTATION/.gemini/config/skills/agency-tax-strategist/SKILL.md)).
- **Frontend Billing Profile & Checkout UI:** Skill [`agency-frontend-developer`](file:///C:/Users/WORKSTATION/.gemini/config/skills/agency-frontend-developer/SKILL.md) + review agent [`react-reviewer`](file:///C:/Users/WORKSTATION/.gemini/config/agents/react-reviewer.md) alongside [`typescript-reviewer`](file:///C:/Users/WORKSTATION/.gemini/config/agents/typescript-reviewer.md).
- **Security, Code Review & Independent Release Gate:** Skills [`code-review`](file:///C:/Users/WORKSTATION/.gemini/config/skills/code-review/SKILL.md), [`security-review`](file:///C:/Users/WORKSTATION/.gemini/config/skills/security-review/SKILL.md), and [`verification-before-completion`](file:///C:/Users/WORKSTATION/.agents/skills/verification-before-completion/SKILL.md) / [`gsd-verify-work`](file:///C:/Users/WORKSTATION/.gemini/config/skills/gsd-verify-work/SKILL.md), backed by agents [`security-reviewer`](file:///C:/Users/WORKSTATION/.gemini/config/agents/security-reviewer.md), [`gsd-verifier`](file:///C:/Users/WORKSTATION/.gemini/config/agents/gsd-verifier.md), and [`agency-reality-checker`](file:///C:/Users/WORKSTATION/.gemini/config/skills/agency-reality-checker/SKILL.md).

---

## 10. Out of Scope (`SPEC-GST-BILLING-2026-01`)
- Enabling international `USD` billing (`$7.99` / `$19.99`), `LUT (RFD-11)`, or cross-border IGST zero-rated exports.
- Live IRP GSP API integration for B2B `IRN` + dynamic QR generation (schema placeholders & fail-closed guard only while `AATO <= ₹5 Cr`).
- Submitting or authenticating the GST portal non-core amendment draft (`SAC 998315`).
- Retroactively altering or renumbering historical sandbox records `INV-2026-0002`–`INV-2026-0005`.
- Modifying `prod-release`, Vercel Production environment variables, or promoting PR `#215`.
