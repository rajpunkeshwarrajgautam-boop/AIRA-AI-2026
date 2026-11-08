# UNSLOP architecture extraction — 2026-11-08

## Scope and invariants

This is an isolated P2 refactor on `prod-release` baseline `bb14406a32f82eba8a2ae22736a80406bb129f44`.
It changes no release configuration, database schema, OAuth policy, or production state.
It is independent of the P0/P1 corrections in draft PR #157.

| Previously embedded code | Extracted module | Preserved contract |
| --- | --- | --- |
| `apps/api/src/index.ts` BFF registration | `apps/api/src/auth/register-bff-routes.ts` | All 17 HTTP method/path pairs, handlers and failure codes remain identical; session and CSRF middleware run before the registration call. |
| `packages/agent-runtime/src/index.ts` prompt classifiers | `packages/agent-runtime/src/intent-heuristics.ts` | Both functions retain their signature, behavior and public re-export at the existing index import path. |
| `src/App.tsx` execution approval presentation | `src/components/ExecutionApprovalBanner.tsx` | Parent retains approval dispatch; labels, disabling and theme classes are identical. |

## Verification

- `npm run typecheck`: PASS.
- `npm run build`: PASS (pre-existing >600 KB output warning remains).
- `node --import tsx --test test/unslop-entrypoint-contracts.test.tsx test/auth-bff-session-gateway.test.ts test/calculator-parsing-and-nvidia-routing.test.ts test/release-readiness-nvidia-repo-intent.test.ts`: PASS.
- Standalone database-dependent OAuth/security checks did not run successfully in this local environment: no isolated Postgres service was configured, so requests to localhost:5432 failed. They must run in disposable CI before merge; do not use production database credentials.

## Deliberately deferred

The three entrypoint files still own many coupled responsibilities. Any further extraction affecting state or middleware semantics requires additional integration tests and a separate review; file length by itself is not evidence of a behavioral defect.

**Release status:** draft-only until required GitHub CI and browser certification finish. Do not merge this refactor into a production branch solely on these local checks.
