import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, execSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';

// Prevent WSL idle-shutdown while Node executes test suites against WSL PostgreSQL clusters
let wslKeepAlive: ChildProcess | null = null;
try {
  wslKeepAlive = spawn('wsl', ['-d', 'Ubuntu-24.04', 'sleep', '600'], { stdio: 'ignore' });
  wslKeepAlive.unref();
  process.on('exit', () => {
    try { wslKeepAlive?.kill(); } catch {}
  });
  process.on('beforeExit', () => {
    try { wslKeepAlive?.kill(); } catch {}
  });
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, 'helpers/standalone-billing-worker.ts');

const host = process.env.PGHOST || '127.0.0.1';
const user = process.env.PGUSER || 'postgres';
const password = process.env.PGPASSWORD || 'rehearsal_test_pass';

async function createDisposableDatabase(port: number, dbName: string): Promise<void> {
  try {
    const adminDb = knex({
      client: 'pg',
      connection: { connectionString: `postgres://${user}:${password}@${host}:${port}/postgres` }
    });
    await adminDb.raw(`CREATE DATABASE "${dbName}"`);
    await adminDb.destroy();
  } catch (err) {
    try {
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb -p ${port} ${dbName}`);
    } catch {
      throw err;
    }
  }
}

async function dropDisposableDatabase(port: number, dbName: string): Promise<void> {
  try {
    const adminDb = knex({
      client: 'pg',
      connection: { connectionString: `postgres://${user}:${password}@${host}:${port}/postgres` }
    });
    await adminDb.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminDb.destroy();
  } catch {
    try {
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb -p ${port} ${dbName}`);
    } catch {}
  }
}

interface EngineConfig {
  version: '16' | '18';
  port: number;
}

const ENGINES: EngineConfig[] = [
  { version: '16', port: Number(process.env.PGPORT_16 || 5433) },
  { version: '18', port: Number(process.env.PGPORT_18 || 5432) }
];

for (const engine of ENGINES) {
  test.describe(`PostgreSQL ${engine.version} — Durable Invoice-Claim Recovery, Fencing & Constraint Suite`, () => {
    const testDbName = `aira_test_rec_pg${engine.version}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const connStr = `postgres://${user}:${password}@${host}:${engine.port}/${testDbName}`;
    let db: Knex;

    test.before(async () => {
      // 1. Create isolated disposable database
      await createDisposableDatabase(engine.port, testDbName);

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
      await dropDisposableDatabase(engine.port, testDbName);
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
      assert.match(worker2Result.invoiceNumber, /^INV\/\d{2}-\d{2}\/\d{5}$/, 'Invoice number must match FY sequential format');

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
      const uniqueTestCnNumber = `CN-2026-UQ-${now}`;
      await db('billing_credit_notes').insert({
        id: `cn_1_${now}`,
        credit_note_number: uniqueTestCnNumber,
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
          credit_note_number: uniqueTestCnNumber, // duplicate
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

    test(`[PG${engine.version}] GATE 4: Stale Worker Fencing -> Worker A paused in service -> Worker B takeover & completion -> Worker A resumes & is rejected`, async () => {
      const cycleBindingKey = 'inv_binding:cust_rec_test_1:sub_rec_test_1:cycle:3';
      const paymentId = `pay_cycle3_${Date.now()}`;

      // Worker A starts and executes real issueDurableInvoice with short lease (800ms) and pause (1600ms)
      const workerA = fork(workerPath, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DATABASE_URL: connStr }
      });

      const workerAPromise = new Promise<any>((resolve) => {
        workerA.on('message', (msg: any) => {
          if (msg?.status === 'SUCCESS' || msg?.status === 'FENCING_REJECTED' || msg?.status === 'ERROR') {
            resolve(msg);
          }
        });
      });

      const workerAToken = await new Promise<string>((resolve, reject) => {
        workerA.on('message', (msg: any) => {
          if (msg?.status === 'CLAIM_ACQUIRED') resolve(msg.ownerToken);
          else if (msg?.status === 'ERROR') reject(new Error(msg.error));
        });
        workerA.send({
          action: 'PROCESS_CYCLE_WITH_PAUSE',
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
          cycleNumber: 3,
          actualPaymentId: paymentId,
          gateway: 'razorpay',
          workerToken: 'worker_a_paused',
          leaseMs: 800,
          pauseMs: 1600
        });
      });

      assert.strictEqual(workerAToken, 'worker_a_paused');

      // Verify claim exists with owner Worker A and generation 1
      const claimRowA = await db('idempotent_operations').where({ key: cycleBindingKey }).first();
      assert.strictEqual(claimRowA.status, 'IN_PROGRESS');
      assert.strictEqual(claimRowA.owner_token, 'worker_a_paused');
      assert.strictEqual(Number(claimRowA.generation), 1);

      // Wait for Worker A lease to expire (900ms)
      await new Promise((r) => setTimeout(r, 900));

      // Worker B restarts and processes cycle 3
      const workerB = fork(workerPath, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, DATABASE_URL: connStr }
      });

      const workerBResult = await new Promise<any>((resolve) => {
        workerB.on('message', (msg: any) => {
          if (msg?.status === 'SUCCESS') resolve(msg.invoice);
          else if (msg?.status === 'ERROR') resolve(msg);
        });
        workerB.send({
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
          cycleNumber: 3,
          actualPaymentId: paymentId,
          gateway: 'razorpay',
          workerToken: 'worker_b_takeover'
        });
      });

      assert.ok(workerBResult?.invoiceNumber, 'Worker B must successfully issue the invoice');
      assert.match(workerBResult.invoiceNumber, /^INV\/\d{2}-\d{2}\/\d{5}$/);

      // Verify claim in DB now has generation >= 2, status COMPLETED
      const claimRowB = await db('idempotent_operations').where({ key: cycleBindingKey }).first();
      assert.strictEqual(claimRowB.status, 'COMPLETED');
      assert.strictEqual(Number(claimRowB.locked_until), 0);
      assert.strictEqual(claimRowB.owner_token, 'worker_b_takeover');
      assert.ok(Number(claimRowB.generation) >= 2, `Generation must be >= 2, was ${claimRowB.generation}`);

      // Now wait for Worker A to resume inside issueDurableInvoice and attempt finalization
      const workerAFinalizeResult = await workerAPromise;

      assert.strictEqual(
        workerAFinalizeResult.status,
        'FENCING_REJECTED',
        'Stale Worker A must be rejected by fencing CAS check inside issueDurableInvoice'
      );
      assert.ok(
        workerAFinalizeResult.error.includes('STALE_WORKER_FENCING_LOST') ||
        workerAFinalizeResult.error.includes('INVOICE_CYCLE_CONTENTION') ||
        workerAFinalizeResult.error.includes('fencing'),
        `Error must identify fencing violation: ${workerAFinalizeResult.error}`
      );

      // Verify DB: exactly ONE invoice for cycle 3
      const invoicesCycle3 = await db('billing_invoices').where({ subscription_id: 'sub_rec_test_1', cycle_number: 3 });
      assert.strictEqual(invoicesCycle3.length, 1, 'Exactly ONE invoice must exist for cycle 3');
      assert.strictEqual(invoicesCycle3[0].invoice_number, workerBResult.invoiceNumber);
    });

    test(`[PG${engine.version}] GATE 5: Migration 033 safe rollback guard blocks destructive deletion of financial documents`, async () => {
      const migration033 = await import('../packages/db/src/migrations/033_billing_invoice_sequences.js');

      // Verify financial records currently exist in database
      const invCount = await db('billing_invoices').count('* as count').first();
      assert.ok(Number(invCount?.count || 0) > 0, 'Invoices must exist in database');

      // Attempt down() without ALLOW_DESTRUCTIVE_FINANCIAL_ROLLBACK
      delete process.env.ALLOW_DESTRUCTIVE_FINANCIAL_ROLLBACK;
      let rollbackBlocked = false;
      let rollbackError = '';
      try {
        await migration033.down(db);
      } catch (err: any) {
        rollbackBlocked = true;
        rollbackError = err.message;
      }

      assert.strictEqual(rollbackBlocked, true, 'Migration 033 down() must fail closed when financial records exist');
      assert.ok(
        rollbackError.includes('ROLLBACK_BLOCKED'),
        `Error must cite ROLLBACK_BLOCKED: ${rollbackError}`
      );

      // Verify tables still exist and were NOT dropped
      const invTableStillExists = await db.schema.hasTable('billing_invoices');
      const cnTableStillExists = await db.schema.hasTable('billing_credit_notes');
      assert.strictEqual(invTableStillExists, true, 'billing_invoices table must NOT be dropped');
      assert.strictEqual(cnTableStillExists, true, 'billing_credit_notes table must NOT be dropped');
    });

    test(`[PG${engine.version}] GATE 6: Real PostgreSQL Credit-Note Savepoint, Rollback & Out-of-Band Reconciliation Suite`, async () => {
      // 1. Seed a dedicated test customer & subscription for refund verification
      const now = Date.now();
      const subId = `sub_rf_test_${now}`;
      const customerId = `cust_rf_${now}`;
      const initialPaymentId = `pay_rf_init_${now}`;
      const originalInvoiceNumber = `INV-2026-RF-${now}`;

      await db('billing_customers').insert({
        id: customerId,
        principal_id: `principal_rf_${now}`,
        email: `billing-rf-${now}@aira.test`,
        name: 'AIRA Refund Recovery Tester',
        default_currency: 'INR',
        country_code: 'IN',
        tax_info: JSON.stringify({ state: '09' }),
        created_at: now,
        updated_at: now
      });

      await db('subscriptions').insert({
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        price_id: 'price_plus_inr',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: `sub_rzp_rf_${now}`,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          customerState: '07',
          country: 'IN',
          initialPaymentId,
          lastPaymentId: initialPaymentId
        }),
        created_at: now,
        updated_at: now
      });

      await db('billing_invoices').insert({
        id: `inv_rf_seed_${now}`,
        invoice_number: originalInvoiceNumber,
        customer_id: customerId,
        subscription_id: subId,
        cycle_number: 1,
        billing_event_id: initialPaymentId,
        plan_tier: 'plus',
        currency: 'INR',
        total_amount: 399.00,
        taxable_base: 338.14,
        gst_amount: 60.86,
        sac_code: '998431',
        supplier_name: 'Virexa AI Ventures Private Limited',
        status: 'Paid',
        gateway: 'razorpay',
        created_at: now,
        updated_at: now
      });

      // Import paymentGatewayService directly in test
      const { paymentGatewayService } = await import('../apps/api/src/billing/payment-gateway-service.js');
      paymentGatewayService.setDbClient(db);

      const refundId1 = `rf_pg_test_1_${now}`;
      const refundPayload1 = {
        event: 'refund.processed',
        payload: {
          payment: {
            entity: {
              id: initialPaymentId,
              order_id: `sub_rzp_rf_${now}`,
              amount: 39900,
              currency: 'INR',
              status: 'refunded'
            }
          },
          refund: {
            entity: {
              id: refundId1,
              payment_id: initialPaymentId,
              amount: 39900,
              currency: 'INR',
              status: 'processed'
            }
          }
        }
      };

      const subRecord1 = await db('subscriptions').where({ id: subId }).first();

      // Step A: Process genuine refund
      await paymentGatewayService.handleSubscriptionRefund({
        gateway: 'razorpay',
        subRecord: subRecord1,
        refundPayload: refundPayload1,
        now
      });

      // Verify credit note was created in relational billing_credit_notes
      const cnRows1 = await db('billing_credit_notes').where({ refund_id: refundId1 });
      assert.strictEqual(cnRows1.length, 1, 'Exactly one credit note must be created in billing_credit_notes');
      assert.match(cnRows1[0].credit_note_number, /^CN\/\d{2}-\d{2}\/\d{5}$/, 'Credit note number must follow FY sequential format');
      assert.strictEqual(cnRows1[0].original_invoice_number, originalInvoiceNumber, 'Must link to original invoice');
      assert.strictEqual(cnRows1[0].status, 'Refunded');

      // Verify linked invoice status was updated to Refunded
      const invAfterRefund1 = await db('billing_invoices').where({ invoice_number: originalInvoiceNumber }).first();
      assert.strictEqual(invAfterRefund1?.status, 'Refunded', 'Original invoice status must update to Refunded');

      // Step B: Duplicate refund delivery (Savepoint idempotency without PostgreSQL transaction abort)
      await paymentGatewayService.handleSubscriptionRefund({
        gateway: 'razorpay',
        subRecord: await db('subscriptions').where({ id: subId }).first(),
        refundPayload: refundPayload1,
        now: now + 100
      });

      // Still exactly 1 credit note row
      const cnRowsAfterDup = await db('billing_credit_notes').where({ refund_id: refundId1 });
      assert.strictEqual(cnRowsAfterDup.length, 1, 'Duplicate delivery must not insert duplicate credit note');

      // Step C: Verify 6-dimension mismatch rejection on conflicting duplicate
      let mismatchError = '';
      try {
        paymentGatewayService.verifyCreditNoteDimensions(cnRows1[0], {
          refundId: refundId1,
          subscriptionId: subId,
          customerId: 'cust_different_tenant', // Tenant mismatch!
          currency: 'INR',
          refundAmount: 399.00,
          originalInvoiceNumber
        });
      } catch (err: any) {
        mismatchError = err.message;
      }
      assert.ok(mismatchError.includes('TENANT_MISMATCH'), `Must throw tenant mismatch error: ${mismatchError}`);

      // Step D: Failure Injection & Out-of-Band Reconciliation Survival
      // Setup second subscription to test transactional rollback with out-of-band persistence
      const subIdFail = `sub_rf_fail_${now}`;
      const initialPayFail = `pay_fail_${now}`;
      const invNumberFail = `INV-2026-FAIL-${now}`;

      await db('subscriptions').insert({
        id: subIdFail,
        customer_id: customerId,
        plan_id: 'plus',
        price_id: 'price_plus_inr',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: `sub_rzp_fail_${now}`,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          customerState: '07',
          country: 'IN',
          initialPaymentId: initialPayFail,
          lastPaymentId: initialPayFail
        }),
        created_at: now,
        updated_at: now
      });

      await db('billing_invoices').insert({
        id: `inv_fail_seed_${now}`,
        invoice_number: invNumberFail,
        customer_id: customerId,
        subscription_id: subIdFail,
        cycle_number: 1,
        billing_event_id: initialPayFail,
        plan_tier: 'plus',
        currency: 'INR',
        total_amount: 399.00,
        taxable_base: 338.14,
        gst_amount: 60.86,
        sac_code: '998431',
        supplier_name: 'Virexa AI Ventures Private Limited',
        status: 'Paid',
        gateway: 'razorpay',
        created_at: now,
        updated_at: now
      });

      const refundIdFail = `rf_fail_test_${now}`;
      const subRecordFail = await db('subscriptions').where({ id: subIdFail }).first();

      // Execute transaction where credit note generation fails (simulating failure via debugHookBeforeCommit)
      let txnThrew = false;
      try {
        await paymentGatewayService.handleSubscriptionRefund({
          gateway: 'razorpay',
          subRecord: subRecordFail,
          refundPayload: {
            event: 'refund.processed',
            payload: {
              payment: {
                entity: {
                  id: initialPayFail,
                  order_id: `sub_rzp_fail_${now}`,
                  amount: 39900,
                  currency: 'INR',
                  status: 'refunded'
                }
              },
              refund: {
                entity: {
                  id: refundIdFail,
                  payment_id: initialPayFail,
                  amount: 39900,
                  currency: 'INR',
                  status: 'processed'
                }
              }
            }
          },
          now,
          debugHookBeforeCommit: async ({ refundId }) => {
            throw new Error(`INJECTED_ROLLBACK_BEFORE_COMMIT:${refundId}`);
          }
        });
      } catch (err: any) {
        txnThrew = true;
      }

      assert.strictEqual(txnThrew, true, 'Injected credit note failure must throw and roll back transaction');

      // OPEN A FRESH INDEPENDENT DATABASE CONNECTION to verify state post-rollback
      const freshDb = knex({
        client: 'pg',
        connection: { connectionString: connStr, ssl: false },
        pool: { min: 1, max: 1 }
      });

      try {
        // 1. Verify business transaction rolled back: subscriptions status is still 'active' (NOT 'refunded')
        const subAfterRollback = await freshDb('subscriptions').where({ id: subIdFail }).first();
        assert.strictEqual(subAfterRollback?.status, 'active', 'Subscription status must NOT be refunded after rollback');

        // 2. Verify zero false CREDIT_NOTE_ISSUED events exist for this refund
        const falseIssuedEvents = await freshDb('billing_audit_events').where({
          customer_id: customerId,
          event_type: 'CREDIT_NOTE_ISSUED'
        });
        const matchedFalse = (falseIssuedEvents || []).filter((e: any) => {
          try {
            const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
            return p?.refundId === refundIdFail;
          } catch { return false; }
        });
        assert.strictEqual(matchedFalse.length, 0, 'Zero false CREDIT_NOTE_ISSUED events must exist');

        // 3. Verify CREDIT_NOTE_PENDING_RECONCILIATION survived transaction rollback via out-of-band commit!
        const pendingEvents = await freshDb('billing_audit_events').where({
          customer_id: customerId,
          event_type: 'CREDIT_NOTE_PENDING_RECONCILIATION'
        });
        const matchedPending = (pendingEvents || []).filter((e: any) => {
          try {
            const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
            return p?.refundId === refundIdFail;
          } catch { return false; }
        });
        assert.ok(matchedPending.length >= 1, 'CREDIT_NOTE_PENDING_RECONCILIATION must survive transaction rollback out-of-band');

        // Step E: Replay/redelivery of refund succeeds and clears pending state with CREDIT_NOTE_RECONCILED
        const validRefundPayload = {
          event: 'refund.processed',
          payload: {
            payment: {
              entity: {
                id: initialPayFail,
                order_id: `sub_rzp_fail_${now}`,
                amount: 39900,
                currency: 'INR',
                status: 'refunded'
              }
            },
            refund: {
              entity: {
                id: refundIdFail,
                payment_id: initialPayFail,
                amount: 39900,
                currency: 'INR',
                status: 'processed'
              }
            }
          }
        };

        await paymentGatewayService.handleSubscriptionRefund({
          gateway: 'razorpay',
          subRecord: await freshDb('subscriptions').where({ id: subIdFail }).first(),
          refundPayload: validRefundPayload,
          now: now + 500
        });

        // Verify credit note now successfully created
        const cnFailResolved = await freshDb('billing_credit_notes').where({ refund_id: refundIdFail }).first();
        assert.ok(cnFailResolved, 'Credit note must be created upon retry');
        assert.strictEqual(cnFailResolved.original_invoice_number, invNumberFail, 'Must link to original invoice');

        // Verify CREDIT_NOTE_RECONCILED was emitted out-of-band
        const reconciledEvents = await freshDb('billing_audit_events').where({
          customer_id: customerId,
          event_type: 'CREDIT_NOTE_RECONCILED'
        });
        const matchedReconciled = (reconciledEvents || []).filter((e: any) => {
          try {
            const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
            return p?.refundId === refundIdFail;
          } catch { return false; }
        });
        assert.ok(matchedReconciled.length >= 1, 'CREDIT_NOTE_RECONCILED event must be emitted upon successful resolution');

        // Verify invoice marked Refunded and subscription marked refunded
        const invFailFinal = await freshDb('billing_invoices').where({ invoice_number: invNumberFail }).first();
        assert.strictEqual(invFailFinal?.status, 'Refunded');

        const subFailFinal = await freshDb('subscriptions').where({ id: subIdFail }).first();
        assert.strictEqual(subFailFinal?.status, 'refunded');
      } finally {
        await freshDb.destroy();
      }
    });

    test(`[PG${engine.version}] GATE 7: Multi-Cycle Subscription Credit Note Linking & Amount Normalization`, async () => {
      const now = Date.now();
      const customerId = `cust_mc_${now}`;
      const subId = `sub_mc_${now}`;

      await db('billing_customers').insert({
        id: customerId,
        principal_id: `principal_mc_${now}`,
        email: `billing-mc-${now}@aira.test`,
        name: 'AIRA Multi-Cycle Tester',
        default_currency: 'INR',
        country_code: 'IN',
        tax_info: JSON.stringify({ state: '07' }),
        created_at: now,
        updated_at: now
      });

      await db('subscriptions').insert({
        id: subId,
        customer_id: customerId,
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'active',
        gateway: 'cashfree',
        gateway_subscription_id: `cf_sub_mc_${now}`,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ currentCycle: 3 }),
        created_at: now,
        updated_at: now
      });

      // Insert 3 invoices in PostgreSQL for the 3 billing cycles
      const invNum1 = `INV-2026-MC1-${now}`;
      const invNum2 = `INV-2026-MC2-${now}`;
      const invNum3 = `INV-2026-MC3-${now}`;

      await db('billing_invoices').insert([
        {
          id: `inv_mc_1_${now}`,
          invoice_number: invNum1,
          customer_id: customerId,
          subscription_id: subId,
          cycle_number: 1,
          billing_event_id: `pay_mc_c1_${now}`,
          plan_tier: 'pro',
          currency: 'INR',
          total_amount: 399.00,
          taxable_base: 338.14,
          gst_amount: 60.86,
          sac_code: '998431',
          supplier_name: 'Virexa AI Ventures Private Limited',
          status: 'Paid',
          gateway: 'cashfree',
          created_at: now - 60000,
          updated_at: now - 60000
        },
        {
          id: `inv_mc_2_${now}`,
          invoice_number: invNum2,
          customer_id: customerId,
          subscription_id: subId,
          cycle_number: 2,
          billing_event_id: `pay_mc_c2_${now}`,
          plan_tier: 'pro',
          currency: 'INR',
          total_amount: 399.00,
          taxable_base: 338.14,
          gst_amount: 60.86,
          sac_code: '998431',
          supplier_name: 'Virexa AI Ventures Private Limited',
          status: 'Paid',
          gateway: 'cashfree',
          created_at: now - 30000,
          updated_at: now - 30000
        },
        {
          id: `inv_mc_3_${now}`,
          invoice_number: invNum3,
          customer_id: customerId,
          subscription_id: subId,
          cycle_number: 3,
          billing_event_id: `pay_mc_c3_${now}`,
          plan_tier: 'pro',
          currency: 'INR',
          total_amount: 399.00,
          taxable_base: 338.14,
          gst_amount: 60.86,
          sac_code: '998431',
          supplier_name: 'Virexa AI Ventures Private Limited',
          status: 'Paid',
          gateway: 'cashfree',
          created_at: now,
          updated_at: now
        }
      ]);

      const { paymentGatewayService } = await import('../apps/api/src/billing/payment-gateway-service.js');
      paymentGatewayService.setDbClient(db);

      // Refund Payment 2 with Cashfree format (decimal major units: 399.00)
      const cfRefundId = `cfrf_mc2_${now}`;
      const subRecord = await db('subscriptions').where({ id: subId }).first();

      await paymentGatewayService.handleSubscriptionRefund({
        gateway: 'cashfree',
        subRecord,
        refundPayload: {
          data: {
            order: { order_id: `cf_sub_mc_${now}` },
            payment: { cf_payment_id: `pay_mc_c2_${now}` },
            refund: {
              cf_refund_id: cfRefundId,
              cf_payment_id: `pay_mc_c2_${now}`,
              refund_amount: 399.00,
              refund_currency: 'INR'
            }
          }
        },
        now
      });

      // Verify in real PostgreSQL: credit note exists and is linked to Invoice 2, NEVER Invoice 1 or 3
      const cnRow = await db('billing_credit_notes').where({ refund_id: cfRefundId }).first();
      assert.ok(cnRow, 'Credit note row must exist in PostgreSQL');
      assert.strictEqual(cnRow.original_invoice_number, invNum2, 'Credit note MUST link to Invoice 2');
      assert.strictEqual(Number(cnRow.refund_amount), 399.00);
      assert.strictEqual(cnRow.status, 'Refunded');

      // Verify that invoice 2 is Refunded, while 1 and 3 remain Paid in PostgreSQL
      const inv1 = await db('billing_invoices').where({ invoice_number: invNum1 }).first();
      const inv2 = await db('billing_invoices').where({ invoice_number: invNum2 }).first();
      const inv3 = await db('billing_invoices').where({ invoice_number: invNum3 }).first();

      assert.strictEqual(inv1?.status, 'Paid', 'Invoice 1 must remain Paid');
      assert.strictEqual(inv2?.status, 'Refunded', 'Invoice 2 must be Refunded');
      assert.strictEqual(inv3?.status, 'Paid', 'Invoice 3 must remain Paid');

      // Verify second refund with unresolved payment ID results in PENDING_RECONCILIATION
      const unmatchRefundId = `cfrf_unmatch_${now}`;
      const unmatchSub = await db('subscriptions').where({ id: subId }).first();

      const unmatchCnResult = await paymentGatewayService.issueDurableCreditNote({
        trx: db,
        subRecord: unmatchSub,
        refundEntity: {
          cf_refund_id: unmatchRefundId,
          cf_payment_id: `pay_unmatched_id_${now}`
        },
        refundAmount: 100.00,
        refundAmountMinorUnits: 10000,
        isPartialRefund: true,
        gateway: 'cashfree',
        now: now + 1000
      });

      assert.ok(unmatchCnResult);
      assert.strictEqual(unmatchCnResult.originalInvoiceNumber, 'UNRESOLVED_ORIGINAL_INVOICE');
      assert.strictEqual(unmatchCnResult.status, 'PENDING_RECONCILIATION');

      // Verify no CREDIT_NOTE_RECONCILED event in PostgreSQL
      const recEvents = await db('billing_audit_events').where({
        customer_id: customerId,
        event_type: 'CREDIT_NOTE_RECONCILED'
      });
      const unmatchRec = (recEvents || []).find((e: any) => {
        try {
          const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
          return p?.refundId === unmatchRefundId;
        } catch { return false; }
      });
      assert.strictEqual(unmatchRec, undefined, 'Must not emit CREDIT_NOTE_RECONCILED when original invoice is unresolved');
    });
  });
}
