# AIRA GenUI — Production Integration & Staging Deployment Plan

**Document Version:** 1.1.0 (Hardened & Reconciled)  
**Date:** 2026-11-28  
**Scope:** Architecture, Lineage, Rollback, Environment Configuration, and Release Governance for AIRA GenUI  
**Authors:** Agency Software Architect & SRE Site Reliability Engineer Specialists  
**Status:** READY FOR STAGING REVIEW (PRODUCTION DEPLOYMENT ON STRICT HOLD)

---

## 1. Executive Summary & Release Governance

This document establishes the comprehensive staging rollout, environmental prerequisites, schema compatibility assessment, lineage tracking, and rollback strategy for the complete **AIRA GenUI Multimodal Suite** (encompassing Phase 1 Foundation through Phase 5 Autonomous Multi-Agent Co-Authoring).

### Strict Production Boundaries
- **Production Deployment Status:** **STRICT HOLD**. No automated production deployment or Git push to `prod-release` is authorized.
- **Commercial Candidate PR #215 Isolation:** PR #215 (`fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568`, containing commercial invoicing, GST reporting, and payment gateway fixes) remains completely decoupled and isolated on STRICT HOLD.
- **Standing Release Delegation Non-Applicability:** In accordance with repository `AGENTS.md`, standing release delegation covers only bounded code-only releases that have fulfilled all mandatory gates. Because GenUI constitutes a major multi-phase capability addition across 16 presentation modes and autonomous agent runtimes, final production release requires explicit owner review, staging verification, and separate owner attestation.

---

## 2. Branch Lineage & Architecture Differential

### 2.1 Commit Lineage & Reconciled Baseline
- **Production Reference HEAD:** `f429d90a1f4322a0d362956fb9e55a38cb3b5508` (`prod-release`)
- **Commercial Candidate Baseline:** PR #215 (`fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568`)
- **GenUI Development Branch:** `feat/aira-genui-phase1-foundation`
- **GenUI Milestone Commits (Reconciled Linear History):**
  - `f2e9b40`: Phase 1 Native GenUI Foundation & A2UI Base Engine
  - `f39ecab`: Phase 2 Declarative A2UI v1.0 Runtime, Reactive Engine & Security Hardening *(Reconciled: replaces speculative hash `4d35cb6`)*
  - `104ced7`: Phase 3 Open Generative UI Applications & Sandboxed Runtime
  - `dfd01a2`: Phase 3.5 Security Closure & Phase 4A Local MCP Apps Containment
  - `a335198`: Phase 4B Multimodal Artifact Workspace & Interactive Canvas
  - `cd7f88a`: Phase 4C Real-Time Collaborative Canvas, CRDT Synchronization & Multi-Agent Co-Authoring
  - `112a0f6`: Phase 5 Integrated Foundation Closure, Autonomous Intelligence Integration, and Final Release Certification
  - `HEAD`: Phase 5 Assurance Remediation (Presence Timestamp Hardening & Provider Fault Simulation)

### 2.2 Subsystem Invariants & Additions
| Subsystem | Change Type | Impact / Backward Compatibility |
|---|---|---|
| **A2UI Runtime (`src/components/genui/`)** | Non-breaking Addition | Renders declarative components safely in sandboxed iframe or direct React DOM. Default fallback handles non-GenUI markdown responses. |
| **Artifact Studio (`src/components/artifacts/`)** | Non-breaking Addition | Extends artifact viewing with 5 multimodal editors (Code, Document, Spreadsheet, Presentation, Flowchart). |
| **Collaboration Engine (`src/utils/collaborationEngine.ts`)** | Non-breaking Addition | Hybrid positional-rebase & causal LWW CRDT model operating in-memory for agent co-authoring. |
| **Collaboration Server (`src/server/collaborationManager.ts`)** | Non-breaking Addition | Authoritative sequencing, presence tracking with server receipt timestamps, participant revocation defense, and tenant isolation. |
| **Autonomous Collaborative Bridge (`packages/agent-runtime/`)** | Non-breaking Addition | Bridges `AutonomousAgentEngine` and specialist roles to multi-agent artifact creation without duplicate execution engines. |
| **Commercial Billing / Payments (`src/server/billing/`)** | **Untouched** | Zero modifications to Razorpay, Cashfree, Stripe, GST calculation, or credit deduction engines. |

---

## 3. Database Schema Compatibility Analysis

### Zero Migrations Guarantee
- **New Migrations Introduced:** **0**
- **Existing Schema Tables Reused:**
  1. `autonomous_agent_tasks`: Stores durable agent task definitions, DAG step states, lease metadata, and checkpoint records.
  2. `runs`: Tracks workflow execution runs, timings, and status transitions.
  3. `workflow_runs`: Persists durable step outcomes and error traces.
  4. `conversation_messages.metadata`: Houses ephemeral artifact references and A2UI message payloads in JSONB.
- **Migration Safety Gate:** `npm run db:verify:deploy` enforces that no unapplied Neon PostgreSQL migrations exist before any production build executes.

---

## 4. Environment Variables & Runtime Feature Flags Reality Check

### 4.1 Authoritative Feature Flags & Server-Side Gates
The runtime relies on authoritative contract-backed feature flags (`packages/contracts/src/featureFlags.ts`) and server-side capability gates rather than speculative documentation-only environment variables:

| Mechanism | Scope / Location | Enforcement Method | Status |
|---|---|---|---|
| `agent_mode_autonomous` | Contract Feature Flag (`packages/contracts/src/featureFlags.ts`) | Evaluated per tier: `false` for Guest/Free; `true` for Plus/Pro. Server gate `requireCapability('autonomous')` enforces HTTP 403 on unauthorized calls. | **ACTIVE & ENFORCED** |
| `pro_sandbox_python` | Contract Feature Flag (`packages/contracts/src/featureFlags.ts`) | Evaluated per tier: `true` for Pro only. | **ACTIVE & ENFORCED** |
| `pro_browser_tools` | Contract Feature Flag (`packages/contracts/src/featureFlags.ts`) | Evaluated per tier: `true` for Pro only. | **ACTIVE & ENFORCED** |
| `assertApprovedPublicMcpDestination` | Tool Gateway Security (`packages/tool-runtime/`) | Hard-coded fail-closed code blockade throwing 503 `MCP_EGRESS_ENFORCEMENT_REQUIRED` for any unapproved remote MCP host in production. | **FAIL-CLOSED IN CODE** |
| `PresentationRouter` Fallback | Client / Server Runtime (`packages/agent-runtime/`) | In the event of presentation rendering failure or disabled state, falls back immediately to `text_markdown`. | **ACTIVE & ENFORCED** |
| `NVIDIA_API_KEY` | Server Secret | When absent, system gracefully and truthfully routes to internal deterministic patch engine. Classified truthfully as `BLOCKED_EXTERNAL`. | **SECURE FALLBACK** |

*Note on Proposed Variables:* Conceptual variables (`ENABLE_GENUI`, `ENABLE_COLLABORATIVE_CANVAS`, `ENABLE_AUTONOMOUS_AGENTS`, `MCP_REMOTE_EGRESS_ALLOWED`) mentioned in early drafts are not ambient environment variables; all capability and security boundaries are enforced server-side through `ExecutionPrincipal`, `entitlement-guard.js`, and `assertApprovedPublicMcpDestination()`.

---

## 5. Staging Rollout & Verification Procedure

### Stage 1: Build & Static Analysis Gate
1. Execute `npm run lint` — Confirm 0 errors.
2. Execute `npm run typecheck` — Confirm 0 compilation issues across client, server, and API projects.
3. Execute `npm run build` — Verify production Vite bundle compiles cleanly.
4. Execute `npm run test:release-auth:unit` — Verify all 52 release authorization unit tests pass.

### Stage 2: Automated GenUI & Swarm Acceptance Gate
Execute the 8 canonical test suites:
```bash
npx tsx --test \
  test/artifact-multimodal-engine.test.ts \
  test/artifact-workspace-acceptance.test.ts \
  test/autonomous-swarm-acceptance.test.ts \
  test/collaboration-acceptance.test.ts \
  test/collaboration-crdt-engine.test.ts \
  test/crdt-property-verification.test.ts \
  test/genui-phase3-sandbox-isolation.test.ts \
  test/mcp-apps-local-acceptance.test.ts
```
Expected: 86/86 tests passing.

### Stage 3: Live Preview Deployment Verification (Vercel Preview)
1. Deploy candidate to isolated Vercel Preview environment via GitHub branch push (once authorized).
2. Verify browser rendering across 16 presentation modes:
   - A2UI Interactive Card & Form submission.
   - Code Editor syntax highlighting and multi-file project tabs.
   - Spreadsheet AST reactive recalculation (`=A1*B1`).
   - Presentation deck keyboard navigation.
   - Mermaid diagram zoom/pan/render.
3. Verify tenant isolation under cross-workspace request headers.

---

## 6. Owner-Authorized Rollback Strategy & Incident Playbook

### 6.1 Verified Rollback Target & Governance Invariants
- **Target Commit SHA:** `f429d90a1f4322a0d362956fb9e55a38cb3b5508` (Last verified stable production commit on `prod-release`).
- **Protected Branch Enforcement:** GitHub Ruleset `25079946` explicitly forbids `git reset --hard` and force-pushes on `refs/heads/prod-release`.
- **Prohibited Rollback Actions:**
  - Automated agents must **NEVER** attempt `git push --force-with-lease` or `git reset --hard` on `prod-release`.
  - Automated agents must **NEVER** invent or assume unverified deployment identifiers.
  - Automated agents must **NEVER** invoke `vercel promote` or CLI rollback directly.

### 6.2 Owner-Authorized Rollback Procedures
If a release-blocking anomaly is detected post-deployment:

#### Path A: Forward Revert via Owner-Attested PR (Git-Authoritative Recovery)
1. On a dedicated fix branch branched from `prod-release`:
   ```bash
   git checkout -b fix/revert-genui-production prod-release
   git revert --no-edit <merge_commit_sha>
   git push origin fix/revert-genui-production
   ```
2. Open a Pull Request targeting `prod-release`.
3. Verify Fast CI and certification tests pass on the revert commit.
4. Maintainer/owner merges the PR into `prod-release` under standard attestation, triggering Vercel to build and redeploy the stable revert state cleanly without history rewriting.

#### Path B: Vercel Dashboard Instant Redeploy (Owner Operational Recovery)
1. In the Vercel Project Dashboard (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`), the repository owner locates the previous production deployment associated with commit `f429d90a1f4322a0d362956fb9e55a38cb3b5508`.
2. Select **"Redeploy"** or **"Promote to Production"** directly via the authenticated web interface.
3. Verify canonical URL `https://aira-ai-2026.vercel.app` serves commit `f429d90`.

### 6.3 Data & Backward Compatibility Assessment
- **Schema Compatibility:** Zero database migrations were introduced by GenUI. All existing tables remain 100% structurally identical.
- **Metadata Compatibility:** Older application versions safely ignore unknown JSONB keys in `conversation_messages.metadata` and do not query `autonomous_agent_tasks`. Therefore, rolling back frontend or API versions incurs **zero database data loss** and zero schema corruption.
- **In-Flight Task Handling:** In-flight autonomous tasks in `autonomous_agent_tasks` will have leases expire cleanly after `leaseExpiresAt` without corrupting user accounts.

---

## 7. Sign-Off & Approvals

| Role | Specialist Agent | Verification Status | Verdict |
|---|---|---|---|
| **Primary Coordinator** | Agency Agents Orchestrator | Full Phase 1–5 Verification | **RECOMMEND STAGING** |
| **System Architecture** | Agency Software Architect | Architecture & Lineage Audit | **VERIFIED NON-BREAKING** |
| **Security & Containment**| Agency Application Security Engineer | Threat Model & Egress Review | **VERIFIED FAIL-CLOSED** |
| **Reliability & Rollback**| Agency SRE Specialist | Rollback & Migration Review | **VERIFIED ZERO MIGRATIONS** |
| **Reality Acceptance** | Agency Reality Checker | Verification & Transport Audit | **VERIFIED ACCURATE** |

**FINAL RELEASE DIRECTIVE:** Keep production deployment on **STRICT HOLD** pending maintainer staging sign-off and separate owner attestation.
