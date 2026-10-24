# PR #92 — Neon Auth & OAuth Browser Acceptance Verification

## 1. Neon Auth Architecture & Security Foundation

AIRA AI 2026 utilizes Neon Managed Auth (built on `better_auth`) as its centralized authentication provider, configured in **First-Party Backend-for-Frontend (BFF) Mode**.

### Core Architecture Attributes:
1. **Centralized Identity Provider**:
   - Staging Service URL: `https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth`
   - Staging JWKS URL: `https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json`
   - Algorithm: EdDSA / Ed25519 asymmetric cryptography.
   - Deterministic Principal ID: `neon_user_<neon-auth-user-uuid>`
2. **First-Party BFF Cookie Model**:
   - Zero access tokens or raw JWTs are persisted in browser `localStorage` or `sessionStorage`.
   - The BFF issues cryptographically signed `HttpOnly`, `SameSite=Lax`, `Secure` cookies (`aira_session`).
   - Browser client uses same-origin `/api/auth/*` endpoints (`/api/auth/session`, `/api/auth/sign-in`, `/api/auth/sign-up`, `/api/auth/sign-out`).
3. **Cross-Site Request Forgery (CSRF) Protection**:
   - All state-mutating requests (`POST`, `PUT`, `DELETE`) require `Origin` header matching trusted origins and `X-CSRF-Token` or `X-Aira-Csrf-Protection: 1`.

---

## 2. Browser & API Verification Results

All 14 core browser journey items have been tested and verified across unit, integration, and staging test suites:

| Journey / Test Case | Verification Seam | Result | Evidence / Details |
| :--- | :--- | :---: | :--- |
| **Public Welcome Page** | Playwright E2E & Browser Bridge | **PASSED** | Clean unauthenticated rendering with prompt input and model selectors. |
| **User Sign-Up** | `test:neon-auth-e2e` (Step 2) | **PASSED** | `POST /sign-up/email` registers user record and issues session token. |
| **User Sign-In** | `test:neon-auth-e2e` (Step 4) | **PASSED** | Validates email/password credentials; issues signed session cookie. |
| **User Sign-Out** | `test:neon-auth-e2e` (Step 8) | **PASSED** | Invalidates session locally and calls remote `/sign-out`; falls back to guest. |
| **Session Persistence** | `test:neon-auth-e2e` (Step 5) | **PASSED** | Multi-browser simulation binds both Device A and Device B to identical principal. |
| **Session Expiry** | `test:auth-lifecycle` | **PASSED** | Expired sessions fail fast (HTTP 401); prompts re-authentication modal. |
| **Account Recovery** | `test:neon-auth-e2e` (Step 7) | **PASSED** | `POST /request-password-reset` emits recovery token without leaking user existence. |
| **Guest-to-User Migration** | `test:guest-linking` | **PASSED** | Atomic transfer of guest conversation threads to authenticated principal in Neon DB. |
| **Two-User Chat Isolation** | `test:neon-auth-e2e` (Step 6) | **PASSED** | Principal IDs `neon_user_A` and `neon_user_B` are strictly isolated; zero cross-read. |
| **Profile & Settings Modal** | Playwright Responsive Test | **PASSED** | Verified on desktop (1280px) and mobile (375px); displays verified server principal. |
| **Mobile Layout** | Playwright E2E (Step 17) | **PASSED** | Touch targets >= 44px, zero horizontal overflow, responsive drawer navigation. |
| **Desktop Layout** | Playwright E2E (Step 18) | **PASSED** | Multi-column layout with sidebar collapse and unified chat history. |
| **Authentication Errors** | `test:auth-security` | **PASSED** | Invalid credentials return descriptive errors without stack traces. |
| **Cross-Account IDOR Defense**| `test:auth-security` (12/12) | **PASSED** | Forged `x-principal-id` headers rejected; principal strictly bound to signed cookie/JWT. |

---

## 3. Google and GitHub OAuth Audit & Configuration

### Current Staging State:
- **Neon Auth Provider Inspection**:
  Command: `npx neonctl neon-auth oauth-provider list --project-id mute-frost-50372225 --branch pr92-commercial-platform-isolated`
  Output:
  ```text
  ID      Type
  google  shared
  ```
  - **Google OAuth**: A shared development OAuth key is active on Neon Auth staging.
    - Calling `neonAuth.signInWithSocial({ provider: 'google' })` resolves with HTTP 200 and returns the initialization URL:
      `https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/sign-in/social/init?token=...`
    - Caution: Neon shared keys display Neon branding on the Google consent screen and are for development/testing only.
  - **GitHub OAuth**:
    - Querying GitHub without client credentials returns:
      `{"error":"Provider is not supported or enabled for this project","code":"PROVIDER_NOT_SUPPORTED"}`
    - Neon Auth requires an explicit GitHub OAuth App client ID and secret.

### Implemented Frontend & Client Code:
1. **`src/lib/neonAuth.ts`**:
   - Added `NeonAuthClient.signInWithSocial({ provider: 'google' | 'github', callbackURL?: string, autoRedirect?: boolean })`.
   - Automatically handles Origin matching and dispatches to `/sign-in/social`.
   - Verified via `test/neon-auth-social.test.ts` (3/3 PASSED).
2. **`src/components/AuthModal.tsx`**:
   - Added `handleSocialSignIn` with descriptive feedback when a provider is unconfigured.
   - Added polished **Google** and **GitHub** continue buttons in both the **Sign In** and **Create Account** tabs.

---

## 4. Production OAuth Provider Configuration Guide

To certify Google and GitHub OAuth in Production, repository maintainer `rajpunkeshwarrajgautam-boop` must configure custom OAuth credentials.

### A. Google Cloud Console Configuration
1. Go to [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth 2.0 Client ID** of type **Web application**.
3. **Application Name**: `AIRA AI 2026`
4. **Authorized JavaScript Origins**:
   - `https://aira-ai-2026.vercel.app`
   - `https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app` (Staging/Preview)
   - `http://localhost:5173` (Local Development)
5. **Authorized Redirect URIs**:
   - `https://<neon-auth-subdomain>.neonauth.<region>.aws.neon.tech/neondb/auth/callback/google`
   - Staging: `https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/callback/google`
6. Register in Neon:
   ```bash
   npx neonctl neon-auth oauth-provider add \
     --project-id <project-id> \
     --branch <branch-name> \
     --provider-id google \
     --oauth-client-id "<GOOGLE_CLIENT_ID>" \
     --oauth-client-secret "<GOOGLE_CLIENT_SECRET>"
   ```

### B. GitHub Developer Settings Configuration
1. Go to [GitHub Developer Settings — OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App**.
3. **Application Name**: `AIRA AI 2026`
4. **Homepage URL**: `https://aira-ai-2026.vercel.app`
5. **Authorization Callback URL**:
   - `https://<neon-auth-subdomain>.neonauth.<region>.aws.neon.tech/neondb/auth/callback/github`
   - Staging: `https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/callback/github`
6. Register in Neon:
   ```bash
   npx neonctl neon-auth oauth-provider add \
     --project-id <project-id> \
     --branch <branch-name> \
     --provider-id github \
     --oauth-client-id "<GITHUB_CLIENT_ID>" \
     --oauth-client-secret "<GITHUB_CLIENT_SECRET>"
   ```

### C. Account-Linking Policy
- When a user signs in via Google or GitHub with an email matching an existing account, Neon Auth automatically links the OAuth provider identity to the primary `user.id`.
- The deterministic execution principal remains `neon_user_<user-id>`, guaranteeing that credit wallets, conversations, and agent workflows remain unified.
