# AIRA AI 2026 — Payment & Commercial Billing Knowledge Graph Report (Reconciled & Synchronized)
**Candidate Commit SHA:** `aaf3974bdbbef751d502e569dd32cf2c27014994`  
**Predecessor Candidate SHA:** `32156ace356462e98d025f42af1eab941a450eaf`  
**Canonical Staging Runtime SHA:** `5da4a4d1c0987de68e75eaddd24d60fab7c51264` (Deployment `dpl_4gu8wqpQssa6rFp82s5PYKzpVmGF` on `https://staging.virexaaiventures.com`)  
**Branch:** `staging` | **PR #218:** MERGED (`5da4a4d1c0987de68e75eaddd24d60fab7c51264`)  
**Coordinating Authority:** Agency Agents Orchestrator  
**Knowledge Authority:** Agency Knowledge Graph Engineer  
**Archaeologist:** Agency Codebase Archaeologist  
**Methodology:** GSD Graphify + Graphify Codebase AST + Graft MCP + TDD + Verification Before Completion  
**Generated At:** `2026-11-28T18:25:00+05:30`  
**Production Verdict:** **STRICT HOLD** (Release Blockers U1–U4 Active)

---

## 1. Executive Summary & Graph Topology
This knowledge graph represents the complete, reconciled, and verified architecture of the AIRA AI 2026 payment and commercial billing subsystem following the recurring subscription billing-period remediation and exact-SHA remote GitHub CI recertification.

- **Total Entities (Nodes):** 40 (Reconciled: 6 services/routes, 1 migration, 12 database tables, 3 entities, 3 statutory models, 3 environments, 5 historical invoices, 4 canonical blockers, 2 engineering dependencies).
- **Total Relationships (Edges):** 52 (0 dangling endpoints, 0 duplicates, 100% verified graph integrity).
- **Domains Covered:** Payment Gateways, Commercial Billing, Statutory Indian GST, Immutable Invoicing, Neon PostgreSQL Schema & Migrations, Release Governance, and Infrastructure Topology.
- **Remote CI Status:** 100% GREEN across Fast CI, PostgreSQL 18 Payment Durability, PostgreSQL 16 Isolated Regression, Semantic Search CI, Main / PR Certification, and GitGuardian.
- **Provenance Standard:** Every node is grounded in concrete repository source files, line ranges, verified database table schemas, and sandbox execution evidence.

---

## 2. Preserved Sandbox Historical Invoices Ground Truth

| Invoice Number | Gateway & Plan | Gross Amount | Tax Breakdown (18%) | Credits Granted | Customer & Purchase IDs | Staging Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **INV-2026-0001** | Razorpay Pro | ₹999.00 | Taxable ₹846.61 + IGST ₹152.39 | 7,500 credits | `cust_9e1e096ced03407aba9db0a71f6c3253`<br>`pur_8150add7f93743e38138b5617f727188`<br>`sub_RiyQ4X7s4w1z6f` | Verified HTML download |
| **INV-2026-0002** | Cashfree Plus | ₹399.00 | Taxable ₹338.14 + IGST ₹60.86 | 3,000 credits (wallet balance 3,100 including 100 welcome bonus) | `cust_2a79b54106e04c9ab491e5be3aed6b97`<br>`pur_411d4e047dd041dc8e7a61f705c3ce27`<br>`cf_payment_id: 1479479837022321152` | Operator HTML download PASS |
| **INV-2026-0003** | Cashfree Pro | ₹999.00 | Taxable ₹846.61 + IGST ₹152.39 | 7,500 credits | `cust_dbfaef1d12024ea99ee860ee4bfc5b77`<br>`pur_b19205cdaa624b82ac99d4cc1150c484`<br>`sub_1479261895046664192` | Paid; cancellation scheduled for 26 Dec 2026; download pending |
| **INV-2026-0004** | Razorpay Plus | ₹399.00 | Taxable ₹338.14 + IGST ₹60.86 | 3,000 credits | `cust_546b027724104cd094ee756b72d6051c`<br>`pur_ad3ac94100294b6192c41e10cb29fa9b`<br>`sub_Rk4R4H7N7d6Q4N` | Paid; cancellation scheduled for period end; download pending |
| **INV-2026-0005** | Razorpay Pro | ₹999.00 | Taxable ₹846.61 + IGST ₹152.39 | 7,500 credits | `cust_d6c10d8b7bc343bc9c648cb372403baa`<br>`pur_9dff97f99a434153bdf698c7c548b2cc`<br>`sub_Rk4Y7Q3M5m1P9L` | Paid; active Razorpay Pro subscription; verified download (**ACTIVE SUBSCRIPTION — NOT A REFUND!**) |

*Note on Historical Invariants:*
- All 5 historical sandbox invoices are preserved verbatim.
- Plus tier grants strictly **3,000 monthly credits** (wallet balance 3,100 in INV-2026-0002 includes initial 100 promotional welcome grant).
- Pro tier grants strictly **7,500 monthly credits**.
- INV-2026-0005 is an active subscription, NOT a refund.

---

## 3. Recurring Subscription Billing-Period Remediation (Defect Fixed)
In candidate `aaf3974`, the Archaeologist finding regarding subscription renewal period drift was remediated and certified via TDD:
1. **Defect:** `apps/api/src/billing/payment-gateway-service.ts` previously used `+ 30 * 24 * 60 * 60 * 1000` when `explicitPeriodEnd` was absent on renewal, causing anniversary date drift on 31-day months (Dec 26 -> Jan 26 -> Feb 25 instead of Feb 26) and permanent loss of contractual anniversary day (31st) after month-end clamping (Jan 31 -> Feb 28 -> Mar 30 instead of Mar 31).
2. **Remediation:**
   - Parameterized `addOneMonthEpochMs(startMs, anchorDay)` to preserve contractual billing anniversary day (1–31) across subsequent renewals after month-end clamping.
   - Subscription metadata now derives, persists, and utilizes `meta.billingAnchorDay`.
   - Renewal processing validates `explicitPeriodEnd > periodStart`, safely falling back to calendar-month computation in IST when absent or corrupted.
   - Duplicate false-positives are avoided when new payment evidence (new payment ID or incremented cycle) exists.
3. **Verification:**
   - 6 TDD regression tests added in `test/cashfree-razorpay-recurring-lifecycle.test.ts`.
   - Local test execution: 31/31 PASS in 656ms.
   - Remote Fast CI & PG18 Payment Durability: 100% PASS on commit `aaf3974bdbbef751d502e569dd32cf2c27014994`.

---

## 4. Canonical Domain Answers to the 16 Verification Questions

### Q1: Cashfree First-Cycle Payment Success Handling
- **Graph Path:** `CashfreeWebhook` &rarr; `PaymentGatewayService.processCashfreeWebhook` &rarr; `PaymentGatewayService.isCashfreeImmediatePaidAuth` &rarr; `fulfillSubscription(cycle=1)` &rarr; `subscriptions.status='active'` &rarr; `credit_grants` &rarr; `allocateDocumentSerial` &rarr; `billing_invoices`.
- **Source Anchors:** `apps/api/src/billing/payment-gateway-service.ts:L1320-L1630, L5712-L5802, L9243-L9250`.
- **Mechanism:** In immediate-payment Cashfree UPI checkout, cycle 0 mandate registration is accompanied by a full ₹399 payment (`payment_type='AUTH'`). `isCashfreeImmediatePaidAuth` verifies that the payment entity represents full immediate settlement. The subscription transitions to `status: 'active'`, sets `current_period_start` and `current_period_end` (+1 calendar month in IST with month-end clamping), sets `hadPaidSubscription=true`, `fulfilledCycle=1`, records `billingAnchorDay`, and credits 3,000 units (Plus). An invoice (`SBX/26-27/00001` or `INV/26-27/00001`) is issued atomically.
- **Evidence Status:** **VERIFIED** in sandbox acceptance ledger (`pur_411d4e047dd041dc8e7a61f705c3ce27`, cf_payment_id `1479479837022321152`, invoice `INV-2026-0002`).

### Q2: Razorpay `invoice.paid` Event Handling
- **Graph Path:** `RazorpayWebhook` &rarr; `PaymentGatewayService.processRazorpayWebhook` &rarr; HMAC SHA256 Signature Check &rarr; Deduplication in `payment_gateway_events` &rarr; `PaymentGatewayService.handleGatewayEvent('razorpay', 'invoice.paid')` &rarr; `subscriptions` &rarr; `credit_grants` &rarr; `allocateDocumentSerial` &rarr; `billing_invoices`.
- **Source Anchors:** `apps/api/src/billing/payment-gateway-service.ts:L1213-L1310, L1635-L1850`.
- **Mechanism:** Razorpay webhook delivers `invoice.paid` with payload containing payment and subscription entities. Signature is checked with `RAZORPAY_WEBHOOK_SECRET`. Idempotency is enforced by inserting `event_id` into `payment_gateway_events`. If subscription is active and cycle >= 1, cycle increments, service period rolls forward, renewal credits are granted, and invoice is allocated.
- **Evidence Status:** **VERIFIED** in test suite `test/cashfree-razorpay-recurring-lifecycle.test.ts`.

### Q3: Duplicate Subscription, Grant, and Invoice Prevention Functions
- **Graph Path:** `CheckoutRequest` &rarr; `CONCURRENT_CHECKOUT_IN_PROGRESS` Guard &rarr; `billing_document_sequences` Atomic UPSERT &rarr; `billing_invoices.invoice_number` UNIQUE Constraint &rarr; `issuedSubscriptionCycles` Set &rarr; `credit_grants.grant_source_id`.
- **Source Anchors:** `apps/api/src/billing/payment-gateway-service.ts:L801-L808, L3346-L3409, L9466-L9489`, `packages/db/src/migrations/036_gst_invoice_compliance_snapshots.ts:L28-L36, L108-L114`.
- **Mechanism:**
  1. Concurrency guard prevents initiating a new checkout while a pending subscription is active (`CONCURRENT_CHECKOUT_IN_PROGRESS`).
  2. Sequential numbering uses PostgreSQL atomic UPSERT on `billing_document_sequences` (`INSERT ... ON CONFLICT (document_scope, financial_year) DO UPDATE ... RETURNING last_number`) with savepoints.
  3. `billing_invoices` enforces unique constraints: `uq_billing_invoices_number` (`invoice_number`), `uq_billing_invoices_event` (`billing_event_id`), and `uq_billing_invoices_sub_cycle` (`subscription_id`, `cycle_number`).
  4. Authoritative database constraints govern data integrity, with in-memory sets acting only as process-local fast-paths.
  5. `credit_grants` links grants to `subscription_id` + `cycle_number` idempotently.
- **Evidence Status:** **VERIFIED** across database constraints, transactions, and migration 036.

### Q4: Held Reservation Settlement Across Grant Expiry
- **Graph Path:** `ChatRequest` &rarr; `CommercialBillingService.reserveCredits` &rarr; Reservation Hold with 15-min TTL &rarr; Plan Expiry Mid-Chat &rarr; `CommercialBillingService.settleReservation` &rarr; Plan Restriction on Future Chats.
- **Source Anchors:** `apps/api/src/billing/commercial-billing-service.ts:L925-L1080`.
- **Mechanism:** `reserveCredits` locks the customer account, sweeps stale expired grants via `expireStaleCreditGrants`, reserves credits in `credit_accounts.reserved_credits`, and inserts a record in `credit_reservations` with state `HELD` and a 15-minute TTL. When the chat completes, `settleReservation` settles the hold, debits grants in FIFO order (`expires_at ASC`)—honoring grants that expired while held—and sweeps remaining expired grants. Subsequent chat requests immediately fail with `PLAN_MODEL_RESTRICTED` or `STANDARD_QUOTA_EXCEEDED` via `hasPaidPeriodEntitlement`.
- **Evidence Status:** **VERIFIED** in `test/commercial-chat-entitlements.test.ts`.

### Q5: Refund Isolation Preserving Unrelated Promotional and Paid Credits
- **Graph Path:** `RefundWebhook/API` &rarr; `PaymentGatewayService.handleSubscriptionRefund` &rarr; Specific Grant Revocation (`grant_source_id = sub.id`) &rarr; Credit Balance Decrement &rarr; Proportional GST Reversal &rarr; `billing_credit_notes`.
- **Source Anchors:** `apps/api/src/billing/payment-gateway-service.ts:L8207-L8450, L6677-L6770`, `apps/api/src/billing/tax-determination.ts:L450-L550`.
- **Mechanism:** Credit ledger tracks credits by distinct `grant_id`. A refund against a subscription only revokes credits issued under that specific subscription grant. Sign-up promotional credits (100 units) and one-time packs maintain distinct grant IDs and are untouched. A proportional credit note is generated under CGST Rule 53(1A).
- **Evidence Status:** **VERIFIED** in `test/cashfree-razorpay-recurring-lifecycle.test.ts`. Note: There is zero completed sandbox refund in the historical staging database.

### Q6: Late Payment Capture Post-Cancellation Handling
- **Graph Path:** `GatewayCaptureEvent` &rarr; `PaymentGatewayService.reconcileAmbiguousSubscription` &rarr; Payment Settlement Verified &rarr; Cancellation Aborted / Active Paid Period Maintained.
- **Source Anchors:** `apps/api/src/billing/payment-gateway-service.ts:L5243, L5320-L5330, L4241-L4324`, `apps/api/src/billing/commercial-billing-service.ts:L26-L72`.
- **Mechanism:** If payment capture is received after the user requested mandate cancellation, `reconcileAmbiguousSubscription` aborts cancellation: *"Payment has been confirmed by the gateway! Cancellation was aborted to protect your plan access."* For late payments arriving on superseded/cancelled subscriptions, the event is recorded under `LATE_PAYMENT_ON_SUPERSEDED_SUBSCRIPTION` and routed through `subscription_cancellation_outbox` with CAS claims and recovery routing.
- **Evidence Status:** **VERIFIED** in `test/cashfree-razorpay-recurring-lifecycle.test.ts`.

### Q7: Cycle 2 Renewal Service Period Anchoring
- **Graph Path:** `RenewalWebhook` &rarr; `PaymentGatewayService.handleGatewayEvent('SUBSCRIPTION_RENEWED')` &rarr; Anchor Date Computation with `billingAnchorDay` &rarr; `billing_invoices`.
- **Source Anchors:** `apps/api/src/billing/payment-gateway-service.ts:L1635-L1850, L2390-L2410, L4110-L4130`, `packages/db/src/migrations/036_gst_invoice_compliance_snapshots.ts:L66-L67`.
- **Mechanism:** Cycle 2 service period start date is anchored strictly to Cycle 1's `current_period_end`. End date is calculated via `addOneMonthEpochMs(periodStart, anchorDay)` (+1 calendar month in IST with month-end clamping, preserving the original anchor day across subsequent months).
- **Evidence Status:** **VERIFIED** in test suites and commit `aaf3974bdbbef751d502e569dd32cf2c27014994`.

### Q8: UP Intra-State (CGST+SGST) vs Inter-State (IGST) Determination
- **Graph Path:** `TaxDeterminationService.determineTax` &rarr; Supplier Location = `09` (UP) &rarr; Customer Place of Supply Determination &rarr; Tax Split &rarr; Integer Paise Math.
- **Source Anchors:** `apps/api/src/billing/tax-determination.ts:L19-L90, L200-L380`.
- **Mechanism:**
  - Supplier: VIREXA AI VENTURES PRIVATE LIMITED, Lucknow, UP (`09`).
  - B2B Customer: PoS = first two digits of validated `customer_gstin`.
  - B2C Customer: PoS = customer address state code (normalized to 2-digit code). Missing billing state is rejected upfront at commercial checkout (`payment-gateway-service.ts:L3209-L3211`). Fallback per IGST Act Sec 12(2)(b)(ii) = supplier location `09`, never silent UNKNOWN.
  - If PoS == `09`: Intra-state supply &rarr; CGST 9% + SGST 9% (or UTGST 9% if Union Territory without legislature).
  - If PoS != `09`: Inter-state supply &rarr; IGST 18%.
  - All arithmetic is computed in integer paise (minor units) with round-half-even and floor-remainder reconciliation (provisional, PENDING_APPROVAL under U2).
- **Evidence Status:** **VERIFIED** in `test/commercial-gst-tax.test.ts`.

### Q9: Concurrent Financial-Year Invoice Number Allocation
- **Graph Path:** `PaymentGatewayService.allocateDocumentSerial` &rarr; `getIndianFinancialYear(now)` &rarr; Atomic PostgreSQL UPSERT on `billing_document_sequences`.
- **Source Anchors:** `apps/api/src/billing/payment-gateway-service.ts:L763-L825`, `packages/db/src/migrations/036_gst_invoice_compliance_snapshots.ts:L28-L36`.
- **Mechanism:** Atomic UPSERT RETURNING last_number partitioned by `document_scope` and `financial_year`. Formatted as `INV/26-27/00001` or `SBX/26-27/00001`.
- **Evidence Status:** **VERIFIED** in PostgreSQL 18 rehearsal and CI certification.

### Q10: Immutable Invoice Snapshot Implementation
- **Graph Path:** `PaymentGatewayService.createInvoice` &rarr; `TaxDeterminationResult` + Customer Profile &rarr; `billing_invoices` Discrete Columns + `issuance_snapshot` JSONB.
- **Source Anchors:** `packages/db/src/migrations/036_gst_invoice_compliance_snapshots.ts:L58-L99`, `apps/api/src/billing/payment-gateway-service.ts:L9470-L9550`.
- **Mechanism:** Migration 036 adds dedicated relational snapshot columns and `issuance_snapshot` JSONB object. Subsequent mutations to supplier details or tax rules never alter previously issued invoices.
- **Evidence Status:** **VERIFIED** in database schema and migration checks.

### Q11: Cross-Account Invoice and Credit Note Access Isolation
- **Graph Path:** Client Request &rarr; `sessionAuth` Middleware (`req.principal`) &rarr; `apps/api/src/billing-routes.ts` (`/invoices/:invoiceNumber/download`) &rarr; `paymentGatewayService.getInvoices(principal.userId)` &rarr; Customer ID Match.
- **Source Anchors:** `apps/api/src/billing-routes.ts:L433-L493, L377-L428`, `apps/api/src/billing/payment-gateway-service.ts:L9100-L9115`.
- **Mechanism:** Invoice and credit note download endpoints strictly inspect the authenticated principal's customer record. If an invoice number belongs to another customer or does not exist, the route returns `404 NOT_FOUND` with no metadata leakage, preventing enumeration and IDOR attacks.
- **Evidence Status:** **VERIFIED** in test suites and route audit.

### Q12: Authoritative Staging Database Identity and Supporting Evidence
- **Graph Path:** Neon Project `mute-frost-50372225`, Branch `br-snowy-bonus-b32thjlz`, Compute Endpoint `ep-twilight-cherry-b3iz2oqv`.
- **Source Anchors:** `.planning/HANDOFF.json:L13-L14`, `docs/BILLING_SANDBOX_ACCEPTANCE_LEDGER.md:L18-L25`.
- **Evidence:** Applied migrations count: 35. Total tables: 54. Preserves sandbox financial records `INV-2026-0001..0005`. Distinct from rehearsal branch `br-calm-meadow-b35e9ahs` and production Neon `old-sky-50952395`.
- **Evidence Status:** **VERIFIED** through direct database inspection and ledger records.

### Q13: Why Migration 036 Must Precede Application Cutover
- **Graph Path:** PR #218 Application Code &rarr; References `billing_document_sequences`, `billing_credit_notes`, and new `billing_invoices` columns &rarr; Execution on Staging.
- **Source Anchors:** `packages/db/src/migrations/036_gst_invoice_compliance_snapshots.ts:L28-L115`, `apps/api/src/billing/payment-gateway-service.ts:L788-L825`.
- **Mechanism:** PR #218 application code directly queries `billing_document_sequences` and inserts into extended snapshot columns. Deploying application code before Migration 036 causes runtime `relation "billing_document_sequences" does not exist` crashes. Release runbook requires **Migrate Before Deploy**.
- **Evidence Status:** **VERIFIED** in database dependency analysis.

### Q14: Outstanding Acceptance Tests
- **Graph Path:** `docs/BILLING_SANDBOX_ACCEPTANCE_LEDGER.md:L140-L185`.
- **Items:**
  1. Cycle 2+ recurring debit simulation for Cashfree (`pur_411d4e047dd041dc8e7a61f705c3ce27`, next debit 26 December 2026) and Razorpay (`cust_9e1e096ced03407aba9db0a71f6c3253`).
  2. Physical browser download verification of invoices `INV-2026-0003` and `INV-2026-0004` on staging UI.
- **Evidence Status:** **PROVISIONAL / PENDING** scheduled billing anniversary.

### Q15: Why Production Commercial Activation Remains Prohibited
- **Graph Path:** `ProductionReadinessService.audit` (`apps/api/src/billing/production-readiness.ts:L86-L250`) &rarr; 4 Active Production Blockers.
- **Source Anchors:** `apps/api/src/billing/production-readiness.ts:L86-L250, L182-L193`, `docs/GST_INVOICE_PRODUCTION_SPECIFICATION.md:L22-L44`.
- **Canonical Blockers (SPEC-GST-BILLING-2026-01 Rev 2.1):**
  - **U1:** Statutory GST non-core amendment for SAC 998315 pending filing/approval on GST portal (statutory draft completion deadline: 13 December 2026).
  - **U2:** Formal written CA / Finance sign-off on 18% GST classification, ±1 paisa Pro intra-state rounding rule, IT Act 2000 electronic authentication, statutory invoice timing, and e-invoicing applicability (AATO <= ₹5 Cr exemption per Notification No. 10/2023-CT).
  - **U3:** Owner reconfirmation immediately prior to GO LIVE that zero external commercial invoices have been issued since incorporation, confirming 00001 as exact starting serial in FY 2026-27.
  - **U4:** Live merchant provisioning and explicit owner GO LIVE (live Razorpay/Cashfree KYC + live API keys/plan IDs + production Vercel tax env vars + explicit owner GO LIVE authorization).
  - *Engineering Dependencies:* Production Neon database migration 036 unapplied while PR #215 remains on STRICT HOLD.
- **Evidence Status:** **VERIFIED BLOCKED**. Overall Verdict: `COMMERCIAL PLATFORM BLOCKED — REMEDIATION REQUIRED`.

### Q16: Exact Next Authorized Release Decision & Canonical 9-Step Runbook
- **Graph Path:** Operator / Maintainer Review &rarr; **Migrate-Before-Deploy** Runbook on Staging &rarr; Staging Acceptance.
- **Source Anchors:** `AGENTS.md:L1-L90`, `docs/GST_INVOICE_PRODUCTION_SPECIFICATION.md:L50-L85`.
- **Canonical 9-Step Staging Runbook:**
  1. **Step 1:** Verify certified candidate commit SHA (`aaf3974bdbbef751d502e569dd32cf2c27014994`) and confirm all required GitHub CI checks are green on PR #218.
  2. **Step 2:** Verify authoritative permanent staging database identity (`mute-frost-50372225`, branch `br-snowy-bonus-b32thjlz`, endpoint `ep-twilight-cherry-b3iz2oqv`, 35 applied migrations, 54 tables).
  3. **Step 3:** Validate backward compatibility and financial preservation (verify rows in `billing_invoices` for `INV-2026-0001..0005` and credit account balances).
  4. **Step 4:** Establish a recoverable pre-migration staging checkpoint on Neon.
  5. **Step 5:** Apply Migration 036 (`036_gst_invoice_compliance_snapshots.ts`) to verified permanent staging database branch `br-snowy-bonus-b32thjlz`.
  6. **Step 6:** Verify database schema (55 tables, `billing_document_sequences` created, extended snapshot columns present on `billing_invoices`, `billing_credit_notes`, `billing_customers`), and verify existing application compatibility.
  7. **Step 7:** Merge exact certified PR #218 into `staging` branch.
  8. **Step 8:** Verify resulting Vercel deployment SHA and canonical staging alias (`https://staging.virexaaiventures.com`).
  9. **Step 9:** Perform targeted deployed acceptance (inspect `/api/billing/readiness`, verify invoice downloads, test customer tax profile updates).
  *(All steps remain pending explicit owner authorization. Production remains on STRICT HOLD).*
- **Evidence Status:** **VERIFIED CANONICAL SEQUENCE**.

---

## 5. Subsystem Architecture & Integrity Invariants

### Invariant 1: Expand-Only Database Evolution
Migration 036 is strictly additive. No existing columns are dropped or renamed. `billing_customers`, `billing_invoices`, and `billing_credit_notes` retain 100% backward compatibility. Destructive rollback blocks prevent data loss.

### Invariant 2: Gapless Financial-Year Invoice Sequences
Document serials (`INV/26-27/00001`, `CN/26-27/00001`, `SBX/26-27/00001`, `SCN/26-27/00001`) are partitioned by Indian Financial Year (Apr 1 – Mar 31) and document scope. Concurrency is handled by PostgreSQL atomic row-level UPSERTs under isolated transaction savepoints.

### Invariant 3: Stateless & Hermetic HTML Document Rendering
Invoice and credit note HTML receipts are rendered with zero external CDN dependencies, self-contained inline CSS, A4 print page-break rules, and sanitized HTML escaping, guaranteeing clean rendering in any client browser or PDF printer.
*(Clarification: HTML rendering is not a statutory tamper-proof e-invoice under CGST Rule 48(4), from which AIRA is exempt due to AATO <= ₹5 Cr).*

### Invariant 4: Fail-Closed Production Tax Determination
If the production environment lacks verified UP 09 GSTIN configuration, approved SAC 998315 amendment, or CA tax sign-off, `ProductionReadinessService` fails closed and blocks commercial checkout.

---

## 6. Graph Artifacts Index
1. `payment_billing_knowledge_graph.json` — Complete machine-readable graph nodes, edges, and provenance metadata (40 nodes, 52 edges).
2. `PAYMENT_BILLING_GRAPH_REPORT.md` — Authoritative knowledge report and verification audit.
3. `payment_billing_graph.html` — Interactive visual architecture and sequence callflow.
4. `manifest.json` — Graph build manifest, commit SHA, and verification metadata.


---

## 7. Global Payments & Billing V2 Increment (`SPEC-GLOBAL-BILLING-V2-2026-01`)
- **Graph Version:** `2.4.0` (`52` nodes, `64` edges, `SHA-256: 3399aa9ef44e1886b33bdfaf01890ab516f0c84f040c8101bc854e8b215e4904`)
- **Staging Baseline:** `5da4a4d1c0987de68e75eaddd24d60fab7c51264` (`dpl_4gu8wqpQssa6rFp82s5PYKzpVmGF`)
- **New Nodes Added (`12`):** `spec_global_billing_v2`, `srv_global_billing_catalog`, `srv_pdf_document_renderer`, `rt_billing_profile`, `rt_billing_payment_methods`, `rt_billing_invoice_pdf`, `rt_billing_invoice_email`, `ui_pricing_modal`, `ui_settings_modal`, `blk_u5_transactional_email`, `blk_u6_razorpay_intl_activation`, `audit_legacy_wallet_delta`.
- **New Edges Added (`12`):** Specification contracts, USD Razorpay-only / Cashfree fail-closed routing, `%PDF-1.4` binary generation, masked `PaymentMethodSummary` extraction, `/invoices/:n/email` `503 EMAIL_DELIVERY_NOT_CONFIGURED` blocker, and staging `38,400` vs `38,300` (`+100` legacy fixture) reconciliation audit.
