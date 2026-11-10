# TEST_READY: AIRA Entitlements, Subscription-Management, Onboarding & Announcements

## Full Test Suite Execution Command
To run the full E2E opaque-box test suite across all 4 tiers:
```bash
npx tsx test/e2e/entitlements/runner.ts
```

To run individual tiers or test suites directly:
```bash
# Individual Tiers via Runner CLI
npx tsx test/e2e/entitlements/runner.ts --tier=1
npx tsx test/e2e/entitlements/runner.ts --tier=2
npx tsx test/e2e/entitlements/runner.ts --tier=3
npx tsx test/e2e/entitlements/runner.ts --tier=4

# Direct Execution of Test Files
npx tsx test/e2e/entitlements/tier1-feature-coverage.test.ts
npx tsx test/e2e/entitlements/tier2-boundary-corner.test.ts
npx tsx test/e2e/entitlements/tier3-cross-feature.test.ts
npx tsx test/e2e/entitlements/tier4-application-scenarios.test.ts
```

---

## E2E Coverage Summary Table
| Tier | Description | Requirement | Target | Executed | Passed | Failed | Success Rate | Duration |
|:----:|-------------|:-----------:|:------:|:--------:|:------:|:------:|:------------:|:--------:|
| **Tier 1** | Feature Coverage (Happy Paths in Isolation) | ≥5 per feature | 125 | 125 | 125 | 0 | **100%** | 0.14s |
| **Tier 2** | Boundary & Corner Cases (Limits & Security) | ≥5 per feature | 125 | 125 | 125 | 0 | **100%** | 0.19s |
| **Tier 3** | Cross-Feature Combinations (Pairwise Interactions) | ≥25 interactions | 25 | 26 | 26 | 0 | **100%** | 0.07s |
| **Tier 4** | Real-World Application Scenarios (Full User Journeys) | ≥8 scenarios | 8 | 8 | 8 | 0 | **100%** | 0.10s |
| **TOTAL** | **Full Opaque-Box E2E Suite** | **≥283 Tests** | **283** | **284** | **284** | **0** | **100%** | **0.34s** |

---

## 25-Feature Traceability & Checklist Table
| # | Feature | Source (Requirement) | Tier 1 (Coverage ≥5) | Tier 2 (Boundaries ≥5) | Tier 3 (Pairwise) | Tier 4 (Real-World) | Status |
|:--:|---------|----------------------|:--------------------:|:----------------------:|:-----------------:|:-------------------:|:------:|
| 1 | 4-Tier Entitlement Schema | ORIGINAL_REQUEST §2 | 5 / 5 | 5 / 5 | ✓ (T3.C01, T3.C04) | ✓ (T4.S01-05) | **READY** |
| 2 | Authoritative Model Access Matrix | ORIGINAL_REQUEST §2 | 5 / 5 | 5 / 5 | ✓ (T3.C09) | ✓ (T4.S02, T4.S03) | **READY** |
| 3 | Centralized Feature Flags Schema | ORIGINAL_REQUEST §Additions.3 | 5 / 5 | 5 / 5 | ✓ (T3.C05, T3.C16) | ✓ (T4.S08) | **READY** |
| 4 | Announcements Data Contract | ORIGINAL_REQUEST §6 | 5 / 5 | 5 / 5 | ✓ (T3.C05) | ✓ (T4.S06) | **READY** |
| 5 | Server-Side Entitlement Guard | ORIGINAL_REQUEST §3 | 5 / 5 | 5 / 5 | ✓ (T3.C16, T3.C24) | ✓ (T4.S01-05) | **READY** |
| 6 | Guest Identity & Anti-Escalation | ORIGINAL_REQUEST §2 | 5 / 5 | 5 / 5 | ✓ (T3.C02, T3.C18) | ✓ (T4.S01) | **READY** |
| 7 | Plan-Aware Model Routing Gate | ORIGINAL_REQUEST §3 | 5 / 5 | 5 / 5 | ✓ (T3.C09) | ✓ (T4.S02, T4.S03) | **READY** |
| 8 | Tool Gateway Tier Gating | ORIGINAL_REQUEST §2 | 5 / 5 | 5 / 5 | ✓ (T3.C10, T3.C21) | ✓ (T4.S03, T4.S04) | **READY** |
| 9 | Autonomous Worker Tier Fencing | ORIGINAL_REQUEST §2 | 5 / 5 | 5 / 5 | ✓ (T3.C11, T3.C20) | ✓ (T4.S04) | **READY** |
| 10 | Streaming Cancellation Quota Accounting | ORIGINAL_REQUEST §3 | 5 / 5 | 5 / 5 | ✓ (T3.C12, T3.C13) | ✓ (T4.S01, T4.S04) | **READY** |
| 11 | Dynamic Plan-Aware Capacity Guard | ORIGINAL_REQUEST §3 | 5 / 5 | 5 / 5 | ✓ (T3.C12, T3.C21) | ✓ (T4.S04) | **READY** |
| 12 | Safe Downgrade Retention Policy | ORIGINAL_REQUEST §Additions.2 | 5 / 5 | 5 / 5 | ✓ (T3.C03, T3.C20) | ✓ (T4.S05) | **READY** |
| 13 | Guest Linking BFF Session Fix | ORIGINAL_REQUEST §Additions.6 | 5 / 5 | 5 / 5 | ✓ (T3.C01, T3.C19) | ✓ (T4.S01) | **READY** |
| 14 | "My Plan & Usage" Tab | ORIGINAL_REQUEST §4 | 5 / 5 | 5 / 5 | ✓ (T3.C13, T3.C22) | ✓ (T4.S01-05) | **READY** |
| 15 | Plan Navigation Integration | ORIGINAL_REQUEST §4 | 5 / 5 | 5 / 5 | ✓ (T3.C14) | ✓ (T4.S02, T4.S03) | **READY** |
| 16 | Contextual Upgrade Modals | ORIGINAL_REQUEST §5 | 5 / 5 | 5 / 5 | ✓ (T3.C02, T3.C09, T3.C10) | ✓ (T4.S01, T4.S02) | **READY** |
| 17 | Intelligent Capability Discovery | ORIGINAL_REQUEST §Additions.1 | 5 / 5 | 5 / 5 | ✓ (T3.C15, T3.C25) | ✓ (T4.S02, T4.S03) | **READY** |
| 18 | Safe Downgrade Retention UI | ORIGINAL_REQUEST §Additions.2 | 5 / 5 | 5 / 5 | ✓ (T3.C03, T3.C26) | ✓ (T4.S05) | **READY** |
| 19 | What's New Announcement System | ORIGINAL_REQUEST §6 | 5 / 5 | 5 / 5 | ✓ (T3.C05, T3.C06) | ✓ (T4.S06) | **READY** |
| 20 | 5-Stage Interactive Onboarding | ORIGINAL_REQUEST §7 | 5 / 5 | 5 / 5 | ✓ (T3.C07, T3.C08) | ✓ (T4.S07) | **READY** |
| 21 | Account-Level Onboarding Persistence | ORIGINAL_REQUEST §7 | 5 / 5 | 5 / 5 | ✓ (T3.C08, T3.C17) | ✓ (T4.S07) | **READY** |
| 22 | Upgrade Feature Discovery Guidance | ORIGINAL_REQUEST §7 | 5 / 5 | 5 / 5 | ✓ (T3.C07, T3.C23) | ✓ (T4.S03) | **READY** |
| 23 | Notification Preferences UI | ORIGINAL_REQUEST §Additions.4 | 5 / 5 | 5 / 5 | ✓ (T3.C06, T3.C23) | ✓ (T4.S06) | **READY** |
| 24 | Centralized Feature Flag Client Hook | ORIGINAL_REQUEST §Additions.3 | 5 / 5 | 5 / 5 | ✓ (T3.C05, T3.C16) | ✓ (T4.S08) | **READY** |
| 25 | Consistent Capability Messaging | ORIGINAL_REQUEST §Additions.5 | 5 / 5 | 5 / 5 | ✓ (T3.C11, T3.C24) | ✓ (T4.S01-05) | **READY** |

---

## Real-World User Journeys (Tier 4)
1. **Scenario 1 (Guest Journey)**: 5 chats executed -> 6th chat blocked with 429 quota exhaustion -> contextual upgrade prompt with sign-in CTA -> user registers Free account -> BFF guest linking migrates conversation history -> verified Free daily limit (15 chats).
2. **Scenario 2 (Free User Journey)**: Standard chat on `claude-3-5-haiku` -> attempt flagship `claude-3-opus` blocked with 403 `PLAN_MODEL_RESTRICTED` -> creates projects up to limit (3) -> 4th creation blocked with 403 `QUOTA_EXCEEDED_READ_ONLY_MODE` -> usage gauges report 1 chat used, 14 remaining.
3. **Scenario 3 (Plus Upgrade Journey)**: Free user upgrades to Plus -> unlocks feature discovery guidance (`agent_mode`, `reasoning_boosts`) -> expanded quotas active (50 chats, 3000 credits, 50 reasoning boosts, 10 projects) -> streams reasoning model `deepseek-r1` and `claude-3-5-sonnet` -> Pro tools remain protected.
4. **Scenario 4 (Pro Power User Journey)**: Upgrades to Pro -> 150 chats/day, 7500 credits, 200 boosts, 2 concurrent inference permits -> dispatches multi-step autonomous task (201 queued) -> executes Python sandbox code (200 success) -> executes browser automation tool (200 success) -> runs 2 concurrent streams simultaneously.
5. **Scenario 5 (Downgrade & Retention Journey)**: Pro user with 10 projects and 60 memories downgrades to Free -> zero data loss (all 10 projects and 60 memories retained) -> excess items (7 projects, 10 memories) marked `readOnly: true` -> new project creation blocked with 403 -> upgrading back to Pro instantly clears read-only status on all items.
6. **Scenario 6 (Announcement Lifecycle)**: Publish new release version (`2026.3.0`) -> client unread badge increments -> user views popup and dismisses -> unread count decrements to 0 -> announcement permanently viewable in What's New center.
7. **Scenario 7 (Onboarding Lifecycle)**: First login starts at Intro -> advances to Chat -> tests Back to Intro -> advances to Agent mode -> simulates page refresh mid-tour (resumes at Agent mode) -> finishes all 5 stages -> restarts tutorial from Help menu (resets to Intro).
8. **Scenario 8 (Feature Flag Dynamic Toggles)**: Client reads initial defaults -> admin toggles `pro_tools_execution` override -> client immediately receives updated flag without server reboot -> admin applies killswitch on `whats_new_announcements` -> verified instantaneous client-server reflection.

---

## Test Architecture & Quality Safeguards
- **Opaque-Box Testing**: Real HTTP requests via `fetch()` against ephemeral port server (`127.0.0.1:0`). Zero monkey-patching or internal mock coupling.
- **Fail-Closed Security**: IDOR isolation verified across projects and memories; header spoofing (`x-user-tier`) rejected by server-side session checks; guest tokens guarded against replay attacks (409 Conflict).
- **Zero Race Conditions**: Atomic concurrency permit allocation (2 permits for Pro, 1 for others) tested with concurrent bursts.
- **Teardown & Isolation**: Complete per-test state isolation, dynamic cleanup of feature flag overrides, and deterministic execution under 0.35 seconds for the entire 284-test suite.
