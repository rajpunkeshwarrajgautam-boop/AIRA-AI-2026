# AIRA AI 2026 — Auth Workspace Master Remediation Plan (PR #65)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate token refresh races in `NeonAuthClient`, prevent authenticated-to-guest silent downgrade, harden credential storage and production configuration, enhance JWKS live key rotation, and verify against real Staging Neon and full CI.

**Architecture:**
1. Monotonic `authEpoch` and session-bound `tokenRefreshPromise` in `NeonAuthClient` to eliminate cross-account token pollution during concurrent or interrupted token refresh.
2. Centralized fail-closed request policy: authenticated users never execute account-scoped operations as anonymous guests if JWT acquisition fails.
3. Strict environment configuration: fail-closed in production if `VITE_NEON_AUTH_URL` is omitted.
4. JWKS cache invalidation on unknown `kid` to support live cryptographic key rotation without downtime.

---

### Task 1: P0 — Eliminate Authentication Token Refresh Races (TDD)
**Files:**
- Create: `test/neon-auth-token-race.test.ts`
- Modify: `src/lib/neonAuth.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing concurrency test in `test/neon-auth-token-race.test.ts`**
  - Test Account A triggers `getValidJwt()`; refresh takes time.
  - While pending, Account B logs in or user logs out.
  - Refresh resolves with Account A token.
  - Assert Account A token is NEVER assigned to Account B session, returned to Account B caller, or saved to Account B storage.
- [ ] **Step 2: Run test to observe failure (RED)**
- [ ] **Step 3: Implement monotonic `authEpoch` and session-bound refresh in `src/lib/neonAuth.ts`**
- [ ] **Step 4: Run test to verify PASS (GREEN)**

---

### Task 2: P0 — Eliminate Authenticated-to-Guest Silent Fallback (TDD)
**Files:**
- Create: `test/auth-fail-closed-policy.test.ts`
- Create / Modify: `src/lib/apiClient.ts` or `src/lib/neonAuth.ts` (`authFetch`)
- Modify: `src/utils/aiEngine.ts`
- Modify: `src/utils/conversationSearch.ts`
- Modify: `src/components/LibraryView.tsx`
- Modify: `src/components/AutomationsView.tsx`
- Modify: `src/components/AgentsView.tsx`
- Modify: `src/App.tsx`
- Modify: `package.json`

- [ ] **Step 1: Write failing test in `test/auth-fail-closed-policy.test.ts`**
  - Assert that when `neonAuth.isAuthenticated()` is true, failed JWT refresh fails closed (does NOT execute as guest or omit Authorization).
  - Assert that when `!neonAuth.isAuthenticated()`, normal guest requests succeed.
- [ ] **Step 2: Run test to observe failure (RED)**
- [ ] **Step 3: Implement centralized `authFetch` / `apiClient` with fail-closed authentication policy and session-expired notifications**
- [ ] **Step 4: Update all frontend request callers to use the centralized policy**
- [ ] **Step 5: Run test to verify PASS (GREEN)**

---

### Task 3: P0 — Harden Session & Credential Storage and Production Config (TDD)
**Files:**
- Create: `test/auth-credential-storage.test.ts`
- Modify: `src/lib/neonAuth.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing test checking production config failure and in-memory JWT handling**
- [ ] **Step 2: Run test to observe failure (RED)**
- [ ] **Step 3: Implement production fail-closed URL check and storage hardening in `src/lib/neonAuth.ts`**
- [ ] **Step 4: Run test to verify PASS (GREEN)**

---

### Task 4: P1 — JWT Verification Hardening & Live Key Rotation (TDD)
**Files:**
- Create: `test/neon-auth-jwt-hardening.test.ts`
- Modify: `apps/api/src/auth/neon-auth-principal.ts`
- Modify: `package.json`

- [ ] **Step 1: Write test testing unknown `kid` cache bypass and strict claim checks**
- [ ] **Step 2: Run test to observe failure / gap (RED)**
- [ ] **Step 3: Implement single-retry JWKS cache invalidation in `apps/api/src/auth/neon-auth-principal.ts`**
- [ ] **Step 4: Run test to verify PASS (GREEN)**

---

### Task 5: Staging Verification, Release Gates, Commit, and CI
**Files:**
- All modified and new files

- [ ] **Step 1: Run `npm run test:secrets` to verify 0 exposed credentials**
- [ ] **Step 2: Run full automated verification suites (`typecheck`, `lint`, `build`, `test`, `test:neon-auth-identity`, `test:neon-auth-e2e`, `test:auth-security`, `test:auth-switching`, `test:guest-linking`, `test:auth-playwright`)**
- [ ] **Step 3: Review git diff and commit to `feat/staging-neon-auth-verified-principal-20261014`**
- [ ] **Step 4: Push to origin PR #65 and monitor GitHub Actions CI**
- [ ] **Step 5: Generate complete certification report**
