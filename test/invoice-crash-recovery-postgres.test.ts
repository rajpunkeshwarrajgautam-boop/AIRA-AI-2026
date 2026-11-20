import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import knex, { type Knex } from 'knex';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, 'helpers/standalone-billing-worker.ts');

interface EngineConfig {
  version: '16' | '18';
  port: number;
}

const ENGINES: EngineConfig[] = [
  { version: '16', port: 5433 },
  { version: '18', port: 5432 }
];

for (const engine of ENGINES) {
  test.describe(`PostgreSQL ${engine.version} — Durable Invoice-Claim Recovery, Fencing & Constraint Suite`, () => {
    const testDbName = `aira_test_rec_pg${engine.version}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const connStr = `postgres://postgres:rehearsal_test_pass@127.0.0.1:${engine.port}/${testDbName}`;
    let db: Knex;

    test.before(async () => {
      // 1. Create isolated disposable database via WSL
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb -p ${engine.port} ${testDbName}`);

      // 2. Connect via Knex
      db = knex({
        client: 'pg',
        connection: {
          connectionString: connStr,
          ssl: false
        },
        pool: { min: 1, max: 4 }
      });

      // 3. Verify server version
      const verRes = await db.raw("SELECT version() AS version, current_setting('server_version') AS server_version");
      const verString = verRes.rows[0]?.version || '';
      assert.ok(
        verString.includes(`PostgreSQL ${engine.version}`),
        `Expected PostgreSQL ${engine.version}, received: ${verString}`
      );

      // 4. Run migrations 001 to 033
      const migrationsDir = path.resolve(__dirname, '../packages/db/src/migrations');
      await db.migrate.latest({
        directory: migrationsDir,
        extension: 'ts',
        loadExtensions: ['.ts']
      });

      // 5. Seed baseline test customer, plan, plan_prices, subscription, credit account
      const now = Date.now();
      await db('billing_customers').insert({
        id: 'cust_rec_test_1',
        principal_id: 'principal_rec_test_1',
        email: 'billing-rec@aira.test',
        name: 'AIRA Recovery Tester',
        default_currency: 'INR',
        country_code: 'IN',
        tax_info: JSON.stringify({ state: '07' }),
        created_at: now,
        updated_at: now
      });

      await db('credit_accounts').insert({
        id: 'ca_rec_test_1',
        customer_id: 'cust_rec_test_1',
        balance_credits: 50,
        reserved_credits: 0,
        lifetime_granted_credits: 50,
        lifetime_spent_credits: 0,
        created_at: now,
        updated_at: now
      });

      await db('subscriptions').insert({
        id: 'sub_rec_test_1',
        customer_id: 'cust_rec_test_1',
        plan_id: 'plus',
        price_id: 'price_plus_inr',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_rzp_rec_1',
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ customerState: '07', country: 'IN' }),
        created_at: now,
        updated_at: now
      });
    });

    test.after(async () => {
      if (db) {
        await db.destroy();
      }
      try {
        execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb -p ${engine.port} ${testDbName}`);
      } catch {}
    });

    test(`[PG${engine.version}] GATE 1: Worker crash mid-claim -> Lease expiration -> Worker 2 fences & issues exactly 1 invoice`, async () => {
      const cycleBindingKey = 'inv_binding:cust_rec_test_1:sub_rec_test_1:cycle:1';
      const paymentId = `pay_cycle1_${Date.now()}`;

      // Step 1: Worker 1 starts, acquires claim in idempotent_operations, and is killed abruptly (SIGKILL / exit 137)
      const worker1 = fork(workerPath, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DATABASE_URL: connStr }
      });

      const worker1ExitCode = await new Promise<number | null>((resolve) => {
        worker1.on('message', (msg: any) => {
          if (msg?.status === 'CLAIM_ACQUIRED') {
            // Worker 1 acquired claim; now wait for exit
          }
        });
        worker1.on('exit', (code) => resolve(code));
        worker1.send({
          action: 'CLAIM_AND_KILL',
          cycleBindingKey,
          principalId: 'principal_rec_test_1',
          purchaseId: 'sub_rec_test_1',
          cycle: 1,
          paymentId,
          leaseMs: 800 // short lease for fast test
        });
      });

      assert.strictEqual(worker1ExitCode, 137, 'Worker 1 must have exited abruptly with code 137');

      // Step 2: Verify database state immediately after Worker 1 crash
      const opRow = await db('idempotent_operations').where({ key: cycleBindingKey }).first();
      assert.ok(opRow, 'Claim must exist in idempotent_operations');
      assert.strictEqual(opRow.status, 'IN_PROGRESS', 'Claim status must be IN_PROGRESS after crash');

      const invoicesBeforeRecovery = await db('billing_invoices').where({ subscription_id: 'sub_rec_test_1', cycle_number: 1 });
      assert.strictEqual(invoicesBeforeRecovery.length, 0, 'No invoice must have been created before crash');

      const auditBeforeRecovery = await db('billing_audit_events').where({ event_type: 'TAX_INVOICE_ISSUED' });
      assert.strictEqual(auditBeforeRecovery.length, 0, 'No audit event must have been created before crash');

      // Step 3: Wait for Worker 1 lease to expire
      await new Promise((r) => setTimeout(r, 900));

      // Step 4: Worker 2 restarts and receives the redelivered signed webhook for cycle 1
      const worker2 = fork(workerPath, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DATABASE_URL: connStr }
      });

      const worker2Result = await new Promise<any>((resolve) => {
        worker2.on('message', (msg: any) => {
          if (msg?.status === 'SUCCESS') resolve(msg.invoice);
          else if (msg?.status === 'ERROR') {
            console.error('[Worker 2 Error]:', msg.error);
            resolve(msg);
          }
        });
        worker2.send({
          action: 'PROCESS_CYCLE',
          customerId: 'cust_rec_test_1',
          principalId: 'principal_rec_test_1',
          purchaseRecord: {
            id: 'sub_rec_test_1',
            customer_id: 'cust_rec_test_1',
            plan_id: 'plus',
            currency: 'INR',
            amount_minor_units: 39900,
            metadata: JSON.stringify({ customerState: '07', country: 'IN' })
          },
          cycleNumber: 1,
          actualPaymentId: paymentId,
          gateway: 'razorpay'
        });
      });

      assert.ok(worker2Result?.invoiceNumber, 'Worker 2 must successfully issue the invoice');
      assert.match(worker2Result.invoiceNumber, /^INV-2026-\d{4}$/, 'Invoice number must match sequential format');

      // Step 5: Verify exactly one invoice exists in relational billing_invoices table
      const invoicesAfterRecovery = await db('billing_invoices').where({ subscription_id: 'sub_rec_test_1', cycle_number: 1 });
      assert.strictEqual(invoicesAfterRecovery.length, 1, 'Exactly ONE invoice must exist in billing_invoices');
      assert.strictEqual(invoicesAfterRecovery[0].invoice_number, worker2Result.invoiceNumber);
      assert.strictEqual(invoicesAfterRecovery[0].billing_event_id, paymentId);

      // Verify idempotent_operations was updated to COMPLETED with zero remaining lock
      const opAfter = await db('idempotent_operations').where({ key: cycleBindingKey }).first();
      assert.strictEqual(opAfter.status, 'COMPLETED', 'Claim must be marked COMPLETED after recovery');
      assert.strictEqual(Number(opAfter.locked_until), 0, 'Claim lease must be cleared (0) with no stranded claim');

      // Step 6: Redeliver signed webhook AGAIN (duplicate redelivery)
      const worker3 = fork(workerPath, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DATABASE_URL: connStr }
      });

      const worker3Result = await new Promise<any>((resolve) => {
        worker3.on('message', (msg: any) => {
          if (msg?.status === 'SUCCESS') resolve(msg.invoice);
          else if (msg?.status === 'ERROR') resolve(msg);
        });
        worker3.send({
          action: 'PROCESS_CYCLE',
          customerId: 'cust_rec_test_1',
          principalId: 'principal_rec_test_1',
          purchaseRecord: {
            id: 'sub_rec_test_1',
            customer_id: 'cust_rec_test_1',
            plan_id: 'plus',
            currency: 'INR',
            amount_minor_units: 39900,
            metadata: JSON.stringify({ customerState: '07', country: 'IN' })
          },
          cycleNumber: 1,
          actualPaymentId: paymentId,
          gateway: 'razorpay'
        });
      });

      assert.strictEqual(worker3Result.invoiceNumber, worker2Result.invoiceNumber, 'Redelivered webhook must return identical invoice');

      // Verify NO duplicate invoice was inserted
      const invoicesAfterDuplicate = await db('billing_invoices').where({ subscription_id: 'sub_rec_test_1', cycle_number: 1 });
      assert.strictEqual(invoicesAfterDuplicate.length, 1, 'Still exactly ONE invoice must exist after duplicate delivery');
    });

    test(`[PG${engine.version}] GATE 2: Worker crash after invoice insertion but before completion -> Worker recovery recovers exact invoice`, async () => {
      const cycleBindingKey = 'inv_binding:cust_rec_test_1:sub_rec_test_1:cycle:2';
      const paymentId = `pay_cycle2_${Date.now()}`;

      // Worker 4 claims cycle 2, inserts into billing_invoices, then terminates abruptly
      const worker4 = fork(workerPath, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DATABASE_URL: connStr }
      });

      let insertedInvoiceNumber = '';
      await new Promise<void>((resolve) => {
        worker4.on('message', (msg: any) => {
          if (msg?.status === 'INVOICE_INSERTED') {
            insertedInvoiceNumber = msg.invoiceNumber;
          }
        });
        worker4.on('exit', () => resolve());
        worker4.send({
          action: 'CLAIM_INSERT_INVOICE_AND_KILL',
          cycleBindingKey,
          customerId: 'cust_rec_test_1',
          principalId: 'principal_rec_test_1',
          purchaseId: 'sub_rec_test_1',
          cycle: 2,
          paymentId,
          planTier: 'plus',
          leaseMs: 800
        });
      });

      assert.ok(insertedInvoiceNumber, 'Worker 4 must have inserted an invoice before termination');

      // Wait for lease to expire
      await new Promise((r) => setTimeout(r, 900));

      // Worker 5 restarts and processes cycle 2
      const worker5 = fork(workerPath, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DATABASE_URL: connStr }
      });

      const worker5Result = await new Promise<any>((resolve) => {
        worker5.on('message', (msg: any) => {
          if (msg?.status === 'SUCCESS') resolve(msg.invoice);
          else if (msg?.status === 'ERROR') resolve(msg);
        });
        worker5.send({
          action: 'PROCESS_CYCLE',
          customerId: 'cust_rec_test_1',
          principalId: 'principal_rec_test_1',
          purchaseRecord: {
            id: 'sub_rec_test_1',
            customer_id: 'cust_rec_test_1',
            plan_id: 'plus',
            currency: 'INR',
            amount_minor_units: 39900,
            metadata: JSON.stringify({ customerState: '07', country: 'IN' })
          },
          cycleNumber: 2,
          actualPaymentId: paymentId,
          gateway: 'razorpay'
        });
      });

      assert.strictEqual(
        worker5Result.invoiceNumber,
        insertedInvoiceNumber,
        'Worker 5 must recover and reuse the exact invoice inserted by the crashed worker'
      );

      // Verify billing_invoices table still has exactly 1 row for cycle 2
      const invoicesCycle2 = await db('billing_invoices').where({ subscription_id: 'sub_rec_test_1', cycle_number: 2 });
      assert.strictEqual(invoicesCycle2.length, 1, 'Exactly ONE invoice must exist for cycle 2');
    });

    test(`[PG${engine.version}] GATE 3: Database-layer relational constraints strictly enforce document and event uniqueness`, async () => {
      const uniqueTestInvNumber = `INV-2026-UQ-${Date.now()}`;
      await db('billing_invoices').insert({
        id: `inv_uq_seed_${Date.now()}`,
        invoice_number: uniqueTestInvNumber,
        customer_id: 'cust_rec_test_1',
        subscription_id: 'sub_rec_test_1',
        cycle_number: 100,
        billing_event_id: `pay_event_uq_1_${Date.now()}`,
        plan_tier: 'plus',
        currency: 'INR',
        total_amount: 399.00,
        taxable_base: 338.14,
        gst_amount: 60.86,
        sac_code: '998431',
        supplier_name: 'Virexa AI Ventures Private Limited',
        gateway: 'razorpay',
        created_at: Date.now(),
        updated_at: Date.now()
      });

      // 1. UNIQUE constraint on invoice_number
      let duplicateNumberThrew = false;
      try {
        await db('billing_invoices').insert({
          id: `inv_dup_${Date.now()}`,
          invoice_number: uniqueTestInvNumber, // Duplicate!
          customer_id: 'cust_rec_test_1',
          subscription_id: 'sub_rec_test_1',
          cycle_number: 101,
          billing_event_id: `pay_event_uq_2_${Date.now()}`,
          plan_tier: 'plus',
          currency: 'INR',
          total_amount: 399.00,
          taxable_base: 338.14,
          gst_amount: 60.86,
          sac_code: '998431',
          supplier_name: 'Virexa AI Ventures Private Limited',
          gateway: 'razorpay',
          created_at: Date.now(),
          updated_at: Date.now()
        });
      } catch (err: any) {
        duplicateNumberThrew = err?.code === '23505' || String(err).includes('unique');
      }
      assert.strictEqual(duplicateNumberThrew, true, 'Duplicate invoice_number must be rejected by PostgreSQL UNIQUE constraint');

      // 2. UNIQUE constraint on (subscription_id, cycle_number)
      let duplicateCycleThrew = false;
      try {
        await db('billing_invoices').insert({
          id: `inv_dup_cycle_${Date.now()}`,
          invoice_number: `INV-2026-DIFF-${Date.now()}`,
          customer_id: 'cust_rec_test_1',
          subscription_id: 'sub_rec_test_1',
          cycle_number: 100, // Cycle 100 already exists!
          billing_event_id: `pay_event_cycle_${Date.now()}`,
          plan_tier: 'plus',
          currency: 'INR',
          total_amount: 399.00,
          taxable_base: 338.14,
          gst_amount: 60.86,
          sac_code: '998431',
          supplier_name: 'Virexa AI Ventures Private Limited',
          gateway: 'razorpay',
          created_at: Date.now(),
          updated_at: Date.now()
        });
      } catch (err: any) {
        duplicateCycleThrew = err?.code === '23505' || String(err).includes('unique');
      }
      assert.strictEqual(duplicateCycleThrew, true, 'Duplicate (subscription_id, cycle_number) must be rejected by PostgreSQL constraint');

      // 3. UNIQUE constraint on billing_credit_notes (credit_note_number)
      const now = Date.now();
      await db('billing_credit_notes').insert({
        id: `cn_1_${now}`,
        credit_note_number: 'CN-2026-0001',
        customer_id: 'cust_rec_test_1',
        subscription_id: 'sub_rec_test_1',
        refund_id: 'rf_unique_1',
        refund_amount: 399.00,
        currency: 'INR',
        supplier_name: 'Virexa AI Ventures Private Limited',
        gateway: 'razorpay',
        created_at: now,
        updated_at: now
      });

      let duplicateCnThrew = false;
      try {
        await db('billing_credit_notes').insert({
          id: `cn_2_${now}`,
          credit_note_number: 'CN-2026-0001', // duplicate
          customer_id: 'cust_rec_test_1',
          subscription_id: 'sub_rec_test_1',
          refund_id: 'rf_unique_2',
          refund_amount: 399.00,
          currency: 'INR',
          supplier_name: 'Virexa AI Ventures Private Limited',
          gateway: 'razorpay',
          created_at: now,
          updated_at: now
        });
      } catch (err: any) {
        duplicateCnThrew = err?.code === '23505' || String(err).includes('unique');
      }
      assert.strictEqual(duplicateCnThrew, true, 'Duplicate credit_note_number must be rejected by PostgreSQL UNIQUE constraint');
    });
  });
}
