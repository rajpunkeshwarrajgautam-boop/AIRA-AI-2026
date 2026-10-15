# AIRA AI 2026 — Authentication Session Security Architecture & BFF Migration Design

**Document ID**: `AIRA-AUTH-SEC-2026-001`  
**Classification**: Core Security Architecture  
**Author**: Principal Authentication Architect & Application Security Engineer  
**Status**: APPROVED DESIGN — INFRASTRUCTURE MIGRATION CONTRACT  

---

## 1. Executive Summary & Problem Statement

AIRA AI 2026 integrates with Neon's Managed Better Auth service for persistent user identity. In the current deployment topology:
- **Frontend Origin**: `https://aira-ai-2026.vercel.app` (or `localhost:5173`)
- **Neon Auth Provider Origin**: `https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth`

Because Neon Auth resides on a third-party apex domain relative to the frontend, browser security policies (Safari Intelligent Tracking Prevention, Chrome third-party cookie phaseout, Firefox Enhanced Tracking Protection, and Brave Shields) partition or block third-party cookies (`SameSite=None; Secure`). Consequently, client-side session management currently persists session tokens and EdDSA JWTs in browser `localStorage` (`aira_neon_auth_session_v1`).

While client-side hardening (monotonic `authEpoch`, session-bound `activeRefresh`, in-flight `AbortController` cancellation, and post-response revalidation) completely eliminates concurrency races, token refresh collisions, and silent guest fallbacks, **storing long-lived bearer session credentials in `localStorage` increases exposure to client-side script injection (XSS)**.

---

## 2. Server-Side Revocation vs. Client Storage Purge

A critical security principle is distinguishing **local credential removal** from **authoritative server-side session revocation**:

1. **Local Client Purge**:
   - Calling `localStorage.removeItem('aira_neon_auth_session_v1')` merely deletes the local copy of the token.
   - If an attacker has exfiltrated the session token prior to logout, or if the token is restored from browser backup/cache, the token remains cryptographically valid on the server unless explicitly revoked.

2. **Authoritative Server Revocation**:
   - In `src/lib/neonAuth.ts`, `signOut()` and `revokeSession()` now execute a two-phase protocol:
     - **Phase 1 (Immediate Isolation)**: `saveSession(null)` purges local storage, increments `authEpoch`, and calls `abortActiveRequests()` to terminate all in-flight network sockets.
     - **Phase 2 (Remote Invalidation)**: Issues an authenticated `POST /sign-out` to `${this.baseUrl}/sign-out` transmitting the session token. Neon Auth removes the session record from the PostgreSQL `session` table.
   - **Revocation Resilience**: If an expired or revoked session token is restored into `localStorage`, `getValidJwt()` encounters HTTP 401 from `${this.baseUrl}/token`, immediately detects revocation, purges the restored session via `this.saveSession(null)`, and throws `AuthenticationRequiredError`.

---

## 3. Target Production Architecture: First-Party BFF Gateway

To achieve zero-JavaScript-credential exposure, the production deployment must adopt a **Backend-For-Frontend (BFF)** architecture:

```
[ Browser / Single-Page App ]
              │
              │  First-Party Same-Origin Requests
              │  Cookie: __Host-aira_session; HttpOnly; Secure; SameSite=Strict
              ▼
[ First-Party API / Vercel Edge Gateway (/api/auth/*) ]
              │
              │  Internal HTTPS / Private Network
              │  Authorization: Bearer <neon_session_token>
              ▼
[ Neon Managed Better Auth Service (AWS ap-southeast-1) ]
              │
              │  PostgreSQL Execution Principal Binding
              ▼
[ Staging / Production Neon PostgreSQL ]
```

### 3.1 First-Party Opaque Session Cookie Contract
- **Architecture**: Opaque server-held session identifier backed by server-side `BffSessionStore`.
- **Payload**: Opaque cryptographically random 32-byte identifier signed with HMAC-SHA256 (`${sessionId}.${signature}`). Raw session tokens and JWTs are NEVER stored inside cookies.
- **Cookie Name**: `__Host-aira_auth_session` (Production / HTTPS) / `aira_auth_session` (Development)
- **Attributes**:
  - `HttpOnly`: Inaccessible to `document.cookie` or injected JavaScript.
  - `Secure`: Transmitted solely over TLS in production environments.
  - `SameSite=Lax`: Immune to cross-site request forgery while preserving top-level navigation authentication.
  - `Path=/`: Scoped to the entire origin.
  - `Max-Age=2592000`: 30-day bounded session lifetime matching database session grants.
- **CSRF Defense**:
  - Unconditional rejection of `Sec-Fetch-Site: cross-site`.
  - Strict `Origin` and `Referer` validation against the incoming `Host` and explicit trusted allowlist (`AIRA_TRUSTED_ORIGINS`).
  - Mismatched origins are REJECTED even if custom headers are present.
  - Cryptographic session-bound CSRF token (`X-CSRF-Token`) validated via constant-time comparison on all state-changing mutations.

### 3.2 Implemented BFF Gateway Endpoints (`apps/api/src/auth/bff-session.ts`)
The first-party BFF session security gateway is implemented and mounted in `apps/api/src/index.ts`:
- `POST /api/auth/sign-in`: Authenticates with Neon Auth server-side, stores session in `BffSessionStore`, sets opaque `HttpOnly` cookie, and returns user profile + session CSRF token without exposing credentials to frontend JS.
- `POST /api/auth/sign-up`: Registers account with Neon Auth server-side, stores session, sets opaque `HttpOnly` cookie, returns user profile + CSRF token.
- `GET /api/auth/session`: Reads opaque cookie, validates session in server store, returns verified profile and fresh CSRF token without token exposure.
- `POST /api/auth/sign-out`: Executes two-phase invalidation: revokes session in `BffSessionStore`, clears cookie with `Max-Age=0`, and invalidates session token on Neon Auth server.
- `createBffSessionMiddleware`: Intercepts incoming `/api/*` requests, resolves opaque cookie against `BffSessionStore`, verifies mutual consistency between JWT subject and stored user ID, and binds verified `ExecutionPrincipal` (`neon_user_<id>`). Fails closed and purges session on subject mismatch.

### 3.3 Verification Suite
- Verified via `test/auth-bff-session-gateway.test.ts` (`npm run test:auth-bff`):
  - Opaque cookie architecture and server-side store ownership.
  - BFF cookie attributes strictly conform to security requirements.
  - Strict origin allowlist and session-bound CSRF token validation.
  - Zero-token response contract (no credentials in JSON).
  - Downstream `ExecutionPrincipal` resolution with mutual subject validation.
  - Two-phase session invalidation and cookie clearing on logout.
  - Production fail-closed behavior when `NEON_AUTH_BASE_URL` is omitted.
- Verified via `test/auth-identity-transition-lifecycle.test.ts` (`npm run test:auth-lifecycle`):
  - Client BFF mode with same-origin authentication and CSRF headers.
  - Complete elimination of session tokens and JWTs from browser `localStorage`.
  - SSE stream cancellation and monotonic `authEpoch` preservation.

---

## 4. Release Blocker Definition & Resolution Certification

- **Status**: **RESOLVED & CERTIFIED ON AUTH BRANCH** (`feat/staging-neon-auth-verified-principal-20261014`)
- **Blocker ID**: `RELEASE-BLOCKER-AUTH-001`
- **Resolution Artifacts**:
  1. `apps/api/src/auth/bff-session.ts`: Opaque session store (`BffSessionStore`), constant-time CSRF tokens, strict origin validation, production fail-closed configuration.
  2. `apps/api/src/index.ts`: Configured with strict credentialed CORS and trusted origin allowlisting.
  3. `src/lib/neonAuth.ts`: Full browser client migration to same-origin first-party BFF mode, zero-token `localStorage`, and legacy token purging.
  4. `src/App.tsx`: Automatic session restoration on initial mount via HttpOnly cookie.
- **Verification Evidence**:
  - `npm run test:auth-bff`: 7/7 PASS
  - `npm run test:auth-lifecycle`: 10/10 PASS
  - `npm run test:auth-token-race`: 5/5 PASS
  - `npm run test:auth-fail-closed`: 5/5 PASS
  - `npm run test:secrets`: PASS (0 credential exposures across 246 files)
  - `npm run test:neon-auth-e2e`: 10/10 PASS against live Staging Better Auth
  - `npm run test:reality`: 15/15 PASS
  - `npm run typecheck`: PASS (0 errors)
  - `npm run build`: PASS (Vite production build cleanly compiled)
- **Verdict**: Certified for coordinated release integration into `prod-release`.

