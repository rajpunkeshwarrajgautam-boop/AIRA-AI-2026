# Aira website/file builder — Multi-Provider Architecture & Setup

This is a code integration on branch `feat/isolated-builder-agent` for Builder PR #73. It extends the existing React/Vite + Express application with a provider-neutral sandbox execution layer.

---

## 1. Provider Architecture

AIRA Builder routes sandbox execution through a provider-neutral interface:

```text
AIRA Builder
    |
    v
BuilderService
    |
    v
SandboxProvider / MultiProviderSandboxFactory
    |
    +--> LightningSandboxProvider    PRIMARY (Lightning AI Sandbox)
    |
    +--> E2BSandboxProvider          OPTIONAL FALLBACK (E2B)
    |
    +--> OCISandboxProvider          FUTURE / BOUNDARY (Oracle Cloud Infrastructure)
```

### Primary Provider: Lightning AI Sandbox
- **Provider name**: `lightning`
- **Account / Organization**: `rajpunkeshwarrajgautam-org`
- **Teamspace**: `rajpunkeshwarrajgautam-org/aira-ai-2026`
- **API Key variable**: `LIGHTNING_SANDBOX_API_KEY` (private server environment variable)
- **Runtime Defaults**:
  - `runtime`: `node24` (curated container with Node 24 and Python 3)
  - `instance_type`: `cpu-2`
  - `ports`: `["3000"]` (exposed HTTPS public preview endpoint under `cloudspaces.litng.ai`)
  - `timeout`: `900000 ms` (15-minute ephemeral TTL)
  - `persistent`: `false` (ephemeral; stops cleanly and disappears from active inventory)
- **Notice**: Lightning credits incur real monetary cost. Real provider sandboxes are ephemeral and stopped immediately upon completion or cancellation. Automated CI runs use mocks and never consume Lightning credits.

### Optional Fallback: E2B Sandbox
- **Provider name**: `e2b`
- **API Key variable**: `E2B_API_KEY`
- **Fallback activation**: Set `AIRA_SANDBOX_FALLBACK_PROVIDER=e2b`. When not set, failures fail closed without creating paid E2B resources unexpectedly.

### Future Provider Boundary: Oracle Cloud Infrastructure (OCI)
- **Provider name**: `oci`
- Unconfigured stub boundary returning deterministic unsupported responses. No fake execution or simulated resources.

---

## 2. Environment Configuration

Configure the following private server-side variables in your staging deployment:

| Variable | Description | Default / Example |
| --- | --- | --- |
| `AIRA_SANDBOX_PROVIDER` | Active primary sandbox provider (`lightning` or `e2b`) | `lightning` |
| `LIGHTNING_SANDBOX_API_KEY` | Private Lightning AI organization/teamspace API key | *private key* |
| `AIRA_LIGHTNING_TEAMSPACE` | Exact Lightning teamspace | `rajpunkeshwarrajgautam-org/aira-ai-2026` |
| `AIRA_LIGHTNING_RUNTIME` | Container runtime | `node24` |
| `AIRA_LIGHTNING_INSTANCE_TYPE` | Machine compute type | `cpu-2` |
| `AIRA_LIGHTNING_PREVIEW_PORT` | Preview server port | `3000` |
| `AIRA_LIGHTNING_SANDBOX_TIMEOUT_MS` | Ephemeral sandbox TTL in milliseconds | `900000` (15 min) |
| `AIRA_SANDBOX_FALLBACK_PROVIDER` | Optional fallback provider upon primary failure | *unset* (disabled) or `e2b` |
| `E2B_API_KEY` | Optional E2B API key when using E2B or fallback | *private key* |
| `AIRA_BUILDER_ENABLED` | Gate to activate builder missions (`true`/`false`) | `true` |
| `AIRA_BUILDER_ALLOWED_USER_IDS` | Comma-separated list of approved Aira user IDs | *staging user ID* |
| `AIRA_BUILDER_SIGNING_SECRET` | HMAC-SHA256 signing secret for workspace/file tickets (min 32 chars) | *random 32+ char secret* |
| `AIRA_BUILDER_RUN_TIMEOUT_MS` | Max model loop wall-clock duration | `120000` (2 min) |

> **Security Rule**: Never prefix provider API keys with `VITE_`. Never commit, log, or forward sandbox API keys or signing secrets into the sandbox environment.

---

## 3. Remote Filesystem & Security Boundary

- **Canonical execution root**: `/home/user/workspace`
- All created, edited, and previewed files must stay strictly beneath this root.
- Path traversal (`../`, absolute paths, null bytes, backslashes) is rejected upfront by `safeRelativePath`.
- Remote symlink traversal is validated inside the remote VM using Python's `pathlib.Path.resolve()`, ensuring no symlink can point outside `/home/user/workspace`.
- File downloads are capped at **3 MiB** with SHA-256 integrity verification, signed tickets bound to BFF `userId` and `sessionId`, and forced `Content-Disposition: attachment` headers with sandboxed CSP.
- Workspace tickets cannot be reused after session logout or revocation.

---

## 4. UI Diagnostics

When viewing the Builder in the Aira interface, the setup panel and diagnostics details show:
- **Sandbox provider**: Lightning
- **Provider configured**: Yes / No
- **Teamspace configured**: Yes / No
- **Runtime**: node24
- **Instance**: cpu-2
- **Workspace TTL**: 15 minutes
- **Preview port**: 3000
- **Fallback provider**: E2B / disabled

---

## 5. Automated Verification Suites

- `npm run test:builder`: Complete suite covering Builder agent loop, AUTH client compatibility, provider contracts, and Lightning provider mechanics.
- `npm run test:sandbox-providers`: Dedicated contract suite for `LightningSandboxProvider`, `E2BSandboxProvider`, `OCISandboxProvider`, and `MultiProviderSandboxFactory`.
- `npm run test:lightning-provider`: Lightning-specific unit tests covering API key enforcement, project ID resolution, symlink escape rejection, and timeout handling.
- `npm run typecheck:builder`: TypeScript verification of runtime and API routes.
- `npm run test:builder:ui`: Playwright browser UI acceptance testing with mock receipts.
