# Rowboat Upstream Architecture Reference

## Upstream Tracking

- **Repository**: `https://github.com/rowboatlabs/rowboat`
- **Pinned Commit**: `3b3c71593b0213499eddae9208d78209c7e7fe9d`
- **Date Inspected**: 2026-10-03
- **License**: Apache License 2.0

---

## Subsystems Analyzed

### 1. `apps/harbor` (Contracts & Centralized Policy)
- **Files**: `apps/harbor/CONTRACT.md`, `apps/harbor/SPEC.md`, `apps/harbor/packages/protocol`, `apps/harbor/packages/server`
- **Architectural Principles Borrowed**:
  - Centralized policy engine (`canSetOrgLogo`, permission classes, access evaluator).
  - Explicit authorization separated from authentication.
  - Append-only event change sets (`ChangeSet`).
  - Strict blob and asset hashing (`blobHash`).

### 2. `apps/x/packages/core` (Runtime, Models, MCP, Knowledge)
- **Runtime (`runtime/`)**:
  - Structured tool dispatch and execution loop: objective -> plan -> tool call -> observation -> evaluation.
  - Durable run state tracking and step persistence.
- **Model Router (`models/`)**:
  - Policy-based provider abstraction decoupling the user-facing model selection from underlying LLM vendors.
  - Server-side credentials and configuration isolation.
- **MCP (`mcp/`)**:
  - Dynamic MCP server configuration, tool discovery, parameter schema conversion to standard schemas, and secure execution sandboxing.
- **Knowledge System (`knowledge/`)**:
  - Multi-tier knowledge ingestion: raw documents -> document chunks with hashes -> semantic property graph with explicit provenance -> curated memory garden.
- **Agent Schedules & Background Tasks (`agent-schedule/`, `background-tasks/`)**:
  - Self-contained automation tasks decoupled from ephemeral conversation state, executing on deterministic schedules with retry policies.
- **Code Mode / ACP (`code-mode/`)**:
  - Agent adapter model for command/session execution, diff tracking, and sandbox containment.

---

## Adaptation Rules for AIRA AI 2026

1. **Zero UI Porting**: Do not port Rowboat's Electron desktop UI, spaces, or branding. Preserve AIRA's existing Claude.ai-inspired web layout, Aira branding, whimsy system, and responsive components.
2. **Selective Architectural Translation**: Adopt Rowboat's execution kernel, durable run state machine, tool runtime, and knowledge layering as server-side execution infrastructure beneath AIRA's existing frontend surfaces.
3. **No Simulation Fallbacks**: Replace browser-authoritative mocks and direct-browser LLM calls with server-authoritative API routes and streaming run events.
