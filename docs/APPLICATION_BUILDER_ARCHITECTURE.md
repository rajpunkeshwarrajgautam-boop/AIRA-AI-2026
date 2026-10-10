# AIRA AI — Application Builder Architecture

**Status: PARTIAL, NOT PRODUCTION CERTIFIED.** Built in draft PR #42 (stacked on #40); tracking Issue #41.

## Request path

```text
Chat composer → /api/chat/stream → ServerIntentRouter(APPLICATION_BUILD)
→ CapabilityRegistry(PARTIAL only when explicit opt-in configured)
→ AgentRuntime (principal projects.write → ApprovalKernel WRITE)
→ ModelRouter real configured provider (structured multi-file draft)
→ ApplicationBuildClient HTTPS/loopback → dedicated DockerProjectWorker
→ per-job files → real docker node/npm checks (network none)
→ state/manifest/hashes on worker filesystem → short-lived static preview
→ tool events → text and distinct project artifact → Artifact Studio
```

The model-generated source is untrusted. The trusted API never invokes Docker. Docker is invoked solely on a separately deployed trusted worker host, running as a non-root OS account with access to a carefully managed daemon. The generated project is mounted only into an ephemeral isolated container. The worker must not run on Vercel.

## Existing implementation

- `packages/app-builder/src/worker.ts`: token-authenticated loopback control server, owner checks, source validation, bounded resources, typed build job states, manifest, static preview service.
- `packages/app-builder/src/archive.ts`: manifest-only tar.gz export with file hash checks and symlink rejection.
- `packages/app-builder/src/client.ts`: configured worker client and real-provider structured draft generator.
- `packages/agent-runtime/src/index.ts`: scoped/approved application-build branch, worker health preflight, two bounded generation/build attempts, evidence-bearing result. No claims of independently verified gameplay.
- `src/components/ArtifactStudio.tsx`: explicit project artifact type with allowlisted preview origin and source archive download.
- `src/utils/runEvents.ts` and `src/App.tsx`: approval value correction and SSE reconnect to persisted events.
- `test/app-builder-worker.ts`: actual Docker job, browser calculator fixture, negative cases, owner isolation and source export.

## Critical limitations

1. Package installation requiring network remains **not configured**. Worker rejects projects with third-party dependencies, including Three.js packages. This prevents the original 3D pinball benchmark from being certified.
2. The tested calculator is a **test fixture supplied by the certification suite**, not a model-created project. The model-driven user request path has not been certified against a live provider and deployed worker.
3. Only static files originally in the source manifest are served by the preview. A Vite dist lifecycle and arbitrary compiled assets are not yet implemented.
4. Job state is written to worker-local JSON and reloaded after restart with in-progress jobs marked BLOCKED. It is not a durable distributed queue and is not safe for horizontally scaled multi-worker production.
5. The API currently waits for bounded worker completion inside a request. Vercel execution time constraints and detached job streaming need engineering before production.
6. No independent generated-game gameplay tests, comprehensive artifact provenance signatures, full worker crash/cancellation safety, disk quotas, registry egress control, package lockfile supply-chain controls, or staging runtime certification yet.
7. The preview control server binds loopback and has an origin setting; safe public proxy routing, authentication, cleanup and production certificates require separate infrastructure.

The registry remains NOT_READY unless explicitly enabled; when enabled it is PARTIAL/BETA and must pass worker health for each request. Full readiness should be tied to production-certified worker health and independently verified acceptance checks.

## Acceptance definitions

`BUILD_PASSED` means configured command steps exited zero inside the worker. It does **not** mean user requirements were independently verified. Full project certification requires externally defined browser/product assertions in addition to model-authored tests and successful compilation.
