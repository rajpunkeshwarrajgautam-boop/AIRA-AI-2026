# AIRA AI 2026 — Post-release acceptance status and evidence register

**Audit date:** 2026-11-18 (UTC). **Source of truth:** GitHub, Vercel and Neon read-only connector queries, plus separately identified owner-supplied Gate 3 report.  
**Production:** https://aira-ai-2026.vercel.app  
**Technical deployment status:** LIVE / PROMOTED. **Full authenticated end-to-end sign-off:** **PENDING**. This register is documentation only, not authorization for further changes.

## 1. Release identity and completed certification

| Evidence | Status and identity |
|---|---|
| PR #185 | MERGED at 2026-11-18T16:23:42Z: https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/185 |
| Production Git HEAD | `b5a27f391447b68448edf067cdb2ee62a598c264` |
| Pre-merge candidate | `4b2074776f790d23fa93fa320a52a4ceed361eeb` |
| Production Vercel deployment | `dpl_BTiLvhq77siuaz655zZARHdBKuBZ`: READY, commit matches production HEAD |
| Production alias | `aira-ai-2026.vercel.app` assigned to `dpl_BTiLvhq77siuaz655zZARHdBKuBZ` (Vercel alias API) |
| Production CI | GitHub Actions run `44346736429`: COMPLETED / SUCCESS at last API update 2026-11-18T16:35:49Z. `Fast CI`, `Semantic Search CI`, `Main / PR certification` succeeded. https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/actions/runs/44346736429 |
| Visual | Production Edge visual acceptance: SUCCESS; deployed staging acceptance: SKIPPED under staging-only workflow condition |
| Database | Neon project `old-sky-50952395`, main branch `br-shiny-moon-b3vy9xj7`: 32 applied migrations; migration `032_reconcile_workflow_run_artifacts.ts` applied; `workflow_runs.artifacts` = nullable `jsonb` default `'[]'::jsonb`; Knex lock = 0 |
| Recovery checkpoint | Neon branch `br-orange-art-b3vzajv0` (`pre-migration-032-checkpoint-20261118`), READY, parent `br-shiny-moon-b3vy9xj7`, parent LSN `0/1E912998` |
| Previous Vercel deployment | `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8`, READY; application rollback target only |

## 2. Three remaining audit items

### Item 1 — Post-merge exact-SHA production CI — COMPLETE
- Verified `44346736429` completed SUCCESS on `b5a27f391447b68448edf067cdb2ee62a598c264`.
- No further CI rerun is required without a new SHA, discovered defect or explicit policy requirement.

### Item 2 — Authenticated production acceptance — OPEN (not independently verified)
The owner-supplied Gate 3 report claims **7/7 public endpoint and anonymous security smoke checks**. Those cover service health, headers, session isolation for anonymous callers, HTTP 401/403 authorization boundaries, and schema state. They **do not prove** successful sign-in or actual AI product behavior.

Required acceptance, each with traceable timestamps, principal/plan test labels (no secrets or PII), expected and observed results, and safe cleanup:
1. **Google OAuth:** complete interactive sign-in, session refresh, CSRF and logout; confirm intended user isolation.
2. **GitHub OAuth:** complete separate interactive sign-in and logout; use an independent test principal.
3. **Guest/Free/paid entitlements:** compare server-returned quotas, permitted models, restricted actions, monthly/daily usage accounting, and enforced upgrade/limit boundaries; test billing writes only if separately authorized, using test-safe fixtures or a non-billable path.
4. **Real inference and streaming:** authenticated model request returns a real response with provider routing evidence; inspect SSE framing, completion/error handling, abort/cancellation and durable tool results.
5. **Agent execution and account isolation:** verify permitted tool access, ownership of runs and artifacts, and that principal A cannot read/cancel/stream principal B's resources. Run data-changing tests only after scoped production test authorization.

**Execution prerequisites:** owner-controlled authenticated browser sessions for two distinct test accounts, scoped test permissions, agreed test budget, and approval for any test operation that writes production data. Do not request passwords, cookies, API tokens or OAuth secrets. If the browser/session cannot be accessed securely, mark the test **NOT VERIFIED**, not PASS.

### Item 3 — Rollback and backup evidence correction — DOCUMENTED / INDEPENDENT RESTORE NOT VERIFIED
- Preserved Vercel deployment is an **application-code** rollback target. Rollback can affect availability and is not guaranteed within 30 or 60 seconds. Record measured alias change, application health, version, and audit evidence if invoked under approval.
- Preserved pre-migration Neon checkpoint is a distinct **database** recovery point; it is not an application rollback. It excludes transactions committed after its parent LSN and timestamp. Recovering them requires authoritative durable write evidence and verified reconciliation. **Access logs and renewed OAuth sessions alone do not reconstruct committed writes.**
- The owner-supplied local backup report identifies archive `aira_prod_main_backup_20261118160905.dump.enc`, SHA-256 `c06ec3b00e833f1981f546b1e6bca940c86a75b00d3e622542523502e0c02e16`, and 48 tables / 12,494 restored rows. **Archive bytes, checksum and isolated restore logs were not independently accessible from connected tools**, so parity remains **REPORTED PASS / INDEPENDENT VERIFICATION PENDING**.
- Preserve checkpoint, backup and previous Vercel deployment; do not delete, reset or repoint anything without approval.

## 3. Current release verdict

**Deployed production release: VERIFIED LIVE. Gate 2 schema: VERIFIED. Production exact-SHA CI: VERIFIED PASS. Full authenticated product acceptance: PENDING.** Keep the production release in place unless a verified incident warrants a separately authorized rollback. Do not call this full feature certification until Item 2 and backup verification have documented evidence.

No production Git changes, database writes, new deployment, recovery reset or rollback were made to produce this register.
