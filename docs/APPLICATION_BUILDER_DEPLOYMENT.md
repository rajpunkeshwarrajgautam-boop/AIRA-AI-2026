# Application Builder — Deployment and Operations

**Experimental local worker only. Not authorized for production deployment.**

## Prerequisites

Dedicated non-root Linux worker host with Node.js 24, npm, a reviewed Docker installation, ample storage, and an explicitly isolated Docker daemon. Never expose that daemon/socket to a generated application.

From the project root, generate a private high-entropy token in your deployment secret store (do not paste it into chat):

```bash
export AIRA_WORKER_TOKEN="<random secret at least 32 characters>"
export AIRA_WORKER_ROOT="/srv/aira-builder/jobs"
export AIRA_WORKER_PORT=4101
export AIRA_WORKER_PREVIEW_PORT=4102
export AIRA_WORKER_PREVIEW_ORIGIN="http://127.0.0.1:4102"
export AIRA_WORKER_FRAME_ORIGIN="http://127.0.0.1:5173"
export AIRA_WORKER_IMAGE="node:24-alpine"
npm ci
npm run worker:build
```

Control and preview listeners bind `127.0.0.1` only. Do not simply expose port 4101 to the internet. Build a reviewed authenticated TLS reverse proxy and separate preview origin before remote access. Preview ticket expiry is 15 minutes; worker disk cleanup and artifact lifecycle automation remain incomplete.

App-side **development only**, when worker and app run on the same trusted local host:

```bash
export AIRA_BUILDER_ENABLED=true
export AIRA_BUILD_WORKER_URL="http://127.0.0.1:4101"
export AIRA_BUILD_WORKER_TOKEN="<same private worker token>"
npm run server
```

Do not set `AIRA_BUILDER_ENABLED=true` on public Vercel merely to bypass an unavailable worker. Do not enable `AIRA_ALLOW_SHELL` on production API hosts. Never put secrets in `VITE_` variables.

For an authorized remote deployment the worker URL must use HTTPS, the public preview must live at a separately controlled HTTPS origin, and `VITE_AIRA_PREVIEW_ORIGIN` must exactly match that origin. The origin must be routed to preview service with strong user/account access policy; current short-lived tickets are a prototype.

## Verification

```bash
docker pull node:24-alpine
npm run test:app-builder
npm run test:router
npm run test:reality
npm run build
```

CI runs `Isolated Application Worker` with a real Docker daemon and Chromium browser. The Docker base image must be pinned by immutable digest and verified for supply chain before production. Docker image security, preview origin isolation, package mirror restrictions and staging acceptance are release blockers.

## Rollback

Disable `AIRA_BUILDER_ENABLED` and redeploy only through the normal certified release workflow. This restores the explicit NOT_READY behavior. Do not move `aira-ai.in` or `www.aira-ai.in` or alter the old `aira-ai-live` backup project.
