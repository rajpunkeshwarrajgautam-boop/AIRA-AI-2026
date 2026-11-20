import knex from 'knex';
import { paymentGatewayService } from '../../apps/api/src/billing/payment-gateway-service.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.exit(1);
}

const db = knex({
  client: 'pg',
  connection: {
    connectionString,
    ssl: false
  },
  pool: { min: 1, max: 3 }
});

process.on('message', async (msg: any) => {
  if (msg?.action === 'CLAIM_AND_KILL') {
    // Acquire lease in idempotent_operations, notify parent, then immediately kill self
    const { cycleBindingKey, principalId, purchaseId, cycle, paymentId, leaseMs } = msg;
    const now = Date.now();
    try {
      await db('idempotent_operations').insert({
        key: cycleBindingKey,
        principal_id: principalId,
        operation_id: `inv_binding_${purchaseId}_cycle_${cycle}`,
        operation_type: 'tax_invoice_binding',
        payload_hash: paymentId || '',
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        locked_until: now + (leaseMs || 1500),
        owner_token: msg.workerToken || `worker_${process.pid}`,
        generation: 1,
        created_at: now,
        updated_at: now
      });
      if (process.send) process.send({ status: 'CLAIM_ACQUIRED', pid: process.pid });
      // Terminate process abruptly mid-claim without invoice generation
      process.exit(137);
    } catch (err: any) {
      if (process.send) process.send({ status: 'ERROR', error: err.message });
      process.exit(1);
    }
  } else if (msg?.action === 'CLAIM_INSERT_INVOICE_AND_KILL') {
    // Acquire lease, insert invoice into relational table, notify parent, then immediately kill self BEFORE idempotent_operations update
    const { cycleBindingKey, customerId, principalId, purchaseId, cycle, paymentId, planTier, leaseMs } = msg;
    const now = Date.now();
    try {
      await db('idempotent_operations').insert({
        key: cycleBindingKey,
        principal_id: principalId,
        operation_id: `inv_binding_${purchaseId}_cycle_${cycle}`,
        operation_type: 'tax_invoice_binding',
        payload_hash: paymentId || '',
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        locked_until: now + (leaseMs || 1500),
        owner_token: msg.workerToken || `worker_${process.pid}`,
        generation: 1,
        created_at: now,
        updated_at: now
      });
      paymentGatewayService.setDbClient(db);
      const invoiceNumber = await paymentGatewayService.allocateInvoiceNumber(db, 2026);
      await db('billing_invoices').insert({
        id: `inv_crash_${Date.now()}`,
        invoice_number: invoiceNumber,
        customer_id: customerId,
        subscription_id: purchaseId,
        cycle_number: cycle,
        billing_event_id: paymentId,
        plan_tier: planTier,
        currency: 'INR',
        total_amount: 399.00,
        taxable_base: 338.14,
        gst_amount: 60.86,
        cgst_amount: 30.43,
        sgst_amount: 30.43,
        sac_code: '998431',
        supplier_name: 'Virexa AI Ventures Private Limited',
        supplier_gstin: '07AAAAA0000A1Z5',
        tax_compliance_status: 'COMPLIANT',
        place_of_supply: '07',
        status: 'Paid',
        gateway: 'razorpay',
        created_at: now,
        updated_at: now
      });
      if (process.send) process.send({ status: 'INVOICE_INSERTED', invoiceNumber, pid: process.pid });
      // Kill abruptly before updating idempotent_operations
      process.exit(137);
    } catch (err: any) {
      if (process.send) process.send({ status: 'ERROR', error: err.message });
      process.exit(1);
    }
  } else if (msg?.action === 'PAUSE_AFTER_CLAIM') {
    const { cycleBindingKey, principalId, purchaseId, cycle, paymentId, leaseMs, workerToken } = msg;
    const now = Date.now();
    const token = workerToken || `worker_${process.pid}_${now}`;
    try {
      await db('idempotent_operations').insert({
        key: cycleBindingKey,
        principal_id: principalId,
        operation_id: `inv_binding_${purchaseId}_cycle_${cycle}`,
        operation_type: 'tax_invoice_binding',
        payload_hash: paymentId || '',
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        locked_until: now + (leaseMs || 1000),
        owner_token: token,
        generation: 1,
        created_at: now,
        updated_at: now
      });
      if (process.send) process.send({ status: 'CLAIM_ACQUIRED', ownerToken: token, pid: process.pid });

      // Wait for resume message
      process.on('message', async (resumeMsg: any) => {
        if (resumeMsg?.action === 'RESUME_FINALIZATION') {
          try {
            // Worker A attempts to finalize its claim with its stale owner_token and generation 1
            const finalizeQuery = db('idempotent_operations')
              .where({ key: cycleBindingKey, owner_token: token, generation: 1 });
            const affected = await finalizeQuery.update({
              status: 'COMPLETED',
              response_status: 200,
              response_body: JSON.stringify({ invoiceNumber: 'INV-STALE-WORKER-A' }),
              locked_until: 0,
              updated_at: Date.now()
            });

            if (affected !== 1) {
              throw new Error(
                `STALE_WORKER_FENCING_LOST: Worker ${token} (gen 1) lost ownership to a newer worker before finalization`
              );
            }

            if (process.send) process.send({ status: 'SUCCESS', pid: process.pid });
            await db.destroy();
            process.exit(0);
          } catch (err: any) {
            if (process.send) process.send({ status: 'FENCING_REJECTED', error: err.message, pid: process.pid });
            await db.destroy();
            process.exit(1);
          }
        }
      });
    } catch (err: any) {
      if (process.send) process.send({ status: 'ERROR', error: err.message });
      process.exit(1);
    }
  } else if (msg?.action === 'PROCESS_CYCLE') {
    const { customerId, principalId, purchaseRecord, cycleNumber, actualPaymentId, gateway, workerToken } = msg;
    try {
      paymentGatewayService.setDbClient(db);
      const invoice = await paymentGatewayService.issueDurableInvoice({
        trx: db,
        customerId,
        principalId,
        purchaseRecord,
        planTier: purchaseRecord.plan_id || 'plus',
        gateway: gateway || 'razorpay',
        actualPaymentId,
        gatewayOrderId: `order_${actualPaymentId}`,
        cycleNumber,
        now: Date.now(),
        workerToken: workerToken || `worker_${process.pid}_${Date.now()}`
      });
      if (process.send) process.send({ status: 'SUCCESS', invoice, pid: process.pid });
      await db.destroy();
      process.exit(0);
    } catch (err: any) {
      if (process.send) process.send({ status: 'ERROR', error: err.message, pid: process.pid });
      await db.destroy();
      process.exit(1);
    }
  }
});
