# AIRA Builder — Cloud Artifact and Preview Handoff

**Verdict: NOT CERTIFIED FOR STAGING OR PRODUCTION.** Draft PR #45 extends PR #44 (on PRs #43, #42, #40). Existing production assets remain untouched.

## Implemented

- Private, content-addressed S3-compatible source/compiled storage (`object-store.ts`), signing requests with AWS SigV4; exact owner-scoped SHA-256 keys, conditional immutable PUT, read integrity checks, 32 MB per-object guard. Configured only when all five `AIRA_OBJECT_STORE_*` settings are present.
- Additive migrations 018 (owner-scoped source/compiled object metadata) and 019 (SHA-256-hashed preview grants).
- Authenticated compiled `dist/` export from the Docker worker, limited by the worker's verified manifest; dispatcher persists source and compiled outputs before queued success when private storage is enabled.
- Owner-checked download API; fallback to PR #44's bounded PostgreSQL archive when storage is disabled.
- Separate loopback preview service (`npm run worker:preview-gateway`), intended behind **dedicated-site HTTPS ingress**. Validates short-lived 5-minute grants, build-pass evidence, compiled digest, archive paths/types, CSP and strict Host. No database secrets or privileged worker commands are exposed to browser code.
- Artifact Studio requests a new authorized preview grant rather than using a stale worker-local URL for compiled cloud builds.
- Local CI: PostgreSQL, simulated S3 service, real Docker worker and browser fixture checks. Exact HEAD workflow must complete before code certification.

## Staging prerequisites (not provisioned)

1. Authorize an existing private S3/R2-compatible bucket with encryption, retention and least-privilege access. Put endpoint, region, bucket, access key ID and secret key in the **server-side secret manager**, never in Git/frontend/generated code.
2. Review and migrate staging database 018/019 only; verify queue and principal bindings.
3. Deploy independent persistent dispatcher and hardened worker host; do not run arbitrary builds in Vercel functions.
4. Provision a separate registrable-domain preview origin, valid TLS termination and private loopback reverse proxy preserving Host. Suppress URL/token paths from access logs; prevent cookies sharing AIRA's site.
5. Configure `AIRA_PREVIEW_GATEWAY_ENABLED=true`, `AIRA_PREVIEW_GATEWAY_ORIGIN`, `AIRA_PREVIEW_APP_ORIGIN` server-side and `VITE_AIRA_PREVIEW_ORIGIN` in the staging frontend build. Leave production disabled.
6. Run real hosted owner/denied-owner, token expiration/revocation, worker-loss, browser/WebGL and stress/security tests.

## Commands

`npm run test:app-builder-objects`
`npm run test:app-builder-preview-grants`
`npm run test:app-builder-preview-http`
`npm run test:app-builder`
`npm run worker:preview-gateway`

## Remaining blockers

No live bucket, paid host, preview DNS/TLS ingress or isolated deployment was created. Preview bearer-ticket URL privacy must be checked in real CDN/proxy logs. Full hostile-code isolation, durable large asset management, distributed orphan cleanup and live-model calculator/3D pinball are **NOT TESTED**. Vercel's recorded preview failure `BUILD_UTILS_SPAWN_1` at `npm run db:verify:deploy && npm run build` lacks accessible detailed build logs, so its root cause is unverified.

Do not modify `aira-ai.in`, `www.aira-ai.in`, `aira-ai-live`, production Neon or `main`/staging. Do not merge this feature as release-ready.