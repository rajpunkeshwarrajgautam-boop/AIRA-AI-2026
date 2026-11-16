# ADR 0001 / ADR 0004: pgvector Version Compatibility & Production Extension Invariance Policy

Please refer to canonical ADR at [docs/adr/0004-pgvector-version-compatibility.md](file:///C:/Users/WORKSTATION/AIRA-PR183-MIGRATION-HARDENING/docs/adr/0004-pgvector-version-compatibility.md).

## Summary
- **Neon Production Database (`ep-withered-art-b36ox90b`):** PostgreSQL 16/17 with `vector 0.8.6`.
- **WSL Disaster-Recovery Environment:** PostgreSQL 18.7 with `vector 0.8.7`.
- **Finding:** Full binary, on-disk, and query compatibility confirmed for `vector(1536)` and cosine distance `<=>`.
- **Policy:** Production remains on `0.8.6` (no unattended extension update). Parity auditor whitelists `['0.8.6', '0.8.7']` and fails closed on all other versions.
