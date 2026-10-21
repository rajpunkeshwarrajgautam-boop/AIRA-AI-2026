# AIRA AI 2026 — First-Party BFF Session Gateway & Real Client Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely eliminate `RELEASE-BLOCKER-AUTH-001` by replacing HMAC-encoded bearer cookies with opaque server-side session cookies, implementing strict origin and cryptographic CSRF verification, migrating the frontend client to same-origin HttpOnly BFF mode without localStorage tokens, and certifying with automated tests and CI.

**Architecture:** 
1. BFF Gateway (`apps/api/src/auth/bff-session.ts`): Issues opaque 256-bit session cookies backed by a secure server-side session store (`BffSessionStore`). The cookie contains only `${sessionId}.${hmac}`, completely removing reusable bearer credentials from client-accessible storage.
2. Origin & CSRF Guard: Enforces strict origin allowlisting (blocking mismatched origins regardless of custom headers) and per-session cryptographic CSRF tokens on all mutating HTTP methods (`POST`, `PUT`, `DELETE`).
3. Frontend Client (`src/lib/neonAuth.ts`): Migrates authentication to same-origin `/api/auth/*` with `credentials: 'include'`, purges legacy localStorage tokens, and uses HttpOnly cookie sessions for `authenticatedApiFetch()` while preserving monotonic epochs, stream cancellation, and guest linking.

**Tech Stack:** TypeScript, Node.js `crypto`, Express, React 19, Neon Managed Better Auth, Playwright, Vitest.

**Spec:** User Directive "AIRA AI 2026 — AUTH P0 SECURITY REMEDIATION AND REAL BFF CERTIFICATION"

## Global Constraints
- Do NOT merge PR #64 or PR #65 into `prod-release`.
- Do NOT alter production ruleset 25079946.
- Do NOT touch production Neon database or production Vercel domains.
- Fail closed in production if `NEON_AUTH_BASE_URL` or `AIRA_SESSION_SECRET` are missing.
- Zero bearer tokens or JWTs stored in browser `localStorage`.
- Preserve monotonic `authEpoch` increment, late 401 revocation isolation, and `identityBoundStream` safety.

---

### Task 1: Opaque Server-Side Session Store in BFF Gateway

**Files:**
- Modify: `apps/api/src/auth/bff-session.ts`
- Modify: `apps/api/src/index.ts`
- Test: `test/auth-bff-session-gateway.test.ts`

**Interfaces:**
- Consumes: `verifyNeonAuthToken` from `apps/api/src/auth/neon-auth-principal.ts`
- Produces: `BffSessionStore`, `BffServerSession`, `readBffSessionFromCookie`, `setBffSessionCookie`, `clearBffSessionCookie`

- [ ] **Step 1: Write failing test asserting opaque cookie structure and server-side invalidation**
- [ ] **Step 2: Run test to confirm failure with current base64 payload implementation**
- [ ] **Step 3: Implement `BffSessionStore` with opaque ID generation, server-side store, and HMAC cookie signature**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Verify production fail-closed validation for `NEON_AUTH_BASE_URL`**

---

### Task 2: Strict Origin Verification & Cryptographic CSRF Protection

**Files:**
- Modify: `apps/api/src/auth/bff-session.ts`
- Modify: `apps/api/src/index.ts`
- Test: `test/auth-bff-session-gateway.test.ts`

**Interfaces:**
- Produces: `verifyCsrfAndOrigin(req: Request, session?: BffServerSession): boolean`, `generateCsrfToken(): string`

- [ ] **Step 1: Write failing test asserting rejection of mismatched origins despite custom headers**
- [ ] **Step 2: Write failing test asserting rejection of mutating requests without valid session CSRF token**
- [ ] **Step 3: Implement strict origin check against host and allowlist, plus session-bound CSRF token validation**
- [ ] **Step 4: Update CORS in `apps/api/src/index.ts` to allow specific origins with credentials**
- [ ] **Step 5: Run tests to verify all pass**

---

### Task 3: Complete Frontend Migration in `src/lib/neonAuth.ts`

**Files:**
- Modify: `src/lib/neonAuth.ts`
- Modify: `src/App.tsx`
- Test: `test/auth-identity-transition-lifecycle.test.ts`

**Interfaces:**
- Produces: First-party same-origin `signIn`, `signUp`, `signOut`, `restoreSession`, and `authenticatedApiFetch` using HttpOnly cookies and `X-CSRF-Token`

- [ ] **Step 1: Write failing test for client BFF mode and localStorage token eradication**
- [ ] **Step 2: Update `NeonAuthClient` to use `/api/auth/*` endpoints with credentials and CSRF tokens**
- [ ] **Step 3: Ensure legacy localStorage tokens are purged on initialization**
- [ ] **Step 4: Update `authenticatedApiFetch` to support HttpOnly cookie auth without requiring raw JWTs in client JS**
- [ ] **Step 5: Preserve guest linking, monotonic epoch, and `identityBoundStream` safety**
- [ ] **Step 6: Run lifecycle tests and typecheck to verify passes**

---

### Task 4: Full Suite Certification & Reality Checker Audit

**Files:**
- Modify: `docs/AUTH_SESSION_SECURITY_ARCHITECTURE.md`
- Modify: `.continue-here.md`

- [ ] **Step 1: Run all security and test suites locally (`test:secrets`, `test:auth-bff`, `test:auth-lifecycle`, `test:auth-token-race`, `test:auth-fail-closed`, `test:neon-auth-identity`, `test:neon-auth-e2e`, `test:auth-security`, `test:guest-linking`)**
- [ ] **Step 2: Run `typecheck`, `lint`, and `build`**
- [ ] **Step 3: Update `docs/AUTH_SESSION_SECURITY_ARCHITECTURE.md` declaring RELEASE-BLOCKER-AUTH-001 resolved on AUTH branch**
- [ ] **Step 4: Commit and push to `feat/staging-neon-auth-verified-principal-20261014`**
- [ ] **Step 5: Monitor GitHub Actions CI run to 100% green completion**
- [ ] **Step 6: Conduct Independent Reality Checker audit and provide comprehensive final report**
