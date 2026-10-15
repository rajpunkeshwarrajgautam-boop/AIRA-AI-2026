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
- **Cookie Name**: `__Host-aira_auth_session`
- **Attributes**:
  - `HttpOnly`: Inaccessible to `document.cookie` or injected JavaScript.
  - `Secure`: Transmitted solely over TLS.
  - `SameSite=Strict`: Immune to cross-site request forgery in modern browsers.
  - `Path=/`: Scoped to the entire origin.
- **CSRF Defense**: Double-submit CSRF header (`X-AIRA-CSRF-TOKEN`) verified against an HMAC cookie, or strict origin validation via `Sec-Fetch-Site: same-origin`.

### 3.2 Vercel Edge Rewrite / Gateway Route
In `vercel.json` (or Express API `apps/api/src/index.ts`), proxy auth endpoints:
```json
{
  "rewrites": [
    {
      "source": "/api/auth/provider/:match*",
      "destination": "https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/:match*"
    }
  ]
}
```

---

## 4. Release Blocker Definition

Until the first-party BFF gateway proxy is configured and deployed to Vercel production infrastructure:
1. `localStorage` credential storage is certified for staging and pre-production evaluation with fail-closed concurrency and revocation enforcement.
2. Full production certification requires deploying the first-party BFF gateway proxy to prevent any client-side JavaScript access to long-lived session credentials.
3. This requirement is tracked as **RELEASE-BLOCKER-AUTH-001** for the final production deployment sign-off.
