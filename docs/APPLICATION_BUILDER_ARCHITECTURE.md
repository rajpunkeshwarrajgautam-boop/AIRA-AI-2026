# AIRA Application Builder — Implemented Architecture

**Release verdict: NOT CERTIFIED.** Draft [PR #42](https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/pull/42) builds upon PR #40; tracked by Issue #41.

## Control-plane flow

```text
AIRA chat → server-authoritative APPLICATION_BUILD intent and capability registry
→ projects.write scope and explicit WRITE approval
→ ModelRouter live provider → structured source draft
→ ApplicationBuildClient (authenticated) → dedicated DockerProjectWorker
→ operator-approved offline cache resolution → npm lockfile validation
→ sandboxed npm ci --offline --ignore-scripts → syntax/build/test commands
→ verified source manifest and optional compiled dist manifest
→ short-lived preview → scoped source archive → project artifact
```

`packages/app-builder/src/worker.ts`: localhost control server, per-owner jobs, source/path checks, cancellation via AbortSignal + Docker cleanup, bounded concurrent jobs, offline package cache, per-job source files, compiled-preview tickets and integrity hashes. Worker state is kept outside untrusted source mounts.

`packages/app-builder/src/dependencies.ts`: exact operator allowlist checks; integrity/registry checks for lockfiles; rejects unsupported specs, lifecycle-install packages, non-npm registry URLs and untrusted lockfile paths. Lockfiles may be generated with `npm install --package-lock-only --offline --ignore-scripts` inside the sandbox from an operator-curated cache, followed by real `npm ci --offline --ignore-scripts`. No general network access is granted to generated code.

`packages/app-builder/src/preview-output.ts`: compiled `dist/` collection with supported extensions, bounded size/count, symlink rejection and per-file hashes. `dist/` output takes precedence over raw source preview; a source archive contains source and generated lockfile, not arbitrary build caches.

`packages/app-builder/src/queue.ts` and `packages/db/src/migrations/016_app_build_durable_queue.ts`: **PostgreSQL queue primitives**, not yet a complete dispatcher. Implement idempotent enqueue, atomic `FOR UPDATE SKIP LOCKED` claim, fencing generations, leased starts/heartbeats/finish, owner-scoped cancellation, cancellation acknowledgment and lease expiry recovery. These primitives are covered by `test/app-builder-queue.ts`.

`packages/agent-runtime/src/index.ts`: server-side scope and approval gate, worker health, capability-aware prompt, bounded model generation and real tool result recording. This path is still request-bound and does **not** yet use the new durable queue as an asynchronous scheduler. A successful model-authored test is never equivalent to independent product certification.

`src/components/ArtifactStudio.tsx`: dedicated project artifact type, separate trusted preview origin; cross-origin project iframe allows scripts and same-origin only for validated independent preview origin, while ordinary HTML snippets retain a stricter sandbox. Project source downloads require authentication and independent worker owner checks.

## Verified tests versus product acceptance

The Docker/Chromium worker test exercises real build and browser interaction for a **supplied calculator fixture**, cancel/denial, source export, compiled `dist` assets and offline Three.js install. It does **not** demonstrate an AI-generated calculator or playable AI-generated pinball.

The database test verifies queue/fencing primitives but does **not** demonstrate durable end-to-end background job execution on Vercel.

## Unresolved architectural work

- Independent live-model software-generation acceptance, model-driven calculator and 3D pinball.
- Vite/React/Three.js compiled application E2E with an approved full dependency cache, not just a Three.js module import.
- Production-grade execution isolation (rootless daemon/microVM and adversarial security verification).
- Durable worker-polling dispatcher, out-of-process agent execution, heartbeat orchestration and cancellation propagation from queue to worker.
- Hardened public preview gateway with per-user authorization, HTTPS, revocation and reliable TTL cleanup.
- Artifact object storage, source versioning and robust per-tenant quotas.
- Security assessment and staging certification.

**Do not advertise a general-purpose production coding agent from these infrastructure checks.**
