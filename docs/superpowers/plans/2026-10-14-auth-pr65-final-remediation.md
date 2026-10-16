# AIRA AI 2026 — AUTH PR #65 Final Security & CI Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate committed staging database credentials, fix the CI mobile chat welcome regression, eliminate account transition races, and provide comprehensive positive guest linking and account switching verification on PR #65.

**Architecture:** Enforce fail-closed staging credential access via environment variables, fix the transient welcome screen state contract in `src/App.tsx`, introduce an `authEpoch` guard and synchronized state ownership to eliminate cross-account cache bleed, and enhance CI secret scanning patterns.

**Tech Stack:** TypeScript, React 19, Express, Neon PostgreSQL, Playwright, Node.js test runner.

**Spec:** User audit directive for PR #65 Authentication Security and CI Remediation.

## Global Constraints
- Target workspace: `C:\Users\WORKSTATION\AIRA-AI-2026-AUTH`
- Branch: `feat/staging-neon-auth-verified-principal-20261014`
- PR: `#65` targeting `prod-release`
- Never touch production Neon, Vercel prod, domains, or PR #64 / RELEASE-CONTROLS worktree.
- Zero mock auth or fake results; fail closed if staging credentials are missing.
- Never output connection credentials, JWTs, session tokens, or cookies in final reports.

---

### Task 1: Contain Committed Database Credentials and Enhance Secret Scanning
**Files:**
- Modify: `test/auth-playwright-cross-browser.test.ts:60-70`
- Modify: `test/auth-security-authorization.test.ts:25-35`
- Modify: `.github/workflows/ci.yml:53-63`
- Create: `test/tracked-secrets-hygiene.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing secret hygiene test (`test/tracked-secrets-hygiene.test.ts`)**
- [ ] **Step 2: Run test to verify it catches the committed staging database string**
- [ ] **Step 3: Remove hardcoded DB strings from test files and require STAGING_DATABASE_URL / DATABASE_URL with fail-closed error**
- [ ] **Step 4: Update CI secret scanning regex in `.github/workflows/ci.yml`**
- [ ] **Step 5: Run secret hygiene test and verify PASS**

---

### Task 2: Fix Mandatory CI Failure (`test/mobile-chat-welcome-responsive.ts:32`)
**Files:**
- Modify: `src/App.tsx:50-65,114-155`

- [ ] **Step 1: Run `npx tsx test/mobile-chat-welcome-responsive.ts` to observe the exact failure**
- [ ] **Step 2: Modify `src/App.tsx` so `onAuthStateChange` does not forcibly activate `guestConvs[0]` when `activeChatId` is empty**
- [ ] **Step 3: Re-run `npx tsx test/mobile-chat-welcome-responsive.ts` across all 6 viewport sizes and verify 100% PASS**

---

### Task 3: Account Transition Race & Identity Isolation
**Files:**
- Modify: `src/App.tsx:90-190`
- Create: `test/auth-account-switching-isolation.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write test simulating rapid account switching (Account A -> Account B -> Logout -> Account A) in `test/auth-account-switching-isolation.test.ts`**
- [ ] **Step 2: Add `authEpochRef` and synchronized ownership state in `src/App.tsx` to discard stale hydration and prevent cross-account cache writes**
- [ ] **Step 3: Run account switching test and verify zero cross-contamination in DOM, localStorage, and API**

---

### Task 4: Positive Guest Linking End-to-End Acceptance
**Files:**
- Create: `test/guest-linking-positive.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement complete positive guest linking suite (`test/guest-linking-positive.test.ts`) covering genuine guest conversation creation, server sync, account registration, link-guest ownership migration, and cross-context verification**
- [ ] **Step 2: Run `test/guest-linking-positive.test.ts` and verify PASS**

---

### Task 5: Release Certification Gates, Commit, and Remote Verification
**Files:**
- All modified files

- [ ] **Step 1: Run complete verification suite (`typecheck`, `lint`, `build`, `test`, `test:neon-auth-identity`, `test:neon-auth-e2e`, `test:auth-security`, `test:auth-playwright`, `test:mobile-chat-welcome-responsive`)**
- [ ] **Step 2: Review git diff to ensure no secrets or unintended changes**
- [ ] **Step 3: Commit and push to `origin feat/staging-neon-auth-verified-principal-20261014`**
- [ ] **Step 4: Monitor GitHub Actions CI run on PR #65 and report verified results**
