# Application Builder — Deployment and Verification

**This branch is experimental; do not deploy publicly or enable on the production AIRA API.**

## Local development prerequisites

- Dedicated non-root Linux service account, Node.js 24, a separately managed Docker daemon.
- A reviewed worker image; production requires an immutable `@sha256:...` digest and a verified rootless Docker daemon.
- Trusted npm cache, if supporting third-party dependencies. A trusted operations job must prefetch vetted packages; user-generated code never gets registry/network access.

Example **development** configuration (use a secret manager for the token):

```bash
export AIRA_WORKER_TOKEN="<generate and store a random token >=32 chars>"
export AIRA_WORKER_ROOT=/srv/aira-builder/jobs
export AIRA_WORKER_PORT=4101
export AIRA_WORKER_PREVIEW_PORT=4102
export AIRA_WORKER_PREVIEW_ORIGIN=http://127.0.0.1:4102
export AIRA_WORKER_FRAME_ORIGIN=http://127.0.0.1:5173
export AIRA_WORKER_IMAGE=node:24-alpine
export AIRA_WORKER_NPM_CACHE=/srv/aira-approved-npm-cache
export AIRA_WORKER_APPROVED_PACKAGES_JSON='{"three":"0.180.0"}'
npm ci
npm run worker:build
```

App-side local test configuration:

```bash
export AIRA_BUILDER_ENABLED=true
export AIRA_BUILD_WORKER_URL=http://127.0.0.1:4101
export AIRA_BUILD_WORKER_TOKEN="<same secret, stored securely>"
npm run server
```

Both control and preview servers listen only on loopback; configure **independent TLS, authorization and separate preview origin** before remote use. For public-origin builds, `VITE_AIRA_PREVIEW_ORIGIN` must point to a different HTTPS origin than the AIRA app.

```bash
npm run db:migrate        # isolated CI/staging DB, NOT production
npm run test:app-builder-queue
npm run test:app-builder
npm run test:router
npm run test:reality
npm run build
```

The worker's package allowlist is **not** a license to publish arbitrary npm access. Refresh/scan trusted tarballs, pin container digests, block dependency lifecycle scripts and enforce offline execution. CI may prefetch an exact test package on its trusted runner; production prefetch must occur through reviewed artifact procurement.

## Release restrictions

In `NODE_ENV=production`, the worker intentionally fails startup unless:
- Docker reports rootless security configuration.
- The image uses an immutable SHA256 digest.
- Parent AIRA frame and preview origins are HTTPS.

These are baseline guards, **not** proof that a runner is production hardened. Keep `AIRA_BUILDER_ENABLED` disabled on production pending separate review.

Cancel individual jobs via the owner-scoped worker `DELETE /v1/jobs/:id`, proxied by `POST /api/app-builder/jobs/:id/cancel`.

## Rollback

Disable `AIRA_BUILDER_ENABLED` and revert via reviewed release workflow; preserve truthful NOT_READY behavior. The old `aira-ai-live` project and both `.in` domains are separate and must remain untouched.
