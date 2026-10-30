# Session trust-boundary remediation and Preview provider policy

**Status:** local-only implementation; not committed, pushed, deployed, or activated.
**Review date:** 2026-10-29.
**Protected branch/release state:** `arena/0f72d2ce-aira-ai-2026`; PR #117 remains OPEN/DRAFT. Published PR #117 Preview HEAD remains `8f811bde2f72be1dbfced3afc5adf2c1eb356ae4`. PR #115 remains frozen at `56064639ea2bf691cd7476b42d734864a32d595e`.

This document records the requested local application changes, compatibility policy choices that remain for the owner, read-only Vercel evidence, deployment actions that must not yet be taken, and validation results. It deliberately contains no secret values.

## 1. Confirmed paths and security findings

### `AIRA_SESSION_SECRET` runtime uses

A repository-wide source search found these runtime consumers in `apps/` and `packages/`:

- `apps/api/src/auth/session-auth.ts`: stateless anonymous/guest session cookie HMAC.
- `apps/api/src/auth/direct-oauth.ts`: direct-OAuth flow-state cookie HMAC and first-party direct-OAuth JWT HMAC.
- `apps/api/src/auth/bff-session.ts`: opaque BFF cookie HMAC, BFF OAuth-flow cookie HMAC, and legacy verification for those formats.
- `apps/api/src/startup-config.ts`: startup-time presence/length validation only.
- No current builder signer/validator uses `AIRA_SESSION_SECRET`; `packages/builder-runtime/src/security.ts` now requires `AIRA_BUILDER_SIGNING_SECRET`. A remaining string reference in its redaction list is not a signing use.

Other occurrences are tests, docs, or a browser prompt-injection fixture; they are not additional runtime signing paths.

### Findings

1. **Unbound guest v1 acceptance across environments.** Guest v1 tokens contain `v`, `uid`, `sid`, `iat`, and `exp`, but no issuer, audience, or deployment-environment claim. The read-only Vercel listing exposed one project variable record for `AIRA_SESSION_SECRET` targeting both Production and Preview (record `vRYnZTocLt7l0NYD`). Thus the same project secret is scoped to both environments. The old guest verifier had no environment check, so a correctly signed guest token could be accepted across those environments when the shared key applied. This establishes cross-environment guest-session acceptance, **not account takeover or existing-account impersonation**. It does not by itself establish that a guest workspace was read, that Production and Preview shared a database, or that an authenticated account was impersonated.
2. **Purpose/key reuse.** The original direct-OAuth helper used a source-embedded fixed HMAC fallback when `AIRA_SESSION_SECRET` was absent. The original BFF and guest-session helpers also had fixed development fallbacks outside `NODE_ENV=production`. The API's pre-existing startup guard required a session secret in Production-mode deployments, so the direct-OAuth fallback is not shown to have been active in the normal guarded Production API boot. It was nevertheless reachable from the exported helpers and any process importing them without that guard. Those fallbacks are now removed.
3. **Builder key fallback was reachable by configuration.** The old builder signer and `builderAccess()` fell back to `AIRA_SESSION_SECRET` when `AIRA_BUILDER_SIGNING_SECRET` was absent. The Production deployment snapshot contains names for `AIRA_BUILDER_ENABLED`, `AIRA_BUILDER_ALLOWED_USER_IDS`, `AIRA_BUILDER_SIGNING_SECRET`, and `LIGHTNING_SANDBOX_API_KEY`; this means the feature path exists in the deployed architecture if the hidden values satisfy its gates. It does **not** prove the feature is enabled or which key was actually used. A missing dedicated builder key could have selected the session-key fallback when the remaining builder gates were met. The fallback is removed; without the dedicated key Builder remains unconfigured/disabled.
4. **BFF cookies are different from guest tokens.** A BFF cookie is only an opaque session identifier plus HMAC; its authority comes from a live, unrevoked server-side session row. Legacy-cookie compatibility retains this row check. Direct-OAuth first-party JWT compatibility is also accepted only after the BFF row has been found and the JWT `sid` matches that row. This preserves the distinction between stateless guest-session acceptance and account authentication.
5. **No rollback of secret values was attempted.** Secret values were not decrypted or printed. No Vercel variable, credential, deployment, alias, branch rule, database, or worker was changed.

## 2. Local source changes

The new security work is concentrated in these files:

- `packages/contracts/src/deployment-environment.ts`: resolves `production`, `preview`, `staging` (Preview branch `staging`), and `development` solely from trusted server process configuration (`VERCEL_ENV`, `VERCEL_GIT_COMMIT_REF`, and `NODE_ENV`); no request-supplied value is accepted.
- `apps/api/src/auth/session-auth.ts`: issues guest v2 tokens; checks issuer, audience, environment, expiry, and maximum lifetime; renews within seven days while preserving `uid`/`sid`; removes development signing fallback; clears invalid cookies. Legacy guest-v1 acceptance is opt-in and Production-only.
- `apps/api/src/auth/direct-oauth.ts`: environment-binds direct OAuth flow-state cookies and first-party JWTs; removes the hard-coded session-key fallback; validates issuer/audience/environment/provider/lifetime.
- `apps/api/src/auth/bff-session.ts`: environment-binds BFF cookies and BFF OAuth-flow cookies; removes the development key fallback; keeps server-side row validation; requires `sid` match for first-party JWTs; upgrades accepted legacy Production cookies/JWT rows to v2; allows deterministic in-memory session-store injection for tests; requires an explicit trusted Origin/Referer on mutating browser requests.
- `packages/builder-runtime/src/security.ts` and `packages/builder-runtime/src/index.ts`: builder signing is dedicated-key-only; new tickets are v2 and environment-bound; legacy v1 verification is a Production-only explicit opt-in.
- `apps/api/src/startup-config.ts`: Vercel Preview can start without paid inference-provider keys; Production and staging retain their prior provider prerequisite. Production requires explicit `true`/`false` values for the three session migration gates before it can start.
- `packages/model-router/src/index.ts`: introduces `ProviderUnavailableError` (`PROVIDER_UNAVAILABLE`, HTTP 503); no-provider resolution fails before adapter dispatch; mock registration is disabled whenever `NODE_ENV=production`, including Vercel Preview.
- `apps/api/src/index.ts`: uses deployment-aware startup validation, reports provider-free health truthfully, and maps provider absence to 503 on run, workflow, agent-run, and streaming paths.
- `test/auth-environment-boundary.test.ts`: deterministic HMAC tests with synthetic keys for cross-environment rejection, missing/altered/foreign claims, tampering, expiry, renewal, legacy gates, BFF-row migration, Builder key isolation, Preview startup, and no-provider dispatch.

Supporting test fixtures were updated in `test/auth-bff-session-gateway.test.ts`, `test/auth-builder-integration.test.ts`, `test/auth-google-oauth-loop-remediation.test.ts`, and `test/builder-agent.test.ts`. They use synthetic values only.

### Keeping this separate from existing certification edits

The worktree already contains extensive uncommitted certification/M2A changes. Those remain untouched and uncommitted. Security changes are independently visible in the auth files, the new deployment resolver/startup validator, the new boundary test, and separate hunks in `apps/api/src/index.ts`. `apps/api/src/index.ts` also contains unrelated pre-existing M2A/approval/workspace certification hunks; do not treat or publish the entire worktree as this security change. No staging or commit was performed.

## 3. Token/version inventory and failure policy

| Path | New format / key | Claims and authority | Lifetime / renewal | Legacy behavior and failure |
|---|---|---|---|---|
| Guest session cookie `aira_session` | v2: base64url JSON + HMAC-SHA256; `AIRA_SESSION_SECRET` (minimum 32 characters) | `v=2`, `iss=aira-session`, `aud=aira-api`, trusted `env`, `uid`, `sid`, `iat`, `exp`. Stateless; no server-side row required. | 30 days; renewed within 7 days, preserving guest identity. | v1 is accepted only in Production when `AIRA_SESSION_ACCEPT_LEGACY_V1=true` and `AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL` is a canonical UTC deadline no more than 7 days ahead; any accepted identity is immediately reissued as v2. Preview/staging always reject v1. Bad signature/claims/env/expiry returns unauthenticated; invalid cookie is cleared and a new guest identity can be issued. |
| Direct OAuth flow cookie | v2 signed state JSON; `AIRA_SESSION_SECRET` | `iss=aira-direct-oauth-flow`, `aud=aira-oauth-callback`, environment, flow ID, provider, action/target, PKCE verifier where applicable, timestamp, `iat`, `exp`. | 10 minutes; no renewal; OAuth must restart after expiry. | Old unbound flow cookies are rejected; missing/tampered/foreign/expired state yields no valid flow and callback fails closed. |
| Direct-OAuth first-party JWT | v2 HS256 JWT; `AIRA_SESSION_SECRET` | `iss=aira-direct-oauth`, `aud=aira-bff-session`, environment, provider=`direct_oauth`, `sub`, `sid`, `iat`, `exp`, optional profile. A JWT alone is not the API's authenticated authority: BFF requires the corresponding live server row and matching `sid`. | Default 30 days; no independent renewal. BFF row expiry is also 30 days. | Old unbound JWT is accepted only through `AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT=true` in Production **after row lookup**; it is replaced in that row with v2 on successful use. Otherwise fail closed. |
| BFF session cookie | `v2.aira-bff-session.<environment>.<sessionId>.<signature>`; `AIRA_SESSION_SECRET`, purpose-separated HMAC | Cookie identifies a server-side session row; `aira-bff-session` is explicit token purpose/audience in the format and HMAC context. The row must exist, be unrevoked, and be unexpired. The cookie has no independent expiry claim. | Cookie and row max-age 30 days; current row lifetime is fixed rather than sliding. | Old `<sessionId>.<signature>` accepted only in Production with `AIRA_BFF_ACCEPT_LEGACY_COOKIE=true`, and only when the Production row exists. Middleware upgrades the cookie to v2. Otherwise clear/re-authenticate. |
| BFF OAuth-flow helper cookie | v2 signed JSON; `AIRA_SESSION_SECRET` | `iss=aira-bff-oauth-flow`, `aud=aira-oauth-callback`, environment, flow ID, timestamp, `iat`, `exp`. Current direct-OAuth entry route uses the separate 10-minute direct-OAuth flow cookie; this helper is otherwise referenced by tests/legacy helper code. | 15 minutes. | v1 helper cookie is rejected; invalid/foreign/expired state returns `null`. |
| Builder workspace/file ticket | v2 JSON + HMAC-SHA256; dedicated `AIRA_BUILDER_SIGNING_SECRET` (minimum 32 characters) | `issuer=aira-builder`, `audience=aira-builder-runtime`, trusted environment, purpose, user/session/workspace/provider and purpose-specific claims. Must match authenticated principal and purpose. | Issued for 15 minutes by current Builder flow; no sliding renewal. | v1 only if `AIRA_BUILDER_ACCEPT_LEGACY_V1=true` in Production and the dedicated Builder key verifies it. No `AIRA_SESSION_SECRET` fallback. Otherwise reject. |
| Neon Auth/provider JWT | Not signed by `AIRA_SESSION_SECRET`; verified by provider/JWKS configuration | Provider issuer/audience and subject; BFF still ties the verified user to the server-side row. | Provider-controlled. BFF may refresh provider JWT while the row is live; row expiry remains 30 days. | Verification/key/issuer/subject failure fails closed; no guest downgrade for an authenticated session. |

All environment labels above derive from Vercel server-injected configuration; none are derived from request headers, query, body, or cookies. The trusted-environment claim prevents Preview and Production tokens from verifying under the same synthetic HMAC key.

## 4. Compatibility impact and owner decision

### Anonymous guest v1 sessions — decision deliberately not made

A legacy v1 token had a 30-day expiry and the old implementation renewed it whenever a request arrived with at most 7 days remaining. Therefore a single token lasted at most 30 days, but an active guest could preserve the same `uid`/`sid` indefinitely by returning at least once within each 23-day period. There is no finite maximum legacy identity age under that old behavior.

Two policies remain owner decisions; neither is activated here:

- **Option A — immediate rejection:** Production sets `AIRA_SESSION_ACCEPT_LEGACY_V1=false` and leaves `AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL` unset. V1 is rejected immediately, the invalid cookie is cleared, and the next bootstrap creates a new `uid`/`sid` and workspace. This does not affect separately verified Google/GitHub/Neon account authentication or account-owned data. It does lose continuity for an unlinked guest identity; records tied to its former principal/workspace may remain stored but become inaccessible from the new anonymous identity. No account takeover is implied.
- **Option B — explicit bounded grace:** Production sets `AIRA_SESSION_ACCEPT_LEGACY_V1=true` and `AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL=YYYY-MM-DDTHH:mm:ss.sssZ` in UTC, at most 7 days after the deploying build's startup-validation time. A valid v1 used before that fixed cutoff is upgraded immediately to v2, preserving `uid`/`sid`; after the cutoff the verifier rejects v1 even if the boolean remains true. This reduces abrupt guest loss for active users, but during the interval still accepts any valid v1 HMAC token from the shared session key, including one minted in Preview. Inactive guests returning after cutoff lose the old identity. Re-deploying with a deliberately extended deadline can extend exposure, so do not roll the deadline forward without a new owner decision.

The API fails Production startup when the three migration flags are absent or not exactly `true`/`false`. The guest-compatibility flag additionally requires the deadline only when true; a deadline while false is rejected. A past deadline is warning-only at startup and remains fail-closed at request time, preventing a cold start from causing an outage after the grace expires.

### Authenticated BFF continuity

Production also requires explicit values for `AIRA_BFF_ACCEPT_LEGACY_COOKIE` and `AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT`. For an initial migration that prioritizes legitimate BFF continuity, the prepared path is to set both `true` after reviewing the current session-key situation: the old cookie still requires a live Production row and is upgraded to v2; a legacy direct-OAuth JWT still requires that row, `sid` equality, and is re-signed into the same row. Old Neon/provider JWT sessions are independently verified and remain row-backed. After the 30-day maximum old BFF row lifetime (and verification that migration completed), the owner can set both flags to `false`. If either is false during rollout, some still-valid old BFF sessions may require a fresh login.

Builder v1 compatibility is separate and short-lived in normal issuance (15 minutes); it always requires the dedicated builder key. Direct-OAuth flow state is short-lived and must be restarted rather than migrated.

## 5. Preview startup and unavailable provider behavior

- `VERCEL_ENV=preview` is evaluated before `NODE_ENV`; Vercel Preview commonly has `NODE_ENV=production`. It can now boot without NVIDIA/Groq/Gemini/OpenAI/Anthropic provider keys.
- Production and staging retain the prior requirement for at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `NVIDIA_API_KEY`. Production also requires `AIRA_SESSION_SECRET` and the three explicit migration-policy booleans.
- Mock adapter registration is based only on non-production `NODE_ENV`; Vercel Preview cannot use it. Setting `AIRA_ALLOW_MOCK=true` does not enable mock inference in Production-mode Preview or Production.
- With no configured provider, model resolution fails before dispatch with `PROVIDER_UNAVAILABLE`; API paths return controlled 503 responses. No paid-provider call is made by the deterministic tests. No mock provider is added to deployed Production.
- `AIRA_FAST_PROVIDER`/model selection is not itself a credential. If it points at an unavailable provider, the missing provider still fails closed. Staging retains its configured-provider behavior.

## 6. Vercel read-only inventory and evidence limits

Project: `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`), team `team_0IZkX9o2Ab319UsAPW9oq1SL`. No secret values were decrypted. A sensitive record’s empty/redacted `value` field in connector output must not be interpreted as an empty secret.

### Exact visible records (IDs and scopes, values omitted)

| Name | Vercel record | Target / branch | Finding |
|---|---|---|---|
| `AIRA_SESSION_SECRET` | `vRYnZTocLt7l0NYD` | Production + Preview; no branch | Shared project record. Supports the observed same-secret scope risk. |
| `AIRA_SESSION_SECRET` | `eb1NCC4qZGNJXfn0` | Preview; `staging` branch | Separate staging-scoped record; scope separation is visible, actual value difference was not verified. |
| `NVIDIA_API_KEY` | `KErVRBlvnEpnYSoz` | Production; no branch | Production-targeted record. |
| `NVIDIA_API_KEY` | `PDmjUkVAQeZVeslh` | Preview; no branch | Preview-wide paid-provider credential is visible; this includes ordinary PR Preview unless overridden. |
| `AIRA_FAST_PROVIDER` | `oNbo12WHqTGCTJzh` | Preview; branch `hotfix/agent-tool-calls-schema-reconciliation-20261025` | One branch-scoped routing record, not proof of the current PR branch’s setting. |
| `GOOGLE_CLIENT_SECRET` / `GOOGLE_CLIENT_ID` | `m99BvmR5r7pOt83r` / `PlAXGULkhw27yuqP` | Production; no branch | Production OAuth record pair. Values not read. |
| `GITHUB_CLIENT_SECRET` / `GITHUB_CLIENT_ID` | `AkeWyeAjGaoOJA83` / `S0emelAvaFIEp4tr` | Production; no branch | Production OAuth record pair. Values not read. |
| `GOOGLE_CLIENT_SECRET` / `GOOGLE_CLIENT_ID` | `0qmr6p456THTKwvm` / `ela9MKZXTA0kA1ke` | Preview; `staging` branch | Separate staging branch records; distinct IDs/scopes do not prove distinct underlying OAuth credentials. |
| `GITHUB_CLIENT_SECRET` / `GITHUB_CLIENT_ID` | `QozBWkinj3RVaEoU` / `Hdb7cZHUuteEdWa5` | Preview; `staging` branch | Separate staging branch records; actual value/app independence unverified. |
| `ALLOWED_ORIGINS` | `eozzT4INk9vxYnpZ` | Preview; `staging` branch | Staging-specific origin record; not a secret. |

The complete environment-variable response was too large for the connector output: its middle section was omitted even though `page_info.has_next_page=false`. The Preview deployment list is also paginated/truncated. **Therefore the exact current IDs/scopes for Groq, Gemini, Exa, Tavily, all fast-routing records, and other omitted provider/budget settings remain unavailable.** Do not infer them from the visible records.

The Production deployment snapshot `dpl_FFcF4EiKGFwqwj8jrbiyHxLMgPfw` is READY, target Production, ref `prod-release`, commit `8ce07aa060048e8c3774fed2702f85391dddde4`. Its deployment-time environment-name list includes `NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `AIRA_FAST_PROVIDER`, `AIRA_FAST_MODEL`, Builder flags/key names, OAuth names, database/auth settings, and the `AIRA_*_BUDGET_*` names. This is a snapshot of names, not proof of present Vercel scopes, values, enabled status, actual budget amounts, or provider spend caps.

The exact current Preview deployment `dpl_FbnFZqFrhawEURvNTDhYyDBnPUwx` is READY for PR #117 at the published Preview HEAD above. Its target field is `null` in the Vercel response (deployment `state=READY`, source ref branch). More recent local-session Preview deployments exist only in Vercel’s read-only history; no deployment was created here. `staging.virexaaiventures.com` DNS configuration is reported as not misconfigured and points to Vercel; that confirms DNS only, not which deployment snapshot currently serves it. The earlier attempt to look up the staging alias as a deployment ID returned 404 and was not repeated. No exact staging deployment ID or complete alias-target inventory was established.

### Preserve / split / remove manifest (proposal only; not executed)

| Scope | Preserve | Split or add | Remove / keep absent |
|---|---|---|---|
| Production | Current authorized production provider/search/vision/sandbox/OAuth credentials and configured budgets, subject to owner verification. Do not rotate in this remediation. Keep `AIRA_SESSION_SECRET` at 32+ characters. | Split `AIRA_SESSION_SECRET` away from the current Production+Preview record into Production-only and Preview-only records; keep a distinct staging override. Keep `AIRA_BUILDER_SIGNING_SECRET` distinct from the session key. Add explicit Production auth migration booleans selected by the owner. Verify spend/rate caps against actual numeric values before rollout. | Do not remove Production credentials solely based on this incomplete inventory. No change now. |
| Staging branch | Preserve current intended provider-backed staging behavior and staging OAuth/origin setup. | Keep a staging-only session secret and independently issued staging provider/OAuth/sandbox credentials; verify actual value/account independence without printing values. Verify lower staging caps. | Do not inherit Production secrets or Production database endpoints. No change now. |
| Ordinary PR Preview | Keep only Preview-specific session/auth config needed for the app and safe certification. | Use Preview-only `AIRA_SESSION_SECRET`; keep any explicitly approved isolated test auth records branch-scoped. | Remove/omit paid inference/search/vision/sandbox credentials and production OAuth credentials. `AIRA_FAST_PROVIDER`/model selection should not imply a provider is available. The app should return `PROVIDER_UNAVAILABLE` (503). No change now. |

Additional cost-bearing/privileged source-level consumers to include in the complete Vercel pass: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `CEREBRAS_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`; `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`; vision keys `FAL_KEY`/`FAL_API_KEY`, `REPLICATE_API_TOKEN`; sandbox keys `LIGHTNING_SANDBOX_API_KEY`, `E2B_API_KEY`; and privileged OAuth, database, webhook, cron, and maintenance keys. This is a source inventory, not confirmation that each has a current Vercel record.

## 7. Existing deployments, aliases, and retirement

Environment-variable scope changes do not retroactively alter an existing deployment snapshot. Any future scope change requires an explicitly authorized new deployment for each affected environment. Do not delete/reassign aliases as part of this auth patch.

Prepared but unexecuted handling:

1. Keep the current Production deployment and production aliases untouched.
2. Keep PR #117’s published Preview snapshot and branch alias untouched until the user authorizes the release. Its current deployment snapshot does not acquire these local code changes automatically.
3. Keep the staging custom domain and branch alias untouched; first identify the exact staging deployment and verify its current env snapshot.
4. After owner-approved environment cleanup, create new staging and Preview deployments to capture the new scopes; verify each by deployment ID and health behavior.
5. Only then inventory old snapshots/aliases by exact deployment IDs and owner intent. Retirement/deletion is a separate approved action; no deployment was canceled/deleted and no alias was changed.

## 8. Validation results

All cryptographic test keys/provider fixtures were synthetic. No paid provider, live OAuth provider, Production secret, migration, or deployed API was invoked.

- `npm ci`: passed; 384 packages installed, audit reported 0 vulnerabilities. It did not request secret values.
- `npx tsx --test test/auth-environment-boundary.test.ts`: **12/12 passed**.
- `npm run test:session-auth`: passed.
- `npm run test:auth-bff`: **7/7 checks passed**.
- `npm run test:auth-builder`: **6/6 checks passed**.
- `npx tsx --test test/auth-google-oauth-loop-remediation.test.ts`: **14/14 passed** with a synthetic session key and a stubbed in-memory account resolver.
- `npm run test:builder`: **27/27 passed**; provider tests are mocked.
- `npm run test:auth-fail-closed`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite emitted the existing large-chunk warning (largest JS bundle about 607.5 kB).
- Targeted `npx oxlint` on changed security files: exit 0, zero errors, seven warnings. Warnings are unused/regex findings in existing code and certification hunks (`safeRelativePath` intentionally rejects control characters; existing model-router parameter; existing helper/imports in BFF/API files). No lint autofix was applied.
- `npm run test:auth-security`: did not run its suite; its guard refused because no `STAGING_DATABASE_URL`/`DATABASE_URL` was supplied. No DB was contacted by that command.
- The full direct-OAuth lifecycle suite remains unrun in this continuation because the prior attempt failed on local database connection refusal. Deterministic direct-OAuth cryptographic, expiry, migration, and OAuth/BFF integration tests passed. No remote database was contacted.
- No full repository test suite was run.

## 9. Release and rollback sequence (not authorized yet)

1. **Owner decision gate:** choose the Production guest-v1 policy (`true` grace or `false` strict rejection) and confirm Production BFF legacy gates. Startup will fail rather than guess when these Production booleans are missing.
2. **Read-only verification gate:** complete the missing exact Vercel provider/budget scopes and staging value/account independence. Do not decrypt or print values; compare equality only if an owner separately approves a secure internal check.
3. **Configuration gate (separate authorization required):** create/split Preview, staging, and Production records as approved; preserve provider-free ordinary Preview; do not rotate Production credentials as part of the split.
4. **Preview validation:** publish a new Preview only after user authorization; verify it boots without paid-provider keys, health reports no provider, inference returns 503, and no mock/provider dispatch occurs.
5. **Staging validation:** after separate authorization, build staging with its own provider credentials, run auth isolation and provider smoke tests only under approved spend limits, and confirm Production tokens/credentials are not accepted.
6. **Production release:** only after code review and explicit release authorization for PR #117; use a new Production deployment with explicit migration policy. Check startup, BFF continuity, guest behavior, provider health/budgets, and security logs. Do not treat environment-variable edits as retroactive to existing snapshots.
7. **Migration closeout:** if guest-v1 grace is chosen, collect only aggregate migration counts (no token values), then disable the guest flag after the owner-approved window. Disable BFF grace after active old rows have been upgraded or expired (maximum row life 30 days). Builder-v1 grace can close after at least its old-ticket lifetime.
8. **Rollback caveat:** reverting to the old deployment is not session-transparent because the old code does not understand v2 guest/BFF cookies or v2 direct-OAuth JWTs. A code rollback may force anonymous guest rebootstrap and authenticated BFF re-login. Prefer a forward fix retaining v2 verification; if a deployment rollback is required, obtain explicit owner acceptance of that user impact. Do not rotate signing keys during rollback.

## 10. Owner authorizations still required

- Choose `AIRA_SESSION_ACCEPT_LEGACY_V1=true` (migration grace) or `false` (immediate guest-v1 rejection) for Production; confirm acceptable guest workspace impact.
- Approve the Production values for `AIRA_BFF_ACCEPT_LEGACY_COOKIE` and `AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT`; the continuity-first proposal is `true` for a bounded migration, then `false` after 30 days/verification.
- Authorize any Vercel environment-variable scope changes, Preview credential removal, staging credential independence checks, budget/rate-limit adjustments, and redeploys. **No such change is authorized now.**
- Authorize publishing PR #117 out of DRAFT or deploying any Production token-policy change. **Neither is authorized now.**
- Separately authorize any Preview/staging alias reassignment or deployment retirement/deletion after the exact IDs and alias targets are identified.
- Acknowledge the rollback/session reauthentication caveat before Production release.

## 11. Operational boundary

This is prepared local application remediation only. The worktree remains uncommitted on `arena/0f72d2ce-aira-ai-2026`; PR #117 remains OPEN/DRAFT; PR #115, the Production deployment, Vercel variables, secrets, branch rules, deployments, aliases, databases, and workers remain unchanged.