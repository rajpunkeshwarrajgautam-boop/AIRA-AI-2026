# ADR 0002: Payment Gateway, Webhook Authenticity, and GST Tax Model

## Status
Accepted

## Context
AIRA AI 2026 offers domestic INR subscriptions via Indian payment gateways (Razorpay / Cashfree) and international USD subscriptions.
Requirements:
- Indian prices are GST-inclusive (Plus ₹399 total, Pro ₹999 total).
- International prices are USD base (Plus $7.99, Pro $19.99).
- Webhook endpoints must verify raw HMAC-SHA256 signatures before parsing or state transitions.
- Duplicate and out-of-order webhooks must be deduplicated idempotently.
- Gateways are authoritative only after server-side cryptographic validation.

## Decisions
1. **Raw Body Signature Verification**:
   The webhook endpoint captures raw request buffers before JSON parsing. It validates `X-Razorpay-Signature` / `X-Cashfree-Signature` against configured webhook secrets. Unsigned or invalid requests receive HTTP 401/403 and terminate immediately.
2. **Reverse GST Calculation**:
   For India INR transactions with 18% GST:
   - Base Price = Total / (1 + 0.18)
   - GST Amount = Total - Base Price
   - Plus: ₹399 total = ₹338.14 base + ₹60.86 GST (18%)
   - Pro: ₹999 total = ₹846.61 base + ₹152.39 GST (18%)
   - Tax rate is stored as configurable versioned metadata, not hardcoded.
3. **Webhook Event Log & Deduplication**:
   All incoming webhook events are recorded in `billing_audit_events` and `payment_gateway_events` with unique event ID constraint. If an event ID already exists in processed status, HTTP 200 is returned immediately.
4. **Subscription Lifecycle State Machine**:
   Subscription activations, renewals, failures, and cancellations are driven strictly by verified gateway events, never frontend client redirects.

## Consequences
- Protects against replay attacks, forged payment confirmations, and incorrect tax invoicing.
