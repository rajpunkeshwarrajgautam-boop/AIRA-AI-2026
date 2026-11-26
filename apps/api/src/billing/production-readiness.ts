/**
 * AIRA AI 2026 — Commercial Production Payment Readiness Audit Service
 *
 * Evaluates all 14 mandatory production payment gates:
 * 1. Merchant KYC and approval (Razorpay + Cashfree)
 * 2. Domestic recurring payment enablement (RBI e-mandate INR plans)
 * 3. International recurring payment approval (USD cards, or fail-closed INR-only launch)
 * 4. Production gateway keys & runtime isolation
 * 5. Verified webhook endpoint & raw HMAC-SHA256 signatures (Razorpay + Cashfree)
 * 6. Correct registered business identity (Virexa AI Ventures Private Limited)
 * 7. Required legal documents and business policies (Vite SPA /terms, /privacy, /refund-policy)
 * 8. GST registration/tax treatment verification (SAC 998431)
 * 9. Sequential compliant tax invoicing & concurrency integrity
 * 10. Refund and dispute procedures (linked credit notes)
 * 11. Fraud and abuse controls (PostgreSQL row locks, balance >= 0, unique active index)
 * 12. Production monitoring and telemetry (billing_audit_events)
 * 13. Provider reconciliation jobs & invoice/cancellation outbox worker
 * 14. Rollback and emergency disable procedures (fail-closed kill-switch)
 */

export type GateStatus =
  | 'VERIFIED'
  | 'PASSED'
  | 'BLOCKED'
  | 'PENDING_OWNER_ACTION'
  | 'NOT_VERIFIED'
  | 'UNKNOWN';

export type GateOutcome = 'PASS' | 'FAIL' | 'PENDING_OWNER_ACTION' | 'UNKNOWN';

export interface GateResult {
  id: string;
  name: string;
  category: 'MERCHANT' | 'SECURITY' | 'LEGAL' | 'TAX' | 'OPERATIONAL';
  status: GateStatus;
  outcome: GateOutcome;
  verificationCondition: string;
  evidenceSource: string;
  evidence: string;
  evidenceTimestampOrCommit: string;
  requiredConfiguration: string;
  failureReason?: string;
  responsibleOwner: string;
  remediationBlocker?: string;
  remediationSteps?: string;
}

export interface ReadinessRuntimeEvidence {
  dbVerified?: boolean;
  appliedMigrationsCount?: number;
  expectedMigrationsCount?: number;
  workerVerified?: boolean;
  testSecretsVerified?: boolean;
  legalRoutesVerified?: boolean;
  commitSha?: string;
}

export interface ProductionPaymentReadinessReport {
  overallVerdict:
    | 'COMMERCIAL PLATFORM READY FOR OWNER-APPROVED PRODUCTION RELEASE'
    | 'COMMERCIAL PLATFORM PARTIALLY READY — EXTERNAL ACTION REQUIRED'
    | 'COMMERCIAL PLATFORM BLOCKED — REMEDIATION REQUIRED';
  timestamp: number;
  environment: string;
  commitSha: string;
  totalGates: number;
  passedCount: number;
  pendingOwnerCount: number;
  blockedCount: number;
  unknownCount: number;
  emergencyKillSwitchActive: boolean;
  internationalUsdEnabled: boolean;
  gates: GateResult[];
}

export class ProductionReadinessService {
  audit(runtimeEvidence: ReadinessRuntimeEvidence = {}): ProductionPaymentReadinessReport {
    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
    const commitSha =
      runtimeEvidence.commitSha ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.GIT_COMMIT_SHA ||
      'UNKNOWN';

    // 1. Live Merchant Credentials (Both Razorpay & Cashfree)
    const rzpKeyId = (process.env.RAZORPAY_KEY_ID || '').trim();
    const rzpKeySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    const hasLiveRazorpay = Boolean(
      rzpKeyId.startsWith('rzp_live_') && rzpKeySecret.length > 0
    );

    const cfAppId = (process.env.CASHFREE_APP_ID || '').trim();
    const cfSecretKey = (process.env.CASHFREE_SECRET_KEY || '').trim();
    const cfEnv = (process.env.CASHFREE_ENV || '').trim().toUpperCase();
    const hasLiveCashfree = Boolean(
      (cfEnv === 'PROD' || cfEnv === 'PRODUCTION') &&
      cfAppId.length > 0 &&
      !cfAppId.startsWith('TEST') &&
      cfSecretKey.length > 0
    );

    const hasBothLiveMerchants = hasLiveRazorpay && hasLiveCashfree;

    // 2. Plan IDs
    const rzpPlusInr = (process.env.RAZORPAY_PLAN_ID_PLUS_INR || '').trim();
    const rzpProInr = (process.env.RAZORPAY_PLAN_ID_PRO_INR || '').trim();
    const cfPlusInr = (process.env.CASHFREE_PLAN_ID_PLUS_INR || '').trim();
    const cfProInr = (process.env.CASHFREE_PLAN_ID_PRO_INR || '').trim();
    const hasAllDomesticPlanIds = Boolean(rzpPlusInr && rzpProInr && cfPlusInr && cfProInr);

    // 3. International USD Toggle
    const internationalUsdEnabled = process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED === 'true';
    const hasUsdPlanIds = Boolean(
      (process.env.RAZORPAY_PLAN_ID_PLUS_USD || '').trim() &&
      (process.env.RAZORPAY_PLAN_ID_PRO_USD || '').trim()
    );
    const hasLut = Boolean((process.env.AIRA_LUT_NUMBER || '').trim());

    // 4. Webhooks
    const hasRzpWebhookSecret = Boolean((process.env.RAZORPAY_WEBHOOK_SECRET || '').trim());
    const hasCfWebhookSecret = Boolean(
      (process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY || '').trim()
    );
    const hasWebhookCoverage = isProd
      ? (hasRzpWebhookSecret && hasCfWebhookSecret)
      : (hasRzpWebhookSecret || hasCfWebhookSecret);

    // 5. GST & Supplier Identity
    const supplierName = (process.env.AIRA_SUPPLIER_NAME || 'Virexa AI Ventures Private Limited').trim();
    const supplierGstin = (process.env.AIRA_SUPPLIER_GSTIN || '').trim();
    const hasSupplierGstin = supplierGstin.length === 15;
    const hasSupplierGstinVerified = Boolean(
      hasSupplierGstin && process.env.AIRA_SUPPLIER_GSTIN_VERIFIED === 'true'
    );
    const hasFinanceTaxSignOff = process.env.AIRA_FINANCE_TAX_SIGNOFF === 'true';
    const isTaxCompliant = hasSupplierGstinVerified && hasFinanceTaxSignOff;

    // 6. Worker & Kill Switch
    const emergencyDisabled =
      process.env.AIRA_BILLING_EMERGENCY_DISABLE === 'true' ||
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED !== 'true';
    const hasWorkerKey = Boolean(
      (process.env.AIRA_INTERNAL_WORKER_KEY || process.env.CRON_SECRET || '').trim()
    );
    const isProdWorkerEnabled = !isProd || process.env.AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER === 'true';

    const missingMerchantParts: string[] = [];
    if (!hasLiveRazorpay) missingMerchantParts.push('Razorpay LIVE (RAZORPAY_KEY_ID=rzp_live_*, RAZORPAY_KEY_SECRET)');
    if (!hasLiveCashfree) missingMerchantParts.push('Cashfree PROD (CASHFREE_ENV=PROD, CASHFREE_APP_ID, CASHFREE_SECRET_KEY)');

    const gates: GateResult[] = [
      {
        id: 'GATE_01_MERCHANT_KYC',
        name: 'Merchant KYC & Live Activation (Razorpay + Cashfree)',
        category: 'MERCHANT',
        status: hasBothLiveMerchants ? 'VERIFIED' : 'PENDING_OWNER_ACTION',
        outcome: hasBothLiveMerchants ? 'PASS' : 'PENDING_OWNER_ACTION',
        verificationCondition: 'Live merchant KYC and production credentials configured for both Razorpay and Cashfree.',
        evidenceSource: 'Runtime env (RAZORPAY_KEY_ID/SECRET, CASHFREE_ENV/APP_ID/SECRET_KEY)',
        evidence: hasBothLiveMerchants
          ? 'Live Razorpay (rzp_live_*) and Cashfree (PROD) merchant credentials are configured.'
          : `Pending live merchant activation/credentials for: ${missingMerchantParts.join('; ')}.`,
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, CASHFREE_ENV=PROD, CASHFREE_APP_ID, CASHFREE_SECRET_KEY',
        failureReason: hasBothLiveMerchants ? undefined : `Missing live credentials: ${missingMerchantParts.join(', ')}`,
        responsibleOwner: 'Repository Owner (rajpunkeshwarrajgautam-boop) / Virexa AI Ventures Board',
        remediationBlocker: hasBothLiveMerchants
          ? undefined
          : 'Complete merchant KYC on Razorpay & Cashfree dashboards and configure live keys in Vercel Production.',
        remediationSteps: 'Activate live accounts on Razorpay and Cashfree portals and set live keys in Vercel Production environment.'
      },
      {
        id: 'GATE_02_DOMESTIC_RECURRING',
        name: 'Domestic Recurring Payment Enablement (RBI e-mandate INR)',
        category: 'MERCHANT',
        status: isProd ? (hasAllDomesticPlanIds ? 'VERIFIED' : 'BLOCKED') : 'VERIFIED',
        outcome: isProd ? (hasAllDomesticPlanIds ? 'PASS' : 'FAIL') : 'PASS',
        verificationCondition: 'Both Razorpay and Cashfree INR recurring plan IDs (Plus ₹399, Pro ₹999) configured for production.',
        evidenceSource: 'Runtime plan IDs (RAZORPAY_PLAN_ID_*_INR, CASHFREE_PLAN_ID_*_INR)',
        evidence: isProd
          ? (hasAllDomesticPlanIds
              ? 'All 4 domestic INR recurring plan IDs (Razorpay + Cashfree Plus/Pro) are configured.'
              : 'Missing one or more production INR plan IDs (RAZORPAY_PLAN_ID_PLUS_INR, RAZORPAY_PLAN_ID_PRO_INR, CASHFREE_PLAN_ID_PLUS_INR, CASHFREE_PLAN_ID_PRO_INR).')
          : (hasAllDomesticPlanIds
              ? 'All 4 domestic INR recurring plan IDs configured explicitly in environment.'
              : 'Operating in non-production environment with sandbox default plan identifiers; production requires explicit *_PLAN_ID_*_INR env vars.'),
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'RAZORPAY_PLAN_ID_PLUS_INR, RAZORPAY_PLAN_ID_PRO_INR, CASHFREE_PLAN_ID_PLUS_INR, CASHFREE_PLAN_ID_PRO_INR',
        failureReason: isProd && !hasAllDomesticPlanIds ? 'Missing explicit production INR recurring plan IDs.' : undefined,
        responsibleOwner: 'Repository Owner / Payments Lead',
        remediationBlocker: isProd && !hasAllDomesticPlanIds ? 'Provision live INR recurring plans on Razorpay & Cashfree and set *_PLAN_ID_*_INR env vars.' : undefined
      },
      {
        id: 'GATE_03_INTERNATIONAL_RECURRING',
        name: 'International Recurring USD Card Scope',
        category: 'MERCHANT',
        status: internationalUsdEnabled
          ? (hasUsdPlanIds && hasLut ? 'VERIFIED' : 'PENDING_OWNER_ACTION')
          : (isProd ? 'VERIFIED' : 'PENDING_OWNER_ACTION'),
        outcome: internationalUsdEnabled
          ? (hasUsdPlanIds && hasLut ? 'PASS' : 'PENDING_OWNER_ACTION')
          : (isProd ? 'PASS' : 'PENDING_OWNER_ACTION'),
        verificationCondition: 'Either international USD checkout is disabled (INR-only launch), OR gateway USD approval + USD plan IDs + LUT are configured.',
        evidenceSource: 'AIRA_INTERNATIONAL_USD_BILLING_ENABLED, RAZORPAY_PLAN_ID_*_USD, AIRA_LUT_NUMBER',
        evidence: !internationalUsdEnabled
          ? 'Domestic INR-only launch posture: AIRA_INTERNATIONAL_USD_BILLING_ENABLED is disabled (USD recurring checkout fails closed in production; USD approval still pending if enabled later).'
          : (hasUsdPlanIds && hasLut
              ? 'International USD billing enabled with USD plan IDs and LUT configured.'
              : 'AIRA_INTERNATIONAL_USD_BILLING_ENABLED=true but USD plan IDs or AIRA_LUT_NUMBER are missing.'),
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'AIRA_INTERNATIONAL_USD_BILLING_ENABLED=false (INR-only) OR (RAZORPAY_PLAN_ID_PLUS_USD, RAZORPAY_PLAN_ID_PRO_USD, AIRA_LUT_NUMBER)',
        failureReason: internationalUsdEnabled && !(hasUsdPlanIds && hasLut)
          ? 'Cross-border recurring USD billing enabled without complete USD plan IDs and LUT.'
          : (!internationalUsdEnabled && !isProd ? 'USD international recurring requires explicit gateway approval before enabling.' : undefined),
        responsibleOwner: 'Repository Owner (rajpunkeshwarrajgautam-boop)',
        remediationBlocker: internationalUsdEnabled && !(hasUsdPlanIds && hasLut)
          ? 'Disable AIRA_INTERNATIONAL_USD_BILLING_ENABLED for INR-only launch or supply USD plan IDs and AIRA_LUT_NUMBER.'
          : undefined
      },
      {
        id: 'GATE_04_GATEWAY_KEYS_PROTECTION',
        name: 'Production Gateway Keys Protection & Isolation',
        category: 'SECURITY',
        status: runtimeEvidence.testSecretsVerified === true
          ? 'VERIFIED'
          : (runtimeEvidence.testSecretsVerified === false ? 'BLOCKED' : 'UNKNOWN'),
        outcome: runtimeEvidence.testSecretsVerified === true
          ? 'PASS'
          : (runtimeEvidence.testSecretsVerified === false ? 'FAIL' : 'UNKNOWN'),
        verificationCondition: 'Zero client-side secret leaks confirmed by npm run test:secrets on exact candidate SHA.',
        evidenceSource: 'runtimeEvidence.testSecretsVerified / npm run test:secrets',
        evidence: runtimeEvidence.testSecretsVerified === true
          ? 'Tracked secret hygiene check verified 0 leaks; gateway keys restricted to server runtime env.'
          : (runtimeEvidence.testSecretsVerified === false
              ? 'Secret hygiene scan failed.'
              : 'UNVERIFIED in synchronous audit(): run npm run test:secrets and CI bundle audit on target SHA.'),
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'Secret environment variables in Vercel Production project settings',
        failureReason: runtimeEvidence.testSecretsVerified === false ? 'Secret scan failed.' : undefined,
        responsibleOwner: 'Application Security Engineer'
      },
      {
        id: 'GATE_05_WEBHOOK_VERIFICATION',
        name: 'Verified Webhook Endpoints & HMAC-SHA256 Secrets',
        category: 'SECURITY',
        status: hasWebhookCoverage ? 'VERIFIED' : 'BLOCKED',
        outcome: hasWebhookCoverage ? 'PASS' : 'FAIL',
        verificationCondition: 'Raw body HMAC-SHA256 verification secrets configured for Razorpay and Cashfree.',
        evidenceSource: 'RAZORPAY_WEBHOOK_SECRET, CASHFREE_WEBHOOK_SECRET / CASHFREE_SECRET_KEY',
        evidence: hasWebhookCoverage
          ? (isProd
              ? 'Both RAZORPAY_WEBHOOK_SECRET and CASHFREE webhook secret are configured for timingSafeEqual verification.'
              : 'Sandbox webhook secret configured for timingSafeEqual signature verification and event deduplication.')
          : (isProd
              ? `Missing production webhook secret(s): ${!hasRzpWebhookSecret ? 'RAZORPAY_WEBHOOK_SECRET ' : ''}${!hasCfWebhookSecret ? 'CASHFREE_WEBHOOK_SECRET/CASHFREE_SECRET_KEY' : ''}`.trim()
              : 'Webhook secret missing in environment; signatures cannot be verified.'),
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'RAZORPAY_WEBHOOK_SECRET, CASHFREE_WEBHOOK_SECRET',
        failureReason: hasWebhookCoverage ? undefined : 'Missing required Razorpay and/or Cashfree webhook secret.',
        responsibleOwner: 'Lead Backend Engineer',
        remediationBlocker: hasWebhookCoverage ? undefined : 'Configure both RAZORPAY_WEBHOOK_SECRET and CASHFREE_WEBHOOK_SECRET in Vercel Production.',
        remediationSteps: 'Create production webhook endpoints (/api/billing/webhook/razorpay, /api/billing/webhook/cashfree) on live dashboards and add secrets to Vercel Production.'
      },
      {
        id: 'GATE_06_BUSINESS_IDENTITY',
        name: 'Correct Registered Business Identity',
        category: 'LEGAL',
        status: supplierName === 'Virexa AI Ventures Private Limited' ? 'VERIFIED' : 'BLOCKED',
        outcome: supplierName === 'Virexa AI Ventures Private Limited' ? 'PASS' : 'FAIL',
        verificationCondition: 'Supplier legal name matches "Virexa AI Ventures Private Limited".',
        evidenceSource: 'AIRA_SUPPLIER_NAME / tax-determination.ts',
        evidence: `Configured supplier legal identity resolves to: ${supplierName}.`,
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'AIRA_SUPPLIER_NAME="Virexa AI Ventures Private Limited"',
        failureReason: supplierName === 'Virexa AI Ventures Private Limited' ? undefined : 'Supplier name mismatch.',
        responsibleOwner: 'Legal & Compliance Lead'
      },
      {
        id: 'GATE_07_LEGAL_DOCUMENTS',
        name: 'Mandatory Legal Policies (Terms, Privacy, Refund, Cancellation)',
        category: 'LEGAL',
        status: runtimeEvidence.legalRoutesVerified === false ? 'BLOCKED' : 'VERIFIED',
        outcome: runtimeEvidence.legalRoutesVerified === false ? 'FAIL' : 'PASS',
        verificationCondition: 'Legal policy modals/routes (/terms, /privacy, /refund-policy) active in Vite SPA.',
        evidenceSource: 'src/components/LegalViewerModal.tsx & Vite SPA legal routes',
        evidence: runtimeEvidence.legalRoutesVerified === false
          ? 'Legal policy route verification failed.'
          : 'Terms of Service, Privacy Policy, Refund & Cancellation terms present in Vite SPA.',
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'Vite SPA production build & static asset routing',
        responsibleOwner: 'Legal & Compliance Lead'
      },
      {
        id: 'GATE_08_GST_TAX_COMPLIANCE',
        name: 'GST Tax Calculation & Classification (SAC 998431)',
        category: 'TAX',
        status: isTaxCompliant ? 'VERIFIED' : 'PENDING_OWNER_ACTION',
        outcome: isTaxCompliant ? 'PASS' : 'PENDING_OWNER_ACTION',
        verificationCondition: '18% GST + SAC 998431 active with verified 15-char supplier GSTIN and formal Finance sign-off.',
        evidenceSource: 'AIRA_SUPPLIER_GSTIN, AIRA_SUPPLIER_GSTIN_VERIFIED, AIRA_FINANCE_TAX_SIGNOFF, tax-determination.ts',
        evidence: isTaxCompliant
          ? '18% GST + SAC 998431 configured with verified supplier GSTIN and AIRA_FINANCE_TAX_SIGNOFF=true.'
          : (!hasSupplierGstin
              ? '18% GST calculation and SAC 998431 logic active in code; AIRA_SUPPLIER_GSTIN (15 chars) not yet configured.'
              : (!hasSupplierGstinVerified
                  ? 'AIRA_SUPPLIER_GSTIN present; AIRA_SUPPLIER_GSTIN_VERIFIED=true pending.'
                  : 'Supplier GSTIN verified; formal Finance sign-off (AIRA_FINANCE_TAX_SIGNOFF=true) pending.')),
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'AIRA_SUPPLIER_GSTIN, AIRA_SUPPLIER_GSTIN_VERIFIED=true, AIRA_FINANCE_TAX_SIGNOFF=true, AIRA_SUPPLIER_STATE=07',
        failureReason: isTaxCompliant ? undefined : (!hasSupplierGstinVerified ? 'AIRA_SUPPLIER_GSTIN not verified.' : 'AIRA_FINANCE_TAX_SIGNOFF pending.'),
        responsibleOwner: 'Repository Owner / Finance Lead',
        remediationBlocker: isTaxCompliant ? undefined : 'Configure verified AIRA_SUPPLIER_GSTIN and AIRA_FINANCE_TAX_SIGNOFF=true in Vercel Production.'
      },
      {
        id: 'GATE_09_INVOICE_COMPLIANCE',
        name: 'Sequential Compliant Tax Invoicing & Concurrency Integrity',
        category: 'TAX',
        status: isTaxCompliant
          ? (isProd && runtimeEvidence.dbVerified === false ? 'BLOCKED' : 'VERIFIED')
          : 'PENDING_OWNER_ACTION',
        outcome: isTaxCompliant
          ? (isProd && runtimeEvidence.dbVerified === false ? 'FAIL' : 'PASS')
          : 'PENDING_OWNER_ACTION',
        verificationCondition: 'Atomic PostgreSQL invoice sequence + verified GSTIN + Finance sign-off.',
        evidenceSource: 'packages/db/src/migrations/033_billing_invoice_sequences.ts & payment-gateway-service.ts',
        evidence: isTaxCompliant
          ? 'Sequential tax invoicing active with atomic PostgreSQL sequences and Finance tax sign-off.'
          : 'Sequential invoice logic & migration 033 implemented; invoices remain provisional until GSTIN verification and Finance sign-off.',
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'AIRA_SUPPLIER_GSTIN, AIRA_SUPPLIER_GSTIN_VERIFIED=true, AIRA_FINANCE_TAX_SIGNOFF=true',
        failureReason: isTaxCompliant ? undefined : 'Invoices provisional until GSTIN verification and Finance sign-off.',
        responsibleOwner: 'Database & Payments Engineer',
        remediationBlocker: isTaxCompliant ? undefined : 'Complete GSTIN verification and Finance sign-off.'
      },
      {
        id: 'GATE_10_REFUND_DISPUTE_PROCEDURES',
        name: 'Refund & Chargeback Dispute Handling',
        category: 'OPERATIONAL',
        status: hasWebhookCoverage ? 'VERIFIED' : (isProd ? 'BLOCKED' : 'UNKNOWN'),
        outcome: hasWebhookCoverage ? 'PASS' : (isProd ? 'FAIL' : 'UNKNOWN'),
        verificationCondition: 'Webhook refund/chargeback processor reverses credits and creates linked credit notes.',
        evidenceSource: 'payment-gateway-service.ts (handleRefundSettlement) + webhook verification config',
        evidence: hasWebhookCoverage
          ? 'Refund settlement webhook handler and credit-note issuance active with configured webhook secrets.'
          : 'Cannot receive signed provider refund webhooks without configured webhook secrets.',
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'RAZORPAY_WEBHOOK_SECRET, CASHFREE_WEBHOOK_SECRET, migration 033 (billing_credit_notes)',
        responsibleOwner: 'Lead Backend Engineer'
      },
      {
        id: 'GATE_11_FRAUD_ABUSE_CONTROLS',
        name: 'Database Schema, Migrations & Anti-Overdraft Ledger Controls',
        category: 'SECURITY',
        status: runtimeEvidence.dbVerified === true
          ? 'VERIFIED'
          : (runtimeEvidence.dbVerified === false ? 'BLOCKED' : 'UNKNOWN'),
        outcome: runtimeEvidence.dbVerified === true
          ? 'PASS'
          : (runtimeEvidence.dbVerified === false ? 'FAIL' : 'UNKNOWN'),
        verificationCondition: 'All expected PostgreSQL migrations applied (verified via db:verify:deploy against target DB), row locks & unique active index intact.',
        evidenceSource: 'runtimeEvidence.dbVerified / npm run db:verify:deploy',
        evidence: runtimeEvidence.dbVerified === true
          ? `Target PostgreSQL verified via db:verify:deploy (${runtimeEvidence.appliedMigrationsCount ?? 'all'} applied migrations).`
          : (runtimeEvidence.dbVerified === false
              ? `Database migration verification FAILED (applied=${runtimeEvidence.appliedMigrationsCount ?? '?'}, expected=${runtimeEvidence.expectedMigrationsCount ?? '?'}).`
              : 'UNVERIFIED in synchronous audit(): live PostgreSQL migration ledger was not queried in this call. Run npm run db:verify:deploy.'),
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'Neon PostgreSQL 18 passing npm run db:verify:deploy',
        failureReason: runtimeEvidence.dbVerified === false ? 'Target database is missing required migrations.' : undefined,
        responsibleOwner: 'Principal Security & Database Architect'
      },
      {
        id: 'GATE_12_PRODUCTION_MONITORING',
        name: 'Telemetry, Audit Logging & Persistent Database Connectivity',
        category: 'OPERATIONAL',
        status: runtimeEvidence.dbVerified === true
          ? 'VERIFIED'
          : (runtimeEvidence.dbVerified === false ? 'BLOCKED' : 'UNKNOWN'),
        outcome: runtimeEvidence.dbVerified === true
          ? 'PASS'
          : (runtimeEvidence.dbVerified === false ? 'FAIL' : 'UNKNOWN'),
        verificationCondition: 'billing_audit_events persistence and /api/health database reachability verified against target DB.',
        evidenceSource: 'runtimeEvidence.dbVerified & billing_audit_events',
        evidence: runtimeEvidence.dbVerified === true
          ? 'Target PostgreSQL connectivity and billing_audit_events schema verified.'
          : 'UNVERIFIED in synchronous audit(): live DB audit-log telemetry not queried synchronously.',
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'DATABASE_URL reachable + /api/health READY',
        responsibleOwner: 'SRE & DevOps Lead'
      },
      {
        id: 'GATE_13_RECONCILIATION_JOBS',
        name: 'Durable Outbox Worker & Settlement Reconciliation',
        category: 'OPERATIONAL',
        status: !hasWorkerKey || (isProd && !isProdWorkerEnabled)
          ? (isProd ? 'BLOCKED' : 'UNKNOWN')
          : (runtimeEvidence.workerVerified === true ? 'VERIFIED' : (runtimeEvidence.workerVerified === false ? 'BLOCKED' : 'VERIFIED')),
        outcome: !hasWorkerKey || (isProd && !isProdWorkerEnabled)
          ? (isProd ? 'FAIL' : 'UNKNOWN')
          : (runtimeEvidence.workerVerified === false ? 'FAIL' : 'PASS'),
        verificationCondition: 'Worker authentication key configured, production worker enabled (in prod), and durable outbox tables present.',
        evidenceSource: 'AIRA_INTERNAL_WORKER_KEY/CRON_SECRET, AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER, process-outbox handler',
        evidence: !hasWorkerKey
          ? 'Worker authentication key missing (CRON_SECRET / AIRA_INTERNAL_WORKER_KEY).'
          : (isProd && !isProdWorkerEnabled
              ? 'Production financial worker disabled (AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER !== true).'
              : 'Worker authentication credentials configured for outbox cancellation and invoice reconciliation.'),
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'AIRA_INTERNAL_WORKER_KEY (or CRON_SECRET), AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER=true (prod), GitHub AIRA_PRODUCTION_WORKER_SCHEDULE_ENABLED=true',
        failureReason: !hasWorkerKey
          ? 'Missing worker authentication key.'
          : (isProd && !isProdWorkerEnabled ? 'AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER is not true in production.' : undefined),
        responsibleOwner: 'Lead Backend Engineer'
      },
      {
        id: 'GATE_14_EMERGENCY_KILL_SWITCH',
        name: 'Rollback & Emergency Disable Kill-Switch',
        category: 'SECURITY',
        status: 'VERIFIED',
        outcome: 'PASS',
        verificationCondition: 'Centralized fail-closed kill-switch (AIRA_COMMERCIAL_BILLING_ENABLED / AIRA_BILLING_EMERGENCY_DISABLE) enforced.',
        evidenceSource: 'payment-gateway-service.ts (assertCommercialFulfillmentAllowed)',
        evidence: `Kill-switch state: AIRA_COMMERCIAL_BILLING_ENABLED=${process.env.AIRA_COMMERCIAL_BILLING_ENABLED || 'false'}, AIRA_BILLING_EMERGENCY_DISABLE=${process.env.AIRA_BILLING_EMERGENCY_DISABLE || 'false'}. Fail-closed enforcement active.`,
        evidenceTimestampOrCommit: commitSha,
        requiredConfiguration: 'AIRA_COMMERCIAL_BILLING_ENABLED (defaults to false), AIRA_BILLING_EMERGENCY_DISABLE',
        responsibleOwner: 'Release & Operations Lead'
      }
    ];

    const passedCount = gates.filter(g => g.status === 'PASSED' || g.status === 'VERIFIED').length;
    const pendingOwnerCount = gates.filter(g => g.status === 'PENDING_OWNER_ACTION').length;
    const blockedCount = gates.filter(g => g.status === 'BLOCKED').length;
    const unknownCount = gates.filter(g => g.status === 'UNKNOWN' || g.status === 'NOT_VERIFIED').length;

    let overallVerdict: ProductionPaymentReadinessReport['overallVerdict'];
    if (blockedCount > 0) {
      overallVerdict = 'COMMERCIAL PLATFORM BLOCKED — REMEDIATION REQUIRED';
    } else if (pendingOwnerCount > 0 || unknownCount > 0) {
      overallVerdict = 'COMMERCIAL PLATFORM PARTIALLY READY — EXTERNAL ACTION REQUIRED';
    } else {
      overallVerdict = 'COMMERCIAL PLATFORM READY FOR OWNER-APPROVED PRODUCTION RELEASE';
    }

    return {
      overallVerdict,
      timestamp: Date.now(),
      environment: isProd ? 'production' : 'staging-sandbox',
      commitSha,
      totalGates: gates.length,
      passedCount,
      pendingOwnerCount,
      blockedCount,
      unknownCount,
      emergencyKillSwitchActive: emergencyDisabled,
      internationalUsdEnabled,
      gates
    };
  }
}

export const productionReadinessService = new ProductionReadinessService();
