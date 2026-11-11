# E2E Test Infra: AIRA Entitlements, Subscription-Management, Onboarding & Announcements

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Target viewports: Microsoft Edge desktop (1280x800) and mobile (390x844).

## Feature Inventory (25 Features)
| # | Feature | Source (requirement) | Tier 1 (Coverage ≥5) | Tier 2 (Boundaries ≥5) | Tier 3 (Pairwise) | Tier 4 (Real-World) |
|---|---------|---------------------|:-------------------:|:---------------------:|:-----------------:|:-------------------:|
| 1 | 4-Tier Entitlement Schema | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 2 | Authoritative Model Access Matrix | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 3 | Centralized Feature Flags Schema | ORIGINAL_REQUEST §Additions.3 | 5 | 5 | ✓ | ✓ |
| 4 | Announcements Data Contract | ORIGINAL_REQUEST §6 | 5 | 5 | ✓ | ✓ |
| 5 | Server-Side Entitlement Guard | ORIGINAL_REQUEST §3 | 5 | 5 | ✓ | ✓ |
| 6 | Guest Identity & Anti-Escalation | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 7 | Plan-Aware Model Routing Gate | ORIGINAL_REQUEST §3 | 5 | 5 | ✓ | ✓ |
| 8 | Tool Gateway Tier Gating | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 9 | Autonomous Worker Tier Fencing | ORIGINAL_REQUEST §2 | 5 | 5 | ✓ | ✓ |
| 10 | Streaming Cancellation Quota Accounting | ORIGINAL_REQUEST §3 | 5 | 5 | ✓ | ✓ |
| 11 | Dynamic Plan-Aware Capacity Guard | ORIGINAL_REQUEST §3 | 5 | 5 | ✓ | ✓ |
| 12 | Safe Downgrade Retention Policy | ORIGINAL_REQUEST §Additions.2 | 5 | 5 | ✓ | ✓ |
| 13 | Guest Linking BFF Session Fix | ORIGINAL_REQUEST §Additions.6 | 5 | 5 | ✓ | ✓ |
| 14 | "My Plan & Usage" Tab | ORIGINAL_REQUEST §4 | 5 | 5 | ✓ | ✓ |
| 15 | Plan Navigation Integration | ORIGINAL_REQUEST §4 | 5 | 5 | ✓ | ✓ |
| 16 | Contextual Upgrade Modals | ORIGINAL_REQUEST §5 | 5 | 5 | ✓ | ✓ |
| 17 | Intelligent Capability Discovery | ORIGINAL_REQUEST §Additions.1 | 5 | 5 | ✓ | ✓ |
| 18 | Safe Downgrade Retention UI | ORIGINAL_REQUEST §Additions.2 | 5 | 5 | ✓ | ✓ |
| 19 | What's New Announcement System | ORIGINAL_REQUEST §6 | 5 | 5 | ✓ | ✓ |
| 20 | 5-Stage Interactive Onboarding | ORIGINAL_REQUEST §7 | 5 | 5 | ✓ | ✓ |
| 21 | Account-Level Onboarding Persistence | ORIGINAL_REQUEST §7 | 5 | 5 | ✓ | ✓ |
| 22 | Upgrade Feature Discovery Guidance | ORIGINAL_REQUEST §7 | 5 | 5 | ✓ | ✓ |
| 23 | Notification Preferences UI | ORIGINAL_REQUEST §Additions.4 | 5 | 5 | ✓ | ✓ |
| 24 | Centralized Feature Flag Client Hook | ORIGINAL_REQUEST §Additions.3 | 5 | 5 | ✓ | ✓ |
| 25 | Consistent Capability Messaging | ORIGINAL_REQUEST §Additions.5 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test runner: `tsx` / Node.js native test runner + Playwright for Edge browser tests.
- Location: `test/e2e/entitlements/` and `test/entitlements-onboarding-browser.test.ts`.
- Invocation: `npx tsx test/e2e/entitlements/runner.ts` (all pass exit code 0).
- Pass/Fail semantics: Strict boolean assertions with zero fabricated mocks.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Guest Journey: 5 chats, limit hit, upgrade prompt, sign-in, conversation linking | F1, F5, F6, F13, F14, F16 | High |
| 2 | Free User Journey: 15 chats, locked model attempt -> upgrade modal, project creation up to 3 | F1, F2, F7, F14, F16, F17 | High |
| 3 | Plus Upgrade Journey: Upgrade to Plus, feature discovery prompt, agent mode enabled, reasoning boost used | F1, F2, F7, F14, F16, F22 | High |
| 4 | Pro Power User Journey: Pro agent mode, Python sandbox + browser tool, 2 concurrent queries | F1, F8, F9, F11, F14 | High |
| 5 | Downgrade & Retention: Pro downgrades to Free, 10 projects & 100 memories kept intact in read-only, exportable, new creation blocked with explanation | F1, F12, F18 | High |
| 6 | Announcement Lifecycle: Deploy new version, first-view popup, unread badge, dismiss, view in What's New center | F4, F19, F23 | Medium |
| 7 | Onboarding Lifecycle: First login, 5-stage walkthrough (Intro -> Chat -> Agent -> Artifacts -> Plans), Skip, Resume, Finish, Restart Tutorial | F20, F21 | High |
| 8 | Feature Flag Toggles: Dynamically toggle feature flags, verify instant client-server reflection | F3, F24 | Medium |

## Coverage Thresholds
- Tier 1: ≥5 per feature (25 × 5 = 125 test cases)
- Tier 2: ≥5 per feature (25 × 5 = 125 test cases)
- Tier 3: pairwise coverage of major feature interactions (≥25 test cases)
- Tier 4: ≥8 realistic end-to-end application scenarios
- **Total Minimum Test Cases**: ~283 test cases.
