# AIRA-AI-2026 — Crash Recovery and Durable Source Archive Certification

**Status: REVIEW PENDING, NOT PRODUCTION CERTIFIED.** Draft PR #44, stacked on PR #43 → PR #42 → PR #40.

## What changed

### Remote worker creation idempotency

\`packages/app-builder/src/worker.ts\` accepts an optional \`idempotencyKey\` and derives a stable owner-scoped UUID from SHA256(owner + NUL + key). It records a source-and-steps request digest. Repeated identical requests return the same job without launching another container; conflicting content fails with \`BUILD_IDEMPOTENCY_CONFLICT\`. The stable ID and digest persist with job state across worker restarts. Atomic workspace creation prevents a simultaneous duplicate request from corrupting another job's workspace; concurrent duplicate requests may need to retry a transient 400 and are not guaranteed a shared synchronous response.

\`ApplicationBuildClient.findByKey()\` reconstructs the stable ID and inspects worker state with authenticated owner identity. \`dispatcher-execution.ts\` performs this lookup **before** a new model invocation and worker creation for the same queue+attempt. A recovered successful job can be reused without a second model call or container. A missing job may trigger generation again; provider calls before accepted worker submission are not exactly-once.

**Limit:** this protects retries routed to the same durable worker storage. Changing workers or losing the entire worker disk without a shared placement ledger still requires stronger distributed coordination. A crashed worker may reload in-progress jobs as \`BLOCKED\`, not silently PASS.

### Bounded durable source archive

\`packages/db/src/migrations/017_app_build_archives.ts\` adds an owner-scoped immutable bytea record keyed by queue job ID, capped at 1.5 MB. \`packages/app-builder/src/artifact-store.ts\` verifies SHA-256 on save and read and rejects immutable overwrite conflicts and cross-owner lookups.

\`dispatcher-execution.ts\` downloads the worker-created, manifest-validated tar.gz and saves it in PostgreSQL **before** committing queue success. The persisted project artifact includes \`queueJobId\` and \`archiveSha256\`.

\`GET /api/app-builder/queue/:id/source\` resolves identity from the authenticated principal and returns the archived bytes even if the original worker is unavailable. Artifact Studio selects this owner-scoped URL for queued projects and verifies the archive checksum in the browser before downloading.

**Limits:** PostgreSQL bytea is a staging-scale durable storage bridge, **not** a production object storage solution; compiled \`dist/\` assets, CDN previews, arbitrary large projects, retention/quotas and externally signed provenance remain unimplemented. A database backup/restore policy and encryption assessment remain required before staging certification.

## Test commands

\`\`\`bash
npm run db:migrate
npm run test:app-builder-artifacts
npm run test:app-builder
npm run test:app-builder-dispatcher
npm run build
\`\`\`

Expected checks:

- Immutable store idempotent writes, tenant access denial, conflict rejection, size bounds and tamper detection with real PostgreSQL.
- Keyed worker duplicate submission, mismatched source denial, different-owner denial and restart survival with real Docker.
- Existing queue/dispatched jobs and full repo integration tests remain green.

**A workflow is not a PASS until its exact final HEAD run reaches SUCCESS.**

## Important unfinished acceptance

- No real model-generated calculator acceptance.
- No model-generated playable Three.js/physics pinball acceptance.
- No deployed hardened rootless/microVM worker or staging dispatcher.
- No separate authenticated HTTPS preview gateway with revocation and origin security checks.
- No independent full browser gameplay acceptance harness for generated pinball.
- No cross-worker shared durable execution ledger, crash cleanup and image security attestation.
- No Vercel preview build fix; known \`db:verify:deploy && npm run build\` exit 1 lacks detailed authorized logs.
- No public domain cutover or production launch.

**VERDICT: APPLICATION BUILDER NOT CERTIFIED — BLOCKERS REMAIN.** Preserve \`aira-ai.in\`, \`www.aira-ai.in\`, \`aira-ai-live\` and production Neon.
