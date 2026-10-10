# Application Builder — Security and Trust Boundaries

## Implemented safeguards

- Authenticated AIRA principal and explicit `projects.write` approval before project execution.
- Owner check on worker job controls and project export; client cannot choose a different server principal.
- Loopback-only worker control endpoint, high-entropy token, no shell execution endpoint.
- Docker container runs as non-root, with no-new-privileges, dropped capabilities, disabled network, read-only root filesystem, temporary directory limits, process/CPU/memory bounds and command timeout.
- Docker job cancellation through AbortSignal and forced container removal on failed/aborted CLI invocation.
- Worker job metadata stored outside untrusted mounted workspace; source paths, archive paths and compiled preview paths checked for escapes and symlinks.
- Short-lived preview tickets, manifest allowlist, file hashes and CSP; compiled builds serve only validated `dist` assets.
- Offline npm installation from separate operator-curated cache; exact approved package/version maps, lockfile registry/integrity verification, `--ignore-scripts`, no sandbox network.
- PostgreSQL queue concurrency through row locks and generation fencing; user cancellation prevents late successful commits to a leased job.

## Significant remaining threats / release blockers

1. **Rootful Docker daemon**: running a worker as non-root does not make access to a privileged Docker daemon safe. Production startup now requires detectable rootless Docker, pinned image digest and HTTPS preview/frame origins; security review still needed.
2. **Package supply chain**: integrity hashes protect lockfile tarball identity but do not prove malware-free code. Operator-curated cache must be scanned, pinned and independently provisioned. npm scripts are ignored on install but project build/test scripts execute inside the sandbox.
3. **Distributed lifecycle**: PostgreSQL lease/recovery primitives exist, but API/runtime still use request-bound worker polling; no durable background dispatcher/fencing orchestration or full process tree audit.
4. **Public previews**: production TLS routing, account-level authorization, preview revocation, rate limits and serving untrusted browser code on a dedicated origin must be independently tested. Bearer tickets alone do not establish all of these.
5. **Host resources**: disk quotas, network-hardening at host level, per-tenant scheduling quotas, orchestration fencing, storage retention and external audit logs are incomplete.
6. **Filesystem races**: path validation and hash verification reduce risk but comprehensive TOCTOU/hardlink tests and openat-style root confinement remain outstanding.
7. **Autonomous generation**: fixture builds are not security or functional certification of arbitrary AI-generated apps; no live model-generated pinball accepted.
8. **Object storage**: distributed durable source/compiled output storage and integrity attestations are incomplete.

**Security verdict: NOT CERTIFIED FOR PUBLIC MULTITENANT USE.** Do not change production secrets, domain mapping, `aira-ai-live` or production Neon.
