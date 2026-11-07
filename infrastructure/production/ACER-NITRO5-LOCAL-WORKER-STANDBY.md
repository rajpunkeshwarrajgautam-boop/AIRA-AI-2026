# PR #127 — Acer Nitro 5 local worker preparation (Option 2)

**Status:** Preparation only. **NOT deployed, NOT production-ready, NOT authorized for activation.**

This is an infrastructure-target addendum to PR #127. It supersedes Oracle-specific
host assumptions in historical deployment guides **only after** an owner-approved
target change. The Acer deployment must not inherit OCI provisioning or GO LIVE
authorization. Use the live PR description and verified GitHub/Neon state for
current SHAs and migration status; several historical PR #127 documents contain
obsolete candidate SHAs and refer to migrations 026–031 as all pending.

## 1. Bounded scope and known baseline

- Target host: user's **spare Acer Nitro 5 AN515-57**, Intel Core i5-11400H
  (**x86-64/AMD64**), 16 GiB RAM, 500 GB SSD, NVIDIA RTX 3050 4 GB.
- Proposed host OS: Ubuntu Server 24.04 **amd64**. OS installation is **not**
  authorized yet; preserve the existing OS, partitions, recovery media, and data.
- The laptop currently has a **motherboard fault** and is due for repair. No
  reliability, storage, thermals, networking, or continuous-operation results
  exist for this host yet.
- Dedicated worker runs as a separate host from the existing staging worker.
  The RTX 3050 is **not** needed for the existing NVIDIA NIM inference path.
- Reported PR #127 at the start of this preparation: draft, head
  `1f4cca0a03bcc73c4f05e6d9dac45ca45b066cc5`; production branch
  `prod-release`, deployment domain `https://aira-ai-2026.vercel.app`.
  Re-read remote state before *any* subsequent release step.
- Production Neon project `old-sky-50952395`, primary branch
  `br-shiny-moon-b3vy9xj7`; **026–030 applied, 031 pending**, per the
  operator handoff (not independently re-queried by this preparation).
- Recovery branch `prod-recovery-pre-031` (`br-plain-credit-b36c2tfh`) and
  logical backup reportedly exist. Prior restore evidence claims PostgreSQL 18,
  46 tables, 10,974 rows, exact count parity and encrypted offsite copy. **Recheck
  independent decryption-key retrieval and restore provenance before cutover.**
- Oracle PAYG upgrade and paid infrastructure are **out of scope**. Neither
  worker placement nor cloud spending may change without separate authority.

## 2. Changes prepared in this branch

The production Compose manifest now chooses the host platform through
`AIRA_TARGET_PLATFORM`, defaulting to the existing `linux/arm64` target. Both
`specialist-worker` and `sandbox-runner` have matching runtime and build
platforms. The optional production environment field accepts **only**
`linux/arm64` or `linux/amd64`. The Acer's authorized value will be
`linux/amd64`; default Oracle behavior remains `linux/arm64`.

The existing controls are intentionally unchanged: Stage A feature gate is
false; the worker's published port binds only to host loopback; the sandbox
network remains internal; root privileges, Docker socket access, and local
host Python fallback remain forbidden; worker concurrency starts at one;
memory/CPU limits remain conservative until a real-host benchmark passes.

**These edits are not part of the immutable certified PR #127 SHA.** Integrate
them through review on a new candidate, rerun all affected gates, and obtain
a new exact-SHA release authorization before production deployment.

## 3. Repair and reliability gates — do not skip

Before considering this laptop a production host:

1. Complete motherboard repair. Verify sustained cold/warm boots, no WHEA/
   firmware/hardware errors, stable AC adapter, charging and reliable RTC.
2. Obtain the owner's explicit disk/OS-preservation choice. Back up personal
   data and create recovery media *before any repartition or OS installation*.
   Installing Ubuntu could erase the pre-existing OS and is not in this task.
3. Run extended memory testing, SSD SMART long test and read-only disk health
   inspection; monitor CPU temperature/throttling under sustained load; check
   fan operation. Confirm at least 80 GB free for images/logs/workspace, with
   a comfortable future headroom margin. A 1 TB SSD is optional, not required
   for the initial standby worker if the existing drive is healthy.
4. Use reliable wired networking if available; verify stable outbound DNS,
   HTTPS to Neon and the API providers, TLS verification, NTP time sync, and
   sustained 24-hour connectivity. CGNAT/dynamic public IP is acceptable
   because this worker uses outbound polling; **no public inbound worker port**.
5. Keep the host connected to AC, configure no automatic sleep on idle or lid
   close, enable restart after power loss if firmware supports it, evaluate UPS
   and internet failover. Treat a consumer laptop as **lower availability**
   than a managed production VM until measured otherwise.
6. After security updates, kernel/firmware compatibility and Docker validation,
   perform at least 48–72 hours of **standby-only** burn-in, including reboot,
   power interruption recovery, log rotation, image restart, and thermal checks.
   Do not schedule any real production job during burn-in.

## 4. Proposed Ubuntu Server 24.04 AMD64 configuration (after repair)

The commands below are **future runbook steps, not execution instructions for
the current preparation session**. Run them only on the verified, approved
host with an authorized operator and non-sensitive shell output handling.

1. Secure Ubuntu: non-root administrative account; SSH key authentication;
   disable password/root SSH login; automatic security updates; least-privilege
   host firewall. Restrict admin SSH to trusted source IPs/VPN. Do not expose
   TCP 8080 or sandbox TCP 8000 to the LAN or internet.
2. Install a supported Docker Engine and Compose plugin from signed packages.
   Confirm `uname -m` shows `x86_64`, `docker compose version` works and the
   engine reports `linux/amd64` as its native architecture. Do not enable
   untrusted Docker TCP API or mount `/var/run/docker.sock` into workloads.
3. Place the **approved, pinned, reviewed** code in `/opt/aira`. The checkout
   commit must equal the new approved release candidate; do not silently use
   the old PR #127 candidate with the AMD64-only changes missing.
4. Using a local secure editor and secrets delivery mechanism, create
   `/etc/aira/production-worker.env` from the template, owned by `root:root`
   and mode `0600`. Never commit, upload, paste, or echo its secrets. Set:

   ```dotenv
   AIRA_TARGET_PLATFORM=linux/amd64
   WORKER_ID=worker_acer_nitro5_production_01
   WORKER_CONCURRENCY=1
   AIRA_PRODUCTION_WORKER_ENABLED=false
   WORKER_PORT_BINDING=127.0.0.1:8080:8080
   AIRA_REQUIRE_CONTAINER_SANDBOX=true
   AIRA_ALLOW_LOCAL_SANDBOX=false
   ```

   Retain correct production Neon identity assertions, TLS-enabled **pooler**
   connection, 32-byte encryption keys and isolated sandbox token. Load actual
   credentials only through the secured host environment; do not substitute
   staging credentials. Validate no existing staging `WORKER_ID` is reused.

5. From `/opt/aira`, verify Stage A config **without printing secrets**:

   ```bash
   sudo /opt/aira/node_modules/.bin/tsx infrastructure/production/scripts/validate-production-environment.ts --env-file /etc/aira/production-worker.env --stage A
   sudo docker compose --env-file /etc/aira/production-worker.env -f infrastructure/production/docker-compose.prod.yml config --quiet
   ```

   Install the audited, lockfile-pinned Node dependencies on the approved host
   before invoking the local `tsx` binary. These commands are meaningful only
   after actual host installation. Do not
   use plain `docker compose config` in shared logs because it can print
   secrets. Confirm all resulting image platforms are `linux/amd64`.

6. Build both images on the host and inspect the resulting platform, Chromium
   availability, Python runner health, read-only isolation and resource limits.
   Install the reviewed unit from `systemd/aira-production-worker.service` only
   after Docker and credentials are ready. On host startup, **Stage A only**:

   - `/health` at `http://127.0.0.1:8080/health` returns HTTP 200 standby.
   - `/ready` at `http://127.0.0.1:8080/ready` returns HTTP 503 standby.
   - No task claims, DB leases, actual jobs, or production side effects occur.
   - Sandboxed Python and browser images run under non-root users, with
     containment intact; no host ports beyond `127.0.0.1:8080`.
   - Stop on startup crash, wrong database identity, unexpected job polling,
     failed sandbox isolation, or thermal/network instability.

7. Record timestamped evidence with sensitive fields redacted: exact Git SHA,
   host architecture/OS, Docker versions, checksums/image digests, permission
   mode, tests, `/health`, `/ready`, zero-claim counters, restart/burn-in result,
   connectivity measurements, disk/memory/thermal summary. Keep logs private.

## 5. Production release gates remain closed

The following require separate evidence and a **new bounded exact-SHA owner
authorization** under `AGENTS.md`:

- Incorporate the AMD64 compatibility patch into a reviewable PR, rerun CI and
  staging/browser acceptance, and verify the GitHub App release authorization
  status against the new, fully qualified candidate SHA.
- Independently recover the actual production backup decryption key, restore
  its data into isolated PostgreSQL 18, verify manifest integrity/row parity
  and maintain a fresh recovery point. Never overwrite a live database for
  this exercise.
- Verify production migration `031_autonomous_agent_tasks.ts` through a
  disposable rehearsal and secure schema review, then authorize and apply it
  out-of-band **only as part of the owner-approved cutover sequence**.
- Verify Vercel project and `prod-release` SHA, deployment, rollback target,
  staging isolation, live login/account separation, autonomous task claims,
  concurrency/crash recovery, streaming, Python sandbox, browser and tools.
- Explicitly authorize the changed worker target (the local Acer), host
  identity and location scope, deployment domain, Neon identity, migration,
  activation order, stop/rollback conditions and approval window. The prior
  OCI-specific authorization does **not** authorize this topology change.
- After all gates pass, approve any merge into `prod-release` and production
  Vercel deployment. Merging to this branch **automatically triggers** the
  production deployment. Do **not** merge as a test.
- Only then, in the approved order, switch the Acer worker from Stage A to
  Stage B. Recheck `/ready`, one successful disposable task, isolation and
  throughput; return to Stage A on failure.

**Option 2 exit criterion:** Code, tests and runbook prepared now. The Acer
worker remains uninstalled/inactive while the motherboard is being repaired.
No production deployment, migration 031, PR merge, OCI spending or staging
modification is implied by completing this preparation.

## 6. Preparation-session verification (non-production)

On a Linux development executor with Node.js 24, `npm ci --ignore-scripts`
completed; `npm run typecheck`, `npm run build`, and `npm run lint` exited 0.
Lint emitted existing warnings, and the build emitted a large-chunk advisory.
The migration 031 mock rehearsal passed 8/8 assertions and the migration
026–031 recovery simulation passed 8/8 assertions. Tracked-file secret hygiene
reported zero exposed credentials. Five targeted production Compose, systemd,
template, platform-selection, and validator tests passed 5/5.

The **full** production-worker test suite did **not** pass in this executor:
its child processes use `tsx` IPC sockets and locally bound HTTP servers which
the executor denied with `EPERM`; the checked-out template also lacked the
POSIX `0600/0640` mode expected by a filesystem-permission test. Those are
test-environment limitations, **not** evidence of passing real standby
runtime acceptance. The executor has no Docker daemon, so real AMD64 image
build, Compose rendering, worker lifecycle and hardware reliability remain
unverified until the Acer is repaired. Tests using mocks must not be described
as an actual production backup restore or a live Neon migration rehearsal.
