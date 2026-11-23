---
status: verified_and_ready
trigger: "P0 Cashfree Recurring Subscription Checkout Failure (GATEWAY_SUBSCRIPTION_FAILED: customer_details.customer_phone_missing)"
created: 2026-11-23T11:00:00.000Z
updated: 2026-11-23T12:08:00.000Z
symptoms:
  expected: "Authenticated Cashfree recurring subscription checkout initiation on staging succeeds, creating a Cashfree periodic subscription checkout session and returning auth_link."
  actual: "Cashfree Subscriptions API (v2023-08-01) returned HTTP 400 Bad Request: customer_details.customer_phone_missing. Checkout failed with GATEWAY_SUBSCRIPTION_FAILED."
  error: "GATEWAY_SUBSCRIPTION_FAILED: Cashfree monthly recurring subscription creation failed (HTTP 400): {\"message\":\"customer_details.customer_phone is required\",\"code\":\"customer_details.customer_phone_missing\",\"type\":\"invalid_request_error\"}"
  gateway: "Cashfree TEST (CASHFREE_ENV=TEST, CASHFREE_APP_ID=TEST...)"
  plan: "Pro (₹999/month, INR, recurring periodic)"
  staging_commit: "467f554d6a2f7f9630b088fb412fadaa2b47c925"
  staging_deployment: "dpl_5GEJ6rpogSzA2UnPJBkMM4tCQRc2"
  dedicated_principal: "neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a"
  billing_customer: "cust_2a79b54106e04c9ab491e5be3aed6b97"
  neon_database: "mute-frost-50372225 / br-snowy-bonus-b32thjlz"

Root Cause Analysis:
  summary: "Cashfree Subscriptions API v2023-08-01 strictly enforces the customer_details.customer_phone field for recurring subscription e-mandates due to Reserve Bank of India (RBI) e-mandate pre-debit SMS notification mandates. In payment-gateway-service.ts lines 2357-2360, customer_details was constructed with customer_id and customer_email, while customer_phone was completely omitted. Furthermore, neither billing-routes.ts nor PricingModal.tsx accepted or collected mobile contact details from the customer."
  investigation_findings:
    - schema_inspection: "Inspected packages/db/src/migrations/020_commercial_billing_ledger.ts. Neither users nor billing_customers possesses a dedicated phone column. billing_customers has name, email, and tax_info (jsonb). subscriptions has metadata (jsonb)."
    - zero_db_migration_rule: "Standing delegation strictly forbids database schema migrations. The contact details flow must be handled at checkout, validated server-side, passed to Cashfree, and stored in subscriptions.metadata and billing_customers.tax_info without altering DB schema."
    - staging_database_partial_records: "Staging Neon was audited immediately following the HTTP 400 error. Exactly 0 orphaned subscriptions, 0 invoices, and wallet balance remained intact at 100 credits for cust_2a79b54106e04c9ab491e5be3aed6b97. Cashfree customer and Razorpay customer invariants remain 100% intact."
    - zero_inventions_constraint: "Strictly enforced: no fake numbers, dummy values, or cross-customer data reuse. The mobile phone number must be explicitly provided by the customer at checkout with clear regulatory transparency."

Proposed Architecture & Fix:
  1_phone_validation_utility:
    function: "validateAndNormalizeIndianPhone(phoneInput: unknown): PhoneValidationResult"
    behavior: "Validates 10-digit Indian mobile numbers starting with [6-9]. Normalizes prefixes (+91, 91, 0) and formatting characters (spaces, dashes, brackets). Fails closed on missing, non-string, short, or invalid prefixes."
  2_backend_service:
    file: "apps/api/src/billing/payment-gateway-service.ts"
    changes:
      - "createSubscriptionCheckout accepts contactDetails?: ContactDetails (phone, email, name)."
      - "If gateway === 'cashfree' with live/staging credentials, enforces validated normalizedPhone. If absent or invalid, throws clear VALIDATION_ERROR before calling external gateway."
      - "Constructs Cashfree customer_details with customer_id, customer_phone, customer_email, and customer_name."
      - "Persists customerPhone in subscriptions.metadata and updates billing_customers.tax_info.phone without database schema migration."
  3_api_route:
    file: "apps/api/src/billing-routes.ts"
    changes:
      - "POST /checkout/subscription accepts customerPhone and customerDetails."
      - "Validates mobile phone server-side when gateway === 'cashfree'. Returns HTTP 400 with VALIDATION_ERROR before invoking gateway service."
      - "Maps VALIDATION_ERROR to HTTP 400 Bad Request."
  4_frontend_ui:
    file: "src/components/PricingModal.tsx"
    changes:
      - "Displays a clear, accessible mobile input with '+91' prefix when INR and Cashfree are selected: 'Mobile Number for Mandate Notifications (RBI Mandated)'."
      - "Client-side validation on checkout submission prevents API calls with invalid/empty phone numbers."
      - "Transparent regulatory explanation informs the user of RBI pre-debit notification requirements."

Verification Evidence:
  test_suite: "test/cashfree-checkout-contact-details.test.ts"
  results: "22/22 tests passing in 920ms"
  coverage:
    - "Indian phone normalization across standard, +91, 0, 91, and formatted inputs."
    - "Strict rejection of short, long, non-numeric, and invalid-digit phone inputs."
    - "Immediate fail-closed VALIDATION_ERROR before external gateway on missing/invalid phone."
    - "Zero orphaned subscriptions or audit records in database upon validation error."
    - "Verified payload construction with customer_phone, customer_email, customer_name."
    - "Razorpay checkout independence (does not require phone)."
    - "Staging rehearsal security fencing (rejects un-enrolled accounts with HTTP 403)."
    - "Unauthenticated checkout protection (HTTP 401)."
    - "Route-level HTTP 400 admission validation on POST /checkout/subscription."
  regression_suites:
    - "test/gate4-upgrade-button-checkout-flow.test.ts: 8/8 PASS"
    - "test/cashfree-razorpay-recurring-lifecycle.test.ts: 25/25 PASS"
    - "test/staging-sandbox-rehearsal-security.test.ts: 55/55 PASS"
    - "test/impeccable-accessibility-contract.test.ts: 8/8 PASS"
  typecheck_gates:
    - "tsc -b: PASS (exit code 0)"
    - "tsc -p tsconfig.server.json --noEmit: PASS (exit code 0)"
    - "tsc -p api/tsconfig.json --noEmit: PASS (exit code 0)"
  build_gate:
    - "npm run build: PASS (exit code 0, 1.63s)"
  lint_gate:
    - "oxlint: 0 errors"

Staging Deployment Recommendation:
  branch: "fix/cashfree-checkout-contact-phone-collection"
  target_deployment: "Vercel Preview, gitBranch staging"
  pr_target: "staging"
  prerequisites:
    - "Merge fix/cashfree-checkout-contact-phone-collection to staging via PR."
    - "Redeploy staging canonical alias (https://staging.virexaaiventures.com)."
    - "Provide dedicated test account phone number during checkout."
    - "Conduct exactly one Cashfree recurring subscription checkout attempt."
  production_hold: "STRICT HOLD remains active on main, prod-release, and production database."
---
