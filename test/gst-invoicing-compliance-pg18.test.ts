import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { db } from '../packages/db/src/index.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import { PaymentGatewayService, paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';

describe('GST Invoicing, FY Sequences, Immutable Snapshots & Credit Note Compliance Suite (PG18)', () => {
  let appServer: http.Server;
  let baseUrl = '';
  const createdPrincipals: string[] = [];
  const origEnv = { ...process.env };

  const uid = (tag: string) => {
    const id = `usr_gst18_${tag}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    createdPrincipals.push(id);
    return id;
  };

  async function cleanupPrincipal(p: string) {
    const cust = await db('billing_customers').where({ principal_id: p }).first().catch(() => null);
    if (!cust) return;
    await db('billing_credit_notes').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('billing_invoices').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('billing_audit_events').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('subscription_cancellation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('billing_invoice_reconciliation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
    await db('idempotent_operations').where({ principal_id: p }).delete().catch(() => {});
    await db('subscriptions').where({ customer_id: cust.id }).delete().catch(() => {});
    const acct = await db('credit_accounts').where({ customer_id: cust.id }).first().catch(() => null);
    if (acct) {
      await db('credit_reservations').where({ account_id: acct.id }).delete().catch(() => {});
      await db('credit_transactions').where({ account_id: acct.id }).delete().catch(() => {});
      await db('credit_grants').where({ account_id: acct.id }).delete().catch(() => {});
      await db('credit_accounts').where({ id: acct.id }).delete().catch(() => {});
    }
    await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
  }

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_SUPPLIER_GSTIN = '09AAMCV4678C1ZV';
    process.env.AIRA_SUPPLIER_GSTIN_VERIFIED = 'true';

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const p = req.headers['x-test-principal'];
      const email = req.headers['x-test-email'];
      if (typeof p === 'string' && p.trim()) {
        req.principal = {
          userId: p.trim(),
          email: typeof email === 'string' ? email : 'subscriber@virexa.test',
          name: 'Test GST Subscriber'
        } as any;
      }
      next();
    });
    app.use('/api/billing', createBillingRoutes());

    appServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = appServer.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    for (const p of createdPrincipals) {
      await cleanupPrincipal(p);
    }
    await new Promise<void>((resolve) => appServer?.close(() => resolve()) || resolve());
    process.env = origEnv;
  });

  it('1. Allocates separate FY-partitioned serials for commercial vs sandbox across IST FY rollover', async () => {
    const svc = new PaymentGatewayService();
    const mar31Utc = Date.parse('2027-03-31T18:29:00.000Z'); // 23:59 IST Mar 31 -> FY 2026-27
    const apr1Utc = Date.parse('2027-03-31T18:31:00.000Z');  // 00:01 IST Apr 01 -> FY 2027-28

    const [cInv1, sInv1, cCn1, sCn1, nextFyInv] = await db.transaction(async (trx) => {
      const a = await svc.allocateInvoiceNumber(trx, { now: mar31Utc, isSandbox: false });
      const b = await svc.allocateInvoiceNumber(trx, { now: mar31Utc, isSandbox: true });
      const c = await svc.allocateCreditNoteNumber(trx, { now: mar31Utc, isSandbox: false });
      const d = await svc.allocateCreditNoteNumber(trx, { now: mar31Utc, isSandbox: true });
      const e = await svc.allocateInvoiceNumber(trx, { now: apr1Utc, isSandbox: false });
      return [a, b, c, d, e];
    });

    assert.match(cInv1, /^INV\/26-27\/\d{5}$/);
    assert.match(sInv1, /^SBX\/26-27\/\d{5}$/);
    assert.match(cCn1, /^CN\/26-27\/\d{5}$/);
    assert.match(sCn1, /^SCN\/26-27\/\d{5}$/);
    assert.match(nextFyInv, /^INV\/27-28\/\d{5}$/);
  });

  it('2. Concurrent 25-way FY serial allocation on PostgreSQL produces 25 unique sequential numbers', async () => {
    const svc = new PaymentGatewayService();
    const marDate = Date.parse('2026-11-28T10:00:00.000Z');
    const results = await Promise.all(
      Array.from({ length: 25 }, () => svc.allocateInvoiceNumber(db, { now: marDate, isSandbox: true }))
    );
    assert.equal(new Set(results).size, 25);
    for (const r of results) {
      assert.match(r, /^SBX\/26-27\/\d{5}$/);
    }
  });

  it('3. Customer Tax Profile API enforces State/UT & B2B GSTIN Mod-36 checksum and rejects retired code 25', async () => {
    const userA = uid('taxprof_a');

    // Retired code 25 rejected
    const badStateRes = await fetch(`${baseUrl}/api/billing/tax-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': userA },
      body: JSON.stringify({ stateCode: '25', country: 'IN' })
    });
    assert.equal(badStateRes.status, 400);

    // Invalid GSTIN checksum rejected
    const badGstinRes = await fetch(`${baseUrl}/api/billing/tax-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': userA },
      body: JSON.stringify({ stateCode: '09', customerGstin: '09AAMCV4678C1ZZ' })
    });
    assert.equal(badGstinRes.status, 400);

    // Mismatched state vs GSTIN rejected
    const mismatchRes = await fetch(`${baseUrl}/api/billing/tax-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': userA },
      body: JSON.stringify({ stateCode: '27', customerGstin: '09AAMCV4678C1ZV' })
    });
    assert.equal(mismatchRes.status, 400);

    // Valid B2B UP profile persists cleanly
    const okRes = await fetch(`${baseUrl}/api/billing/tax-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': userA },
      body: JSON.stringify({
        legalName: 'Virexa Partner Pvt Ltd',
        stateCode: '09',
        customerGstin: '09AAMCV4678C1ZV',
        addressLine1: '10 Gomti Nagar',
        city: 'Lucknow',
        postalCode: '226010',
        country: 'IN'
      })
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.profile.stateCode, '09');
    assert.equal(okBody.profile.isB2b, true);
    assert.equal(okBody.profile.customerGstin, '09AAMCV4678C1ZV');
  });

  it('4. Immutable snapshot isolation: post-issuance env or buyer changes never alter historical invoice or A4 HTML', async () => {
    const userA = uid('imm_a');
    const userB = uid('imm_b');
    await commercialBillingService.getOrCreateCustomer(userA, 'buyer.a@example.com', 'Buyer Alpha');
    await commercialBillingService.getOrCreateCustomer(userB, 'attacker.b@example.com', 'Attacker Beta');

    await commercialBillingService.upsertBillingTaxProfile(userA, {
      legalName: 'Buyer Alpha Enterprises',
      stateCode: '04', // Chandigarh — inter-state IGST from UP (09)
      addressLine1: 'Sector 17 Plaza',
      city: 'Chandigarh',
      postalCode: '160017',
      country: 'IN'
    });

    const custA = await db('billing_customers').where({ principal_id: userA }).first();
    const now = Date.now();
    const subId = `pur_imm_${now}`;
    await db('subscriptions').insert({
      id: subId,
      customer_id: custA.id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'active',
      gateway: 'razorpay',
      gateway_subscription_id: `sub_imm_${now}`,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      cancel_at_period_end: false,
      metadata: JSON.stringify({
        principalId: userA,
        customerId: custA.id,
        customerName: 'Buyer Alpha Enterprises',
        customerState: '04',
        is_sandbox: true
      }),
      created_at: now,
      updated_at: now
    });

    const payId = `pay_imm_${now}`;
    await db('billing_audit_events').insert({
      id: `bae_imm_act_${now}`,
      customer_id: custA.id,
      event_type: 'SUBSCRIPTION_ACTIVATED',
      actor_type: 'gateway_webhook',
      actor_id: subId,
      payload: JSON.stringify({ purchaseId: subId, actualPaymentId: payId, amount: 39900, currency: 'INR' }),
      created_at: now
    });

    const issued = await db.transaction(async (trx) => {
      return await paymentGatewayService.issueDurableInvoice({
        trx,
        customerId: custA.id,
        principalId: userA,
        purchaseRecord: await trx('subscriptions').where({ id: subId }).first(),
        planTier: 'plus',
        gateway: 'razorpay',
        actualPaymentId: payId,
        cycleNumber: 1,
        now
      });
    });

    assert.ok(issued);
    assert.match(issued!.invoiceNumber, /^SBX\/\d{2}-\d{2}\/\d{5}$/);
    assert.equal(issued!.igstAmount, 60.86);
    assert.equal(issued!.cgstAmount, undefined);
    assert.equal(issued!.utgstAmount, undefined);
    assert.equal(issued!.pdfDownloadAvailable, true);
    assert.equal(issued!.printableDocumentAvailable, true);

    // Mutate environment & customer profile AFTER issuance
    process.env.AIRA_SUPPLIER_GSTIN = '27AAACV9999Z1Z9';
    process.env.AIRA_SUPPLIER_NAME = 'MUTATED_COMPANY_NAME';
    await commercialBillingService.upsertBillingTaxProfile(userA, {
      legalName: 'Changed Later Pvt Ltd',
      stateCode: '27',
      country: 'IN'
    });

    const encodedInv = encodeURIComponent(issued!.invoiceNumber);
    const invHtmlRes = await fetch(`${baseUrl}/api/billing/invoices/${encodedInv}/download`, {
      headers: { 'x-test-principal': userA }
    });
    assert.equal(invHtmlRes.status, 200);
    const html = await invHtmlRes.text();
    assert.ok(html.includes('VIREXA AI VENTURES PRIVATE LIMITED'), 'Supplier snapshot must stay immutable');
    assert.ok(html.includes('09AAMCV4678C1ZV'), 'Original GSTIN snapshot must stay immutable');
    assert.ok(html.includes('Buyer Alpha Enterprises'), 'Original buyer name snapshot must stay immutable');
    assert.ok(html.includes('Chandigarh (04)'), 'Original PoS snapshot must stay immutable');
    assert.ok(html.includes('IGST'), 'Inter-state UP->Chandigarh supply must render IGST split');
    assert.ok(html.includes('SANDBOX REHEARSAL RECEIPT — NOT A VALID TAX INVOICE'), 'Sandbox document must display watermark');
    assert.ok(!html.includes('MUTATED_COMPANY_NAME'));
    assert.ok(!html.includes('Changed Later Pvt Ltd'));
    assert.ok(!html.includes(userA), 'Invoice HTML must never expose internal usr_ principal ID');

    // Cross-tenant download denied with 404
    const crossTenantRes = await fetch(`${baseUrl}/api/billing/invoices/${encodedInv}/download`, {
      headers: { 'x-test-principal': userB }
    });
    assert.equal(crossTenantRes.status, 404);
  });

  it('5. Proportional Credit Notes (Rule 53(1A)), voided serial preservation, and fail-closed production guards', async () => {
    process.env.AIRA_SUPPLIER_GSTIN = '09AAMCV4678C1ZV';
    process.env.AIRA_SUPPLIER_GSTIN_VERIFIED = 'true';
    const userP = uid('cn_void');
    await commercialBillingService.getOrCreateCustomer(userP, 'refund.user@example.com', 'Refund User');
    await commercialBillingService.upsertBillingTaxProfile(userP, {
      legalName: 'Refund User',
      stateCode: '09',
      country: 'IN'
    });

    const cust = await db('billing_customers').where({ principal_id: userP }).first();
    const now = Date.now();
    const subId = `pur_cn_${now}`;
    const payId = `pay_cn_${now}`;

    await db('subscriptions').insert({
      id: subId,
      customer_id: cust.id,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'active',
      gateway: 'razorpay',
      gateway_subscription_id: `sub_cn_${now}`,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: userP, customerId: cust.id, customerState: '09', is_sandbox: false }),
      created_at: now,
      updated_at: now
    });

    const inv = await db.transaction(async (trx) => {
      return await paymentGatewayService.issueDurableInvoice({
        trx,
        customerId: cust.id,
        principalId: userP,
        purchaseRecord: await trx('subscriptions').where({ id: subId }).first(),
        planTier: 'pro',
        gateway: 'razorpay',
        actualPaymentId: payId,
        cycleNumber: 1,
        now
      });
    });
    assert.ok(inv);
    assert.match(inv!.invoiceNumber, /^INV\/\d{2}-\d{2}\/\d{5}$/);

    // Issue 2 partial Credit Notes summing to ₹999.00 (500.00 + 499.00)
    const subRow = await db('subscriptions').where({ id: subId }).first();
    await db.transaction(async (trx) => {
      await paymentGatewayService.issueDurableCreditNote({
        trx,
        subRecord: subRow,
        refundEntity: { id: `ref_1_${now}`, payment_id: payId },
        refundAmount: 500,
        refundAmountMinorUnits: 50000,
        isPartialRefund: true,
        gateway: 'razorpay',
        now: now + 1000
      });
      await paymentGatewayService.issueDurableCreditNote({
        trx,
        subRecord: subRow,
        refundEntity: { id: `ref_2_${now}`, payment_id: payId },
        refundAmount: 499,
        refundAmountMinorUnits: 49900,
        isPartialRefund: true,
        gateway: 'razorpay',
        now: now + 2000
      });
    });

    const cns = await paymentGatewayService.getCreditNotes(userP);
    assert.equal(cns.length, 2);
    const totalTaxable = Number(((cns[0].taxableBase || 0) + (cns[1].taxableBase || 0)).toFixed(2));
    const totalCgst = Number(((cns[0].cgstAmount || 0) + (cns[1].cgstAmount || 0)).toFixed(2));
    const totalSgst = Number(((cns[0].sgstAmount || 0) + (cns[1].sgstAmount || 0)).toFixed(2));
    assert.equal(totalTaxable, inv!.taxableBase);
    assert.equal(totalCgst, inv!.cgstAmount);
    assert.equal(totalSgst, inv!.sgstAmount);

    // Voiding invoice marks VOIDED without deleting serial row
    const voidRes = await paymentGatewayService.voidBillingDocument({
      documentType: 'invoice',
      documentNumber: inv!.invoiceNumber,
      reason: 'Duplicate test issuance voided for audit trail',
      actorId: 'operator_test'
    });
    assert.equal(voidRes.documentStatus, 'VOIDED');
    const rowAfterVoid = await db('billing_invoices').where({ invoice_number: inv!.invoiceNumber }).first();
    assert.ok(rowAfterVoid, 'Voided serial record must never be deleted');
    assert.equal(rowAfterVoid.document_status, 'VOIDED');

    const cnHtmlRes = await fetch(
      `${baseUrl}/api/billing/credit-notes/${encodeURIComponent(cns[0].creditNoteNumber)}/download`,
      { headers: { 'x-test-principal': userP } }
    );
    assert.equal(cnHtmlRes.status, 200);
    const cnHtml = await cnHtmlRes.text();
    assert.ok(cnHtml.includes(inv!.invoiceNumber));
    assert.ok(cnHtml.includes('CGST Rule 53(1A)'));

    // Fail-closed live production guard check when SAC/Finance sign-off unapproved
    const prevNode = process.env.NODE_ENV;
    const prevSacApp = process.env.AIRA_SUPPLIER_SAC_APPROVED;
    const prevFinApp = process.env.AIRA_FINANCE_TAX_SIGNOFF;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.AIRA_SUPPLIER_SAC_APPROVED;
      delete process.env.AIRA_FINANCE_TAX_SIGNOFF;
      await assert.rejects(
        () => db.transaction(async (trx) => {
          return await paymentGatewayService.issueDurableInvoice({
            trx,
            customerId: cust.id,
            principalId: userP,
            purchaseRecord: subRow,
            planTier: 'pro',
            gateway: 'razorpay',
            actualPaymentId: `pay_prod_block_${now}`,
            cycleNumber: 2,
            now: now + 5000
          });
        }),
        /TAX_CONFIG_UNAPPROVED/
      );
    } finally {
      process.env.NODE_ENV = prevNode;
      if (prevSacApp !== undefined) process.env.AIRA_SUPPLIER_SAC_APPROVED = prevSacApp;
      if (prevFinApp !== undefined) process.env.AIRA_FINANCE_TAX_SIGNOFF = prevFinApp;
    }
  });
});
