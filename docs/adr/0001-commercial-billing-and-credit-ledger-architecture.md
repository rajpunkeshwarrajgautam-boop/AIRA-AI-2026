# ADR 0001: Commercial Billing, Entitlements and Credit Ledger Architecture

## Status
Accepted

## Context
AIRA AI 2026 requires a high-integrity, financially auditable billing and entitlement system. Key requirements:
- Three subscription tiers: Free, Plus (₹399 / $7.99), Pro (₹999 / $19.99).
- Separation between standard chat (covered by daily/monthly unit allowances) and premium metered capabilities (covered by a credit wallet).
- 1 Credit = $0.001 USD retail value.
- Strict anti-overdraft: zero negative balances allowed.
- Atomic reservations with two-phase commit (Hold -> Settle / Release).
- Full auditability via immutable ledger transactions.

## Decisions
1. **Neon PostgreSQL as the Single Authoritative Financial Datastore**:
   All balances, grants, reservations, subscriptions, and usage events reside in PostgreSQL. No client-side or in-memory balances are authoritative.
2. **Two-Phase Commit Reservation System**:
   Before initiating billable model calls, tools, or sandbox runs, a `credit_reservations` row is created in status `HELD`. Available balance is calculated as `balance_credits - sum(active_holds)`. If available balance < estimated cost, the request is rejected with `INSUFFICIENT_CREDITS`.
3. **Optimistic Locking and Row-Level Locks**:
   Mutations to `credit_accounts` use PostgreSQL row-level locks (`SELECT ... FOR UPDATE`) inside transactions to eliminate race conditions and double-spending across concurrent requests.
4. **Idempotency Keys**:
   Every credit debit, grant, refund, and webhook event requires an `idempotency_key` unique index in PostgreSQL to prevent duplicate processing under network retries.

## Consequences
- Guarantees financial correctness and auditability.
- Safe under multi-instance concurrent loads.
- Requires transaction management on all credit operations.
