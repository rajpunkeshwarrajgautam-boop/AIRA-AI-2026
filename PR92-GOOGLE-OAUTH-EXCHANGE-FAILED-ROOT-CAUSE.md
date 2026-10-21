# PR #92 — Google OAuth `exchange_failed` Root-Cause Diagnosis & Remediation Report

**Date:** 2026-10-20  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Workspace:** `C:\Users\WORKSTATION\AIRA-AI-2026-COMMERCIAL`  
**Branch:** `feat/aira-commercial-platform-v1`  
**Draft PR:** #92  
**New Candidate Commit SHA:** `1fd1baec2d433a490217ccfc285a170a160e753b`  
**Preview Deployment ID:** `dpl_nsc2EKCqeN5mLxeWANxFe7goXTKQ`  
**Preview URL:** [https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app](https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app/)  
**Neon Staging Project:** `mute-frost-50372225`  
**Neon Staging Branch:** `pr92-commercial-platform-isolated` (`br-green-snow-b3dsci5u`)  

---

## 1. Executive Summary & Status

- **Status:** **REMEDIATION IMPLEMENTED & PREVIEW DEPLOYED — OWNER-ASSISTED REAL BROWSER ACCEPTANCE REQUIRED**
- **Prior Symptom:** Microsoft Edge completed Google OAuth authorization, but was redirected to `/?auth_error=exchange_failed`, leaving AIRA in Guest mode.
- **Root Cause Isolated:**
  1. `handleBffOAuthGoogleStart` initiated OAuth via Neon Auth `POST /sign-in/social`, but discarded upstream `Set-Cookie` challenge headers (`__Secure-neon-auth.session_challenge`). The browser therefore lacked the cryptographic challenge cookie when returning from Google.
  2. `handleBffOAuthGoogleCallback` did not redeem the one-time `neon_auth_session_verifier` through Neon Auth's primary authority `/get-session` endpoint. Instead, it performed a heuristic timestamp query against PostgreSQL `neon_auth.session` and extracted the raw database token.
  3. Passing the raw database token to Neon Auth `/token` resulted in HTTP 401 Unauthorized (`{"message":"Unauthorized","code":"UNAUTHORIZED"}`) because Better Auth / Neon Auth requires the HMAC-signed session cookie or an active session exchange.
  4. The 401 exception was caught by `handleBffOAuthGoogleCallback`, causing HTTP 302 redirect to `/?auth_error=exchange_failed`.
- **Remediation:**
  1. Updated `handleBffOAuthGoogleStart` to forward and normalize upstream `__Secure-neon-auth.session_challenge` cookies to the first-party domain.
  2. Updated `handleBffOAuthGoogleCallback` to redeem `neon_auth_session_verifier` via Neon Auth `/get-session`, forwarding the request's challenge cookies.
  3. Captured the signed `__Secure-neon-auth.session_token` cookie and session data directly from Neon Auth's primary authority response.
  4. Issued EdDSA JWT via Neon Auth `/token` using the authenticated session and verified cryptographic signature against live JWKS.
  5. Established first-party signed HttpOnly BFF session (`__Host-aira_auth_session`) and redirected to `/?auth_success=1`.
- **Release Gating:** In strict adherence to repository release rules, **GOOGLE OAUTH FULLY VERIFIED** is withheld until the owner performs the live sign-in test in Microsoft Edge and confirms persistent authentication after refresh.

---

## 2. Sanitized Vercel Execution Evidence

Live runtime function logs captured via Vercel CLI from production preview functions:

```text
21:17:57.08 error λ GET /api/auth/oauth/google/callback
[API_REQ] GET /api/auth/oauth/google/callback?flowId=[REDACTED]&neon_auth_session_verifier=[REDACTED]
[handleBffOAuthGoogleCallback] Error completing OAuth handoff: Failed to obtain JWT from Neon Auth (401): {"message":"Unauthorized","code":"UNAUTHORIZED"}

21:23:20.72 error λ GET /api/auth/oauth/google/callback
[API_REQ] GET /api/auth/oauth/google/callback?flowId=[REDACTED]&neon_auth_session_verifier=[REDACTED]
[handleBffOAuthGoogleCallback] Error completing OAuth handoff: Failed to obtain JWT from Neon Auth (401): {"message":"Unauthorized","code":"UNAUTHORIZED"}
```

Database inspection on Neon staging (`pr92-commercial-platform-isolated`) established that Google OAuth had successfully created the user and session in Neon Auth:
```text
User: id=3aea147c-fc80-4ad4-9df8-df2f5c07c91a, email=antigravitypower490@gmail.com, name=elliot anderson
Session: id=490c9618-3dd5-4c7e-93d5-153e89765416, token=L6ZnYq3Rs5...
Account: providerId=google, accountId=109885171219226843992
Verification: identifier=ZZJgy2QfV3pP5NMO (one-time verifier)
```

However, calling Neon Auth `/token` with the raw database token string returned 401 Unauthorized because Better Auth requires the signed cookie issued during verifier exchange.

---

## 3. Confirmed Neon Auth / Better Auth Handoff Contract

Analysis of `@neondatabase/auth` package specification and live endpoint probing confirmed:

1. **Initiation (`POST /sign-in/social`):**
   - Body: `{ provider: 'google', callbackURL: '...' }`
   - Response: Status 200 with `{ url: 'https://.../init?token=...' }`
   - Response Headers:
     `Set-Cookie: __Secure-neon-auth.session_challenge=<challenge_hash>.<sig>; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`
     `Set-Cookie: __Secure-neon-auth.session_challange=<challenge_hash>.<sig>; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`
   - *Requirement:* These challenge cookies MUST be forwarded to the client browser on the first-party domain.

2. **Google OAuth & Redirect to Callback:**
   - User consents in Google.
   - Google redirects to Neon Auth (`.../auth/callback/google?code=...`).
   - Neon Auth stores a verification record in `neon_auth.verification` (`identifier: <verifier>`).
   - Neon Auth redirects the browser to `callbackURL` with query parameter:
     `?flowId=<first_party_flow_id>&neon_auth_session_verifier=<verifier>`
   - Browser sends `Cookie: __Secure-neon-auth.session_challenge=...` along with first-party flow cookie.

3. **Verifier Redemption (`GET /get-session`):**
   - Request: `GET ${baseUrl}/get-session?neon_auth_session_verifier=${verifier}`
   - Header: `Cookie: __Secure-neon-auth.session_challenge=...`
   - Primary Authority Validation:
     - Neon Auth validates that `session_challenge` matches the verification record for `neon_auth_session_verifier`.
     - Deletes the verification record from `neon_auth.verification` (anti-replay).
     - Response: Status 200 with `{ session: { id, userId, token, ... }, user: { id, email, name, image, ... } }`.
     - Response Headers: `Set-Cookie: __Secure-neon-auth.session_token=<signed_session_token>`.

4. **Cryptographic JWT Issuance & BFF Binding (`GET /token`):**
   - Request: `GET ${baseUrl}/token`
   - Headers: `Authorization: Bearer ${session.token}`, `Cookie: __Secure-neon-auth.session_token=${signed_token}`
   - Response: Status 200 with `{ token: <EdDSA_JWT> }`.
   - Neon Auth verifies EdDSA signature against live JWKS (`verifyNeonAuthToken`).
   - First-party BFF issues signed HttpOnly cookie: `__Host-aira_auth_session`.

---

## 4. Remediation Implementation Details

### Files Modified

1. **[`apps/api/src/auth/bff-session.ts`](file:///c:/Users/WORKSTATION/AIRA-AI-2026-COMMERCIAL/apps/api/src/auth/bff-session.ts):**
   - Added `sanitizeUpstreamCookie()` helper to strip `Partitioned` and normalize `SameSite=None` to `SameSite=Lax` for reliable top-level GET return navigation.
   - In `handleBffOAuthGoogleStart`:
     - Extracted `upstreamRes.headers.getSetCookie()` from Neon Auth `/sign-in/social` response.
     - Forwarded `__Secure-neon-auth.session_challenge` and legacy challenge cookies to client response.
   - In `handleBffOAuthGoogleCallback`:
     - Extracted `neon_auth_session_verifier` from `req.query`.
     - Replaced heuristic database timestamp query with direct call to Neon Auth `GET /get-session?neon_auth_session_verifier=...`, forwarding incoming browser cookies.
     - Handled non-2xx responses with structured, sanitized error logging.
     - Captured signed session cookie headers and session token directly from Neon Auth response.
     - Passed authenticated credentials to `fetchNeonJwtFromServer` and verified JWT principal.
     - Minted first-party BFF session and redirected to `/?auth_success=1`.

2. **[`test/auth-oauth-verifier-redemption.test.ts`](file:///c:/Users/WORKSTATION/AIRA-AI-2026-COMMERCIAL/test/auth-oauth-verifier-redemption.test.ts):**
   - Created comprehensive regression suite testing:
     - Forwarding of challenge cookies from `/sign-in/social`.
     - Redemption of `neon_auth_session_verifier` via `/get-session`.
     - Handling of missing or mismatched challenge cookies (HTTP 400).
     - Full EdDSA JWT issuance and first-party BFF session creation.

---

## 5. Automated Verification Results

| Gate | Command | Result | Details |
|---|---|---|---|
| **TypeScript Typecheck** | `npm run typecheck` | **PASS** | `tsc --noEmit` exited 0 with zero errors |
| **Linter** | `npm run lint` | **PASS** | `0 errors`, 170 non-blocking warnings |
| **New Contract Test** | `npx tsx test/auth-oauth-verifier-redemption.test.ts` | **PASS** | 3/3 subtests passed |
| **Regression Suite** | `npx tsx test/auth-google-oauth-loop-remediation.test.ts` | **PASS** | 12/12 subtests passed |
| **Production Build** | `npm run build` | **PASS** | `vite build` completed in 998ms |
| **Live Preview Start Probe** | `POST /api/auth/oauth/google/start` | **PASS** | HTTP 200, `__Host-aira_oauth_flow` & `__Secure-neon-auth.session_challenge` confirmed present |

---

## 6. Live Preview Verification & Action Required

- **Preview Deployment ID:** `dpl_nsc2EKCqeN5mLxeWANxFe7goXTKQ`
- **Live Preview URL:** [https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app](https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app/)

### Owner-Assisted Browser Acceptance Procedure (Microsoft Edge)

1. Open Microsoft Edge and navigate to:
   `https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app/`
2. Click **Sign in** / **Continue with Google**.
3. Select your Google account (`antigravitypower490@gmail.com`).
4. Complete consent and observe the redirect back to AIRA.
5. **Expected Result:**
   - URL lands on `/?auth_success=1` (NOT `/?auth_error=exchange_failed`).
   - Profile avatar and name **elliot anderson** (`antigravitypower490@gmail.com`) display in top right corner.
   - User mode changes from "Guest" to authenticated user.
   - Refreshing the page preserves authentication (`GET /api/auth/session` returns `200 AUTHENTICATED`).
   - Clicking Sign Out terminates session and returns to clean Guest mode.
