# Auth, Session, Workspace-Authority & Preview Release-Migration Review

**Review date:** 2026-10-29  
**Review scope:** local worktree on `arena/0f72d2ce-aira-ai-2026`; read-only Vercel metadata; no publish or deployment/config/database mutation.  
**Decision:** **Production NO-GO. Owner policy decision required.** Neither guest-v1 policy nor any Production migration gate was activated.

## 1. Git, PR, and publication state

- Local branch: `arena/0f72d2ce-aira-ai-2026`.
- Actual local `HEAD`: `56064639ea2bf691cd7476b42d734864a32d595e` (matches PR #115's frozen head SHA, not the published PR #117 head).
- GitHub PR #117: **OPEN, DRAFT**, head SHA `8f811bde2f72be1dbfced3afc5adf2c1eb356ae4`.
- GitHub PR #115: **OPEN, DRAFT**, head SHA `56064639ea2bf691cd7476b42d734864a32d595e`.
- Local changes remain uncommitted. The local branch name matches PR #117's head branch, but its checked-out `HEAD` is behind/different from that PR head. Do not infer that the local edits are already in PR #117.
- No commit, push, PR update/close/merge, Vercel setting change, deployment, database migration, worker activation, credential decryption, or secret rotation occurred. PR #117 remains OPEN/DRAFT and PR #115 remains OPEN/DRAFT at its frozen SHA.
- There is one worktree and no `origin/arena/0f72d2ce-aira-ai-2026` tracking ref. Local refs include only `origin/prod-release` / `origin/HEAD` at `8ce07aa060048e8c3774fed2702f85391dddde4` for these branches.

### Full-tree PR #117 comparison and cause

A read-only GitHub API tree comparison used PR #117's commit tree (`590` blobs) and hashed every current changed/untracked worktree path (`83` paths after the preflight correction): **46 paths match PR #117 byte-for-byte, 27 differ, and 10 are absent from PR #117**. This is a mixed worktree, not a clean copy of either PR's tree. In particular:

- `apps/api/src/auth/principal-provider.ts`, `packages/agent-runtime/src/workspace-authority.ts`, migration 030, and many existing M2-A/certification files match PR #117 exactly.
- The current auth implementation files `session-auth.ts`, `bff-session.ts`, `direct-oauth.ts`, plus `apps/api/src/index.ts`, differ from PR #117. `startup-config.ts`, the auth environment-boundary test, deployment-environment resolver, and the session/workspace review docs are local-only (absent from PR #117).
- Therefore the session-boundary remediation is not simply the published PR #117 tree: it is a mixture of exact PR #117 content and additional/divergent local edits layered in a worktree whose Git base is still PR #115's SHA. Do not equate file overlap with commit ancestry or assume the whole worktree is already published.

The complete non-identical path set is below (all other 46 changed/untracked paths hash-identically to PR #117):

**Different content from PR #117 (27):** `.github/workflows/ci.yml`; `.github/workflows/postgres-certification.yml`; `apps/api/src/auth/bff-session.ts`; `apps/api/src/auth/direct-oauth.ts`; `apps/api/src/auth/session-auth.ts`; `apps/api/src/index.ts`; `package-lock.json`; `package.json`; `packages/builder-runtime/src/index.ts`; `packages/builder-runtime/src/security.ts`; `packages/model-router/src/index.ts`; `packages/tool-runtime/src/adapters/browser-adapter.ts`; `packages/tool-runtime/src/gateway.ts`; `test/approval-resumption-outbox-postgres.test.ts`; `test/auth-bff-session-gateway.test.ts`; `test/auth-builder-integration.test.ts`; `test/auth-google-oauth-loop-remediation.test.ts`; `test/browser-execution-suite.ts`; `test/builder-agent.test.ts`; `test/capability-reality-audit-suite.ts`; `test/live-provider-agent-acceptance.ts`; `test/m2a-real-postgres-verification.test.ts`; `test/principal-provider-workspace.test.ts`; `test/recovery.ts`; `test/staging-agent-mission-certification.ts`; `test/tool-gateway-certification.ts`; `test/workflow-engine.ts`.

**Absent from PR #117 (10):** `apps/api/src/startup-config.ts`; `docs/release-readiness/auth-session-workspace-migration-review.md`; `docs/security-hardening/session-boundary-and-preview-provider-remediation.md`; `packages/contracts/src/deployment-environment.ts`; `test/auth-environment-boundary.test.ts`; `test/browser-authorization.test.ts`; `test/helpers/disposable-postgres-test-entry.ts`; `test/helpers/local-chromium.ts`; `test/helpers/postgres-execution-fixture.ts`; `test/workflow-engine-preflight.test.ts`.

The verified cause is a stale local branch pointer, not detached HEAD or another worktree: the local branch was created at `56064639...` and its reflog never advanced; the published branch of the same name is at `8f811bde...`. The published PR #117 commit history includes the local `56064639...` SHA as an ancestor, with subsequent commits through `8f811bde...`. In Git terms, every current uncommitted edit—including the session/auth review work—is a worktree diff against local `HEAD=56064639...` (PR #115), not a committed change based on local `HEAD=8f811bde...`. Some files now byte-match PR #117, but the changed guest/BFF/direct-OAuth files differ from its head and the new startup/environment files are absent there. The older `docs/release-readiness/m2a-stage-1-2-production-go-readiness.md` contains a historical SHA assertion that does not match this local `HEAD`; use the verified state above.

### Lossless recovery plan — prepared only, not executed

No branch/ref/worktree recovery has been run. If separately authorized later:

1. Freeze writes and make a verified byte-for-byte archive **outside the repository** of all changed tracked paths and all untracked files, retaining relative paths, modes, and symlinks. Also save `git diff --binary HEAD`, `git diff --cached --binary`, status, current branch/HEAD/ref values, reflog, and a SHA-256 manifest; verify the archive and manifest before touching refs.
2. Fetch the exact PR #117 head object without checking out another branch or worktree. Re-verify that `56064639...` is an ancestor of `8f811bde...` locally with Git before any ref movement.
3. If still authorized and ancestry is proven, atomically advance only `refs/heads/arena/0f72d2ce-aira-ai-2026` from the expected old SHA `56064639...` to `8f811bde...` using an expected-old-value ref update. This does not check out files or alter the worktree/index; the current file bytes remain in place and Git will naturally show exact-duplicate files as clean and divergent/local-only files as changes against PR #117.
4. Re-run status, path/hash comparison, and `git diff --check`; stop on any unexpected path/hash or ref movement. Do not discard/reapply “duplicate” files until their byte hashes and archive are verified. No reset, checkout, rebase, stash, clean, cherry-pick, commit, push, or recovery action is authorized by this plan.

The plan is not authorization to execute it. The only action taken so far was this read-only comparison.

## 2. Guest v1/v2 compatibility impact and owner options

### Historical renewal ceiling

The prior `HEAD` implementation (`git show HEAD:apps/api/src/auth/session-auth.ts`) issued v1 guest tokens with a 30-day `exp` and renewed them when `exp - now <= 7 days`, setting a fresh 30-day expiry while retaining the same `uid` and `sid`.

- **Single token maximum lifetime:** 30 days.
- **Maximum active v1 identity age:** **unbounded**. A returning guest could preserve the identity indefinitely by making a request at least once in each 23-day interval, refreshing on or before day 23. If idle for 30 days, that token expires.
- The current worktree's v2 token keeps the 30-day TTL and 7-day refresh window, but adds version, issuer, audience, and trusted deployment environment claims.

### Option A — immediate v1 rejection (not selected)

Production values for the compatible code would be:

```text
AIRA_SESSION_ACCEPT_LEGACY_V1=false
AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL=<unset>
```

The v1 cookie is rejected and cleared. The next guest bootstrap creates a new random `uid`/`sid`, and the resolver provisions a workspace for that new principal. This can strand data attached to the prior anonymous principal; it does **not** imply account takeover. A separately verified Google/GitHub/Neon account and its BFF session do not become invalid merely because a guest cookie is rejected. Any data already linked to an account may remain account-owned, but its actual state was not queried.

### Option B — short, explicit v1 grace (not selected)

The worktree now supports this bounded form:

```text
AIRA_SESSION_ACCEPT_LEGACY_V1=true
AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL=<owner-approved UTC deadline, at most 7 days ahead>
```

The deadline must be exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, be selected for Production explicitly, and be treated as an immutable absolute cutoff for that environment. A v1 guest token used before that cutoff is immediately reissued as v2 with the **same `uid`/`sid`** and a new 30-day expiry; renewal does not change or reset the v1 cutoff, and the server does not mint a replacement v1 token. At/after the cutoff, v1 is rejected even if the boolean remains `true`; the new v2 token may continue as an environment-bound session and is no longer an unbound legacy token. Guests who do not return before the cutoff lose the old identity. During grace, however, any valid v1 HMAC token made with the shared session secret remains acceptable in Production, including a token originating in Preview if that key was shared.

**Important limitation:** the current code validates that a configured deadline is absolute/canonical and no more than seven days ahead at startup, and request-time v1 renewal does not reset it. The environment variable can still be changed to a later value in a future deployment; code alone does not make the deadline immutable across deployments. Thus Option B is not eligible for selection until an owner approves both the date and an enforceable no-extension control (for example, deployment/config governance that prevents changing the fixed cutoff). Do not treat a fresh seven-day window on every deploy as acceptable.

A missing deadline or a deadline more than seven days in the future fails Production startup. A deadline paired with `false` is rejected. A past deadline is warning-only at startup, but the request verifier is fail-closed; this keeps cold starts healthy after grace ends.

**Neither Option A nor B is activated.** No production session counts or records were inspected, so the magnitude of guest impact is unknown.

## 3. Authentication, OAuth, logout, and Builder trace

### Guest sessions and API ordering

`apps/api/src/index.ts` installs `createSessionAuthMiddleware()` before Neon identity and BFF session middleware. A valid guest cookie attaches the guest `uid`/`sid`; an invalid cookie is cleared. `/api/auth/session` can issue a fresh guest cookie or renew an accepted session. In Production, the v2 verifier requires matching trusted environment, issuer `aira-session`, audience `aira-api`, valid `uid`/`sid`, valid signature, and bounded times. A v1 token is accepted only with the new bounded guest grace policy.

The guest cookie is stateless and has no server-side session row or revocation lookup. The BFF sign-out route revokes the BFF row and clears the BFF cookie; it does not itself revoke a stateless guest token. A `AIRA_SESSION_SECRET` change would invalidate signatures (including related signed session/flow artifacts) and is not a safe behavior rollback.

### BFF live-session verification and revocation

BFF authentication is separate from the guest token. The opaque v2 BFF cookie names its environment and session ID; authorization still requires a live, unrevoked, unexpired `bff_sessions` row. The cookie itself has no expiry claim; the server row is fixed at a 30-day lifetime, not sliding. Session middleware validates row and JWT/session consistency, reconstructs the principal, and fails closed on row lookup errors. `POST /api/auth/sign-out` requires CSRF/origin validation, clears the cookie, and deletes/revokes the server row. Workspace-authority revocation is separate from logout.

The old unbound BFF cookie is accepted only in Production with `AIRA_BFF_ACCEPT_LEGACY_COOKIE=true`, a valid old signature, and a live Production row, then upgraded to v2. The legacy direct-OAuth JWT is only considered after that row lookup, must match the row's `sid`, and is replaced in the same row with v2. These gates do not make a standalone JWT authoritative. Old BFF rows have a fixed expiry; no sliding renewal was found.

### Direct Google/GitHub OAuth and OAuth state

Current direct OAuth uses provider-bound signed flow state. Google uses PKCE; callbacks validate/consume the flow cookie, state/flow ID, provider/action, and expiry before exchanging the code. State is environment-bound in v2 and expires after 10 minutes; the separate BFF OAuth helper cookie is 15 minutes. Old/foreign/expired flow state is rejected and the user must restart OAuth; it does not migrate a guest identity. OAuth account creation/linking is distinct from guest v1 acceptance. OAuth client IDs/secrets are configured separately in Vercel and need scope review.

The legacy direct-OAuth JWT gate is `AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT`; enabling it without the legacy BFF-cookie gate is rejected by the new startup validator as an ambiguous/no-benefit state. Neon Auth/provider JWT verification is separate and uses its issuer/JWKS configuration, with a BFF row still required for first-party session authority.

### Builder tickets

Builder workspace/file tickets use the dedicated `AIRA_BUILDER_SIGNING_SECRET`, not `AIRA_SESSION_SECRET`. V2 tickets bind issuer, audience, environment, purpose, user, session, workspace, and expiry (normal issuance is 15 minutes); Builder routes also reconstruct the live authenticated BFF principal, so a ticket alone is not authority and BFF revocation blocks later Builder use. Legacy v1 tickets are only accepted when `AIRA_BUILDER_ACCEPT_LEGACY_V1=true` in Production and signed with the dedicated Builder key; absent/false rejects v1. This is a separate, optional gate, not one of the three required Production migration flags.

## 4. Workspace authority and historical personal data

The new authority is server-derived from an authenticated principal. `derivePersonalWorkspaceId(principalId)` yields a deterministic `ws_personal_<sha256>` candidate, but authorization requires an active PostgreSQL row keyed by the principal in `principal_workspace_authorities`. Client workspace/project headers and request bodies are ignored. Missing/revoked/conflicting authority fails closed. Authority provisioning is lazy on first authenticated resolution; revocation writes a tombstone that provisioning cannot recreate.

**Historical continuity is not established.** The prior principal-provider accepted `req.user.workspaceId` and test-only `x-workspace-id`; the prior managed-identity path returned `workspaceId: undefined`, and guest session attachment did not populate a workspace. Migration `030_principal_workspace_authority` creates an empty table and does not backfill old workspaces, runs, or tasks.

Relevant prior data migrations reinforce this gap:

- Migration `008_phase3_3_task6_identity` backfilled run `principal_id` and `session_id='legacy-session'`, but it added `workspace_id` without backfilling that column.
- Migration `016_knowledge_memory_principal_isolation` assigns unowned knowledge sources to `legacy_unassigned` and leaves historical workspace IDs null; chunks inherit principal/system state from sources.
- The new code deliberately refuses to invent authority from historical/client-selected workspace values. Runs/tasks with absent or mismatched persisted workspace authority cannot be approved/recovered by the new protected paths.

Keep three different questions separate:

1. **Guest recognition:** the session verifier recognizes a valid guest cookie and its `uid`/`sid`. Immediate v1 rejection clears the old cookie and the next bootstrap creates a new guest identity; bounded grace can recognize and upgrade the old guest before its fixed cutoff. Neither choice authenticates a Google/GitHub/Neon account.
2. **New authoritative workspace provisioning:** on first resolution, the server may derive the personal workspace candidate from the authenticated principal and lazily create its new authority row, unless a revocation tombstone exists. The client cannot choose the workspace. This is creation of new authority, not adoption of an old workspace ID.
3. **Historical run/task recovery:** existing run/task/workspace rows are only usable if persisted ownership satisfies the new authority checks. A remembered guest identity or client-supplied historical workspace ID is not proof. No historical run/task authorization may be inferred from an untrusted workspace ID; any recovery would require a separately authorized read-only inventory and an independently reviewed, explicit mapping/repair design.

Therefore Option B preserving a guest `uid`/`sid` does **not** prove access to historical personal workspace data: it can provision a new deterministic workspace for the same `uid`, while old run/task/knowledge rows may still have null, legacy, or mismatched workspace ownership. Option A also loses the old guest principal identifier. Existing verified account authentication remains distinct from guest identity, but prior guest data could be inaccessible in either path. Exact user counts, row counts, and recoverability require an authorized, read-only database inventory; none was performed. Do not promise continuity or assert data deletion.

Migration 030's `down` drops authority rows and revocation tombstones; this is not a production rollback. Never treat a session-key change, guest rejection, or database rollback as restoring prior identity/workspace behavior.

## 5. Production migration-gate audit and synthetic matrix

The new API startup validator requires these **three exact Production variables** to be explicitly `true` or `false`:

| Gate | Runtime effect when `true` | Runtime effect when `false`/absent | Additional rule |
|---|---|---|---|
| `AIRA_SESSION_ACCEPT_LEGACY_V1` | Accept Production v1 guest tokens only before `AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL`; upgrade to v2 | Reject v1 guest tokens; create a new guest on bootstrap | Required in Production; true requires canonical UTC deadline no more than 7 days ahead; false requires deadline unset |
| `AIRA_BFF_ACCEPT_LEGACY_COOKIE` | Accept old two-part signed cookie only if its Production BFF row is live; replace with v2 | Reject old cookie | Required in Production; v2 unaffected |
| `AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT` | Consider old direct-OAuth JWT only after live BFF row lookup; enforce matching `sid`; replace with v2 | Reject old direct-OAuth JWT; Neon/provider JWT path is separate | Required in Production; `true` requires `AIRA_BFF_ACCEPT_LEGACY_COOKIE=true` |

Configuration semantics:

- **Production:** any missing/empty/uppercase/other boolean representation fails startup. Migration flag values are also read by verifiers on requests. The new guest grace deadline is checked at request time; an expired deadline warns at startup and rejects v1.
- **Preview/staging:** missing flags default to strict rejection; an explicitly configured `true` for any of these three flags is a startup error; exact `false` is permitted. Guest deadline must be unset. The staging branch is still a Vercel Preview deployment, identified by trusted `VERCEL_GIT_COMMIT_REF=staging`.
- **Development/tests:** no Production compatibility; synthetic tests can set the flags but runtime compatibility remains Production-only.
- Startup validation runs when `apps/api/src/index.ts` initializes. The verifiers consult `process.env` per request. Vercel deployments use their environment snapshot; changing dashboard values alone does not change an already-running deployment. A new deployment is required for a new snapshot.
- Provider prerequisite: new code requires `AIRA_SESSION_SECRET` (at least 32 characters) outside development; Production and staging require at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `NVIDIA_API_KEY`; ordinary Preview can boot without one and does not register a mock provider.

Synthetic tests passed the strict Option A combination; Option B within seven days; expiry/missing/too-long/mismatched deadline; exact boolean validation; Preview `true` rejection; expired-deadline warning/fail-closed behavior; and the unsafe direct-JWT-true/cookie-false combination. No live configuration was changed. These gates are part of local uncommitted code and are not presumed deployed.

## 6. Preview isolation and credential scope recommendations

The v2 claims prevent cross-environment token reuse even when two environments use the same key. This protection does not apply to legacy v1 guest tokens during Option B, and shared BFF/legacy verification must remain row-bound. The Vercel metadata shows a project-wide `AIRA_SESSION_SECRET` record scoped to both Production and Preview (record `vRYnZTocLt7l0NYD`) plus a separate Preview `staging`-branch record (`eb1NCC4qZGNJXfn0`). Split Production from ordinary Preview/staging before a later release. This is a key rotation/session invalidation event that needs an owner-approved transition; do not rotate it as a review action.

Recommended target scopes (manifest details below):

- **Production only:** Production `AIRA_SESSION_SECRET`, Production database URL, Production provider keys, Production OAuth client credentials, Production Builder signing key, and the three Production migration gates. Avoid using one Production HMAC secret for Preview.
- **Ordinary PR Preview:** a dedicated non-Production session secret; no Production database/provider/OAuth credentials; no legacy compatibility `true`; no paid provider access after Preview certification is switched to mock/synthetic contracts. Mock inference remains disabled in deployed Preview.
- **Staging branch Preview:** dedicated staging session key, staging database branch/role, staging Neon Auth/OAuth configuration, and—only if needed for staging missions—dedicated staging provider credentials. Never reuse Production credentials.

The current PR #117 Preview deployment metadata lists `AIRA_SESSION_SECRET`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, and Google/GitHub OAuth variable names in its deployment environment snapshot. The project env metadata visibly confirms a Preview NVIDIA record (`PDmjUkVAQeZVeslh`) and a separate Production NVIDIA record (`KErVRBlvnEpnYSoz`). The metadata shows names/scopes, not secret contents; do not infer key values or whether every listed provider variable is populated. The exact Preview credential-to-branch association remains incomplete because the env listing is truncated.

## 7. Read-only Vercel inventory and metadata limitation

Read-only Vercel checks identified project `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`, team `team_0IZkX9o2Ab319UsAPW9oq1SL`):

- Current PR #117 Preview deployment is `dpl_FbnFZqFrhawEURvNTDhYyDBnPUwx`, READY, commit `8f811bde2f72be1dbfced3afc5adf2c1eb356ae4`, ref `arena/0f72d2ce-aira-ai-2026`.
- Production deployment is `dpl_FFcF4EiKGFwqwj8jrbiyHxLMgPfw`, READY, commit `8ce07aa060048e8c3774fed2702f85391dddde4`, ref `prod-release`.
- Production deployment snapshot includes names for `DATABASE_URL`, `AIRA_SESSION_SECRET`, provider, OAuth, Neon Auth, and Builder variables. The PR #117 Preview snapshot includes the names described in §6; neither response revealed decrypted values.
- The observed project build command runs `scripts/staging-db-guard.ts && npm run db:migrate && npm run db:verify:deploy` for the `staging` branch, and `npm run db:verify:deploy` (no migration command) for Production before `npm run build`. A future staging deployment can therefore mutate the staging database at build time; this was not invoked.
- Visible records include Production `DATABASE_URL` (sensitive record `EVELh8gFpi85Oa8V`), the shared Production+Preview session secret, the staging-branch session secret, and Preview/Production provider records. Preview branch-specific DB/Auth variables are also present. No values were decrypted.
- No live staging deployment ID was established. The deployments endpoint returns cursor pages without a branch/ref filter; its large result was truncated by the connector.

The Vercel `list_env_vars` connector accepts no filters or paging arguments. It returned `has_next_page=false`, but the tool transport explicitly truncated the middle of the result, so it is not a complete inventory. `get_env_var` would decrypt values and was not used. This is a supported-metadata limitation, not evidence that omitted records do not exist. For a complete read-only audit, the owner should export only variable **names, targets, git-branch/custom-environment scope, type/visibility, and updated time** from Vercel Project → Settings → Environment Variables (or a metadata-only authorized Vercel API/CLI listing); do not `env pull`, decrypt, or include values in the export.

## 8. Locally safe verification results

The review preserves, and does not silently drop or replace, the existing Stage 1.1/1.2A/1.2B/1.2C approval work, durable resumption outbox, workspace-revocation tombstones, durable-worker authorization/fencing, local Chromium certification, run-scoped disposable-PostgreSQL guard, and provider-isolation work. The tests below cover safe in-memory/synthetic portions; the database-backed portions remain explicit gaps.

| Area | Result |
|---|---|
| Guest/session environment boundary and synthetic gate matrix | **PASS 12/12** (`npx tsx --test test/auth-environment-boundary.test.ts`) |
| BFF gateway/session/CSRF/sign-out | **PASS 7/7** (`npm run test:auth-bff`) |
| Builder + auth integration | **PASS 6/6** (`npm run test:auth-builder`) |
| Client auth identity transition/logout/revocation | **PASS 10 checks** (`npm run test:auth-lifecycle`) |
| Authenticated fail-closed/no guest downgrade | **PASS 3 checks** (`npm run test:auth-fail-closed`) |
| Google/GitHub BFF login-loop remediation | **PASS 13/13** in the multi-suite local run; mocked providers, no real OAuth transaction |
| Neon token-refresh race | **PASS** in the same local test run; mocked client state |
| Workspace principal resolution | **PASS 2/2** (`test/principal-provider-workspace.test.ts`) |
| Durable worker authorization + ToolGateway approval/fail-closed + workflow approval authority + migration rollback guard | **PASS 35/35** (in-memory/synthetic; not PostgreSQL certification) |
| Durable specialist execution | **PASS 17/17** (`npm run test:m2a`) |
| M2A activation security | **PASS 52/52** (`npm run test:m2a:activation`); synthetic configs only; no worker activated |
| Model routing/provider failover suites | **PASS**; all invoked script groups exited 0, synthetic fetch/provider fixtures |
| Builder agent/provider/UI contract suites | **PASS 27/27** (`npm run test:builder`); mocked provider endpoints |
| Real local Chromium + ToolGateway authorization | **PASS 2/2** (`npm run test:browser:authorization`); local browser only, no network access |
| CORS/CSRF | **PASS 8/8** (`npm run test:cors`) |
| Disposable PostgreSQL address-policy unit tests | **PASS 9/9** (`node --test scripts/ci/postgres-address-policy.test.mjs`); synthetic address data |
| Project-wide TypeScript | **PASS** (`npm run typecheck`) |
| Production build | **PASS** (`npm run build`); Vite reports a 607.5 kB main JS chunk, above its 600 kB advisory threshold |
| Lint | **PASS exit 0**, 273 warnings and 0 errors (`npm run lint`); warnings span the existing large worktree |
| Tracked-secret hygiene | **PASS**; 565 tracked files scanned, zero exposed credentials |
| Scoped Builder typecheck | **FAIL** (`npm run typecheck:builder`; exact command: `tsc --ignoreConfig --noEmit --target ES2023 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck packages/builder-runtime/src/index.ts apps/api/src/builder-routes.ts`). Errors: Zod default argument typing at `packages/contracts/src/agent-specialists.ts:97,104` and `packages/contracts/src/index.ts:124`; Gemini adapter returns unsupported `content` properties at `packages/model-router/src/gemini-adapter.ts:249,419`; string model values fail literal-union assignments at `packages/model-router/src/index.ts:408–416,506–514`, with impossible `aira-fast` comparisons at `:1060,1065`; `resilient-adapter.ts:75` has `string | undefined` where `string` is required. The full project `npm run typecheck` passes, so this isolated compiler invocation does not mirror the repository's effective project configuration/reference context; it is a scoped check failure, not evidence of a production runtime failure. Safest correction: reconcile the targeted command with the same `tsconfig`/project graph and then address any remaining real contract errors, rather than papering over them with broad casts. |
| Neon OAuth verifier-redemption fixture | **FAIL / stale contract mismatch** (`npx tsx --test test/auth-oauth-verifier-redemption.test.ts`, run with a synthetic-only key; no DB or live provider was used). Exact result: 10/12 fail, 2/12 pass. Representative errors: start fixture asserts `BFF_FLOW_COOKIE_NAME_DEV` is set but it is not; callbacks log `CSRF/State validation failed: missing or expired flow state cookie`, so `/get-session` is never called; expected `/?auth_error=exchange_failed` and `/?auth_success=1` redirects then fail. Both provider-state cross-provider rejection tests pass. Cause: the fixture expects the prior Neon Auth `session_challenge` / `neon_auth_session_verifier` handoff while current direct Google/GitHub handlers require the current direct-OAuth flow-cookie state contract. Safest correction: rewrite this fixture against the handler contract that is actually mounted, or retire it in favor of the passing current OAuth-loop and direct-OAuth synthetic suites; do not change production handlers just to satisfy the obsolete fixture. This fixture is not direct-OAuth end-to-end certification. |
| Cross-instance durable BFF test | **NOT CERTIFIED**: an attempted local run failed at valid-principal reconstruction because no disposable DB was configured; its test creates per-instance stores but its middleware uses the default global store. No database was connected. The durable behavior needs the verified DB fixture. |
| Workflow engine DB suite | **SAFE REFUSAL / DB suite not run**. Prior to this fix, `npm run test:workflow` attempted the implicit localhost fallback and got `ECONNREFUSED` on `::1`/`127.0.0.1:5432`; no connection succeeded. The entry now checks the complete isolated-test identity contract, runs `scripts/ci/assert-disposable-postgres.mjs`, and only then dynamically imports DB-backed modules. `npx tsx --test test/workflow-engine-preflight.test.ts`: **4/4 PASS** (missing authorization and a lone localhost `DATABASE_URL` both prevent preflight/suite initiation; valid contract orders preflight before suite; failed preflight prevents suite). The actual entry with all disposable variables unset exits at the pure guard with `PostgreSQL workflow tests require the matching identity-verified, run-scoped disposable database contract.` No DB was contacted. In-memory workflow-approval-authority tests passed separately. Generic CI now executes only the no-connection preflight tests; the dedicated PostgreSQL certification invocation passes `CI_EXPECTED_POSTGRES_ADDRESSES` into `npm run test:workflow`, preserving the verified disposable-runner path. The real PostgreSQL workflow suite remains uncertified here because that runner was not invoked. |
| Strict TLS harness | **BLOCKED before TLS assertions** (`npm run test:verify-tls` → `npx tsx test/verify-strict-tls.ts`): the setup's `npx --yes neonctl connection-string ...` helper was unavailable in the earlier run; it produced no usable connection string and `new URL(connStr)` failed with `Invalid URL`. No TLS handshake or database connection succeeded. The harness currently also falls back to arbitrary `DATABASE_URL` or an automatically fetched Neon URL, so do not rerun it in this investigation or point it at staging. Safest correction is to eliminate automatic Neon/ambient-URL discovery and require an explicitly approved, independently verified disposable endpoint before any network action; local TLS properties can instead be tested with a controlled local TLS fixture. |
| Production/staging DB integration, auth security, direct OAuth lifecycle, positive guest linking, durable ToolGateway, outbox, worker staging E2E, API recovery/startup integration | **NOT RUN**: no Docker executable, no verified disposable PostgreSQL fixture, and no authorized staging DB URL. These are gaps, not passes. |

`packages/db/src/index.ts` still has its legacy localhost fallback; it was not globally changed because in-memory/unit modules import that package transitively. The corrected `test/workflow-engine.ts` path is safe because it has no static DB-backed imports and refuses before dynamic imports unless the matching disposable contract and connected-server identity preflight pass. Other database-writing test entry points remain a separate audit surface and must not be assumed protected by this narrow fix.

`test:tools` was not run because the preceding DB-backed `test:workflow` command failed in the `&&` chain. `test:startup`, `test:auth-security`, `test:direct-oauth`, `test:guest-linking`, Playwright auth cross-browser, M2A real-Postgres, ToolGateway PostgreSQL certification, and staging worker E2E must only run later against the repository's verified run-scoped disposable DB contract. No local PostgreSQL/Docker target was available. No production/staging database was contacted.

## 9. Staging and Production-specific risks

1. Production's current deployment is older than the local branch work and does not prove the new startup validator or cutoff behavior is live.
2. The new validator refuses Production startup unless all three migration booleans are exact. The Vercel deployment snapshot did not show those names, and the env inventory is incomplete. A compatible Production deployment without them would fail startup. Do not deploy before owner-selected exact values are available.
3. `principal_workspace_authorities` requires migration 030 before protected API paths can use persistent workspace authority. The migration has no legacy backfill. Production's build runs a schema verifier, not migrations. Database preparation and application rollout must be separately authorized.
4. The staging branch build command runs migrations automatically after its staging database guard. A wrong/missing staging scope could mutate an unintended DB; require a verified isolated branch/role and complete disposable/staging certification first.
5. Ordinary Preview currently has credential **names** in its deployment snapshot, including session/provider and OAuth variables. Metadata alone cannot establish all exact scopes/values. Remove general Preview provider access only after checking build assumptions and isolating a dedicated staging Preview scope.
6. Replacing shared `AIRA_SESSION_SECRET` invalidates signed cookies/tickets/flows; do not assume rollback restores them. Workspace authority and revocation tombstones are persistent state; do not use migration `down` for Production rollback.
7. PR #117's currently visible Vercel Preview deployment corresponds to the published SHA, not the local worktree. It is not a certification of the uncommitted deadline/config changes.

## 10. Exact later-approval configuration manifest (not applied)

### Production

| Key | Required value/scope after owner approval |
|---|---|
| `AIRA_SESSION_SECRET` | Dedicated Production-only secret, length ≥32; owner-approved session/key transition required before changing current shared record. No value is recorded here. |
| `AIRA_SESSION_ACCEPT_LEGACY_V1` | **Option A:** exact `false`; **Option B:** exact `true`. Owner must choose. |
| `AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL` | **Option A:** unset. **Option B:** exact UTC ISO timestamp `YYYY-MM-DDTHH:mm:ss.sssZ`, no more than 7 days ahead when validated; owner supplies the cutoff. |
| `AIRA_BFF_ACCEPT_LEGACY_COOKIE` | Exact `true` or `false`; owner decision. `true` requires a live unexpired Production session row and upgrades the cookie. |
| `AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT` | Exact `true` or `false`; `true` is only valid when the cookie flag is also `true`. |
| `AIRA_BUILDER_SIGNING_SECRET` | Dedicated Production-only secret, length ≥32; never share with session key. |
| `AIRA_BUILDER_ACCEPT_LEGACY_V1` | Recommended absent or exact `false` unless a separate Builder migration is approved; `true` requires the dedicated key. |
| `DATABASE_URL` | Production-only DB target; never use for Preview/staging or local tests. |
| Provider and OAuth credentials | Production-only provider and Google/GitHub OAuth client scopes. Do not reuse in Preview. |

### Ordinary Preview and staging branch

| Key group | Scope/value rule |
|---|---|
| Session signing key | Preview-only key; staging may use a separate staging-only key. Do not share Production secret. |
| Three Production migration flags | Absent or exact `false`; never `true` in Preview/staging. Guest deadline unset. |
| Builder legacy flag | Absent/false; Production-only compatibility is rejected outside Production. |
| `DATABASE_URL` | No Production URL. Ordinary PR certification uses the verified disposable fixture; staging uses only its isolated staging branch/role. |
| Provider keys | None for ordinary PR Preview. If required for staging missions, use a dedicated non-Production staging key scoped only to the staging branch. |
| OAuth/Neon Auth | Dedicated test/staging client and staging-only provider/Auth endpoints; no Production callback credentials in general Preview. |

The specific Option A/B values and the two BFF values remain **owner choices**. This manifest is not a change request executed against Vercel.

## 11. Release ordering and rollback limits

Recommended sequence, subject to owner approval:

1. Resolve the complete metadata-only Vercel environment inventory; identify branch-scoped secrets and verify the staging branch database/Auth/provider isolation. Prepare a separate secret/key transition plan; do not rotate during this review.
2. Make configuration scope safe for existing builds: split Production from Preview/staging credentials, remove Production database/provider/OAuth access from ordinary Preview, and preserve only staging-scoped resources required for staging. Check whether existing build scripts depend on these names before removing them.
3. Keep PR #117 OPEN/DRAFT; reconcile local `HEAD` vs published SHA and decide how the uncommitted branch work will be reviewed/published. Do not combine unrelated M2A/certification work into an unreviewed auth policy change.
4. Publish the approved draft candidate only after typecheck/lint warnings, OAuth stale tests, and release manifest are reconciled. No publication occurred here.
5. Certify disposable PostgreSQL using the verified run-scoped fixture (database/user/name/Docker-address identity preflight) across migrations 027–030, outbox, workspace authority, ToolGateway, workflow, worker, and rollback-guard suites. Certify Preview with no paid provider access and the correct isolated database; use synthetic providers for deterministic tests.
6. Run staging against the verified staging branch. Because staging build invokes migrations, inspect the guard and exact branch target before any staging deployment; complete OAuth, auth, guest-linking, browser/Chromium, ToolGateway/workflow/worker, schema and rollback checks.
7. Enforce the required PostgreSQL certification checks and any release authorization checks only after those results are complete and all check definitions are reviewed. No release-rule change was made.
8. **Production gate sequencing constraint:** the current local startup validator fails Production startup when any of the three required gate flags is missing. Therefore do not deploy this code to Production with flags absent. The safe interpretation of “gates after compatible code” is: first deploy/certify compatible code in Preview/staging, then obtain owner values and provide them to the Production deployment before its processes initialize (the policy takes effect at that Production startup). If the requirement instead means first run the new code in Production with the flags absent and only configure gates later, that is incompatible with the current startup validator and requires an explicit, separately reviewed two-phase design; do not improvise a silent default.
9. Apply the chosen Production config only after the authorized compatible-code release plan, database schema verification, scopes, checks, and owner approvals are ready. Evaluate Production authorization last; do not activate the worker or policy without that authorization.

Rollback is not “restore old behavior”: v2 environment-bound tokens may not verify under old code; splitting/rotating keys invalidates signatures; persisted workspace authority/revocation/outbox state cannot safely be dropped; old runs/tasks have no trustworthy workspace backfill. A rollback plan must stop protected traffic/workers where needed, preserve the schema/state, and use an independently reviewed forward-recovery/backup procedure. Do not use destructive migration 030 `down` in Production.

## 12. Owner decisions, publication readiness, and final GO/NO-GO

Owner decisions still required:

1. Select Option A or Option B for guest-v1; if B, choose a fixed ≤7-day UTC deadline.
2. Select values for both BFF legacy flags, with direct-OAuth JWT true only if legacy cookie is true.
3. Confirm the acceptable historical guest/workspace data impact and authorize a read-only staging/Production record-count inventory if needed.
4. Approve key-scope split/rotation and separate Preview/staging OAuth/provider/database scopes.
5. Approve staging migration and Production schema-verification order, required PostgreSQL checks, and Production authorization authority.
6. Reconcile the stale OAuth verifier-redemption test and the failing standalone Builder typecheck before claiming complete certification.

**Publication readiness:** the local edits are uncommitted, local `HEAD` is `56064639…`, and published PR #117 is at `8f811bde…`. Do not push or update PR #117 until the owner policy decision and review scope are settled. PR #117 remains OPEN/DRAFT; PR #115 remains OPEN/DRAFT at its frozen SHA.

**Production GO/NO-GO: NO-GO.** Blocks: no owner guest/BFF policy, incomplete Vercel metadata inventory and unresolved Preview secret scopes, no disposable PostgreSQL or staging certification, unverified historical workspace/data impact, no approved key/migration/rollback plan, and a strict Production startup contract that must receive explicit values before the new code can initialize. No gate, migration, worker, deployment, or release authorization was activated.

### Working-tree inventory

The worktree was already substantially dirty before this review; do not attribute all existing certification/M2-A changes to the auth review. The earlier session-remediation edits remain in `apps/api/src/auth/session-auth.ts`, `apps/api/src/startup-config.ts`, `apps/api/src/index.ts`, `test/auth-environment-boundary.test.ts`, and `docs/security-hardening/session-boundary-and-preview-provider-remediation.md`. This continuation added the disposable PostgreSQL test-entry guard, its deterministic negative/ordering tests, and the narrow generic-vs-disposable CI routing described in §8. No existing uncommitted work was discarded. Current inventory: **50 modified tracked files + 33 untracked files (83 changed/untracked paths)**; no tracked build artifacts were added. Full current inventory:

```text
.github/workflows/ci.yml
.github/workflows/postgres-certification.yml
apps/api/src/auth/bff-session.ts
apps/api/src/auth/direct-oauth.ts
apps/api/src/auth/principal-provider.ts
apps/api/src/auth/session-auth.ts
apps/api/src/index.ts
apps/api/src/startup-config.ts
docs/release-readiness/auth-session-workspace-migration-review.md
docs/release-readiness/m2a-stage-1-2-production-go-readiness.md
docs/security-hardening/M2A-5-ACTIVATION-CHECKLIST.md
docs/security-hardening/M2A-SECURITY-HARDENING-STATUS.md
docs/security-hardening/session-boundary-and-preview-provider-remediation.md
docs/security-hardening/workspace-authority-lifecycle.md
package-lock.json
package.json
packages/agent-runtime/src/durable/durable-task-scheduler.ts
packages/agent-runtime/src/durable/specialist-task-repository.ts
packages/agent-runtime/src/durable/specialist-worker-runtime.ts
packages/agent-runtime/src/durable/tool-authorization.ts
packages/agent-runtime/src/index.ts
packages/agent-runtime/src/repositories.ts
packages/agent-runtime/src/specialists/mathematical-specialist.ts
packages/agent-runtime/src/workflow-engine.ts
packages/agent-runtime/src/workspace-authority.ts
packages/approvals/src/index.ts
packages/approvals/src/repositories.ts
packages/builder-runtime/src/index.ts
packages/builder-runtime/src/security.ts
packages/contracts/src/deployment-environment.ts
packages/contracts/src/index.ts
packages/db/src/index.ts
packages/db/src/migrations/027_atomic_approval_decisions.ts
packages/db/src/migrations/028_approval_resumption_outbox.ts
packages/db/src/migrations/029_authoritative_approval_resumption_targets.ts
packages/db/src/migrations/030_principal_workspace_authority.ts
packages/db/src/scripts/test_repos.ts
packages/model-router/src/index.ts
packages/tool-runtime/src/adapters/browser-adapter.ts
packages/tool-runtime/src/gateway.ts
scripts/ci/assert-disposable-postgres.mjs
scripts/ci/postgres-address-policy.mjs
scripts/ci/postgres-address-policy.test.mjs
test/approval-atomic-resolution.test.ts
test/approval-lifecycle-stage-1-2a.test.ts
test/approval-once-consumption.test.ts
test/approval-resumption-outbox-postgres.test.ts
test/auth-bff-session-gateway.test.ts
test/auth-builder-integration.test.ts
test/auth-environment-boundary.test.ts
test/auth-google-oauth-loop-remediation.test.ts
test/behavioral/security.test.ts
test/browser-authorization.test.ts
test/browser-execution-suite.ts
test/builder-agent.test.ts
test/capability-reality-audit-suite.ts
test/durable-worker-authorization.test.ts
test/helpers/disposable-postgres-test-entry.ts
test/helpers/local-chromium.ts
test/helpers/postgres-execution-fixture.ts
test/helpers/standalone-specialist-worker.ts
test/identity.ts
test/integration.ts
test/isolated-neon-certification.ts
test/live-provider-agent-acceptance.ts
test/m2a-durable-specialist-execution.test.ts
test/m2a-production-activation-security.test.ts
test/m2a-real-postgres-verification.test.ts
test/migration-clean.ts
test/migration-path-b.ts
test/p1-6-6-guest-db-pool.test.ts
test/principal-provider-workspace.test.ts
test/recovery.ts
test/run-prompt-schema-drift.ts
test/staging-agent-mission-certification.ts
test/tool-calls-schema-drift.ts
test/tool-gateway-approval-fail-closed.test.ts
test/tool-gateway-certification.ts
test/verify-runtime.ts
test/workflow-approval-authority.test.ts
test/workflow-engine-preflight.test.ts
test/workflow-engine.ts
test/workspace-authority-migration-guard.test.ts
```