# AIRA AI 2026 — PR #178 Staging Certification Report

## Summary
PR #178 diagnoses and resolves the authenticated Free-plan access regression where authenticated Free accounts received HTTP 403 `PLAN_MODEL_RESTRICTED` on `aira-auto` and `Plan and usage are unavailable` in Settings. Root cause analysis revealed two defects:
1. `requireEntitledModel` gating reported misleading `requiredTier: plus` instead of the canonical `requiredTier: free`, while `resolveModelUpgradeTrigger` misclassified unauthenticated vs tier restrictions.
2. `getAuthBaseUrl()` evaluated `process.env.NODE_ENV === 'production'`, which crashed in Vercel preview/staging because Vercel defines `NODE_ENV=production`.
3. `/api/version` misreported `environment: "production"` in staging due to static `NODE_ENV` inspection.

All three defects have been remediated in commit [`f87f14c`](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/commit/f87f14c4b985b74aea77654996260a6fe1e4d1b6), deployed to `https://staging.virexaaiventures.com`, and certified across 14 live acceptance steps.

---

## Verification Results

| Check | Expected | Actual | Result | Evidence |
|---|---|---|---|---|
| Environment Classification | `environment: "staging"` | `environment: "staging"` | PASS | `GET /api/version` (commit `f87f14c`) |
| Database & Secrets Isolation | 0 prod credentials, isolated Neon staging DB | 0 secrets across 1,019 files; 41/41 DB isolation tests pass | PASS | `npm run test:secrets`, `npm run test:db-isolation` |
| BFF Free Account Auth | HTTP 200, secure HttpOnly cookie, CSRF token issued | HTTP 200 `status: AUTHENTICATED`, `__Host-aira_auth_session` set | PASS | `POST /api/auth/sign-up` |
| BFF Session Endpoint | HTTP 200, `status: AUTHENTICATED` | HTTP 200, sanitized user profile | PASS | `GET /api/auth/session` |
| Billing Plan & Quotas | Plan `free`, 15 daily chats, 100 credits | `planId: "free"`, `dailyChatLimit: 15`, `availableCredits: 100` | PASS | `GET /api/billing/summary` |
| Authoritative Entitlements | Plan `free`, `canInitiateChat: true` | Plan `free`, `canInitiateChat: true` | PASS | `GET /api/billing/entitlements` |
| Principal Consistency | Identical authenticated principal across billing APIs | Consistent `principalId` across summary & entitlements | PASS | Principal assertion check |
| Authenticated Aira Auto Stream | HTTP 200 `text/event-stream`, full SSE lifecycle | HTTP 200, 2,454 bytes, `run_started` → `content_delta` → `done` | PASS | `POST /api/chat/stream` |
| Quota / Model Restrictions | `aira-pro` returns HTTP 403 `requiredTier: plus` | HTTP 403 `PLAN_MODEL_RESTRICTED`, `callerTier: free` | PASS | Model restriction probe |
| UI Model Selector | `Aira Auto` selectable without lock prompt | Selected cleanly without upgrade prompt | PASS | Playwright Microsoft Edge |
| Session Persistence | Session persists across page reloads | Active Free workspace persists on reload | PASS | Playwright Edge reload |
| Sign-Out Revocation | Cookie cleared, session revoked to ANONYMOUS | HTTP 200, subsequent session returns `ANONYMOUS` | PASS | `POST /api/auth/sign-out` |

---

## Open Risks and Discrepancies
- **Zero Release-Blocking Regressions:** All 14 live staging acceptance steps passed.
- **Residual Risk:** Neon Auth upstream rate limits on disposable email registrations during high-concurrency automated testing. Production uses persistent user accounts and dedicated OAuth providers.

---

## Remaining Acceptance Scenario
- None for staging. Staging certification is 100% complete.
- Production acceptance pending owner authorization and post-merge deployment smoke.

---

## CI Requirements
- **Fast CI:** [PASS](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43684668341/job/132722510344) (3m 1s)
- **PostgreSQL 16 Isolated Certification:** [PASS](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43684668375/job/132722510165) (2m 34s)
- **Semantic Search CI:** [PASS](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43684668341/job/132722510179) (52s)
- **Staging Validation & Isolation Gate:** [PASS](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43684674441/job/132722528694) (1m 20s)
- **Permanent Staging Deployment:** [PASS](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/43684674441/job/132722828840) (18s)
- **GitGuardian Security Checks:** [PASS](https://dashboard.gitguardian.com) (9s)
- **Vercel Preview Deployment:** [PASS](https://vercel.com/rajpunkeshwarrajgautam-boops-projects/aira-ai-2026/HM9hnTE1eC65HYpQCXeq1VkxCauK)

---

## Release Decision
**STAGING CERTIFIED — AWAITING OWNER VERIFICATION**

---
*Notice: Execution has stopped at the mandatory Phase 8 release boundary. In accordance with release protocol, production remains untouched until you provide the exact authorization string:*
`"I VERIFIED STAGING. AUTHORIZE PR MERGE AND PRODUCTION RELEASE."`
