# AIRA Adaptive Studio: Release Blockers & Unblock Criteria Matrix

**Document Version:** 1.0.0  
**Status:** ACTIVE GATING MATRIX  
**Quality Target:** Zero Known Release-Blocking Defects  
**Operational Policy:** Production Readiness is an Evidence-Backed Gate, Not a Date  

---

## 1. Executive Summary

While the frontend implementation of the AIRA Adaptive Studio redesign across **Phases 7 through 1** is 100% complete and verified on local worktrees, **Adaptive Studio is NOT certified for production activation**.

Going live in production requires satisfying five strict release gates. This document specifies each blocker, its exact failure mode, technical impact, required evidence, and precise unblocking conditions.

---

## 2. Release-Blocker Classification Matrix

| Blocker ID | Domain | Severity | Blocking Gate | Current State | Required Evidence to Unblock |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **BLK-01** | Backend / Database | **CRITICAL** | PR #127 & Migration 030 (`principal_workspace_authorities`) | **DRAFT / NOT MERGED** | PR #127 review, disposable PostgreSQL certification PASS, forward migration verification |
| **BLK-02** | Infrastructure | **CRITICAL** | PR #137 Standby Specialist Worker (`aira-specialist-worker`) | **DRAFT / NOT MERGED** | Hardened Docker image build, non-root user verification, minimal attack surface scan |
| **BLK-03** | Security / Governance | **HIGH** | Staging Maintenance Barrier & Release Cutover Attestation | **GATE OPEN** | Signed release authorization phrase, candidate commit attestation (`scripts/staging-cutover-orchestrator.ts`) |
| **BLK-04** | Runtime / E2E | **HIGH** | Live Staging Multi-Agent SSE & Cross-Principal Isolation | **UNVERIFIED ON LIVE INFRA** | Execution of live staging acceptance suite against isolated staging Neon branch |
| **BLK-05** | Production Config | **CONTROLLED** | Feature Flag Activation (`VITE_ADAPTIVE_STUDIO_PREVIEW=false`) | **FLAG DISABLED BY DEFAULT** | Owner approval to update production build config following BLK-01..04 resolution |

---

## 3. In-Depth Blocker Analysis & Unblocking Conditions

### BLK-01: PR #127 & Migration 030 (`principal_workspace_authorities`)
- **Root Problem:**
  Adaptive Studio's Multi-File Workspace Explorer and Agent Execution Graph rely on persisted workspace authority and approval outbox atomicity. This requires database Migration 030 (`principal_workspace_authorities`), which is introduced in **PR #127**.
- **Impact if Bypassed:**
  Attempting to run durable agent runs or multi-file project synchronization without Migration 030 would crash server routes or fallback to insecure client-supplied workspace identifiers, violating tenant isolation.
- **Unblocking Conditions:**
  1. PR #127 is reviewed and authorized by the repository owner.
  2. The dedicated CI job `PostgreSQL 16 isolated regression certification` passes against a disposable PostgreSQL container.
  3. Migration 030 is applied cleanly to the staging database branch with 0 DDL errors.

### BLK-02: PR #137 Standby Specialist Worker Container Infrastructure
- **Root Problem:**
  High-compute multi-agent tasks (such as code compilation, deep multi-file analysis, and long-running tools) exceed the execution time and CPU limits of Cloudflare Edge Workers. PR #137 provides the portable standby AMD64 specialist worker environment.
- **Impact if Bypassed:**
  Multi-agent execution graphs dispatched on edge-only workers will experience 504 gateway timeouts and truncated SSE streams.
- **Unblocking Conditions:**
  1. PR #137 is completed, tested, and reviewed.
  2. The specialist worker container `aira-specialist-worker:staging` starts, binds loopback, passes mutual TLS authentication, and successfully reports health telemetry.

### BLK-03: Staging Maintenance Barrier & Release Cutover Attestation
- **Root Problem:**
  AIRA governance enforces strict cryptographic release controls via `scripts/verify-production-release-readiness.ts` and `RELEASE_APPROVAL_POLICY.md`. A candidate cannot be deployed to `prod-release` without owner authorization linking the exact PR number, candidate commit SHA, and approval phrase.
- **Impact if Bypassed:**
  Any unauthorized merge would violate repository security policies and trigger automated CI rejection.
- **Unblocking Conditions:**
  1. Repository owner provides explicit approval phrase:
     `I approve release candidate <SHA> for PR <#>`
  2. `test/release-authorization-guard.test.ts` confirms dual-evidence attestation provenance.

### BLK-04: Live Staging Multi-Agent SSE & Cross-Principal Isolation
- **Root Problem:**
  Adaptive Studio has only been tested against client-side mocked SSE events and local simulated sandboxes. Authoritative multi-agent streaming, worker cancellation, and cross-account isolation must be verified on live staging infrastructure.
- **Impact if Bypassed:**
  Untested concurrency races, token buffer truncation, or cross-tenant data leaks could occur in production.
- **Unblocking Conditions:**
  1. Live staging execution of all 4 suites described in `ADAPTIVE_STUDIO_BACKEND_CERTIFICATION_PLAN.md`.
  2. Verified fail-closed security for unauthenticated callers and verified cross-principal 403 rejections.

### BLK-05: Feature Flag Activation in Production Build Configuration
- **Root Problem:**
  The preview bridge is deliberately governed by `VITE_ADAPTIVE_STUDIO_PREVIEW=false`.
- **Operational Policy:**
  Even after PRs #138–#143 are merged into `prod-release`, the feature flag will remain `false` by default. This ensures zero risk to the millions of active baseline AIRA conversations.
- **Unblocking Conditions:**
  1. Production smoke testing confirms baseline chat operates with 100% fidelity.
  2. Explicit authorization to enable `VITE_ADAPTIVE_STUDIO_PREVIEW=true` for beta cohorts.

---

## 4. Residual Risks & Mitigation Table

| Residual Risk | Probability | Impact | Mitigation Implemented |
| :--- | :--- | :--- | :--- |
| **Iframe Sandbox Escape** | Very Low | Critical | Iframe sandboxed with `allow-scripts allow-modals allow-forms`, strictly omitting `allow-same-origin`. Nonce verification required for all postMessage events. |
| **SVG Script Injection** | Very Low | High | `sanitizeSvgMarkup` strips `<script>`, `<foreignObject>`, inline `on*` event handlers, and `javascript:` URIs. |
| **Memory Leak in Long Sessions** | Low | Medium | Guaranteed `URL.revokeObjectURL` cleanup on component unmount and file change in `MultiModalAssetViewer`. |
| **Small-Mobile Header Overflow** | Very Low | Low | Icon-only tabs and hidden secondary actions on `<640px` viewports ensure Close button is 100% visible and clickable. |
| **ZIP Archive Compression Bomb** | Very Low | Medium | Quota guards in `artifactZipExporter.ts` strictly enforce <= 50MB and <= 500 files per archive. |
