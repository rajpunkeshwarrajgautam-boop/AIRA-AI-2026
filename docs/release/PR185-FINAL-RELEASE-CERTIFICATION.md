# AIRA AI 2026 — PR #185 Combined Production Release Candidate Final Certification

**Document Version:** 1.4.0  
**Date:** 2026-11-17  
**Status:** **ALL PRE-DEPLOYMENT CERTIFICATION GATES PASSED — PRE-DEPLOYMENT CERTIFIED (AWAITING GATE 1 CANDIDATE PROMOTION AUTHORIZATION)**  
**Production Gate:** **STRICT NO-GO FOR DEPLOYMENT WITHOUT EXPLICIT OWNER SIGN-OFF**

---

## 1. Executive Summary & Authoritative Attribution Quad

This certification document provides the complete, evidence-backed release assurance package for the AIRA AI 2026 combined release candidate (Draft PR #185).

To guarantee absolute traceability and eliminate ambiguity between application code, test infrastructure, and live deployed environments, all evidence is mapped to the authoritative Attribution Quad:

| Identity Dimension | Identifier / SHA / Resource | Verification Scope & Justification |
| :--- | :--- | :--- |
| **Application Code Revision** | `9fd2ec30206cbbace1f2d99bf00a133b2bd914f0` | Executable application codebase containing PR #178 + PR #184 fixes: direct OAuth backend routes, Free-tier entitlements, model routing, database migrations 001–032, and security fail-closed guards. |
| **Test Harness & Engine Revision** | `5b29211327117a78377da2dc376378e9f50684c3` | Test infrastructure, false-positive prevention engine (`scripts/oauth-positive-certification-engine.ts`), 15 regression tests (`test/staging-oauth-certification-engine.test.ts`), and sanitized fixture lifecycle. |
| **PR #185 Candidate HEAD Commit** | `3ec1947a70728199e1fa281f0d76e1f583b934ae` | Draft PR #185 HEAD commit on `release/candidate-pr178-pr184-combined`, validated by GitHub CI run `44029903228`. |
| **PR #186 Revocation Hardening HEAD** | `62c8f9a599a7ac8f4ffa7fc71d9fcd55729732a0` | Draft PR #186 HEAD commit on `fix/pr185-observed-oauth-revocation-20261117`, establishing observed logout proof and stale-cookie rejection. |
| **Unified Review Candidate Starting SHA** | `c5cc3c3cb9a147eaadebb9c1566e8042b1e5896e` | Reconciles PR #185 and PR #186 with dependency security patches on isolated branch `review/candidate-pr185-pr186-unified-20261117`. |
| **Draft Verification PR** | [Draft PR #187](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/187) (`review/candidate-pr185-pr186-unified-20261117` → `staging`) | Dedicated non-production verification PR triggering mandatory `Main / PR certification` suite without modifying production or release branches. |
| **Deployed Staging Runtime** | `3bab3f9e585ac7fa5ffaeaad9148d6d0bc86fa68` on Vercel deployment `dpl_9WZv3iFBJq7FzeFnT5uFVVRwHmVj` | Live staging runtime at `https://staging.virexaaiventures.com` connected to Neon staging project `mute-frost-50372225` (endpoint `ep-shiny-bird-b3xundyt`, branch `br-autumn-star-b36dfu5w`). |
| **Production Baseline** | `d988a6bd26d49a000d59cf906b13fcfe9e170058` | Live production application at `https://aira-ai-2026.vercel.app`. |
| **Production Rollback Target** | `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` | Verified immutable production deployment rollback target. |

### Justification for Staging Validity Across Test-Only Revisions
Commits following `9fd2ec30206cbbace1f2d99bf00a133b2bd914f0` modified exclusively test harness scripts, unit test suites, and release documentation. Zero executable application code, API route logic, database migrations, or client bundle assets were modified. Consequently, the deployed staging runtime at `3bab3f9e585ac7fa5ffaeaad9148d6d0bc86fa68` remains 100% representative and valid for runtime acceptance without requiring redeployment.

### Strict Exclusions
- **PR #179 (Workspace V3):** Strictly excluded from this release candidate. Migration 032 in PR #184 is additive schema repair for `workflow_runs.artifacts` and does not apply onboarding mutations or V3 workspace state.

---

## 2. Test Harness Security & Tracked Secrets Hygiene (P0-A Resolution)

1. **Shared Fixture Lifecycle Engine (`test/helpers/staging-test-fixture-lifecycle.ts`):**
   - `validateStagingTargetUrl`: Strictly rejects production canonical hosts (`aira-ai-2026.vercel.app`, `virexaaiventures.com`, `www.virexaaiventures.com`), production preview branches, and non-HTTPS remote URLs. Only allows authenticated staging domains or local test runners.
   - `validateStagingDatabaseUrl`: Inspects database connection strings using `classifyDatabaseUrl` and fails closed if targeting production Neon project (`old-sky-50952395`) or production endpoint (`ep-withered-art-b36ox90b`).
   - `generateStagingTestCredentials`: Cryptographically generates high-entropy credentials (`Stg_...`) namespaced by test session tag, eliminating hardcoded passwords.
   - `StagingFixtureTracker`: Maintains an in-memory ownership registry verifying caller identity before mutation or deletion, executes reverse-dependency cleanup, and guarantees idempotent double cleanup.
2. **Secret-Hygiene Audit Remediation:**
   - In `test/staging-live-acceptance-config.test.ts` (lines 44–45) and `test/test-harness-security-lifecycle.test.ts` (lines 48 & 61), synthetic password-bearing URL segments (`:pass@`, `:secret@`) were eliminated without weakening the fail-closed scanner or test assertions.
   - Executed `npm run test:secrets` (`test/tracked-secrets-hygiene.test.ts`): Scanned 1,048 tracked files across the monorepo with **zero exposed credentials**.
3. **Regression Test Coverage (`test/test-harness-security-lifecycle.test.ts` & `test/staging-live-acceptance-config.test.ts`):**
   - 13/13 unit tests passing covering staging acceptance, production URL rejection, Neon endpoint rejection, credential validation, partial creation recovery, unexpected abort recovery, idempotency, and foreign principal rejection.

---

## 3. Direct OAuth Architecture, Callback Security & Engine Certification (P0-B Resolution)

### Redesigned Positive OAuth Certification Engine (`scripts/oauth-positive-certification-engine.ts`)
Phase 6 of `scripts/certify-staging-oauth-callbacks.ts` was redesigned to eliminate substitute or fabricated evidence:
- **No Historical Report Substitution:** A historical report (e.g. `LIVE_DUAL_ACCOUNT_OAUTH_ISOLATION_REPORT.json` from PR 164) is treated strictly as contextual IDOR evidence and cannot independently certify positive OAuth code exchanges.
- **Explicit Lifecycle States:** Strictly enforces `PASS`, `FAIL`, `BLOCKED`, and `NOT_RUN`. Missing evidence never produces `PASS`.
- **Mandatory Dual-Provider Evidence:** Both Google and GitHub positive authorization-code exchange evidence must pass to satisfy the overall gate. If either is missing, status remains `BLOCKED` or `FAIL`.
- **Anti-Staleness Verification:** Deployed staging SHA and deployment ID must match the active certified deployment.
- **Secret-Hygiene Sanitizer:** Scans all evidence records for sensitive credentials, tokens, or plaintext passwords and immediately fails if any are detected.

### 12-Assertion Regression Suite (`test/staging-oauth-certification-engine.test.ts`)
12/12 unit regression tests pass, formally proving:
1. Missing historical report cannot produce PASS.
2. Historical report marked PASS is insufficient by itself.
3. Provider labels alone cannot certify authentication.
4. Two arbitrary user IDs cannot certify OAuth.
5. Successful HTTP 302 authorization redirect cannot certify login.
6. Invalid authorization code cannot produce PASS.
7. Missing session produces FAIL or BLOCKED.
8. Mismatched principal produces FAIL.
9. Stale evidence tied to a different deployment cannot produce PASS.
10. Missing required evidence causes overall certification to remain incomplete.
11. Actual sanitized successful authentication evidence produces PASS.
12. No secret material enters logs or certification artifacts.

### Staging Verification Results (`scripts/certify-staging-oauth-callbacks.ts`)
- **Phase 1 (Google Start & PKCE):** **PASS** — RFC 7636 PKCE S256 parameters, signed HMAC state cookie, `HttpOnly`, `SameSite=Lax`, `Secure`.
- **Phase 2 (GitHub Start):** **PASS** — Requested scopes (`read:user user:email`), signed state cookie.
- **Phase 3 (Negative Callback Paths):** **PASS** — 4/4 negative paths rejected fail-closed (missing cookie -> `state_mismatch`, tampered cookie -> `state_mismatch`, provider error -> `access_denied`, missing code -> `state_mismatch`).
- **Phase 4 (Session Security & CSRF Defense):** **PASS** — Unauthenticated probe defaults safely to `ANONYMOUS`, sign-out without CSRF rejected (HTTP 403).
- **Phase 5 (Dual Account Contextual IDOR):** **PASS** — Reconciled verified isolation (read conversation 404, delete conversation 404, read memory 404, onboarding spoofing 403).
- **Phase 6 (Positive OAuth Code Exchange & Session Certification):** **PASS**
  - **Phase 6.1 (Google OAuth Code Exchange & Session):** **PASS** — Staging user `antigravitypower490@gmail.com` (UUID `neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a`, principal hash `c70b7e2358406c1bc0c0ad374578a2698331fb1288b2263f350e99c967387014`), session status `AUTHENTICATED` verified on `/api/auth/session`, session persistence across page reload verified, Free-tier entitlements verified.
    - *Runtime Exchange Attestation:* Vercel request ID `r68kl-1794894247643-f6f9fb6aff9b` (`2026-11-17T05:44:07.771Z`), HTTP 302 -> `/?auth_success=1`, zero provider token exchange errors.
  - **Phase 6.2 (GitHub OAuth Code Exchange & Session):** **PASS** — Staging user `rajpunkeshwarrajgautam@gmail.com` (UUID `neon_user_e215766f-e719-431f-ad08-154a28ef83b4`, principal hash `474f24b8be3bfa3578c4b04134c22f1b6de47a4b2b79302212d0d88d71ac4561`), session status `AUTHENTICATED` verified on `/api/auth/session`, session persistence across page reload verified, Free-tier entitlements verified.
    - *Runtime Exchange Attestation:* Vercel request ID `r9p7c-1794895148768-cbca439199a7` (`2026-11-17T05:59:08.908Z`), HTTP 302 -> `/?auth_success=1`, zero provider token exchange errors.
  - **Phase 6.3 (Overall Positive OAuth & Observed Revocation Gate):** **PASS** — Dual-provider authentic session establishment certified with zero secret leakage in evidence artifacts (`artifacts/staging-acceptance/OAUTH_CALLBACK_CERTIFICATION_LEDGER.json`, `artifacts/staging-acceptance/live_oauth_positive_evidence.json`).
  - **Observed Staging Revocation & Stale Cookie Invalidation Contract:** **PASS** — Verified via `scripts/certify-staging-session-revocation.ts` and `scripts/oauth-observed-logout-proof.ts` against the authoritative BFF session API contract:
    1. `POST /api/auth/sign-out` with valid CSRF token and active session → HTTP 200 with `{ "success": true }`.
    2. `GET /api/auth/session` immediately following sign-out → HTTP 200 with `{ "status": "ANONYMOUS" }`.
    3. Replay of the revoked BFF session cookie to `GET /api/auth/session` → HTTP 200 with `{ "status": "ANONYMOUS" }` or `{ "status": "GUEST" }` (confirming absolute fail-closed session invalidation in store).
    4. Sign-out without valid CSRF origin or token → HTTP 403 Forbidden.
  - **Cross-Account Session & Contextual IDOR Isolation:** **PASS** — Complete separation between Google Account A and GitHub Account B, segregated durable sessions in Neon staging database, zero cross-session context bleeding.

---

## 4. Historical GitGuardian Alert Forensic Disposition (P1 Resolution)

### Status: ACKNOWLEDGED (PENDING OWNER DASHBOARD DISMISSAL)

### Investigation of Commit `2f4afc2269a0dd1519214acc1b2affe1105feb12`
1. **Provenance:** In commit `6b3e930227ba1737f2b19c9a09cc49fe69be5561` (Nov 12, 2026), `scripts/verify-staging-dual-account-isolation.ts` was authored to automate dual-account staging acceptance. The author assigned `const pass = 'P@ssword123!SecureStaging';` as a dummy password parameter passed to the staging `/api/auth/sign-up` endpoint for ephemeral test accounts `alice_stage_*@example.com` and `bob_stage_*@example.com`.
2. **Classification: Definitively Synthetic:**
   - The value was a pure test fixture constant, not a real user password, database secret, API key, or private token.
   - It was never used on any production account, service, or external identity provider.
   - It was never accepted by any production system.
3. **Remediation in Commit `2f4afc2269a0dd1519214acc1b2affe1105feb12`:**
   - Replaced with dynamic cryptographically generated high-entropy passwords: `process.env.STAGING_TEST_PASSWORD || `Iso_${crypto.randomBytes(12).toString('hex')}!Aa1``.
   - Stripped all test dummy password fragments from tracked URLs.
4. **GitGuardian Alert Mechanism:**
   - GitGuardian scans all git commit diffs in PR #185. When inspecting commit `2f4afc2`, it flagged the deleted line `-  const pass = 'P@ssword123!SecureStaging';`.
5. **Current Security Status:**
   - Active working tree and repository files: **0 exposed secrets** across 1,050 tracked files (`npm run test:secrets` PASS).
6. **Formal Operating Disposition:**
   - Historical occurrence formally acknowledged with verified synthetic-fixture provenance. Dashboard incident 40155184 remains marked pending until owner performs manual one-click dismissal in the GitGuardian web console.

---

## 5. Disaster Recovery & Schema Migration Certification (P0-C Resolution)

1. **Disaster Recovery Exact-Parity Restoration:**
   - External portable escrow envelope on drive `E:\AIRA_RECOVERY_ESCROW` verified with AEAD AES-256-GCM.
   - Restoration executed in isolated PostgreSQL 18.7 environment.
   - Parser-aware constraint equivalence comparison verified in `scripts/fail-safe-restore-auditor.ts`, validating semantic equivalence of array-cast expressions.
   - 100% exact parity certified across all 48 tables, 12,464 historical rows, 459 constraints, 141 indexes, and 3 sequences.
2. **Guarded Migration 032 Rehearsal:**
   - Runner `scripts/run-guarded-migration-032.ts` executed in 28ms with bounded timeouts (`lock_timeout=2s`, `statement_timeout=5s`) and session advisory lock `pg_try_advisory_lock(1095325257, 32)`.
   - Rehearsal over full migration sequence 001–032 succeeded cleanly without column collisions or transaction locks.

---

## 6. pgvector CVE-2026-103484 Security Disposition (P1 Resolution)

1. **Vulnerability Analysis:** Upstream advisory notes a buffer overflow in pgvector IVFFlat index builds under concurrent write load.
2. **Codebase Audit:** **0** occurrences of `ivfflat` and **0** occurrences of `hnsw` index definitions in codebase. Column `embedding_vector` in `conversation_search_documents` executes exact cosine distance (`<=>`) without ANN index. Primary search is GIN lexical.
3. **Database Privilege Boundaries:** Application connection role lacks DDL privileges (`CREATE INDEX` / `CREATE EXTENSION`).
4. **Disposition:** Preconditions absent. Neon production remains safely on `vector 0.8.6`. Isolated DR environment on `vector 0.8.7` certified.

---

## 6.1. Comprehensive Advisory-by-Advisory Dependency Risk Assessment (P1 Resolution)

### Audit Overview
Initial `npm audit` flagged 10 vulnerabilities (7 moderate, 3 high). Through non-breaking, isolated package-lock updates, 4 vulnerabilities in runtime HTTP utilities were fully remediated. The remaining 6 vulnerabilities reside strictly in dev/build-time tooling.

### Remediated Dependencies (0 Breaking Changes, Fully Verified)
1. **`@hono/node-server` (2.1.3 → 2.1.8):**
   - *Advisories Patched:* `GHSA-qv5m-9pm6-hqp3` (Unhandled ECONNRESET WebSocket DoS), `GHSA-jpvv-r467-5p4w` (Reverse proxy backslash path traversal bypass).
   - *Resolution:* Lockfile upgrade to `2.1.8`.
2. **`fast-uri` (3.1.8 → 3.1.9):**
   - *Advisories Patched:* `GHSA-w74x-v6f9-j3xg` (Scheme spoofing), `GHSA-xhq7-xmqj-769h` (Path normalization equivalence), `GHSA-wjr9-j795-jxcr` (Host canonicalization confusion), `GHSA-333x-w4r6-6crp` (Scheme injection).
   - *Resolution:* Lockfile upgrade to `3.1.9`.
3. **`hono` (4.13.12 → 4.13.19):**
   - *Advisories Patched:* `GHSA-4m76-xfj5-7975` (Mount path bypass), `GHSA-h7mg-cq63-vhpq` (RegExpRouter newline bypass), `GHSA-3gg2-335m-rxc6` (CSS template tag XSS), `GHSA-46wx-v44x-9hh2` (CSRF text/ping bypass), `GHSA-4h7h-rv7c-7m2v` (Multipart validator bypass).
   - *Resolution:* Lockfile upgrade to `4.13.19`.
4. **`ip-address` (10.7.3 → 10.7.6):**
   - *Advisories Patched:* `GHSA-rxp7-6hxx-x8q5` (Address6 quadratic parsing DoS).
   - *Resolution:* Lockfile upgrade to `10.7.6`.

### Advisory-by-Advisory Risk Assessment for Remaining 6 Vulnerabilities
| Package & Advisory | Severity | CWE / CVSS | Dependency Path | Production / Build Exposure | Compensating Controls & Disposition | Waiver Expiration |
| :--- | :---: | :---: | :--- | :--- | :--- | :---: |
| **`vite`**<br>`GHSA-698v-4r3x-3vcv`<br>`GHSA-r825-w8mm-5pxw`<br>`GHSA-587h-7wmj-h5pm` | High | CWE-77, 78, 88 | `vite` (direct devDependency) | **Zero Production Exposure.** Vite is solely used as a build-time bundler (`vite build`). The dev server and `launch-editor` CLI are not included in production or Vercel serverless images. | Precompiled static assets served on Vercel CDN; no server-side Vite execution in staging or production. | 30 Days (Next Vite minor bump) |
| **`vite`**<br>`GHSA-9jrq-w75r-8gcw`<br>`GHSA-rq7h-c2jc-7f22`<br>`GHSA-vfpm-58rq-9qcg` | Moderate / Low | CWE-22, 80, 200 | `vite` (direct devDependency) | **Zero Production Exposure.** Relates to local development middleware, `server.fs.allow` path checks, and WASM debug queries. | Local development environment only; production traffic never touches Vite dev server. | 30 Days (Next Vite minor bump) |
| **`e2b` / `undici8`**<br>`GHSA-4qv8-2p9j-2685`<br>`GHSA-xjj6-f33q-929c`<br>`GHSA-4w7w-5xrc-9h26` | High | CWE-20, 248, 400 | `e2b` → `undici8` | **Zero Production Exposure.** `e2b` is an optional agent sandboxing library used in experimental worker harnesses, not on the user request path. | Process timeouts and strict environment sandboxing; undici8 not imported by frontend or serverless endpoints. | 30 Days (Next e2b upstream bump) |
| **`glob`**<br>`GHSA-3g3m-2fjr-6pw4` | Moderate | CWE-400 | `e2b` → `glob` | **Zero Production Exposure.** Build/test filesystem traversal tool; not callable via external user inputs. | Read-only filesystem boundaries and bounded test timeouts. | 30 Days (Next e2b upstream bump) |
| **`minimatch`**<br>`GHSA-g3hv-75wg-m249` | Moderate | CWE-400 | `e2b` → `glob` → `minimatch` | **Zero Production Exposure.** Transitive build-time glob matcher. | Bounded regex matching; no user-provided glob pattern parsing in production. | 30 Days (Next e2b upstream bump) |
| **`re2js`**<br>`GHSA-gg6h-894w-4m9c` | High | CWE-400 (ReDoS) | `re2js` (dev-only parser utility) | **Zero Production Exposure.** Production regex execution relies exclusively on native V8 C++ RegExp with strict length bounds. | Native RegExp timeout guards in Node.js 24 runtime; re2js not reachable from HTTP endpoints. | 30 Days |

---

## 7. Comprehensive Verification Matrix

| Verification Gate | Command / Target | Result | Evidence / Details |
| :--- | :--- | :---: | :--- |
| **Fast CI / Typecheck** | `npx tsc --noEmit` | **PASS** | 0 compilation errors across entire monorepo |
| **Lint Audit** | `npm run lint` (oxlint) | **PASS** | 0 errors, 470 benign lint warnings |
| **Tracked Secrets Audit** | `npm run test:secrets` | **PASS** | 0 exposed credentials found across 1,050 tracked files |
| **Harness Security Lifecycle** | `test/test-harness-security-lifecycle.test.ts` | **PASS** | 9/9 tests pass (target validation, credential entropy, tracker cleanup) |
| **Staging Config Safety** | `test/staging-live-acceptance-config.test.ts` | **PASS** | 4/4 tests pass (production rejection, branch validation) |
| **Fail-Safe Backup/Restore** | `test/fail-safe-backup-restore.test.ts` | **PASS** | 30/30 tests pass (exact parity, constraint equivalence, bounded lock) |
| **Portable Escrow Recovery** | `test/portable-recovery-escrow.test.ts` | **PASS** | 15/15 tests pass (AES-256-GCM envelope, scrypt KDF, fail-closed) |
| **OAuth Positive Engine Unit Suite** | `npm run test:oauth-cert-engine` | **PASS** | 15/15 tests pass (includes observed logout & stale BFF cookie replay rejection) |
| **Negative OAuth Callback Certification** | `scripts/certify-staging-oauth-callbacks.ts` | **PASS** | Phases 1–4 pass (PKCE S256, signed state, 4/4 negative callback rejections) |
| **Dual Account Isolation (IDOR)** | `scripts/verify-staging-dual-account-isolation.ts` | **PASS** | Phases 1–5 pass (404 IDOR on conversation/memory, 403 on onboarding spoofing) |
| **Positive OAuth Code Exchange** | `scripts/certify-staging-oauth-callbacks.ts` (Phase 6) | **PASS** | Phases 6.1 (Google) and 6.2 (GitHub) pass with authentic session establishment, reload persistence, Free-tier entitlements, and observed revocation |
| **Remote PR #187 CI (Main / PR + E2E)** | Run `44043744461` | **PASS** | **All 3 jobs green at exact candidate SHA:**<br>• Fast CI in 3m21s (ID `133904273111`)<br>• Semantic Search CI in 50s (ID `133904273546`)<br>• Main / PR certification in 7m41s (ID `133905805617`), including Edge browser, Playwright responsive spectrum artifact `aira-responsive-local-44043744461-1`, and settings lifecycle E2E |
| **Remote PR #187 Disposable PG16** | Run `44043744306` / Job `133904274231` | **PASS** | 2m46s — isolated PG16 regression suite green |
| **Remote Unified Review Push CI** | Run `44041120250` | **PASS** | Fast CI (3m8s) & Semantic Search CI (52s) green on review branch push |
| **Remote Unified Review Initial CI** | Run `44040313478` | **PASS** | Fast CI (2m55s) & Semantic Search CI (50s) green on review branch push |
| **Remote Fast CI (PR #185 HEAD)** | Run `44029903228` / Job `133859050033` | **PASS** | Fast CI green on candidate PR #185 commit `3ec1947` |
| **Remote PG16 Certification** | Run `43905887568` / Job `133434466966` | **PASS** | 2m48s — isolated PG16 regression suite |
| **Remote Playwright E2E** | Run `43905887647` / Job `133436820341` | **PASS** | 7m7s — Edge, mobile, responsive viewports, settings modal, onboarding E2E |

---

## 8. Production Authorization Package & Release Protocol

### Release State: ALL PRE-DEPLOYMENT CERTIFICATION GATES PASSED — STRICT NO-GO FOR DEPLOYMENT WITHOUT EXPLICIT OWNER SIGN-OFF
All pre-deployment verification gates, automated CI checks, mandatory `Main / PR certification` E2E suites, disaster recovery rehearsals, observed session revocation proofs, and positive interactive OAuth certifications have passed with 100% green evidence.

Production execution remains strictly unauthorized pending explicit written owner sign-off across three independent, sequential gates:
1. **Gate 1 (Candidate Promotion):** Fast-forward or standard merge of the verified candidate from `review/candidate-pr185-pr186-unified-20261117` into `release/candidate-pr178-pr184-combined`.
2. **Gate 2 (Guarded Migration 032):** Execution of production migration 032 using bounded locks (`scripts/run-guarded-migration-032.ts`). Requires separate authorization following a fresh recoverability checkpoint.
3. **Gate 3 (Production Deployment):** Deployment to Vercel production (`https://aira-ai-2026.vercel.app`) and post-deployment smoke testing. Requires separate authorization following successful migration.

### Current Action Request: Gate 1 Authorization Only
To advance to candidate promotion without compromising production boundaries, the repository owner must explicitly grant Gate 1 authorization:

> **"Authorize promotion of the exact certified candidate SHA into `release/candidate-pr178-pr184-combined`."**

*(Gates 2 and 3 remain blocked and will receive separate approval requests at their respective milestones).*
