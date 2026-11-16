# ADR 0004: pgvector versions in disaster recovery and production

**Status:** Conditional DR compatibility accepted; production extension change requires separate approval  
**Date:** 2026-11-16

## Verified environment identities

Read-only inspection of the Neon production branch `br-shiny-moon-b3vy9xj7` on 2026-11-16 reported **PostgreSQL 18.7**, with `vector` extension **0.8.6**. This supersedes older descriptions of production as PostgreSQL 16/17.

The isolated WSL recovery environment reported PostgreSQL **18.7**, with `vector` extension **0.8.7**. A real encrypted backup from 2026-11-15 was successfully authenticated and restored there, and its catalog and historical row-count checks were recorded separately.

**Scope of evidence:** successful restoration across these extension versions demonstrates recovery of this specific backup under the tested environment. It does **not** establish general binary/on-disk equivalence for every vector index, identical planner choices, or complete semantic and performance equivalence for all vector queries.

The historical backup catalog contains 48 tables and 12,464 rows. A read-only production check on 2026-11-16 found 48 tables and 12,483 rows, with changes in seven tables. These differences must be treated as possible legitimate post-backup activity, not silently called exact current-production parity or proof of restore failure. Historical backup parity must be assessed against authenticated backup-time evidence.

## Security and compatibility risk

According to the upstream pgvector 0.8.7 release notes, version 0.8.7 fixes a buffer overflow in IVFFlat index builds (CVE-2026-103484) and an `avg` aggregate error when no rows match. The PostgreSQL project advisory notes that the buffer overflow could permit arbitrary code execution and recommends upgrading when possible.

Sources:
- https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md
- https://www.postgresql.org/about/news/pgvector-087-released-3392/

The production installation at 0.8.6 should therefore receive a **separate, security-reviewed exposure assessment**, covering whether IVFFlat index creation is reachable and whether a controlled patch upgrade is warranted. No upgrade or production data change is authorized by this ADR.

## Decision and gates

1. Keep Neon production at its observed `vector 0.8.6` pending separate owner-approved maintenance. Do not run `ALTER EXTENSION vector UPDATE` during this release.
2. Permit `vector 0.8.7` **only for the isolated PostgreSQL 18 recovery acceptance scenario already exercised**. The auditor may explicitly accept both versions under that documented DR policy; that whitelist is not a universal compatibility guarantee.
3. Fail closed on unreviewed extension versions, missing extension metadata, or catalog/schema mismatches.
4. Before proposing a future production extension change, run representative vector insert/search, cosine-distance, index-build and index-scan regression tests, document query-plan changes, check affected indexes, and establish rollback and restoration procedures.
5. Keep the PR #178 + PR #184 release separate from PR #179 Workspace V3 and from any pgvector production upgrade.

## Outstanding validation

Deployed authenticated staging acceptance is distinct from GitHub Preview CI and must be evidenced separately. Exact-parity certification must distinguish backup-time catalog evidence from the live mutable production database. Neither this ADR nor successful DR restoration authorizes a protected-branch merge or production deployment.
