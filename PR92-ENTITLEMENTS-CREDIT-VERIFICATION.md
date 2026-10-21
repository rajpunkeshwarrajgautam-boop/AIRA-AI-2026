# PR #92 — Free / Plus / Pro Commercial Entitlement & Credit Ledger Certification

## 1. Plan Allowances & Launch Specification

All plan definitions, quotas, and credit allowances are defined in `packages/contracts/src/commercial.ts` and enforced in `apps/api/src/billing/commercial-billing-service.ts`.

| Feature / Allowance | Free | Plus | Pro |
| :--- | :---:| :---:| :---:|
| **Daily Standard Chats** | 15 chats / day | 50 chats / day | 150 chats / day |
| **Monthly Standard Chat Units** | 150 units / month | 700 units / month | 2,000 units / month |
| **Monthly Premium Credits** | 100 credits | 3,000 credits | 7,500 credits |
| **Auto Reasoning Boosts** | 5 boosts / month | 50 boosts / month | 200 boosts / month |
| **Saved Agent Configurations** | 0 (Ephemeral only) | 3 agents | 20 agents |
| **Builder MicroVM Access** | None | Trial (capped TTL) | Metered |
| **Concurrent Inferences** | 1 | 1 | 2 |
| **Price (INR / month)** | ₹0 | ₹399 (incl. 18% GST) | ₹999 (incl. 18% GST) |
| **Price (USD / month)** | $0 | $7.99 | $19.99 |

> **Payment Gateways Deferred**: Live Razorpay and Cashfree gateway subscriptions are explicitly deferred. Testing of Plus and Pro tiers is performed exclusively via controlled staging database fixtures.

---

## 2. Multi-Tier Ledger Verification

### Test Suite: `test/commercial-credit-ledger.test.ts`
All 7 integration tests passed against the live isolated Staging Neon database (`mute-frost-50372225`, compute `ep-ancient-sound-b3drtnp5`):

```text
▶ Commercial Credit Ledger & Entitlements Engine
  ✔ 1. Initializes new customer with Free tier welcome allotment (100 credits) (2222.3646ms)
  ✔ 2. Atomically consumes standard chat and enforces daily ceiling (1836.1602ms)
  ✔ 3. Consumes complimentary reasoning boosts within monthly cap (3548.6942ms)
  ✔ 4. Two-phase commit reservation hold and full settlement (2329.0797ms)
  ✔ 5. Two-phase commit reservation hold and complete release on error (2225.1066ms)
  ✔ 6. Rejects requests exceeding available credits with InsufficientCreditsError (912.4966ms)
  ✔ 7. Concurrency & Race-condition safety: Prevents double spending across simultaneous requests (2046.4616ms)
✔ Commercial Credit Ledger & Entitlements Engine (16124.611ms)
```

### Detailed Functional Evidence:

#### A. Initial Free Account Grant
- Upon customer creation, `billing_customers` and `credit_accounts` records are created in a single ACID transaction.
- An initial welcome grant of **100 promotional credits** (`credit_grants`) is inserted with `expires_at = NOW + 30 days`.
- Initial ledger transaction `ctx_...` recorded with `transaction_type = 'GRANT'`, `balance_before = 0`, `balance_after = 100`.

#### B. Atomic Quota Consumption & Ceilings
- Daily and monthly chat units are tracked in `entitlement_snapshots` per `(customer_id, period_date)`.
- Chat streaming (`/api/chat/stream`) increments `daily_standard_chat_count` and `monthly_standard_chat_count` via `atomicIncrementUsage()`.
- When daily standard chats reach 15 (Free), subsequent standard chat requests throw `StandardQuotaExceededError('daily')`.
- Verified live against preview: Post-chat check returned `dailyChatsUsed: 1`, `monthlyUnitsUsed: 1`.

#### C. Complimentary Reasoning Boosts
- Reasoning models (e.g. `meta/llama-3.3-70b-instruct` or DeepSeek R1) consume from `monthly_reasoning_boost_count`.
- Up to the tier limit (5 Free / 50 Plus / 200 Pro), reasoning boosts cost 0 credits.
- Once reasoning boosts are exhausted, queries require credit reservation or fail closed if insufficient credits exist.

#### D. Two-Phase Commit (2PC) Credit Reservations
- Prior to executing expensive operations (multimodal vision, deep research, code execution), the API issues:
  `commercialBillingService.reserveCredits(principalId, amount, taskType, ...)`
- Creates a `credit_reservations` row with `status = 'HELD'`.
- Deducts `amount` from `credit_accounts.available_credits` while maintaining `balance_credits` intact.
- **Settlement**: Upon success, `settleReservation()` marks status `SETTLED`, commits credit debit to `credit_transactions`, and decrements `credit_accounts.balance_credits`.
- **Release**: Upon inference or network failure, `releaseReservation()` marks status `RELEASED`, releasing the reserved amount back to available balance. Zero unearned credits are debited.

#### E. Concurrency & Negative Balance Prevention
- `reserveCredits` and `settleReservation` utilize PostgreSQL row-level locking (`SELECT ... FOR UPDATE`).
- Simulated simultaneous requests attempting to spend 60 credits each on a 100-credit wallet:
  - Request 1: Acquired lock, reserved 60 credits (remaining: 40).
  - Request 2: Blocked until Request 1 finished, then evaluated available credits (40 < 60) and was rejected with `InsufficientCreditsError(60, 40)`.
  - Negative balances are mathematically impossible under the schema constraint `CHECK (balance_credits >= 0)`.

---

## 3. AIRA Multimodal Tariff Baseline Consistency

The implemented tariffs in `packages/contracts/src/commercial.ts` and `apps/api/src/vision/vision-service.ts` match the approved internal baseline with zero discrepancy:

### Image Generation Tariffs:
| Quality Tier | Resolution | Target Dimensions | Credit Tariff | Implemented Code |
| :--- | :--- | :---: | :---: | :---: |
| **Economy Standard** | Standard | 1024x1024 (1:1) / 896x1152 (3:4) / 1344x768 (16:9) | **12 credits** | `calculateVisionTariff('generate', { quality: 'economy', resolution: 'standard' })` |
| **Economy High** | High | 1536x1536 (1:1) / 1344x1792 (3:4) / 2048x1152 (16:9) | **24 credits** | `calculateVisionTariff('generate', { quality: 'economy', resolution: 'high' })` |
| **Premium Standard** | Standard | 1024x1024 (1:1) / 896x1152 (3:4) / 1344x768 (16:9) | **100 credits** | `calculateVisionTariff('generate', { quality: 'premium', resolution: 'standard' })` |
| **Premium High** | High | 1536x1536 (1:1) / 1344x1792 (3:4) / 2048x1152 (16:9) | **125 credits** | `calculateVisionTariff('generate', { quality: 'premium', resolution: 'high' })` |

### Image Editing Tariffs:
| Quality Tier | Resolution | Mode | Credit Tariff | Implemented Code |
| :--- | :--- | :--- | :---: | :---: |
| **Economy Standard** | Standard | Inpainting / Style modification | **40 credits** | `calculateVisionTariff('edit', { quality: 'economy', resolution: 'standard' })` |
| **Economy High** | High | High-res inpainting | **80 credits** | `calculateVisionTariff('edit', { quality: 'economy', resolution: 'high' })` |
| **Premium Edit** | Standard | FLUX Redux / Depth guidance | **130 credits** | `calculateVisionTariff('edit', { quality: 'premium', resolution: 'standard' })` |
| **Advanced Premium** | High | Multi-mask / Advanced Inpainting | **250 credits** | `calculateVisionTariff('edit', { quality: 'premium', resolution: 'high', advancedMode: true })` |

### Multimodal Understand Tariff:
- Visual Q&A, OCR, and Chart Analysis: **10 credits / query**.

---

## 4. Controlled Paid Tier Staging Fixture

In staging, Plus and Pro tiers are activated for automated testing via direct PostgreSQL subscription fixtures rather than live payment charges:

```typescript
// Controlled staging activation fixture
await db('subscriptions').insert({
  id: `sub_staging_fixture_${Date.now()}`,
  customer_id: customer.id,
  plan_id: 'pro', // or 'plus'
  status: 'active',
  current_period_start: Date.now(),
  current_period_end: Date.now() + 30 * 24 * 60 * 60 * 1000,
  cancel_at_period_end: false,
  gateway_subscription_id: 'sub_fixture_staging_only',
  gateway: 'test_fixture',
  created_at: Date.now(),
  updated_at: Date.now()
});
```

- **Policy Compliance**: No customer is charged, no fake webhook success events are used to claim gateway certification, and production database remains 100% untouched.
