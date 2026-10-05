# Aira Bot release gates

This file records deployment certifications that must not be lost between implementation phases.

## Deferred external gate — Oracle Cloud Docker smoke test

**Status:** ON HOLD by user request. Do not treat Docker computer mode as production-certified until this gate is completed.

Target host previously prepared by the user: Oracle Cloud Ubuntu VM. The exact host identity and access details must be re-confirmed at execution time rather than copied into repository documentation.

Run this gate when the repository-side Aira Bot work is otherwise ready for deployment certification.

Required evidence:

1. Verify Linux architecture, Docker Engine/Compose, CPU/RAM/disk and free space.
2. Check out the exact release candidate commit; do not test an uncommitted or moving branch.
3. Build `docker/aira-computer/Dockerfile` on the host architecture.
4. Start one isolated computer using production-equivalent hardening:
   - non-root user
   - read-only root filesystem
   - all Linux capabilities dropped
   - `no-new-privileges`
   - CPU/RAM/PID limits
   - bounded tmpfs
   - persistent named volume
   - runner API exposed on loopback only
   - authenticated runner secret
5. Verify runner health and authenticated control requests.
6. Verify per-user persistent computer identity and per-bot workspace separation.
7. Start Chromium inside the container and exercise open/click/type/scroll/wait/screenshot on a public test page.
8. Verify localhost, private, link-local and reserved network targets remain blocked.
9. Exercise an allowlisted terminal command and verify a non-allowlisted program is rejected.
10. Verify file traversal and symlink escape attempts are rejected.
11. Verify computer lease fencing and human takeover/return-control behavior.
12. Restart/suspend the container and confirm persistent browser/workspace state survives as designed.
13. Confirm no model/provider/API credentials are injected into the computer container.
14. Remove smoke-only containers/volumes that are explicitly disposable; do not alter unrelated services, DNS, firewall rules or production processes.

**Reminder rule:** when repository-side Aira Bot implementation reaches release/deployment certification, explicitly tell the user that the Oracle Cloud smoke test is the next required gate before enabling `AIRA_COMPUTER_PROVIDER=docker` in production.

## Repository gates

Every stacked Aira Bot PR must continue to pass:

- frontend build
- API typecheck
- lint
- computer runner syntax
- isolation/lease certification
- orchestration certification once introduced
- local computer regression
- browser E2E
- Vercel preview/build status where applicable

## Still external by nature

These cannot be fully certified by repository-only CI and need live credentials/infrastructure at the appropriate release stage:

- Oracle/production Docker runtime smoke
- live model-provider calls
- live Firebase authentication
- live Brave search
- OAuth connector authorization and provider-specific side effects
- horizontal multi-worker/queue load and failover testing
