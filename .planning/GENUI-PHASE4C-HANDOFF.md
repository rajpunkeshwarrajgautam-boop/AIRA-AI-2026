# AIRA GenUI Phase 4C — Handoff & Implementation Prerequisites

**Status:** READY FOR PHASE 4C INITIATION  
**Source Phase:** Phase 4B (Advanced Multimodal Artifact Workspace & Unified Interactive Canvas)  
**Target Phase:** Phase 4C (Multi-Agent Synchronous Editing, Collaborative Canvas & CRDT Infrastructure)  
**Date:** 2026-11-27  
**Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI`  
**Branch:** `feat/aira-genui-phase1-foundation`  

---

## 1. Context & Baseline

Phase 4B has completed with full certification (`PHASE_4B_ARTIFACT_WORKSPACE_CERTIFIED`).
The multimodal artifact workspace now natively supports:
- 8 multimodal artifact classes under contract `aira-artifact/v1`.
- Pure TypeScript in-memory OpenXML exports (`.docx`, `.xlsx`, `.pptx`).
- Bounded recursive-descent AST formula evaluation for spreadsheets with zero dynamic `eval()`.
- Formula injection defense for CSV exports.
- Atomic delta patching with optimistic concurrency version checking.
- Zero-migration conversation metadata persistence (`conversation_messages.metadata`).

Phase 4C expands this foundation from single-user / single-turn artifact modification to **Multi-Agent Synchronous Editing, Real-Time Collaborative Canvas, and Conflict-Free Replicated Data Types (CRDT)**.

---

## 2. Phase 4C Scope & Objectives

1. **Conflict-Free Replicated Data Types (CRDT):**
   - Provide local convergence guarantees across concurrent agent updates and human user edits without data loss.
   - Support granular text/cell/slide operations with causal ordering.
2. **Multi-Agent Awareness & Presence Protocol:**
   - Display active agent avatars, cursor positions, and current focus (e.g. agent A editing cell B4 while agent B edits cell D10).
3. **Live Synchronous Broadcast:**
   - Real-time delta propagation across WebSocket connections (`/ws/canvas`) with fallback to short polling.
4. **Autonomous Agent Co-Authoring:**
   - Specialized agents (e.g. Data Analyst agent populating spreadsheet cells while Copywriter agent drafts the presentation deck) operating concurrently on shared multi-artifact workspaces.

---

## 3. Strict Architectural & Security Invariants for Phase 4C

1. **Zero Production DB Schema Mutations:**
   - CRDT state snapshots and event logs must continue to leverage existing JSONB tables (`conversation_messages.metadata`, `idempotent_operations`) or dedicated ephemeral memory/Redis stores.
2. **Fail-Closed WebSocket Authorization:**
   - Every collaborative session join must verify conversation ownership and user authentication tokens before establishing channel subscription.
3. **Zero Un-sandboxed Code Execution:**
   - Agent-generated scripts and expressions must continue executing within isolated opaque iframes (`origin === 'null'`) or AST evaluators. Never expose host `window` or server runtime to collaborative inputs.
4. **Preservation of Commercial Baseline:**
   - PR #215 commercial candidate (`fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568`), GST invoicing, Stripe/Razorpay payment gateways, and billing modules remain strictly untouchable.
5. **Fail-Closed Remote MCP Gating:**
   - `assertApprovedPublicMcpDestination()` must remain in place with 503 enforcement in production environments until socket-level pinning is certified.

---

## 4. Key Files for Phase 4C Reference

- `packages/contracts/src/artifacts.ts`: Multimodal artifact schema and patch descriptors.
- `src/utils/artifactPatchEngine.ts`: Atomic delta patch application and base version validation.
- `src/utils/spreadsheetEngine.ts`: AST calculation and acyclic cell dependency graph.
- `src/utils/officeDocumentExporter.ts`: Pure TypeScript OpenXML packager for DOCX, XLSX, PPTX.
- `src/components/ArtifactStudio.tsx`: Multimodal canvas container and user interface.
- `docs/genui/AIRA_GENUI_PHASE4B_ARTIFACT_WORKSPACE_CERTIFICATION.md`: Certification record.
