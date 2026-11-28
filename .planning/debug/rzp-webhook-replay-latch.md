---
status: diagnosed
trigger: "Debug the historical webhook TERMINAL_FAILURE replay latch (investigate safe, authenticated re-processing of the 3 failed companion events)"
created: 2026-11-23T08:44:00.000Z
updated: 2026-11-23T08:50:00.000Z
symptoms:
  expected: "Validly signed companion webhook events (invoice.paid, order.paid, payment.captured) that failed reconciliation due to past code defect should be replayable/reprocessable safely through corrected correlation logic without being permanently rejected by TERMINAL_FAILURE checks."
  actual: "In PaymentGatewayService.ts lines 926-928 and 1014-1016, executeWebhookTransaction rejects retries immediately if record.error.startsWith('TERMINAL_FAILURE') or lifecycle.state === 'TERMINAL_FAILURE'. Because past unpatched code threw TerminalRejectionError('BILLING_RECONCILIATION_FAILED...'), the 3 failed events have error starting with TERMINAL_FAILURE in payment_gateway_events and cannot be re-evaluated through standard webhook entrypoints. No dedicated authenticated operator reprocess/recovery mechanism exists."
  error: "TERMINAL_FAILURE: Webhook event evt_rzp_... was terminally rejected: TERMINAL_FAILURE: BILLING_RECONCILIATION_FAILED: No authoritative purchase record found for transaction ..."
  timeline: "Gate 4 sandbox rehearsal. Pro subscription and payment succeeded (sub_U3VmcSATvHNdhX / pay_U3W8gDtuakYZGC), but the 3 companion events arrived and failed reconciliation under unpatched code."
  reproduction: "Call processRazorpayWebhook with the rawBody and valid signature of any of the 3 events (pge_f7d5fd18365c4fb492c0970ef3a4677d, pge_6084c1512ee041769c40e06869d2b53f, pge_5173a8a8fcb841d7ab2ee2279223202b). The execution aborts at lines 926-928."

Current Focus:
  hypothesis: "executeWebhookTransaction intentionally short-circuits retries for TERMINAL_FAILURE events at lines 926-928 to protect against fraudulent retries (verified by test/billing-remediation-security-matrix.test.ts lines 290 and 400). However, because application reconciliation bugs also throw TerminalRejectionError, historical events become permanently latched. The correct architectural solution is NOT weakening public webhook guards, but providing an Authenticated Operator Recovery Procedure."
  test: "Verified test/billing-remediation-security-matrix.test.ts requirements and designed an isolated Operator Recovery contract."
  expecting: "Diagnosed root cause and proposed safe operator-authenticated recovery design without tampering with public webhook security."
  next_action: "present diagnosis report and recovery design options to operator"

Root Cause:
  summary: "Public webhook entrypoint processRazorpayWebhook strictly enforces F2 anti-tampering guards by short-circuiting retry attempts on events marked TERMINAL_FAILURE (PaymentGatewayService.ts:926-928). Because the previous code defect threw TerminalRejectionError('BILLING_RECONCILIATION_FAILED...'), the 3 historical staging events were durably latched with error='TERMINAL_FAILURE:...'. The public endpoint cannot and should not be relaxed, as that would regress security test assertions in billing-remediation-security-matrix.test.ts."
  files_involved:
    - "apps/api/src/billing/payment-gateway-service.ts (lines 249-258, 925-928, 972-986)"
    - "test/billing-remediation-security-matrix.test.ts (lines 285-300, 393-410)"
    - "test/razorpay-companion-webhook-correlation.test.ts"

Remediation Options:
  option_1_operator_recovery_service:
    title: "Dedicated Authenticated Operator Reprocess Method (Recommended)"
    description: "Implement a dedicated reprocessEventAsOperator(eventId, operatorContext) on PaymentGatewayService. It verifies the operator identity, re-verifies stored webhook payload signatures, executes handleGatewayEvent within an isolated Knex transaction, marks processed=true, records COMPANION_EVENT_ACKNOWLEDGED, and emits an OPERATOR_RECOVERY audit event in billing_audit_events. Public webhooks remain 100% hardened."
    security_impact: "Zero security regressions. Public entrypoints remain strictly fail-closed."
    financial_impact: "Zero financial impact. Idempotency guarantees in PR #201 prevent duplicate grants or invoices."
  option_2_leave_historical_records_as_failed:
    title: "Accept Historical Failure Records as Point-in-Time Telemetry"
    description: "Acknowledge that cycle 1 is already 100% fulfilled (active Pro subscription, paid invoice INV-2026-0001, 7,600 credits), and leave the 3 failed event rows in payment_gateway_events as accurate historical audit artifacts of the unpatched rehearsal state. Future companion events will process cleanly under PR #201."
    security_impact: "Zero code changes needed beyond PR #201."
    financial_impact: "Financial invariants remain 100% correct."

Evidence:
  - timestamp: 2026-11-23T08:44:00.000Z
    observation: "Staging database inspection confirmed 3 failed payment_gateway_events (pge_f7d5fd18365c4fb492c0970ef3a4677d, pge_6084c1512ee041769c40e06869d2b53f, pge_5173a8a8fcb841d7ab2ee2279223202b) have processed=false and error starting with TERMINAL_FAILURE: BILLING_RECONCILIATION_FAILED."
  - timestamp: 2026-11-23T08:44:00.000Z
    observation: "PaymentGatewayService.ts line 926: if (lifecycle.state === 'TERMINAL_FAILURE' || record.error?.startsWith('TERMINAL_FAILURE')) throw new TerminalRejectionError(...) unconditionally blocks retries."
  - timestamp: 2026-11-23T08:48:00.000Z
    observation: "test/billing-remediation-security-matrix.test.ts lines 285-300 and 393-410 explicitly require public webhook retries of TERMINAL_FAILURE events to reject immediately without entering transactions."

Eliminated:
  - hypothesis: "Weakening the public webhook retry guard to allow retry of BILLING_RECONCILIATION_FAILED"
    reason: "Eliminated because test/billing-remediation-security-matrix.test.ts requires strict rejection of all TERMINAL_FAILURE events to prevent fraudulent replay attacks."
