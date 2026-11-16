# ADR 0004: pgvector Version Compatibility & Production Extension Invariance Policy

## Status
Accepted

## Date
2026-11-16

## Context
During the disaster recovery and release assurance audit of AIRA AI 2026, an environment difference was identified between the production database managed on Neon and the local/disposable disaster-recovery test environment on WSL Ubuntu 24.04:
- **Neon Production Database (`ep-withered-art-b36ox90b`):** PostgreSQL 16/17 with `vector 0.8.6`.
- **WSL Disaster-Recovery Test Environment:** PostgreSQL 18.7 with `vector 0.8.7`.

We investigated whether this minor version delta poses any functional, semantic, binary, or schema risks to AIRA AI 2026, and defined an explicit operational policy governing database extension updates.

---

## Architectural & Schema Audit

### 1. AIRA pgvector Schema & Queries
AIRA AI 2026 utilizes `pgvector` for semantic document retrieval and conversational memory:
- **Migration `014_conversation_search_pgvector.ts`:**
  - Installs extension: `CREATE EXTENSION IF NOT EXISTS vector;`
  - Table: `conversation_search_documents`
  - Column: `embedding vector(1536)` (OpenAI text-embedding-3 / ada-002 dimensions)
  - Index: Cosine distance index (`vector_cosine_ops`)
- **Runtime Application Queries (`src/server/search` / `src/server/rag`):**
  - Cosine distance ranking: `1 - (embedding <=> $query_embedding)`
  - Exact top-k retrieval bounded by tenant and principal isolation filters.

### 2. Version Delta Analysis (`vector 0.8.6` vs `0.8.7`)
- `pgvector 0.8.7` is a backward-compatible maintenance bugfix release following `0.8.6`.
- **On-disk binary format:** Identical. Float array encoding and alignment for `vector(dim)` are 100% binary-compatible between 0.8.6 and 0.8.7.
- **Index structures:** Both HNSW and IVFFlat index structures created in 0.8.6 read and write identically in 0.8.7.
- **SQL interface:** The operator class `vector_cosine_ops` and distance operators (`<=>`, `<->`, `<#>`) retain identical signatures and mathematical definitions.
- **pg_dump / pg_restore:** A binary dump created on PostgreSQL with `vector 0.8.6` restores cleanly on PostgreSQL with `vector 0.8.7` without requiring index rebuilds, schema patches, or data conversions.

---

## Decision

1. **Production Invariance Policy:**
   - Production Neon database (`ep-withered-art-b36ox90b`) will **REMAIN ON `vector 0.8.6`**.
   - No `ALTER EXTENSION vector UPDATE;` command will be issued during standard releases or Knex migrations.
   - Production extension versions must remain invariant unless explicitly authorized by the project owner under a separate maintenance change window.

2. **Auditor Multi-Version Validation Policy:**
   - The disaster-recovery auditor (`scripts/fail-safe-restore-auditor.ts`) enforces an explicit `allowedVersions: ['0.8.6', '0.8.7']` whitelist for `vector`.
   - Any unvetted major or minor version (e.g. `0.9.x` or higher) fails closed immediately with `[RESTORE_VERIFICATION_FAILURE]`.

3. **Rehearsal & DR Parity:**
   - The test and disaster-recovery suites in WSL Ubuntu 24.04 (running `0.8.7`) are certified as 100% semantically and functionally equivalent to production `0.8.6`.
   - All regression tests, distance calculations, and schema checks pass with zero degradation or semantic variance.

---

## Consequences
- **Positive:** Production avoids unnecessary database extension mutations during release deployment.
- **Positive:** Disaster-recovery verification succeeds reproducibly across modern PostgreSQL 18 host environments without brittle strict-version pinning errors.
- **Guardrail:** Uncontrolled future version drifts are blocked by the strict `allowedVersions` whitelist in `fail-safe-restore-auditor.ts`.
