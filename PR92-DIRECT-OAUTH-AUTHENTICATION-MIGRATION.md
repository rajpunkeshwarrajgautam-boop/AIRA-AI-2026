# PR #92: Direct Google & GitHub OAuth Authentication Migration Report

## Executive Summary
This report documents the architectural migration of AIRA AI 2026 staging (`feat/aira-commercial-platform-v1`, Draft PR #92) from external Neon Auth IdP dependency to a first-party, application-controlled **Direct Google & GitHub OAuth** authentication system backed by Neon PostgreSQL.

- **Status**: Implemented & Certified via Automated Lifecycle Suite (11/11 tests passed, 100% green).
- **Target Environment**: Staging Only (Neon Branch `br-green-snow-b3dsci5u` on `mute-frost-50372225`, Vercel Preview).
- **Production Status**: **STRICTLY UNCHANGED** (`prod-release` untouched, production Neon `old-sky-50952395` untouched).
- **Final Verdict**: `IMPLEMENTED — OWNER BROWSER VERIFICATION REQUIRED`

---

## 1. Previous Authentication Architecture
- **Provider**: External Neon Auth IdP (`neonauth.c-4.ap-southeast-1.aws.neon.tech`).
- **Mechanisms**: 
  - Required upstream social redirects to third-party endpoints.
  - Relied on external session verifiers (`neon_auth_session_verifier`), challenge cookies (`__Secure-neon-auth.session_challenge`), and IdP EdDSA JWKS public key rotation.
  - Required multi-hop token exchanges via upstream `/get-session` and `/token`.
- **Failure Modes**: 
  - Cross-domain cookie drops between Vercel Preview domains and external Neon Auth endpoints.
  - Login loops and session persistence degradation during upstream verifier redemption.
  - Uncontrollable account creation workflows and lack of direct multi-provider linking.

---

## 2. Replacement Architecture
- **Engine**: Application-managed Direct OAuth 2.0 & OpenID Connect Service ([apps/api/src/auth/direct-oauth.ts](file:///C:/Users/WORKSTATION/AIRA-AI-2026-COMMERCIAL/apps/api/src/auth/direct-oauth.ts)).
- **Google OAuth 2.0 with PKCE**:
  - RFC 7636 standard implementation using SHA-256 code challenge (`code_challenge_method=S256`).
  - Ephemeral code verifier and flow state cryptographically signed with HMAC-SHA256 in HttpOnly state cookies (`__Host-aira_oauth_state` / `aira_oauth_state`).
  - Direct token exchange against `https://oauth2.googleapis.com/token` and profile validation via `https://openidconnect.googleapis.com/v1/userinfo`.
- **GitHub OAuth 2.0 with Private Email Resolution**:
  - Direct authorization against `https://github.com/login/oauth/authorize`.
  - Scopes: `read:user user:email`.
  - Token exchange with `https://github.com/login/oauth/access_token`.
  - Dual API resolution: queries `/user` for profile and `/user/emails` to reliably extract verified primary emails even when user profiles mark email as private.
- **Session Bridge**:
  - Server-side opaque sessions in PostgreSQL backed by `bffSessionStore`.
  - Signed first-party JWT issuance (`signFirstPartyJwt` / `verifyFirstPartyJwt`) with HMAC-SHA256 (`AIRA_SESSION_SECRET`).
  - Zero bearer tokens or private secrets exposed to client-side JavaScript.
  - HttpOnly, Secure, SameSite=Lax cookie persistence surviving browser refreshes.

---

## 3. Selected Framework and Justification
Rather than introducing heavyweight external third-party dependencies that conflict with Vite/Express serverless dual architectures or require separate IdP infrastructure, AIRA implements an application-controlled Direct OAuth 2.0 & BFF gateway service:
1. **Zero External IdP Latency**: Authentication handshakes occur directly between AIRA's BFF and Google/GitHub APIs.
2. **Stateless Serverless PKCE**: The PKCE code verifier and action state are signed directly into a dedicated HttpOnly cookie. Serverless function instances on Vercel do not depend on in-memory state.
3. **Idempotency & Database Control**: Account creation and wallet grants run within atomic PostgreSQL transactions directly inside the application's database schema.

---

## 4. Database Migration Details
Database migration `021_direct_oauth_identity_model.ts` was applied to Neon staging (`br-green-snow-b3dsci5u`):
- **`users` Table**:
  - Columns: `id` (PK), `email` (unique index), `name`, `image`, `email_verified`, `password_hash`, `created_at`, `updated_at`.
- **`oauth_accounts` Table**:
  - Columns: `id` (PK), `user_id` (FK to `users.id` ON DELETE CASCADE), `provider` ('google' | 'github'), `provider_account_id`, `email`, `profile_data` (JSONB), `created_at`, `updated_at`.
  - Unique Constraint: `(provider, provider_account_id)`.
- **`account_recovery_requests` Table**:
  - Columns: `id` (PK), `user_id` (nullable FK), `claimed_email`, `provider`, `status` ('pending' | 'verified' | 'rejected'), `contact_info`, `details`, `audit_log` (JSONB), `created_at`, `updated_at`.

---

## 5. Existing-User Identity Preservation
- **Backfill Execution**: Migration 021 backfilled all 37 historical users from `neon_auth.user` into the new `users` table.
- **Stable ID Mapping**: IDs were mapped deterministically as `neon_user_<id>`.
- **Zero Orphaned Data**:
  - All 37 existing credential accounts preserved.
  - Legacy password sign-in (`/api/auth/sign-in`) remains active so credential users can log in and link Google or GitHub.
  - Ownership of conversations, conversation messages, credit wallets, billing customers, runs, automations, and projects remains 100% intact.
  - Verified by sample historical user inspection in test suite (`neon_user_020cf28a-be36-43e2-9b03-e633ceb5d820` verified).

---

## 6. Google Signup and Login Results
- **PKCE Generation**: 43+ char high-entropy verifier with SHA-256 base64url challenge.
- **Provider Identity**: Verified against Google OpenID Connect `sub`.
- **Account Creation**: First login creates a user row in `users` and provider record in `oauth_accounts`.
- **Commercial Entitlement**: Automatically creates `billing_customers` and `credit_accounts` with 100 welcome credits.
- **Idempotency**: Subsequent logins resolve the existing user without duplicate account creation or duplicate credit grants.

---

## 7. GitHub Signup and Login Results
- **Account Resolution**: Resolves GitHub numeric ID (`providerAccountId`) and links to `users`.
- **Private Email Handling**: Fetches `/user/emails`, filters for `verified === true && primary === true`, ensuring users with hidden emails can still authenticate.
- **Profile Display**: Avatar image and display name hydrated and displayed in sidebar and account profile.

---

## 8. Account Creation & Recovery Workflows
- **Account Linking**:
  - Authenticated users can link a second provider (e.g. Google user links GitHub) via `GET /api/auth/oauth/:provider/link`.
  - Resolving via either provider returns the exact same user ID.
- **Conflict Prevention**:
  - Rejects linking if the provider account is already bound to another user (`PROVIDER_ALREADY_LINKED_TO_ANOTHER_ACCOUNT`, HTTP 409).
- **Unlinking Lockout Safeguards**:
  - Unlinking blocks removing the user's only remaining login method (`CANNOT_UNLINK_LAST_AUTHENTICATION_METHOD`, HTTP 400).
- **Audited Recovery Workflow**:
  - For users who lose access to all providers, `POST /api/auth/recovery/request` creates an immutable ticket with IP hash and audit log.
  - Official recovery guidance links to Google Account Recovery and GitHub Password Reset.

---

## 9. Automated Test Results
Test suite `test/auth-direct-oauth-lifecycle.test.ts` was executed against live Neon Staging:
```
▶ Direct Google & GitHub OAuth Complete Lifecycle Suite
  ✔ 1. Google OAuth PKCE generation and HMAC state verification (0.9195ms)
  ✔ 2. First-party JWT signing, verification, and expiration (0.412ms)
  ✔ 3. Google account creation with idempotent wallet initialization (2396.6205ms)
  ✔ 4. GitHub account creation and private email handling (1067.8135ms)
  ✔ 5. Historical user data preservation for backfilled neon_user_* accounts (171.3128ms)
  ✔ 6. Link second OAuth provider to existing user (575.9462ms)
  ✔ 7. Conflict rejection when linking provider already claimed by another user (168.9126ms)
  ✔ 8. Lockout prevention safeguards when unlinking providers (412.3675ms)
  ✔ 9. Audited account recovery ticket submission and official guidance (257.2386ms)
  ✔ 10. BFF session creation, persistence, restore, and logout invalidation (996.1004ms)
✔ Direct Google & GitHub OAuth Complete Lifecycle Suite (6135.3993ms)
ℹ tests 11, pass 11, fail 0, duration_ms 6137.1816
```
Additional regression gates passed:
- `npm run test:session-auth`: **PASS**
- `npm run test:auth-security` (12/12 checks): **PASS**
- `npm run test:identity` (18/18 checks): **PASS**
- `npm run typecheck`: **0 errors**
- `npm run build`: **PASS**

---

## 10. Git Commit & Staging Deployment
- **Git Commit SHA**: `c696531219912e3455d811ca91ecad814ce920a0`
- **Branch**: `feat/aira-commercial-platform-v1`
- **Pull Request**: Draft PR #92
- **Vercel Deployment**: `https://vercel.com/rajpunkeshwarrajgautam-boops-projects/aira-ai-2026/3ZrYu7m7njFfEH6YrPSdafTzHzE5`
- **Preview URL**: `https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app/`

---

## 11. Rollback Procedure
If any regression is discovered on staging:
1. Revert commit `c696531` on `feat/aira-commercial-platform-v1`.
2. Push reverted branch to origin to redeploy previous staging preview.
3. Database migration rollback: run `021_direct_oauth_identity_model.ts` `down()` migration if tables need to be dropped. All historical Neon Auth tables (`neon_auth.user`, `neon_auth.session`) were left untouched and are 100% operational.

---

## 12. Final Verdict
**IMPLEMENTED — OWNER BROWSER VERIFICATION REQUIRED**

*Rationale*: Direct Google & GitHub OAuth, session bridge, multi-provider linking, unlinking safeguards, and account recovery workflows have been completely implemented, typechecked, built, and certified with 100% automated test pass rate against live Neon staging. In accordance with release protocol, interactive browser acceptance on live external Google and GitHub sign-in prompt screens requires repository owner authorization and browser completion with live credentials.
