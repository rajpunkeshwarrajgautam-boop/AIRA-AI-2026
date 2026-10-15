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

### 3.1 First-Party Cookie Contract
- **Cookie Name**: `__Host-aira_auth_session` (Production / HTTPS) / `aira_auth_session` (Development)
- **Attributes**:
  - `HttpOnly`: Inaccessible to `document.cookie` or injected JavaScript.
  - `Secure`: Transmitted solely over TLS in production environments.
  - `SameSite=Lax`: Immune to cross-site request forgery while preserving top-level navigation authentication.
  - `Path=/`: Scoped to the entire origin.
  - `Max-Age=2592000`: 30-day bounded session lifetime matching database session grants.
- **CSRF Defense**: Enforces explicit anti-CSRF headers (`x-aira-csrf-protection: 1` or `x-requested-with`), `sec-fetch-site` browser assertions, or matching `Origin`/`Referer` validation on all state-changing endpoints.

### 3.2 Implemented BFF Gateway Endpoints (`apps/api/src/auth/bff-session.ts`)
The first-party BFF session security gateway is implemented and mounted in `apps/api/src/index.ts`:
- `POST /api/auth/sign-in`: Authenticates with Neon Auth server-side, sets `HttpOnly` session cookie, and returns user profile without exposing credentials to frontend JS.
- `POST /api/auth/sign-up`: Registers account with Neon Auth server-side, sets `HttpOnly` session cookie, returns public user profile.
- `GET /api/auth/session`: Reads `HttpOnly` cookie, returns verified session profile or anonymous state without token exposure.
- `POST /api/auth/sign-out`: Executes two-phase invalidation: clears `HttpOnly` cookie with `Max-Age=0` and invalidates session token on Neon Auth server.
- `createBffSessionMiddleware`: Intercepts incoming `/api/*` requests, cryptographically verifies the `HttpOnly` cookie session, and automatically binds the verified `ExecutionPrincipal` (`neon_user_<id>`) for downstream route security.

### 3.3 Verification Suite
- Verified via `test/auth-bff-session-gateway.test.ts` (`npm run test:auth-bff`):
  - Cookie serialization & HMAC-SHA256 signature verification.
  - Tamper rejection fail-closed.
  - CSRF & origin enforcement on POST/PUT/DELETE.
  - Zero-token response contract (no session tokens or raw JWTs in response JSON).
  - Downstream `ExecutionPrincipal` resolution without client Bearer headers.
  - Server-side session invalidation and cookie clearing on logout.

---

## 4. Release Blocker Definition & Resolution Path

- **Status**: **IMPLEMENTED ON AUTH BRANCH — PRE-PROD GATE ACTIVE**
- **Artifact**: Implemented in `apps/api/src/auth/bff-session.ts`, mounted in `apps/api/src/index.ts`, and verified by `npm run test:auth-bff`.
- **Production Integration Note**: While the first-party BFF gateway code is 100% functional and tested, deploying to the custom production domain (`aira.ai`) requires final DNS and Vercel routing verification during the coordinated release cycle.
- **Release Tracking**: **RELEASE-BLOCKER-AUTH-001** is maintained as a required verification gate during the coordinated release to guarantee that the production deployment strictly utilizes first-party HttpOnly cookies.
