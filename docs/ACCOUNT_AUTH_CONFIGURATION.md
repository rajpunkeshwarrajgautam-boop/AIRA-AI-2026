# Account authentication configuration and certification

The API supports Firebase Admin SDK account-session exchange at `POST /api/auth/account`, separate from signed guest sessions. The body contains a Firebase client ID token, not a caller-selected user ID. Admin verification checks revocation; anonymous identities and sign-ins older than five minutes are rejected. Account middleware verifies the provider session cookie with revocation checks on each request. Account bootstrap preserves verified identity rather than creating a guest identity. `POST /api/auth/logout` revokes all Firebase account sessions; clients must label this as signing out everywhere.

Configure the existing authorized Firebase project, not the frontend demo fallback:

- `FIREBASE_PROJECT_ID`: verified Firebase project identity.
- `AIRA_FIREBASE_SERVICE_ACCOUNT_JSON`: authorized service-account credential, entered directly into protected server environment settings. Its project ID must match. Never expose it through Vite variables, reports, logs or chat.
- `AIRA_AUTH_ALLOWED_ORIGINS`: exact HTTPS app origins, comma-separated. Vercel's trusted deployment/branch/production URL metadata is also accepted. No wildcard origins or caller-supplied Host trust.
- Matching client Firebase configuration and enabled intended sign-in provider.

Exchange and logout enforce allowed Origin and reject cross-site browser requests. Session cookies are HttpOnly, SameSite=Strict and Secure on deployment. Exchange clears the guest cookie. Account roles do not receive repository, filesystem or administrator scopes. Middleware never falls back to a guest identity when an account cookie is invalid or revoked.

Before enabling a frontend account flow, partition client conversation/project caches by verified identity, prevent stale-account rendering and cross-account synchronization, and prove account switching and logout across browser sessions. The existing editable profile email and anonymous Firebase helper do not prove account authentication.

Source regressions use an injected Admin SDK boundary fixture. They test application policies, not Firebase cryptographic verification, configured provider availability or actual account login. Live certification requires an exact-SHA deployment, configured credentials, real sign-in, cross-account persistence denial and revoked-cookie replay rejection. Missing provider configuration remains a release blocker.

Implementation follows the Firebase Admin SDK session-cookie workflow:
https://firebase.google.com/docs/auth/admin/manage-cookies
https://firebase.google.com/docs/auth/admin/verify-id-tokens
