# AIRA AI 2026 Commercial Platform Primary Research

## Executive Summary
This document records primary source research for the AIRA AI 2026 Commercial Platform, covering Neon Auth, payment gateways (Razorpay / Cashfree), Indian GST compliance, multimodal generation providers (Fal.ai / Replicate / OpenAI), and PostgreSQL financial ledger patterns.

---

## 1. Neon Auth Architecture & Session Security

### Primary Sources
- Neon Auth Docs: [https://neon.tech/docs/guides/neon-auth](https://neon.tech/docs/guides/neon-auth)
- Better Auth Specification: Session cookies, EdDSA JWKS endpoint (`/.well-known/jwks.json`), `/token` endpoint.

### Verified Architecture in AIRA:
- **First-Party Backend-For-Frontend (BFF)**: Session tokens stored in HttpOnly, Secure, SameSite=Lax cookies (`aira_session`).
- **Browser State**: Zero raw JWTs or unencrypted bearer tokens stored in browser `localStorage`.
- **Identity Resolution**: `createBffSessionMiddleware()` and `createNeonAuthPrincipalMiddleware()` validate cookies/JWTs and instantiate an immutable `ExecutionPrincipal` with `userId`, `role`, and scopes.
- **CSRF Defense**: `x-aira-csrf-protection` and session-tied CSRF tokens on all mutating endpoints (`POST`, `PUT`, `DELETE`).
- **Guest Linking**: Server validates the guest cookie against the authenticated session before transferring data, eliminating client-forged ID takeovers.

---

## 2. Payment Gateway Integration: Razorpay & Cashfree

### Primary Sources
- Razorpay Subscriptions API: [https://razorpay.com/docs/api/subscriptions/](https://razorpay.com/docs/api/subscriptions/)
- Razorpay Webhooks: [https://razorpay.com/docs/webhooks/](https://razorpay.com/docs/webhooks/)
- Cashfree Subscriptions API: [https://docs.cashfree.com/docs/subscription-overview](https://docs.cashfree.com/docs/subscription-overview)

### Webhook Signature Verification Contract:
```typescript
// Razorpay HMAC SHA256 validation
import crypto from 'crypto';

export function verifyRazorpayWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(expectedSignature, 'utf8')
  );
}
```

### Critical Edge Cases:
1. **Raw Body Requirement**: Middleware must preserve `req.rawBody` buffer before `express.json()` parses it. Modifying whitespace or character encodings breaks signature verification.
2. **Duplicate Webhook Delivery**: Gateways guarantee at-least-once delivery. An `idempotency_key` or `event_id` table must record received event IDs. If `event_id` is already processed, return `200 OK` immediately without re-crediting the wallet.
3. **Out-of-Order Events**: `subscription.charged` might arrive before `subscription.authenticated`. State transitions must check event timestamps and monotonic sequence numbers.

---

## 3. Indian GST Tax Treatment & Invoicing

### Regulatory Standard:
- **Service Classification**: SAC 998431 — On-line text, sound and video data information services (OIDAR / AI SaaS).
- **Applicable Tax Rate**: 18% standard GST (IGST for interstate, CGST 9% + SGST 9% for intrastate).
- **Inclusive Retail Pricing Model**:
  - AIRA Plus: ₹399.00 total
    - Base Taxable Value: `399.00 / 1.18` = **₹338.14**
    - GST (18%): `399.00 - 338.14` = **₹60.86**
  - AIRA Pro: ₹999.00 total
    - Base Taxable Value: `999.00 / 1.18` = **₹846.61**
    - GST (18%): `999.00 - 846.61` = **₹152.39**
- **Invoicing Requirements**:
  - Supplier Legal Name: Virexa AI Ventures Private Limited.
  - Mandatory fields: Sequential invoice number, date of issue, customer name/email, SAC code, taxable value, tax rate, split CGST/SGST/IGST, total invoice value.

---

## 4. Multimodal Generation & Tariff Modeling

### Provider Economics:
- **Fal.ai Flux Schnell**: ~$0.003 / image generation at 1024x1024.
- **Fal.ai Flux Dev**: ~$0.025 / image generation.
- **Replicate SDXL**: ~$0.008 / image generation.
- **OpenAI DALL-E 3**: ~$0.040 / image generation standard.

### AIRA Tariff Policy (1 Credit = $0.001 USD):
- **Economy Standard (1024x1024)**:
  - Provider cost: ~$0.003 (~3 credits).
  - Retail Price: **12 credits** ($0.012, ~4x direct cost target).
- **Economy High (1536x1536)**:
  - Provider cost: ~$0.006 (~6 credits).
  - Retail Price: **24 credits** ($0.024).
- **Premium Standard (1024x1024)**:
  - Provider cost: ~$0.025 (~25 credits).
  - Retail Price: **100 credits** ($0.100, 4x direct cost).
- **Premium High (1536x1536)**:
  - Provider cost: ~$0.035 (~35 credits).
  - Retail Price: **125 credits** ($0.125).

---

## 5. Financial Ledger & Anti-Race Invariants

### PostgreSQL Concurrency Safeguards:
1. `SELECT balance_credits, reserved_credits FROM credit_accounts WHERE id = $1 FOR UPDATE`: Serializes concurrent reservation and deduction requests on the same wallet.
2. `CHECK (balance_credits >= 0)`: Database-level guarantee that balance can never drop below zero under any condition.
3. `CHECK (reserved_credits >= 0)`: Database-level guarantee that holds cannot be over-released.
4. Two-phase commit protocol:
   - Phase 1: `UPDATE credit_accounts SET reserved_credits = reserved_credits + $hold WHERE id = $id AND balance_credits - reserved_credits >= $hold`
   - Phase 2 (Settle): `UPDATE credit_accounts SET balance_credits = balance_credits - $actual, reserved_credits = reserved_credits - $hold WHERE id = $id`
   - Phase 2 (Release): `UPDATE credit_accounts SET reserved_credits = reserved_credits - $hold WHERE id = $id`
