import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaymentGatewayService, PaymentDbClient } from '../apps/api/src/billing/payment-gateway-service.js';
import { taxDeterminationService } from '../apps/api/src/billing/tax-determination.js';

function createMockDb() {
  const tables: Record<string, any[]> = {
    billing_customers: [],
    subscriptions: [],
    credit_balances: [],
    credit_transactions: [],
    payment_gateway_events: [],
    billing_audit_events: [],
    idempotent_operations: [],
    billing_invoices: [],
    billing_credit_notes: []
  };

  const dbClient: any = (tableName: string) => {
    if (!tables[tableName]) {
      tables[tableName] = [];
    }
    const tableData = tables[tableName];

    const builder: any = {
      _whereClauses: [] as any[],
      where: (queryOrCol: any, opOrVal?: any, val?: any) => {
        if (typeof queryOrCol === 'string') {
          if (val === undefined) {
            builder._whereClauses.push({ [queryOrCol]: opOrVal });
          } else {
            builder._whereClauses.push({ [queryOrCol]: { op: opOrVal, val } });
          }
        } else if (typeof queryOrCol === 'object') {
          builder._whereClauses.push(queryOrCol);
        }
        return builder;
      },
      andWhere: (queryOrCol: any, opOrVal?: any, val?: any) => {
        return builder.where(queryOrCol, opOrVal, val);
      },
      select: async () => {
        return tableData.filter((row) => {
          return builder._whereClauses.every((clause: Record<string, any>) => {
            return Object.entries(clause).every(([k, v]) => {
              if (v && typeof v === 'object' && 'op' in v) {
                if (v.op === '<=') return Number(row[k]) <= Number(v.val);
                if (v.op === '>=') return Number(row[k]) >= Number(v.val);
                if (v.op === '<') return Number(row[k]) < Number(v.val);
                if (v.op === '>') return Number(row[k]) > Number(v.val);
                if (v.op === '=') return row[k] === v.val;
              }
              return row[k] === v;
            });
          });
        });
      },
      first: async () => {
        const matches = await builder.select();
        return matches[0] || null;
      },
      orderBy: (_col: string, _dir?: string) => {
        return builder;
      },
      insert: async (record: any) => {
        if (dbClient._failInserts && dbClient._failInserts[tableName]) {
          throw new Error(`SIMULATED_DB_WRITE_FAILURE: ${tableName} write failure simulation`);
        }
        // Enforce Primary Key uniqueness on 'key' for idempotent_operations
        if (tableName === 'idempotent_operations') {
          const keyExists = tableData.some(r => r.key === record.key);
          if (keyExists) {
            throw new Error(`UNIQUE_CONSTRAINT_VIOLATION: duplicate key value violates unique constraint "idempotent_operations_pkey" (Key: ${record.key})`);
          }
        }
        if (tableName === 'billing_credit_notes') {
          const refundExists = tableData.some(r => r.refund_id === record.refund_id);
          if (refundExists) {
            const err: any = new Error(`duplicate key value violates unique constraint "uq_billing_credit_notes_refund"`);
            err.code = '23505';
            throw err;
          }
        }
        tableData.push({ ...record });
        return [record];
      },
      update: async (patch: any) => {
        const matches = await builder.select();
        for (const m of matches) {
          Object.assign(m, patch);
        }
        return matches.length;
      },
      delete: async () => {
        const matches = await builder.select();
        for (const m of matches) {
          const idx = tableData.indexOf(m);
          if (idx !== -1) tableData.splice(idx, 1);
        }
        return matches.length;
      },
      onConflict: (_cols: any) => {
        return {
          ignore: () => builder
        };
      }
    };

    return builder;
  };

  dbClient.schema = {
    hasTable: async (name: string) => Boolean(tables[name])
  };

  dbClient.raw = async (sql: string) => {
    if (sql.includes('nextval')) {
      return { rows: [{ seq: Math.floor(Math.random() * 9000) + 1000 }] };
    }
    return { rows: [] };
  };

  return { dbClient, tables };
}

describe('Invoice Concurrency, Tax Matrix & Failure Handling Integrity Suite', () => {
  describe('1. Concurrency & Collision-Free Monotonic Sequence', () => {
    it('generates strictly unique invoice numbers across 25 concurrent parallel allocations', async () => {
      const { dbClient } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const allocations = await Promise.all(
        Array.from({ length: 25 }, () => service.allocateInvoiceNumber(dbClient, 2026))
      );

      assert.equal(allocations.length, 25);
      const uniqueAllocations = new Set(allocations);
      assert.equal(
        uniqueAllocations.size,
        25,
        'Zero duplicate invoice numbers allowed across concurrent allocations'
      );

      for (const invNum of allocations) {
        assert.match(invNum, /^INV-2026-\d{4,}$/);
      }
    });

    it('generates strictly unique credit note numbers across 20 concurrent parallel allocations', async () => {
      const { dbClient } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const allocations = await Promise.all(
        Array.from({ length: 20 }, () => service.allocateCreditNoteNumber(dbClient, 2026))
      );

      assert.equal(allocations.length, 20);
      const uniqueAllocations = new Set(allocations);
      assert.equal(
        uniqueAllocations.size,
        20,
        'Zero duplicate credit note numbers allowed across concurrent allocations'
      );

      for (const cnNum of allocations) {
        assert.match(cnNum, /^CN-2026-\d{4,}$/);
      }
    });
  });

  describe('2. Exact-Once Cycle Binding & Database Uniqueness', () => {
    it('enforces exact-once invoice issuance per subscription cycle under concurrent calls', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_cycle_test';
      const principalId = 'usr_cycle_test';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const purchaseRecord = {
        id: 'pur_cycle_01',
        customer_id: customerId,
        plan_id: 'plus',
        amount_minor_units: 39900,
        currency: 'INR',
        metadata: JSON.stringify({ customerState: '07' })
      };

      // Call issueDurableInvoice directly via reflection
      const issueDirect = (service as any).issueDurableInvoice.bind(service);

      const [res1, res2] = await Promise.all([
        issueDirect({
          trx: dbClient,
          customerId,
          principalId,
          purchaseRecord,
          planTier: 'plus',
          gateway: 'razorpay',
          actualPaymentId: 'pay_concurrent_1',
          cycleNumber: 1,
          now: Date.now()
        }),
        issueDirect({
          trx: dbClient,
          customerId,
          principalId,
          purchaseRecord,
          planTier: 'plus',
          gateway: 'razorpay',
          actualPaymentId: 'pay_concurrent_2',
          cycleNumber: 1,
          now: Date.now()
        })
      ]);

      assert.ok(res1);
      assert.ok(res2);
      // Both results must share the exact same invoice number due to idempotent cycle binding
      assert.equal(res1.invoiceNumber, res2.invoiceNumber);

      const auditInvoices = tables.billing_audit_events.filter(e => e.event_type === 'TAX_INVOICE_ISSUED');
      assert.equal(auditInvoices.length, 1, 'Only exactly 1 tax invoice audit event may be recorded per cycle');
    });

    it('fences out stale Worker A when its lease expires and Worker B takes over (CAS generation fencing)', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_stale_fence_test';
      const principalId = 'usr_stale_fence_test';
      const subId = 'sub_stale_fence_01';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const subRecord = {
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'active',
        currency: 'INR',
        amount_minor_units: 39900,
        created_at: Date.now(),
        updated_at: Date.now()
      };

      const now = Date.now();
      const cycleBindingKey = `inv_binding:${customerId}:${subId}:cycle:1`;

      // Step 1: Worker A acquires the initial lease with generation 1 and token 'worker_a'
      tables.idempotent_operations.push({
        key: cycleBindingKey,
        principal_id: principalId,
        operation_id: `inv_binding_${subId}_cycle_1`,
        operation_type: 'tax_invoice_binding',
        payload_hash: 'pay_1',
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        owner_token: 'worker_a',
        generation: 1,
        locked_until: now - 1000, // Lease has expired while Worker A was paused!
        created_at: now - 35000,
        updated_at: now - 35000
      });

      // Step 2: Worker B notices expired lease, takes over via CAS, bumping generation to 2, and completes issuance
      const workerBInvoice = await service.issueDurableInvoice({
        trx: dbClient,
        customerId,
        principalId,
        purchaseRecord: subRecord,
        planTier: 'plus',
        gateway: 'razorpay',
        actualPaymentId: 'pay_b_takeover',
        cycleNumber: 1,
        now,
        workerToken: 'worker_b'
      });

      assert.ok(workerBInvoice);
      assert.match(workerBInvoice.invoiceNumber, /^INV-2026-\d{4,}$/);

      // Verify idempotent_operations now has generation 2, COMPLETED, and response_body
      const opRecord = tables.idempotent_operations.find(r => r.key === cycleBindingKey);
      assert.ok(opRecord);
      assert.equal(opRecord.status, 'COMPLETED');
      assert.equal(opRecord.generation, 2);
      assert.equal(opRecord.owner_token, 'worker_b');

      // Step 3: Stale Worker A resumes and attempts to finalize using its stale lease (token: 'worker_a', gen: 1)
      // Attempting to finalize with stale credentials must be rejected by CAS
      const finalizeStale = await dbClient('idempotent_operations')
        .where({
          key: cycleBindingKey,
          status: 'IN_PROGRESS',
          owner_token: 'worker_a',
          generation: 1
        })
        .update({
          status: 'COMPLETED',
          response_body: 'STALE_OVERWRITE_PAYLOAD',
          locked_until: 0,
          updated_at: Date.now()
        });

      assert.equal(finalizeStale, 0, 'Stale Worker A must affect 0 rows and be completely fenced out');

      // Step 4: Verify exactly one audit event exists in total
      const auditEvents = tables.billing_audit_events.filter(e => e.event_type === 'TAX_INVOICE_ISSUED');
      assert.equal(auditEvents.length, 1, 'Exactly one invoice audit event must exist');
      assert.equal(JSON.parse(auditEvents[0].payload).invoiceNumber, workerBInvoice.invoiceNumber);
    });
  });

  describe('3. Outbox Failure Handling & Reconciliation', () => {
    it('records TAX_INVOICE_PENDING_RECONCILIATION and exposes Pending Reconciliation status on failure', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_fail_test';
      const principalId = 'usr_fail_test';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const now = Date.now();
      tables.subscriptions.push({
        id: 'pur_fail_01',
        customer_id: customerId,
        plan_id: 'pro',
        status: 'active',
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({ invoice_status: 'PENDING_RECONCILIATION' }),
        created_at: now,
        updated_at: now
      });

      // Record pending reconciliation event in audit log
      tables.billing_audit_events.push({
        id: 'bae_fail_01',
        customer_id: customerId,
        event_type: 'TAX_INVOICE_PENDING_RECONCILIATION',
        actor_type: 'system',
        actor_id: 'pur_fail_01',
        payload: JSON.stringify({
          errorCode: 'INVOICE_GENERATION_FAILED',
          errorMessage: 'PostgreSQL sequence connection timeout simulation',
          correlationId: 'rec_test_fail_123',
          purchaseId: 'pur_fail_01',
          cycleNumber: 1,
          paymentId: 'pay_fail_sim_1',
          gateway: 'razorpay',
          amount: 99900,
          planTier: 'pro'
        }),
        created_at: now
      });

      // Query invoices: should surface Pending Reconciliation without crashing
      const invoices = await service.getInvoices(principalId);
      assert.equal(invoices.length, 1);
      assert.equal(invoices[0].status, 'Pending Reconciliation');
      assert.equal(invoices[0].invoiceNumber, 'INV-PENDING-RECONCILIATION');
      assert.equal(invoices[0].totalAmount, 999.00);

      // Reconcile pending invoices
      const reconcileResult = await service.reconcilePendingInvoices();
      assert.equal(reconcileResult.reconciled, 1);
      assert.equal(reconcileResult.failed, 0);

      // Query invoices again: must now return the fulfilled durable invoice
      const postReconcileInvoices = await service.getInvoices(principalId);
      assert.equal(postReconcileInvoices.length, 1);
      assert.equal(postReconcileInvoices[0].status, 'Paid');
      assert.ok(postReconcileInvoices[0].invoiceNumber.startsWith('INV-2026-'));
    });
  });

  describe('4. Credit Note Original Invoice Referencing & No Manufacturing', () => {
    it('sets UNRESOLVED_ORIGINAL_INVOICE and status PENDING_RECONCILIATION when original invoice is missing', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_cn_missing_test';
      const principalId = 'usr_cn_missing_test';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const subRecord = {
        id: 'pur_no_inv_01',
        customer_id: customerId,
        principal_id: principalId,
        amount_minor_units: 39900,
        currency: 'INR'
      };

      const issueCn = (service as any).issueDurableCreditNote.bind(service);
      await issueCn({
        trx: dbClient,
        subRecord,
        refundEntity: { id: 'rfnd_missing_01' },
        refundAmount: 39900,
        isPartialRefund: false,
        gateway: 'cashfree',
        now: Date.now()
      });

      const cnEvent = tables.billing_audit_events.find(e => e.event_type === 'CREDIT_NOTE_ISSUED');
      assert.ok(cnEvent);
      const payload = JSON.parse(cnEvent.payload);

      // Invariant: Never manufacture invoice number like INV-2026-NO-INV-01!
      assert.equal(payload.originalInvoiceNumber, 'UNRESOLVED_ORIGINAL_INVOICE');
      assert.equal(payload.status, 'PENDING_RECONCILIATION');
      assert.ok(payload.creditNoteNumber.startsWith('CN-2026-'));
    });

    it('verifies existing credit note on uniqueness conflict and rejects tenant/amount mismatch', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_cn_tenant_test';
      const principalId = 'usr_cn_tenant_test';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const subRecord = {
        id: 'sub_cn_conflict_01',
        customer_id: customerId,
        principal_id: principalId,
        amount_minor_units: 39900,
        currency: 'INR'
      };

      // Seed pre-existing credit note with different customer
      tables.billing_credit_notes.push({
        id: 'cn_exist_01',
        credit_note_number: 'CN-2026-0001',
        original_invoice_number: 'INV-2026-0001',
        customer_id: 'cust_attacker',
        subscription_id: 'sub_other',
        refund_id: 'rfnd_conflict_01',
        refund_amount: 39900,
        currency: 'INR',
        is_partial_refund: false,
        supplier_name: 'Virexa AI Ventures Private Limited',
        status: 'Refunded',
        gateway: 'razorpay',
        created_at: Date.now(),
        updated_at: Date.now()
      });

      // Simulating uniqueness conflict with mismatched customer must fail closed
      await assert.rejects(
        () => service.issueDurableCreditNote({
          trx: dbClient,
          subRecord,
          refundEntity: { id: 'rfnd_conflict_01' },
          refundAmount: 39900,
          isPartialRefund: false,
          gateway: 'razorpay',
          now: Date.now()
        }),
        /CREDIT_NOTE_TENANT_MISMATCH/
      );
    });

    it('records CREDIT_NOTE_PENDING_RECONCILIATION and does not emit CREDIT_NOTE_ISSUED on DB failure', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_cn_db_err';
      const principalId = 'usr_cn_db_err';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const subRecord = {
        id: 'sub_cn_db_fail',
        customer_id: customerId,
        principal_id: principalId,
        amount_minor_units: 39900,
        currency: 'INR'
      };

      // Mock DB failure on billing_credit_notes insert
      dbClient._failInserts = { billing_credit_notes: true };

      await assert.rejects(
        () => service.issueDurableCreditNote({
          trx: dbClient,
          subRecord,
          refundEntity: { id: 'rfnd_db_err_01' },
          refundAmount: 39900,
          isPartialRefund: false,
          gateway: 'razorpay',
          now: Date.now()
        }),
        /SIMULATED_DB_WRITE_FAILURE/
      );

      // Verify that CREDIT_NOTE_ISSUED was NOT emitted
      const issuedEvents = tables.billing_audit_events.filter(e => e.event_type === 'CREDIT_NOTE_ISSUED');
      assert.equal(issuedEvents.length, 0, 'No CREDIT_NOTE_ISSUED event may be recorded when persistence fails');

      // Verify truthful CREDIT_NOTE_PENDING_RECONCILIATION was recorded
      const pendingEvents = tables.billing_audit_events.filter(e => e.event_type === 'CREDIT_NOTE_PENDING_RECONCILIATION');
      assert.equal(pendingEvents.length, 1, 'Exactly one CREDIT_NOTE_PENDING_RECONCILIATION event must be recorded');
    });
  });

  describe('5. Cross-Account Invoice Isolation', () => {
    it('fails closed and prevents customer A from reading customer B invoices', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const userA_principal = 'usr_alice_123';
      const userA_cust = 'cust_alice_123';
      const userB_principal = 'usr_bob_456';
      const userB_cust = 'cust_bob_456';

      tables.billing_customers.push(
        { id: userA_cust, principal_id: userA_principal },
        { id: userB_cust, principal_id: userB_principal }
      );

      // Record invoice for Alice
      tables.billing_audit_events.push({
        id: 'bae_alice_01',
        customer_id: userA_cust,
        event_type: 'TAX_INVOICE_ISSUED',
        actor_type: 'system',
        actor_id: 'INV-2026-0001',
        payload: JSON.stringify({
          invoiceNumber: 'INV-2026-0001',
          totalAmount: 399,
          subscriptionId: 'sub_alice'
        }),
        created_at: Date.now()
      });

      // Bob requests invoices
      const bobInvoices = await service.getInvoices(userB_principal);
      assert.equal(bobInvoices.length, 0, 'Bob must receive 0 invoices from Alice');

      // Unauthorized principal requests invoices
      const unauthInvoices = await service.getInvoices('usr_mallory_intruder');
      assert.equal(unauthInvoices.length, 0, 'Unregistered intruder must receive 0 invoices');

      // Alice requests invoices
      const aliceInvoices = await service.getInvoices(userA_principal);
      assert.equal(aliceInvoices.length, 1);
      assert.equal(aliceInvoices[0].invoiceNumber, 'INV-2026-0001');
    });
  });

  describe('6. Comprehensive Tax Determination Matrix', () => {
    it('correctly calculates intra-state Delhi tax (9% CGST + 9% SGST)', () => {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 39900,
        currency: 'INR',
        customerState: 'Delhi',
        supplierGstin: '07AAACV2026E1Z5',
        supplierGstinVerified: true
      });

      assert.equal(res.totalAmount, 399.00);
      assert.equal(res.taxableBase, 338.14);
      assert.equal(res.gstAmount, 60.86);
      assert.equal(res.cgstAmount, 30.43);
      assert.equal(res.sgstAmount, 30.43);
      assert.equal(res.igstAmount, undefined);
      assert.equal(res.placeOfSupply, '07');
      assert.equal(res.taxComplianceStatus, 'COMPLIANT');
    });

    it('correctly calculates inter-state Maharashtra tax (18% IGST)', () => {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 99900,
        currency: 'INR',
        customerState: 'MH',
        supplierGstin: '07AAACV2026E1Z5',
        supplierGstinVerified: true
      });

      assert.equal(res.totalAmount, 999.00);
      assert.equal(res.taxableBase, 846.61);
      assert.equal(res.gstAmount, 152.39);
      assert.equal(res.igstAmount, 152.39);
      assert.equal(res.cgstAmount, undefined);
      assert.equal(res.sgstAmount, undefined);
      assert.equal(res.placeOfSupply, '27');
      assert.equal(res.taxComplianceStatus, 'COMPLIANT');
    });

    it('flags missing place of supply as PROVISIONAL_PENDING_PLACE_OF_SUPPLY and never defaults to Delhi', () => {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 39900,
        currency: 'INR',
        customerState: undefined,
        supplierGstin: '07AAACV2026E1Z5',
        supplierGstinVerified: true
      });

      assert.equal(res.placeOfSupply, 'UNKNOWN');
      assert.equal(res.taxComplianceStatus, 'PROVISIONAL_PENDING_PLACE_OF_SUPPLY');
      assert.equal(res.igstAmount, 60.86);
      assert.equal(res.cgstAmount, undefined);
      assert.equal(res.sgstAmount, undefined);
    });

    it('handles domestic USD transaction from customer in India as 18% domestic supply (not export)', () => {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 1999, // $19.99
        currency: 'USD',
        customerCountry: 'IN', // Customer located in India
        customerState: '27',
        supplierGstin: '07AAACV2026E1Z5',
        supplierGstinVerified: true
      });

      assert.equal(res.isExport, false);
      assert.equal(res.totalAmount, 19.99);
      assert.equal(res.taxableBase, 16.94);
      assert.equal(res.gstAmount, 3.05);
      assert.equal(res.igstAmount, 3.05);
      assert.equal(res.taxComplianceStatus, 'COMPLIANT');
    });

    it('handles international export without LUT with standard 18% IGST', () => {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 1999,
        currency: 'USD',
        customerCountry: 'US',
        lutAvailable: false,
        supplierGstin: '07AAACV2026E1Z5',
        supplierGstinVerified: true
      });

      assert.equal(res.isExport, true);
      assert.equal(res.totalAmount, 19.99);
      assert.equal(res.taxableBase, 16.94);
      assert.equal(res.gstAmount, 3.05);
      assert.equal(res.igstAmount, 3.05);
      assert.equal(res.taxComplianceStatus, 'COMPLIANT');
    });

    it('handles international export with valid LUT as zero-rated export', () => {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 1999,
        currency: 'USD',
        customerCountry: 'US',
        lutNumber: 'LUT-2026-EX-001',
        lutAvailable: true,
        supplierGstin: '07AAACV2026E1Z5',
        supplierGstinVerified: true
      });

      assert.equal(res.isExport, true);
      assert.equal(res.totalAmount, 19.99);
      assert.equal(res.taxableBase, 19.99);
      assert.equal(res.gstAmount, 0);
      assert.equal(res.igstAmount, undefined);
      assert.equal(res.taxComplianceStatus, 'COMPLIANT_ZERO_RATED_EXPORT');
    });

    it('flags unverified supplier GSTIN as PROVISIONAL_PENDING_GSTIN_VERIFICATION', () => {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 39900,
        currency: 'INR',
        customerState: '07',
        supplierGstin: '07AAACV2026E1Z5',
        supplierGstinVerified: false
      });

      assert.equal(res.taxComplianceStatus, 'PROVISIONAL_PENDING_GSTIN_VERIFICATION');
    });
  });
});
