# AIRA AI 2026 Commercial Domain Glossary

This document serves as the canonical domain vocabulary across all engineering skills, tests, database entities, and API contracts for the AIRA AI 2026 Commercial Platform.

---

## 1. Identity & Customer Principals

### `BillingCustomer` (`billing_customers`)
The authoritative commercial identity record mapped 1:1 to an authenticated user principal (`userId`, matching Neon Auth `users.id`) or a verified transitional guest identity. Holds regional locale, default currency (`INR` or `USD`), billing address, tax identification (e.g., GSTIN), and gateway customer references (`razorpay_customer_id`, `cashfree_customer_id`).

### `GuestPrincipal`
An unauthenticated or transitional browser session. May consume unauthenticated Free-tier limits under strict IP/session rate guards. Can be cleanly upgraded to an authenticated `BillingCustomer` via guest-to-account data migration (`/api/auth/link-guest`).

---

## 2. Subscription Plans & Pricing

### `Plan` (`plans`)
A canonical product tier:
- `free`: Baseline zero-cost tier with daily and monthly standard allowances and trial access.
- `plus`: Individual everyday power-user tier (₹399 INR GST-inclusive / $7.99 USD).
- `pro`: Advanced professional tier with extended limits, vision, agents, and builder access (₹999 INR GST-inclusive / $19.99 USD).

### `PlanPrice` (`plan_prices`)
A localized price book entry defining billing interval (`monthly`), currency (`INR`, `USD`), amount in minor currency units (paise/cents), tax inclusion status (`is_tax_inclusive`), and active tariff version.

### `Subscription` (`subscriptions`)
The durable state machine governing a user's plan lifecycle:
- States: `created`, `authenticated`, `active`, `pending`, `past_due`, `paused`, `cancelled`, `expired`.
- Contains: `current_period_start`, `current_period_end`, `gateway_subscription_id`, `cancel_at_period_end`.

---

## 3. Entitlements & Allowances

### `StandardChatAllowance`
General Fast and Auto chat queries that do not consume premium credits. Governed by:
- **Daily Standard Chat Ceiling**: Maximum fast chat interactions permitted per 24-hour rolling window (Free: 15, Plus: 50, Pro: 150).
- **Monthly Standard Chat Units**: Monthly standard conversational allowance (Free: 150, Plus: 700, Pro: 2,000).
- **Weighted Compute Accounting**: Algorithmic weighting for standard requests based on prompt length and context complexity.

### `ComplimentaryReasoningBoost`
Monthly allocation of premium deep reasoning passes granted in Auto mode without wallet deductions:
- Free: 5 / month
- Plus: 50 / month
- Pro: 200 / month

---

## 4. Financial Ledger & Credit Accounting

### `CreditWallet` / `CreditAccount` (`credit_accounts`)
The authoritative database-backed wallet for a customer. Stores `balance_credits`, `reserved_credits`, and `lifetime_granted_credits`.
- **Value Definition**: **1 Credit = $0.001 USD** of retail AI usage value.
- **Invariant**: `balance_credits >= 0` and `reserved_credits >= 0` enforced by PostgreSQL check constraints and transactional isolation. Zero negative balances permitted.

### `CreditGrant` (`credit_grants`)
An inflow of credits into an account. Types:
- `subscription_monthly`: Granted upon successful monthly subscription payment or renewal (Free: 100, Plus: 3,000, Pro: 7,500).
- `purchased_topup`: On-demand credit pack purchased separately (does not expire monthly).
- `promotional`: Non-refundable promotional credits with defined expiry and rollover ceilings.

### `CreditReservation` (`credit_reservations`)
A two-phase commit pre-authorization hold:
1. **Hold (`RESERVE`)**: Before an expensive inference task (e.g. image generation, deep research, builder run) begins, the maximum estimated charge is reserved (`reserved_credits += amount`).
2. **Settlement (`SETTLE`)**: Upon task completion, the actual calculated fee is debited from `balance_credits`, and the reservation is released (`reserved_credits -= amount`).
3. **Release (`RELEASE`)**: If a task fails or aborts before execution, the entire hold is released back to available balance.

### `CreditTransaction` (`credit_transactions`)
An immutable ledger entry recording all debits, credits, refunds, adjustments, and expired credits with cryptographic idempotency keys.

### `UsageEvent` (`usage_events`)
Detailed micro-metering event tracking exact consumed units:
- Input tokens, output tokens, billable reasoning tokens, cached tokens.
- Image operations (understand, generate, edit).
- Search API calls, document extraction, embedding vectors.
- Agent step count, sandbox wall-clock seconds.

---

## 5. Multimodal & Advanced Capabilities

### `AiraVision`
- **Vision Understand**: Image OCR, visual question answering, document parsing.
- **Vision Generate**: Diffusion/Autoregressive generation supporting aspect ratios (`1:1`, `3:4`, `16:9`), batch size (1 or 2 images), and quality presets (`standard`, `high`).
- **Vision Edit**: Inpainting, style alteration, image-to-image refinement.

### `AiraResearch`
Deep multi-step search, retrieval, citation verification, and factual synthesis with transparent task cost estimates and customer receipts.

### `AiraAgents`
Autonomous agents with tool permissions, execution budgets, step limits, and durable session state (Plus: 3 saved agents, Pro: 20 saved agents).

### `AiraBuilder`
Isolated container sandbox workspace for code generation, execution, live web preview, and artifact compilation.
