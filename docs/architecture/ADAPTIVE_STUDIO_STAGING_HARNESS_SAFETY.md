# Adaptive Studio — Isolated Staging Certification Harness Safety

Status: code-level guards prepared; live execution pending branch-scoped credentials and Auth integration.

## Target and authority boundary

- Neon project: `mute-frost-50372225` (staging only).
- Allowed existing branch: `pr-agent-tool-calls-isolated` (`br-muddy-wave-b3zxhkqf`).
- Production project `old-sky-50952395`, permanent staging `main`, and commercial branch `br-green-snow-b3dsci5u` are **not** approved execution targets.
- No migration, database provisioning, specialist worker startup, PR merge, deployment, or production feature-flag change is part of these scripts.

## Agent mission certification

`test/staging-agent-mission-certification.ts` checks the real Neon project/branch identity and existing `tool_calls` columns/indexes **read-only**. It no longer calls `reconcileToolCallsSchema`, so it cannot silently apply migration 025. The runtime mission requires `AIRA_STAGING_MISSION_WRITES_ENABLED=true` and creates a randomized test principal. After execution it attempts to cancel any active fixture run and deletes only records identified by that principal, relying on the existing foreign-key cascade for run-owned records. Cleanup refuses to delete an active run or unexpectedly multiple runs.

If cancellation or cleanup fails, the suite fails closed and reports the generated fixture principal for investigation. It never attempts broad data deletion.

## Auth and cross-principal certification

`test/auth-security-authorization.test.ts` requires:

- An explicitly configured isolated `STAGING_DATABASE_URL` (or `DATABASE_URL`).
- Explicit `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` pointing to the **same compute ID** verified from Neon PostgreSQL GUCs on branch `br-muddy-wave-b3zxhkqf`.
- Two distinct **pre-existing** test accounts via `STAGING_AUTH_TEST_USER_A_EMAIL`, `STAGING_AUTH_TEST_USER_A_PASSWORD`, `STAGING_AUTH_TEST_USER_B_EMAIL`, and `STAGING_AUTH_TEST_USER_B_PASSWORD`.
- `AIRA_AUTH_TEST_FIXTURE_WRITES_ENABLED=true` for application fixture writes.

There is no hard-coded Auth fallback and no unattended user signup. Created automation and conversation fixtures are deleted through their identity-bound application APIs in `finally`; failed cleanup makes the suite fail. Tests of the Auth URL and explicit opt-in guards are in `test/staging-certification-safety.test.ts`.

At the time of this preparation, the existing Auth URL (`ep-ancient-sound-b3drtnp5`) belongs to the **commercial** branch, whereas the selected staging agent branch uses compute `ep-purple-dew-b337uqdy`. **Do not run the auth suite until branch-specific authentication is available and verified.**

## Execution policy

1. Verify the exact Git commit/PR and Neon control-plane branch/compute before running.
2. Run all offline guards and compare lint/test results against the exact target SHA.
3. Use a secret-injected isolated runner; do not print connection strings, access tokens, or passwords.
4. Verify no unrelated staging rows were modified and fixture cleanup completed.
5. Treat failures, missing infrastructure, or unverified Auth provenance as **blocked**, not skipped passes.
6. Obtain separate exact-SHA GO LIVE authorization before any production merge or deployment.
