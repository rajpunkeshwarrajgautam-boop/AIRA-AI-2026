# pgvector compatibility decision — reference

The canonical release decision is [ADR 0004: pgvector versions in disaster recovery and production](../adr/0004-pgvector-version-compatibility.md).

**Production:** Neon PostgreSQL 18.7 with pgvector 0.8.6 (verified read-only, 2026-11-16).

**Isolated recovery:** PostgreSQL 18.7 with pgvector 0.8.7 (observed restoration). This recovery result does not prove universal binary, index, or query equivalence.

**Security:** pgvector 0.8.7 addresses CVE-2026-103484 in IVFFlat index builds. Production patch assessment requires a separate approved security change; no upgrade is included in PR #178 or PR #184.

For evidence, limitations, authorized version policy, and acceptance gates, use the canonical ADR above. Do not use absolute workstation file links.
