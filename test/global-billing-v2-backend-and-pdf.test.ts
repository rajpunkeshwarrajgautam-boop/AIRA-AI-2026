import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { db } from '../packages/db/src/index.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import {
  buildInvoicePdfBuffer,
  buildCreditNotePdfBuffer
} from '../apps/api/src/billing/pdf-document-renderer.js';

describe('V2 Slice 2: Global Profile, Payment Methods, PDF Binary Renderer & Route Security (PG18)', () => {
  let appServer: http.Server;
  let baseUrl = '';
  const createdPrincipals: string[] = [];
  const origEnv = { ...process.env };

  const uid = (tag: string) => {
    const id = `usr_v2_${tag}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
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
    process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.AIRA_TEST_GATEWAY_KEY_ID = 'rzp_test_v2_key';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_v2_rzp';
    process.env.AIRA_SUPPLIER_GSTIN = '09AAMCV4678C1ZV';
    process.env.AIRA_SUPPLIER_GSTIN_VERIFIED = 'true';

    const app = express();
    app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));
    app.use((req, _res, next) => {
      const p = req.headers['x-test-principal'];
      const email = req.headers['x-test-email'];
      if (typeof p === 'string' && p.trim()) {
        req.principal = {
          userId: p.trim(),
          email: typeof email === 'string' ? email : 'global.buyer@example.com',
          name: 'Global Buyer'
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

  it('1. Public /plans hides internal taxConfigSummary diagnostics while returning global countries and capabilities', async () => {
    const res = await fetch(`${baseUrl}/api/billing/plans`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.taxConfigSummary, undefined, 'Public /plans must not expose internal taxConfigSummary diagnostics');
    assert.ok(Array.isArray(body.countries) && body.countries.length >= 25);
    assert.ok(body.providerCapabilities?.domesticInrRazorpay);
    assert.ok(body.providerCapabilities?.internationalUsdRazorpay);
    assert.equal(body.providerCapabilities?.internationalUsdCashfree?.status, 'UNVERIFIED_FOR_CURRENT_CHECKOUT');
    assert.equal(body.providerCapabilities?.invoiceEmailDelivery?.status, 'UNCONFIGURED_BLOCKER');
  });

  it('2. Global billing /profile saves non-India individual & business profiles cleanly without requiring Indian state', async () => {
    const usUser = uid('us_biz');
    const res = await fetch(`${baseUrl}/api/billing/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': usUser },
      body: JSON.stringify({
        country: 'US',
        accountType: 'business',
        legalName: 'Pacific Neural Labs LLC',
        addressLine1: '500 Howard St',
        city: 'San Francisco',
        stateCode: 'CA',
        postalCode: '94105',
        taxId: 'EIN-88-9911223'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.profile.country, 'US');
    assert.equal(data.profile.accountType, 'business');
    assert.equal(data.profile.legalName, 'Pacific Neural Labs LLC');
    assert.equal(data.profile.taxId, 'EIN-88-9911223');
    assert.equal(data.profile.isB2b, true);

    const getRes = await fetch(`${baseUrl}/api/billing/profile`, {
      headers: { 'x-test-principal': usUser }
    });
    assert.equal(getRes.status, 200);
    const got = await getRes.json();
    assert.equal(got.profile.country, 'US');
    assert.equal(got.profile.taxId, 'EIN-88-9911223');
  });

  it('3. USD checkout rejects Cashfree gateway cleanly and accepts Razorpay international USD without Indian mobile phone', async () => {
    const buyer = uid('usd_co');
    const badRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': buyer },
      body: JSON.stringify({
        planId: 'plus',
        currency: 'USD',
        gateway: 'cashfree',
        billingProfile: { country: 'US', accountType: 'individual' }
      })
    });
    assert.equal(badRes.status, 400);
    const badBody = await badRes.json();
    assert.equal(badBody.error, 'UNSUPPORTED_INTERNATIONAL_GATEWAY');

    const okRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': buyer },
      body: JSON.stringify({
        planId: 'pro',
        currency: 'USD',
        gateway: 'razorpay',
        billingProfile: { country: 'US', accountType: 'business', legalName: 'Global SaaS LLC', taxId: 'EIN-11-2233445' }
      })
    });
    assert.equal(okRes.status, 200);
    const co = await okRes.json();
    assert.equal(co.gateway, 'razorpay');
    assert.equal(co.currency, 'USD');
    assert.equal(co.amount, 1999);
  });

  it('4. Razorpay webhook activation extracts masked payment method summary, issues export invoice & serves true binary PDF with IDOR isolation', async () => {
    const userA = uid('buyer_pdf_a');
    const userB = uid('buyer_pdf_b');
    await commercialBillingService.getOrCreateCustomer(userB, 'other.user@example.com', 'Other User');

    const coRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-principal': userA,
        'x-test-email': 'alice@globalcorp.io'
      },
      body: JSON.stringify({
        planId: 'plus',
        currency: 'USD',
        gateway: 'razorpay',
        billingProfile: { country: 'GB', accountType: 'business', legalName: 'GlobalCorp UK Ltd', taxId: 'GB123456789' }
      })
    });
    assert.equal(coRes.status, 200);
    const co = await coRes.json();

    const webhookPayload = {
      entity: 'event',
      account_id: 'acc_test',
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: co.orderId,
            plan_id: 'plan_plus_usd_monthly',
            status: 'active',
            paid_count: 1,
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor((Date.now() + 30 * 86400000) / 1000),
            notes: { purchase_id: co.purchaseId, principal_id: userA, plan_tier: 'plus' }
          }
        },
        payment: {
          entity: {
            id: `pay_usd_${Date.now()}`,
            amount: 799,
            currency: 'USD',
            status: 'captured',
            method: 'card',
            card: {
              network: 'Visa',
              last4: '4242',
              type: 'credit',
              issuer: 'BARC'
            },
            notes: { purchase_id: co.purchaseId }
          }
        }
      }
    };
    const raw = JSON.stringify(webhookPayload);
    const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(raw).digest('hex');

    const whRes = await fetch(`${baseUrl}/api/billing/webhook/razorpay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': sig
      },
      body: raw
    });
    assert.equal(whRes.status, 200);

    // 1. Payment methods endpoint returns strictly masked provider-derived descriptor
    const pmRes = await fetch(`${baseUrl}/api/billing/payment-methods`, {
      headers: { 'x-test-principal': userA }
    });
    assert.equal(pmRes.status, 200);
    const pmBody = await pmRes.json();
    assert.equal(pmBody.paymentMethods.length, 1);
    assert.equal(pmBody.paymentMethods[0].brand, 'Visa');
    assert.equal(pmBody.paymentMethods[0].last4, '4242');
    assert.match(pmBody.paymentMethods[0].displayLabel, /Visa.*4242/);

    // 2. Summary includes paymentMethods & billingProfile
    const sumRes = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { 'x-test-principal': userA }
    });
    assert.equal(sumRes.status, 200);
    const sum = await sumRes.json();
    assert.equal(sum.paymentMethods[0].last4, '4242');
    assert.equal(sum.billingProfile.country, 'GB');
    assert.equal(sum.billingProfile.accountType, 'business');
    assert.equal(sum.billingProfile.taxId, 'GB123456789');

    // 3. Invoices & true binary PDF download
    const invRes = await fetch(`${baseUrl}/api/billing/invoices`, {
      headers: { 'x-test-principal': userA }
    });
    const invBody = await invRes.json();
    assert.equal(invBody.invoices.length, 1);
    const inv = invBody.invoices[0];
    assert.equal(inv.currency, 'USD');
    assert.equal(inv.totalAmount, 7.99);
    assert.equal(inv.pdfDownloadAvailable, true);
    assert.equal(inv.printableDocumentAvailable, true);

    const pdfRes = await fetch(`${baseUrl}/api/billing/invoices/${encodeURIComponent(inv.invoiceNumber)}/pdf`, {
      headers: { 'x-test-principal': userA }
    });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    const pdfAscii = pdfBuf.toString('latin1');
    assert.ok(pdfAscii.startsWith('%PDF-1.4'), 'PDF endpoint must return valid %PDF-1.4 magic header');
    assert.ok(pdfAscii.includes('%%EOF'), 'PDF endpoint must terminate with %%EOF');
    assert.ok(pdfAscii.includes(inv.invoiceNumber), 'PDF must contain exact invoice number');
    assert.ok(!pdfAscii.includes(userA), 'PDF must never leak internal usr_ principal ID');

    // 4. Cross-account isolation on PDF and Email endpoints
    const attackerPdfRes = await fetch(`${baseUrl}/api/billing/invoices/${encodeURIComponent(inv.invoiceNumber)}/pdf`, {
      headers: { 'x-test-principal': userB }
    });
    assert.equal(attackerPdfRes.status, 404);

    // 5. Email invoice fails closed honestly when mail transport is unconfigured
    const emailRes = await fetch(`${baseUrl}/api/billing/invoices/${encodeURIComponent(inv.invoiceNumber)}/email`, {
      method: 'POST',
      headers: { 'x-test-principal': userA }
    });
    assert.equal(emailRes.status, 503);
    const emailBody = await emailRes.json();
    assert.equal(emailBody.error, 'EMAIL_DELIVERY_NOT_CONFIGURED');
  });

  it('5. Unit verification of buildInvoicePdfBuffer & buildCreditNotePdfBuffer structure', () => {
    const invBuf = buildInvoicePdfBuffer({
      invoiceNumber: 'INV/26-27/00099',
      date: '2026-11-28',
      financialYear: '2026-27',
      plan: 'AIRA Pro',
      currency: 'INR',
      totalAmount: 999,
      taxableBase: 846.61,
      gstAmount: 152.39,
      igstAmount: 152.39,
      igstRate: 0.18,
      sacCode: '998315',
      supplierName: 'VIREXA AI VENTURES PRIVATE LIMITED',
      supplierGstin: '09AAMCV4678C1ZV',
      customerName: 'Test Buyer',
      placeOfSupply: '27',
      placeOfSupplyName: 'Maharashtra',
      status: 'Paid',
      isSandbox: true
    });
    const text = invBuf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'));
    assert.ok(text.includes('xref'));
    assert.ok(text.includes('%%EOF'));
    assert.ok(text.includes('SANDBOX REHEARSAL RECEIPT'));

    const cnBuf = buildCreditNotePdfBuffer({
      creditNoteNumber: 'SCN/26-27/00001',
      originalInvoiceNumber: 'SBX/26-27/00099',
      date: '2026-11-28',
      currency: 'USD',
      refundAmount: 7.99,
      taxableBase: 7.99,
      gstAmount: 0,
      supplierName: 'VIREXA AI VENTURES PRIVATE LIMITED',
      status: 'Refunded',
      isPartialRefund: false,
      isSandbox: true
    });
    assert.ok(cnBuf.toString('latin1').startsWith('%PDF-1.4'));
    assert.ok(cnBuf.toString('latin1').includes('%%EOF'));
  });

  it('6. Business -> Individual toggle clears cleanly on non-India /profile & long international state never overflows Credit Note DB columns', async () => {
    const intlUser = uid('intl_refund');
    const bizRes = await fetch(`${baseUrl}/api/billing/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': intlUser },
      body: JSON.stringify({
        country: 'US',
        accountType: 'business',
        legalName: 'Valley AI Corp',
        stateCode: 'California',
        taxId: 'EIN-77-1122334'
      })
    });
    assert.equal(bizRes.status, 200);
    const biz = await bizRes.json();
    assert.equal(biz.profile.accountType, 'business');
    assert.equal(biz.profile.stateCode, 'California');

    const indivRes = await fetch(`${baseUrl}/api/billing/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': intlUser },
      body: JSON.stringify({
        country: 'US',
        accountType: 'individual',
        stateCode: 'California',
        taxId: ''
      })
    });
    assert.equal(indivRes.status, 200);
    const indiv = await indivRes.json();
    assert.equal(indiv.profile.accountType, 'individual');
    assert.equal(indiv.profile.taxId, null);

    // Direct service USD checkout must still route to Razorpay even if default gateway env is cashfree
    const prevDefaultGw = process.env.AIRA_PAYMENT_GATEWAY_DEFAULT;
    process.env.AIRA_PAYMENT_GATEWAY_DEFAULT = 'cashfree';
    try {
      const co = await paymentGatewayService.createSubscriptionCheckout(
        intlUser,
        'plus',
        'USD',
        undefined,
        { userId: intlUser, email: 'valley@example.com' },
        undefined,
        undefined,
        { country: 'US', accountType: 'individual', stateCode: 'California' }
      );
      assert.equal(co.gateway, 'razorpay');

      // Activate & full refund via real signed webhooks -> must succeed without varchar(4) overflow on California
      const caPaymentId = `pay_ca_${Date.now()}`;
      const actRaw = JSON.stringify({
        entity: 'event',
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: co.orderId, status: 'active', paid_count: 1, notes: { purchase_id: co.purchaseId, principal_id: intlUser, plan_tier: 'plus' } } },
          payment: { entity: { id: caPaymentId, amount: 799, currency: 'USD', status: 'captured', method: 'card', card: { network: 'Mastercard', last4: '8888' } } }
        }
      });
      const actSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(actRaw).digest('hex');
      const actWh = await fetch(`${baseUrl}/api/billing/webhook/razorpay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': actSig },
        body: actRaw
      });
      assert.equal(actWh.status, 200);

      const rfndRaw = JSON.stringify({
        entity: 'event',
        event: 'refund.processed',
        payload: {
          refund: { entity: { id: `rfnd_ca_${Date.now()}`, payment_id: caPaymentId, amount: 799, currency: 'USD', status: 'processed' } }
        }
      });
      const rfndSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(rfndRaw).digest('hex');
      const rfndWh = await fetch(`${baseUrl}/api/billing/webhook/razorpay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': rfndSig },
        body: rfndRaw
      });
      assert.equal(rfndWh.status, 200);

      const cns = await paymentGatewayService.getCreditNotes(intlUser);
      assert.equal(cns.length, 1);
      assert.equal(cns[0].currency, 'USD');
    } finally {
      if (prevDefaultGw === undefined) delete process.env.AIRA_PAYMENT_GATEWAY_DEFAULT;
      else process.env.AIRA_PAYMENT_GATEWAY_DEFAULT = prevDefaultGw;
    }
  });
});
