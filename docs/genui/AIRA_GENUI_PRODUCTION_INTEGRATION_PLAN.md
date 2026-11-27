# AIRA GenUI — Production Integration & Staging Deployment Plan

**Document Version:** 1.0.0  
**Date:** 2026-11-28  
**Scope:** Architecture, Lineage, Rollback, Environment Configuration, and Release Governance for AIRA GenUI  
**Authors:** Agency Software Architect & SRE Site Reliability Engineer Specialists  
**Status:** READY FOR STAGING REVIEW (PRODUCTION DEPLOYMENT ON STRICT HOLD)

---

## 1. Executive Summary & Release Governance

This document establishes the comprehensive staging rollout, environmental prerequisites, schema compatibility assessment, lineage tracking, and rollback strategy for the complete **AIRA GenUI Multimodal Suite** (encompassing Phase 1 Foundation through Phase 5 Autonomous Multi-Agent Co-Authoring).

### Strict Production Boundaries
- **Production Deployment Status:** **STRICT HOLD**. No automated production deployment or Git push to `prod-release` is authorized.
- **Commercial Candidate PR #215 Isolation:** PR #215 (`fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568`, containing the commercial invoicing, GST reporting, and payment gateway fixes) remains completely decoupled and isolated on STRICT HOLD.
- **Standing Release Delegation Non-Applicability:** In accordance with repository `AGENTS.md`, standing release delegation covers only bounded code-only releases that have fulfilled all mandatory gates. Because GenUI constitutes a major multi-phase capability addition across 16 presentation modes and autonomous agent runtimes, final production release requires explicit owner review and staging verification.

---

## 2. Branch Lineage & Architecture Differential

### 2.1 Commit Lineage
- **Production Reference HEAD:** `f429d90a1f4322a0d362956fb9e55a38cb3b5508` (`prod-release`)
- **Commercial Candidate Baseline:** PR #215 (`fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568`)
- **GenUI Development Branch:** `feat/aira-genui-phase1-foundation`
- **GenUI Milestone Commits:**
  - `f2e9b40`: Phase 1 Native GenUI Foundation & A2UI Base Engine
  - `4d35cb6`: Phase 2 Declarative Schema & Rendering Runtime
  - `dfd01a2`: Phase 3.5 Security Closure & Phase 4A Local MCP Apps Containment
  - `a335198`: Phase 4B Multimodal Artifact Workspace & Interactive Canvas
  - `cd7f88a`: Phase 4C Real-Time Collaborative Canvas, CRDT Synchronization & Multi-Agent Co-Authoring
  - `HEAD` (Phase 5): Integrated Foundation Closure, Autonomous Intelligence Integration, and Final Release Certification

### 2.2 Subsystem Invariants & Additions
| Subsystem | Change Type | Impact / Backward Compatibility |
|---|---|---|
| **A2UI Runtime (`src/components/genui/`)** | Non-breaking Addition | Renders declarative components safely in sandboxed iframe or direct React DOM. Default fallback handles non-GenUI markdown responses. |
| **Artifact Studio (`src/components/artifacts/`)** | Non-breaking Addition | Extends artifact viewing with 5 multimodal editors (Code, Document, Spreadsheet, Presentation, Flowchart). |
| **Collaboration Engine (`src/utils/collaborationEngine.ts`)** | Non-breaking Addition | Hybrid positional-rebase & causal LWW CRDT model operating in-memory and over WebSocket/SSE. |
| **Collaboration Server (`src/server/collaborationManager.ts`)** | Non-breaking Addition | Authoritative sequencing, presence tracking with server receipt timestamps, and tenant isolation. |
| **Autonomous Collaborative Bridge (`packages/agent-runtime/`)** | Non-breaking Addition | Bridges `AutonomousAgentEngine` and specialist roles to multi-agent artifact creation without duplicate execution engines. |
| **Commercial Billing / Payments (`src/server/billing/`)** | **Untouched** | Zero modifications to Razorpay, Stripe, GST calculation, or credit deduction engines. |

---

## 3. Database Schema Compatibility Analysis

### Zero Migrations Guarantee
- **New Migrations Introduced:** **0**
- **Existing Schema Tables Reused:**
  1. `autonomous_agent_tasks`: Stores durable agent task definitions, DAG step states, and checkpoint metadata.
  2. `runs`: Tracks workflow execution runs, timings, and status transitions.
  3. `workflow_runs`: Persists durable step outcomes and error traces.
  4. `conversation_messages.metadata`: Houses ephemeral artifact references and A2UI message payloads in JSONB.
- **Migration Safety Gate:** `npm run db:verify:deploy` enforces that no unapplied Neon PostgreSQL migrations exist before any production build executes.

---

## 4. Environment Variables & Runtime Feature Flags

### 4.1 Required Staging Configuration
| Variable | Staging Recommended | Production Default | Security Function |
|---|---|---|---|
| `ENABLE_GENUI` | `"true"` | `"false"` (Gated) | Master feature flag enabling GenUI UI components. |
| `ENABLE_COLLABORATIVE_CANVAS` | `"true"` | `"false"` (Gated) | Controls real-time WebSocket connection initialization. |
| `ENABLE_AUTONOMOUS_AGENTS` | `"true"` | `"false"` (Gated) | Enables specialist agent task execution in worker host. |
| `MCP_REMOTE_EGRESS_ALLOWED` | `"false"` | `"false"` | **Fail-closed security lock.** Enforces 503 `MCP_EGRESS_ENFORCEMENT_REQUIRED` for any non-approved remote MCP server. |
| `NVIDIA_API_KEY` | Provided via Secrets | Optional (External) | Powers external live AI revision. In absence, system truthfully falls back to internal deterministic patch engine. |

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
1. Deploy feature branch to isolated Vercel Preview environment (`preview.aira-ai-2026.vercel.app`).
2. Verify browser rendering across 16 presentation modes:
   - A2UI Interactive Card & Form submission.
   - Code Editor syntax highlighting and multi-file project tabs.
   - Spreadsheet AST reactive recalculation (`=A1*B1`).
   - Presentation deck keyboard navigation.
   - Mermaid diagram zoom/pan/render.
3. Verify WebSocket presence awareness and multi-actor cursor rendering.
4. Verify tenant isolation under cross-workspace request headers.

---

## 6. Rollback Strategy & Incident Playbook

### 6.1 Verified Rollback Target
- **Target Commit SHA:** `f429d90a1f4322a0d362956fb9e55a38cb3b5508`
- **Recovery Time Objective (RTO):** < 60 seconds (instant Vercel deployment rollback).
- **Recovery Point Objective (RPO):** Zero data loss (since zero DB migrations or destructive state mutations exist).

### 6.2 Rollback Procedure
1. If staging or production anomaly is detected:
   - In Vercel Project Dashboard (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`), locate previous production deployment `dpl_prev_f429d90` and select **"Instant Rollback / Promote to Production"**.
2. Alternatively via CLI (trusted maintainer):
   ```bash
   git checkout prod-release
   git reset --hard f429d90a1f4322a0d362956fb9e55a38cb3b5508
   git push origin prod-release --force-with-lease
   ```
3. Set `ENABLE_GENUI="false"` in project environment variables to immediately suppress client-side interactive rendering.

---

## 7. Sign-Off & Approvals

| Role | Specialist Agent | Verification Status | Verdict |
|---|---|---|---|
| **Primary Coordinator** | Agency Agents Orchestrator | Full Phase 1–5 Verification | **RECOMMEND STAGING** |
| **System Architecture** | Agency Software Architect | Architecture & Lineage Audit | **VERIFIED NON-BREAKING** |
| **Security & Containment**| Agency Application Security Engineer | Threat Model & Egress Review | **VERIFIED FAIL-CLOSED** |
| **Reliability & Rollback**| Agency SRE Specialist | Rollback & Migration Review | **VERIFIED ZERO MIGRATIONS** |
| **Multi-Agent Systems** | Agency Multi-Agent Systems Architect | Autonomous Swarm Acceptance | **VERIFIED (13/13 MISSIONS)** |

**FINAL RELEASE DIRECTIVE:** Keep production deployment on **STRICT HOLD** pending maintainer staging sign-off and separate owner attestation.
