# Application Builder Security Notes

**Trust boundary:** untrusted generated source never executes in the application/API process. Worker auth requires a high-entropy token and an owner identity from the authenticated API. Never expose the token or Docker daemon to the browser.

## Implemented mitigations

- Explicit `projects.write` scope plus WRITE approval before project generation and execution.
- Worker access token compared using timing-safe equality; control listener bound to loopback.
- Worker must run as a non-root OS account; Docker-run is non-root, network disabled, root filesystem read-only, caps dropped, no-new-privileges, resource limits and isolated temporary directory.
- Worker only invokes fixed argv operations: Node syntax check and npm build/test scripts. No arbitrary command endpoint.
- Per-job randomized workspace directories, path-component validation, size limits, maximum files, symlink restrictions and source hash manifests.
- Owner-checked job lookups and authenticated source archives; public preview uses random short-lived ticket and manifest-only file serving, with frame-origin CSP, no-referrer and no-store.
- Distinct BUILD_PASSED state prevents equating successful build commands with independent gameplay certification.

## Unresolved high-priority security work

1. Worker Docker daemon access must be isolated from other workloads (non-root worker process alone does **not** make a rootful Docker socket safe). Prefer rootless, microVM or otherwise hardened runner with independent security review.
2. Container termination must be hardened for CLI timeout, host restarts and orphan cleanup. Current 45-second command timeout is not a complete cancellation protocol.
3. Enforce disk quota, storage retention, job expiry, global and per-tenant quotas, robust audit logs, idempotency, durable queue/leases and concurrent worker fencing.
4. External dependency installation needs tightly constrained registry-only egress, reproducible lockfiles, malware/supply-chain controls, integrity pins and vulnerability checks before it may be enabled.
5. Dedicated HTTPS preview routing, explicit per-user authorization, origin separation, replay protection and ticket invalidation need independent testing.
6. Generated JS/browser preview does not yet have a complete automated security/a11y/gameplay acceptance suite.
7. Worker source paths and archives should undergo adversarial symlink, hardlink, Unicode and TOCTOU testing. Audit potential data retention and log leak risks.
8. `node:24-alpine` is currently selected by mutable tag for local CI; pin a reviewed immutable digest before staged deployment.
9. No evidence of remote production deployment or provider-driven model source generation is established by current worker fixture tests.

**Production verdict:** NOT CERTIFIED. Do not deploy the worker to a public reachable execution environment or claim production-grade isolation until all blocking issues are resolved.
