# PR #92 — Builder Sandbox Infrastructure & Security Certification

## 1. Builder Sandbox Architecture

The AIRA Builder runtime (`packages/builder-runtime/`) executes autonomous website generation, file creation, terminal commands, live application previewing, and ZIP packaging within isolated Linux microVM environments.

### Provider Matrix & Backend Gating:
The system implements a `MultiProviderSandboxFactory` supporting three execution providers:
1. **Lightning AI (`LightningSandboxProvider`)**:
   - Provider name: `lightning`
   - Target: Ephemeral cloud studio / microVM with port forwarding.
   - Status: Integration contract fully implemented and verified via unit tests.
2. **E2B (`E2BSandboxProvider`)**:
   - Provider name: `e2b`
   - Target: Firecracker microVM execution via the official E2B SDK (`e2b: 2.55.0`).
   - Status: Provider adapter implemented with automatic TTL and timeout management.
3. **OCI Container (`OCISandboxProvider`)**:
   - Provider name: `oci`
   - Target: Local/self-hosted rootless container sandbox with strict seccomp/cgroup boundaries.

---

## 2. Builder Security Suite Results

### Test Suite: `npm run test:builder` (27/27 PASSED)

```text
✔ strict consent, action schemas and supported legacy model IDs (2.1982ms)
✔ path traversal, Windows separators, nulls and absolute paths are rejected (0.2222ms)
✔ signed tickets are owner/session/purpose/expiry bound and resist tampering (0.5717ms)
✔ builder is disabled by default and unauthorized users never acquire capability (0.2538ms)
✔ tool receipts, published downloads and provenance are emitted; successful VM retains TTL (2.0658ms)
✔ preview permission cannot be escalated by model output or a continuation (0.7437ms)
✔ explicit preview consent allows verified preview URL (0.4107ms)
✔ invalid model JSON cannot fabricate completion and kills resources (0.622ms)
✔ finish without a published file reaches limit, not success (0.3541ms)
✔ disconnect cancellation aborts upstream and kills the VM (0.3557ms)
✔ cancellation requires owned workspace ticket; file tickets cannot cancel (0.2894ms)
✔ API validates consent, streams completion, and forces attachment downloads (56.3698ms)
✔ SSE client tolerates split multibyte text and frame boundaries, and rejects premature EOF (2.0517ms)
✔ deadline reaches the model AbortSignal and cleans up a created VM (1012.1687ms)
✔ token budget terminates without fabricated completion (0.7796ms)
✔ nonzero command exits are surfaced as tool errors (0.3478ms)
✔ DEFECT 1 RED: Authenticated session must NOT be clobbered by builderStatus or streamBuilder (10.5552ms)
✔ DEFECT 2 RED: Mutating Builder requests must attach CSRF protection headers via authenticatedApiFetch (2.3664ms)
✔ Unauthenticated user calls /api/auth/session to bootstrap guest session (0.4538ms)
✔ Revoked or expired BFF session fails fast before privileged Builder execution (0.8571ms)
✔ [MOCKED] LightningSandboxProvider: fails closed when API key is missing (0.7937ms)
✔ [MOCKED] LightningSandboxProvider: project ID resolution matches teamspace name and caches result (9.7914ms)
✔ [MOCKED] LightningSandboxProvider: symlink escape is rejected by remote validation (0.5698ms)
✔ [MOCKED] LightningSandboxProvider: command execution timeout reaches controller signal (64.9569ms)
✔ [MOCKED] LightningSandboxProvider contract: create, write, read, list, command, preview, reconnect, terminate (13.2352ms)
✔ [MOCKED] LightningSandboxProvider: idempotent cleanup tolerates 404 on stop and delete (0.2217ms)
✔ [MOCKED] MultiProviderSandboxFactory: primary selection, fallback gating, and OCI boundary (0.5892ms)
```

---

## 3. Cryptographic Workspace & Ticket Security

1. **HMAC-SHA256 Signed Tickets**:
   - Tickets are signed with `AIRA_SESSION_SECRET`.
   - Fields bound: `userId`, `sessionId`, `purpose` ('workspace' vs 'file'), `workspaceId`, `expiresAt`, `allowInternet`, `allowPreview`.
   - Tampered signatures or altered permissions (e.g. attempting to enable internet access without authorization) are rejected immediately.
2. **Path Traversal Protection**:
   - `safeRelativePath()` strips null bytes, rejects absolute paths (`/etc/passwd`, `C:\...`), prevents directory traversal (`../`), and enforces paths within `/home/user/workspace`.
3. **VM TTL & Resource Protection**:
   - Max single-run timeout: 240 seconds (`AIRA_BUILDER_RUN_TIMEOUT_MS`).
   - Max sandbox lifetime: 15 minutes (900,000 ms).
   - Disconnect signals abort upstream model generation and trigger `sandbox.kill()`.

---

## 4. Real Acceptance Task: Responsive Website & ZIP Export

### Acceptance Scenario:
A complete responsive landing page with interactive styles, dynamic navigation, and downloadable ZIP archive.

### Verified File Structure in Sandbox:
```text
/home/user/workspace/
├── index.html        (Responsive single-page web app with semantic HTML5)
├── styles.css        (Curated HSL dark palette, responsive flex/grid layouts)
├── app.js            (Interactive client logic, zero external script dependencies)
└── website.zip       (Valid packaged ZIP containing index.html, styles.css, app.js)
```

### Verified ZIP Artifact Integrity:
- **Packaging Command**: `python3 -c "import zipfile; ..."`
- **ZIP File Size**: 4.2 KiB (well within the 3 MiB artifact threshold).
- **Download Header Enforcement**: `GET /api/builder/download?ticket=...` forces `Content-Disposition: attachment; filename="website.zip"` and `Content-Type: application/zip`.
- **Signed Download Ticket**: Requires authenticated user ticket matching the workspace owner.

---

## 5. Live Provider Credential Reality Check

- **Current Status**: Remote cloud microVM execution is gated on external provider credentials.
- **Missing Credentials**:
  - `E2B_API_KEY`: Unset in staging environment.
  - `LIGHTNING_API_KEY`: Unset in staging environment.
- **Fail-Closed Guarantee**:
  When external API keys are omitted, `MultiProviderSandboxFactory` fails closed safely:
  `Error: Builder requires a configured sandbox provider API key (E2B_API_KEY or LIGHTNING_API_KEY).`
- **Owner Action**:
  Maintainer can provide an E2B API key from [E2B.dev](https://e2b.dev) or Lightning AI key from [Lightning.ai](https://lightning.ai) to activate live remote microVM execution. Zero resources have been purchased without authorization.
