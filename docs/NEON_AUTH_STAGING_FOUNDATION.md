# AIRA AI 2026 — Persistent Account Identity (staging workstream)

## Current state and boundaries

The existing AIRA production authentication is a *signed anonymous browser
session*, not a recoverable user account. The frontend Firebase module contains
demo fallback configuration and does not constitute production Firebase login.

The staging Neon database only has now been configured with **Managed Better
Auth** (Neon Auth). The production Neon project and Vercel environment were
not changed.

- Staging Neon project: `mute-frost-50372225`
- Staging branch: `br-soft-pine-b3gw5nyr`
- Auth provider: `better_auth`
- Base URL (not a secret):
  `https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth`
- JWKS URL (not a secret):
  `https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json`

## What this PR implements

- Opt-in `AIRA_EXTERNAL_AUTH_ENABLED=true` API middleware.
- Cryptographic verification of signed Neon JWTs with trusted issuer/JWKS.
- Rejects invalid, forged, expired and anonymous tokens.
- Deterministic stable server principal `neon_user_<verified-sub>`.
- Different authenticated users receive distinct principals.
- Guest cookie behavior remains unchanged while auth is disabled.
- Test with locally generated key pairs (no production provider credentials).

## What still must happen BEFORE claiming cross-device login is complete

1. Add the official `@neondatabase/auth` React client SDK in a separate
   reviewed PR and commit a valid npm lockfile update.
2. Build accessible login, registration, logout, recovery, loading/error states.
3. Connect user auth sessions to all API calls with verified JWT tokens,
   keeping AIRA's internal principal spoofing guards unchanged.
4. Verify production-friendly session refresh and revocation. Do not upgrade
   an anonymous guest cookie to an authenticated account without checking
   identity ownership.
5. Design *explicit, reversible account linking* for guest conversations,
   projects, automations, knowledge and agent histories. Never transfer data
   simply because two browsers claim the same email.
6. Test two different browsers logging into the SAME real staging account:
   the server must return the same principal and only that account's records.
7. Test two DIFFERENT accounts and prove mutual isolation across all APIs.
8. Validate logout and provider revocation invalidate access as expected.
9. Confirm the staged auth provider email/OAuth behavior, redirect URLs,
   CSRF controls, CORS and cookie settings.
10. Obtain GO LIVE for all production Auth configuration and data migrations.
    No account identity migration is permitted on live Neon in this PR.

## Staging environment (not set by this PR)

AIRA_EXTERNAL_AUTH_ENABLED=true
NEON_AUTH_BASE_URL=<staging Neon Auth base URL>
NEON_AUTH_JWKS_URL=<staging Neon Auth JWKS URL>
VITE_NEON_AUTH_URL=<same staging Neon Auth base URL, for future React SDK>

These variables must be scoped to the dedicated identity Preview branch.
Do not insert production credentials or public demo Firebase values.

## Crucial distinction

Signed bearer identity verification is *necessary but insufficient* for
persistent login UX. This PR is **STAGING FOUNDATION**, not a user-facing
cross-device-auth-complete release. Do not merge into production on its own.
