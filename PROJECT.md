# Project: AIRA AI 2026 — Entitlements, Subscription-Management, Onboarding & Announcements

## Architecture
- **Contract & Entitlement Layer** (`packages/contracts/src/commercial.ts`, `featureFlags.ts`, `announcements.ts`):
  - Authoritative 4-tier system: `guest`, `free`, `plus`, `pro`.
  - Authoritative Model Allowlist (`PLAN_MODEL_ALLOWLIST`) and Capability Matrix (`PLAN_CAPABILITY_MATRIX`).
  - Quota limits: Guest (5 chats/day, 0 credits, 0 memory, 0 projects, 0 autonomous), Free (15 chats/day, 100 credits, 5 reasoning boosts, 50 memories, 3 projects), Plus (50 chats/day, 3000 credits, 50 reasoning boosts, 250 memories, 10 projects, agent mode), Pro (150 chats/day, 7500 credits, 200 reasoning boosts, unlimited memories/projects, agent mode, browser tools, python sandbox, 2 concurrent requests).
  - Centralized feature flags contract and announcement definitions.
- **Backend Enforcement & Quotas** (`apps/api/src/`, `packages/model-router/`, `packages/tool-runtime/`, `packages/agent-runtime/`):
  - `entitlement-guard.ts` middleware: Server-side validation of plan tier, rejecting unauthorized model and capability access with HTTP 403 (`PLAN_MODEL_RESTRICTED`, `PLAN_CAPABILITY_RESTRICTED`).
  - `commercialBillingService`: Explicit `guest` tier handling, preventing auto-crediting or auto-promotion of guests into the free customer tier.
  - Streaming cancellation accounting: Standard chat consumption deferred until at least one content chunk is emitted or refunded on immediate disconnect.
  - Dynamic plan-aware capacity guard: Pro tier granted 2 concurrent inference permits, other tiers 1. Reasoning models guarded.
  - Tool Gateway gating: `browser_*` and `python_sandbox` strictly gated to Pro tier.
  - Autonomous task & worker gating: `POST /api/agent/autonomous/tasks` and `AutonomousWorkerHost` enforce Pro tier before task admission and claim.
  - Safe downgrade data retention: Excess data retained in read-only state without silent deletion; mutations blocked with clear explanations.
  - Guest linking fix: BFF session middleware preserves guest session to allow seamless guest-to-account migration on sign-in.
- **Subscription Management & Upgrade Experiences** (`src/components/`, `src/utils/`):
  - "My Plan & Usage" tab inside `SettingsModal.tsx` linked from `AccountMenuDropdown.tsx` and `Sidebar.tsx`.
  - Real-time gauges for daily/monthly chat quotas, credits, reasoning boosts, reset countdowns, and plan comparison. Payment collection cleanly disabled with clear notice.
  - Contextual `UpgradeModal.tsx` triggered by guest limits, free->plus models, plus->pro tools/agents, and quota exhaustion.
  - Intelligent capability discovery integrated into `ModelSelector.tsx`, `ChatInput.tsx`, `capabilityDispatcher.ts`, and `aiEngine.ts`.
- **What's New, Announcements & 5-Stage Onboarding** (`src/components/`, `src/utils/`, `src/lib/`):
  - Reusable feature announcement system (`WhatsNewAnnouncementModal.tsx`, `announcements.ts`): versioning, first-view popups, dismissal persistence, unread badge indicators, permanent release center.
  - 5-stage interactive walkthrough (`OnboardingWalkthrough.tsx`): Intro, Chat/Reasoning, Agent Mode, Projects/Artifacts, Plans with Skip, Back, Next, Resume, Finish, Restart Tutorial, and account-level persistence.
  - Upgrade feature discovery guidance on Plus/Pro transitions.
  - Centralized feature flag provider (`src/lib/featureFlags.ts`).
- **Dual Track E2E Testing & Acceptance** (`test/`, `TEST_INFRA.md`):
  - Parallel requirement-driven opaque-box test suite covering Tiers 1-4 (minimum 280+ test cases across 25 features).
  - Playwright browser acceptance on Microsoft Edge (`channel: 'msedge'`) for desktop (1280x800) and mobile (390x844).
  - Tier 5 adversarial coverage hardening and forensic audit verification.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | 4-Tier Entitlement Schema | Define guest, free, plus, pro tiers, quotas, and capabilities in contracts | M1 | ORIGINAL_REQUEST §2, Survey 1, 2 |
| 2 | Authoritative Model Access Matrix | Allowlist of permitted models per tier in contracts | M1 | ORIGINAL_REQUEST §2, Survey 1 |
| 3 | Centralized Feature Flags Schema | Contract and defaults for feature flag evaluation across client/server | M1 | ORIGINAL_REQUEST §Additions.3, Survey 3 |
| 4 | Announcements Data Contract | Contract for versioned product announcements, unread tracking, and changelogs | M1 | ORIGINAL_REQUEST §6, Survey 3 |
| 5 | Server-Side Entitlement Guard | Express middleware enforcing plan boundaries and rejecting unauthorized API calls | M2 | ORIGINAL_REQUEST §3, Survey 1 |
| 6 | Guest Identity & Anti-Escalation | Prevent auto-crediting or auto-promotion of guests into the free customer tier | M2 | ORIGINAL_REQUEST §2, Survey 1 |
| 7 | Plan-Aware Model Routing Gate | Reject model access exceeding caller's tier on /api/chat/stream with HTTP 403 | M2 | ORIGINAL_REQUEST §3, Survey 1 |
| 8 | Tool Gateway Tier Gating | Restrict browser tools and Python sandbox execution strictly to Pro tier | M2 | ORIGINAL_REQUEST §2, Survey 2 |
| 9 | Autonomous Worker Tier Fencing | Restrict multi-step autonomous tasks and worker execution to Pro tier | M2 | ORIGINAL_REQUEST §2, Survey 2 |
| 10 | Streaming Cancellation Quota Accounting | Defer chat decrement or refund on client disconnect before first content delta | M2 | ORIGINAL_REQUEST §3, Survey 1 |
| 11 | Dynamic Plan-Aware Capacity Guard | 2 concurrent inference permits for Pro, 1 for others; reasoning protection | M2 | ORIGINAL_REQUEST §3, Survey 1 |
| 12 | Safe Downgrade Retention Policy | Retain excess projects, memories, and chats in read-only mode without deletion | M2 | ORIGINAL_REQUEST §Additions.2, Survey 2 |
| 13 | Guest Linking BFF Session Fix | Preserve guest session across BFF auth so guest chats link on sign-in | M2 | ORIGINAL_REQUEST §Additions.6, Survey 1 |
| 14 | "My Plan & Usage" Tab | First-class plan tab in SettingsModal with usage gauges and reset countdowns | M3 | ORIGINAL_REQUEST §4, Survey 3 |
| 15 | Plan Navigation Integration | Wire "Manage Plan" from AccountMenuDropdown and Sidebar to plan tab | M3 | ORIGINAL_REQUEST §4, Survey 3 |
| 16 | Contextual Upgrade Modals | Modal explaining restrictions and showing upgrade CTAs for 4 distinct triggers | M3 | ORIGINAL_REQUEST §5, Survey 3 |
| 17 | Intelligent Capability Discovery | Surface upgrade prompts when selecting locked models, agents, or tools | M3 | ORIGINAL_REQUEST §Additions.1, Survey 3 |
| 18 | Safe Downgrade Retention UI | Display read-only banners and explanations when data exceeds lower-tier quotas | M3 | ORIGINAL_REQUEST §Additions.2, Survey 3 |
| 19 | What's New Announcement System | Modal, unread badge, first-view popups, dismissal persistence, and center | M4 | ORIGINAL_REQUEST §6, Survey 3 |
| 20 | 5-Stage Interactive Onboarding | Interactive tour with Intro, Chat, Agents, Artifacts, Plans and full navigation controls | M4 | ORIGINAL_REQUEST §7, Survey 3 |
| 21 | Account-Level Onboarding Persistence | Persist onboarding completion and restart capability per account | M4 | ORIGINAL_REQUEST §7, Survey 3 |
| 22 | Upgrade Feature Discovery Guidance | Contextual guidance cards highlighting newly unlocked features on upgrade | M4 | ORIGINAL_REQUEST §7, Survey 3 |
| 23 | Notification Preferences UI | Manage announcement dismissals and optional product notification preferences | M4 | ORIGINAL_REQUEST §Additions.4, Survey 3 |
| 24 | Centralized Feature Flag Client Hook | React hook `useFeatureFlag` for dynamic capability rollout | M4 | ORIGINAL_REQUEST §Additions.3, Survey 3 |
| 25 | Consistent Capability Messaging | Align model selector, chat input, agent mode, settings, and errors | M4 | ORIGINAL_REQUEST §Additions.5, Survey 3 |
| 26 | Complete User Journey Integration | Verify Guest->Free->Plus->Pro->Downgrade transitions with isolated fixtures | M5 | ORIGINAL_REQUEST §Additions.6, Survey 1, 2 |
| 27 | 100% E2E Test Suite Pass (Tiers 1-4) | Pass all opaque-box tests created by the E2E Testing Track | M5 | ORIGINAL_REQUEST §8, Dual Track |
| 28 | Adversarial Coverage Hardening | Tier 5 white-box challenger tests, security isolation, and Edge browser acceptance | M5 | ORIGINAL_REQUEST §8, Dual Track |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Contracts & Core Entitlement Engine | Features 1, 2, 3, 4: Commercial contracts, plan tiers, model allowlists, feature flags, announcements schema | none | DONE (`packages/contracts/src/commercial.ts`, `featureFlags.ts`, `announcements.ts`, 21/21 tests pass, 6/6 adversarial pass) |
| 2 | Backend Enforcement, Quotas & Retention | Features 5, 6, 7, 8, 9, 10, 11, 12, 13: Server entitlement guard, model gating, tool/worker fences, quota accounting, downgrade retention, BFF guest linking | M1 | DONE (`apps/api/src/middleware/entitlement-guard.ts`, 284/284 E2E pass, 20/20 stress pass) |
| 3 | Subscription UI & Contextual Upgrades | Features 14, 15, 16, 17, 18: "My Plan & Usage" in settings, UpgradeModal, capability discovery wiring, downgrade read-only UI | M1, M2 | DONE (`src/components/UpgradeModal.tsx`, `SettingsModal.tsx`, 284/284 E2E pass) |
| 4 | Announcements, Onboarding & Rollout Controls | Features 19, 20, 21, 22, 23, 24, 25: What's New center, 5-stage onboarding tour, notification preferences, feature flag hook, capability messaging alignment | M1, M3 | DONE (`src/components/WhatsNewAnnouncementModal.tsx`, `OnboardingWalkthrough.tsx`, `src/lib/featureFlags.ts`, 285/285 E2E pass) |
| 5 | Final Milestone: E2E Pass & Adversarial Hardening | Features 26, 27, 28: Complete user journeys, 100% pass on E2E test suite (Tiers 1-4), Tier 5 white-box adversarial hardening, Edge desktop & mobile acceptance | M2, M3, M4, TEST_READY.md | DONE (`test/adversarial-tier5.test.ts`, `test/entitlements-onboarding-browser.test.ts`, 30/30 Tier 5 pass, 5/5 Edge scenarios pass, 6 screenshots verified) |

## Interface Contracts
### `packages/contracts/src/commercial.ts` ↔ Backend & Frontend
- `PlanTierSchema`: `z.enum(['guest', 'free', 'plus', 'pro'])`
- `PLAN_MODEL_ALLOWLIST`: `Record<PlanTier, readonly string[]>`
- `PLAN_CAPABILITY_MATRIX`: `Record<PlanTier, PlanCapabilities>`
- `getEntitlements(principalId: string)`: returns `EntitlementState`

### `apps/api/src/middleware/entitlement-guard.ts` ↔ API Routes
- `requireEntitledModel(model: string)`: Express middleware verifying model allowlist
- `requirePlanTier(minTier: PlanTier)`: Express middleware verifying minimum required plan tier
- `requireToolEntitlement(toolDef: ToolDefinition)`: verifies tool execution against caller's tier

### `packages/contracts/src/featureFlags.ts` ↔ Client & Server
- `FeatureFlagKey`: `z.enum([...])`
- `evaluateFeatureFlags(tier: PlanTier, overrides?: Record<string, boolean>)`: returns flag map
- `useFeatureFlag(flag: FeatureFlagKey)`: React hook returning boolean

### `packages/contracts/src/announcements.ts` ↔ Announcements UI
- `AnnouncementSchema`: `{ id: string, version: string, title: string, summary: string, features: string[], publishedAt: string }`
- `ANNOUNCEMENT_REGISTRY`: `Announcement[]`

## Code Layout
- `packages/contracts/src/commercial.ts`: Core commercial plan tiers, quotas, model allowlists
- `packages/contracts/src/featureFlags.ts`: Feature flag definitions, schema, defaults
- `packages/contracts/src/announcements.ts`: Announcement definitions and registry
- `apps/api/src/middleware/entitlement-guard.ts`: Express entitlement and tier enforcement middleware
- `apps/api/src/billing/commercial-billing-service.ts`: Atomic quota tracking and customer provisioning
- `packages/tool-runtime/src/gateway.ts`: Tool tier gating (Pro-only tools)
- `packages/agent-runtime/src/autonomous/autonomous-worker-host.ts`: Worker task claim tier fencing
- `src/components/SettingsModal.tsx`: "My Plan & Usage" tab
- `src/components/UpgradeModal.tsx`: Contextual upgrade modal
- `src/components/WhatsNewAnnouncementModal.tsx`: What's New modal and unread indicator
- `src/components/OnboardingWalkthrough.tsx`: 5-stage interactive onboarding walkthrough
- `src/lib/featureFlags.ts`: React context & hook for feature flags
- `src/utils/announcements.ts`: Announcement state and dismissal persistence
- `test/e2e/entitlements/`: Comprehensive E2E opaque-box test suite (Tiers 1-4)
- `test/entitlements-onboarding-browser.test.ts`: Playwright Microsoft Edge browser acceptance suite
