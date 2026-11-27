# AIRA GenUI Phase 4C — Real-Time Collaborative Canvas, CRDT-Based Artifact Editing and Multi-Agent Co-Authoring Specification

**Document Version:** 1.0.0  
**Contract Version:** `aira-collab/v1` (integrating with `aira-artifact/v1`)  
**Status:** APPROVED FOR IMPLEMENTATION  
**Lead Roles:** Agency Agents Orchestrator, Realtime Collaboration Engineer, Software Architect  
**Workspace:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI`  
**Branch:** `feat/aira-genui-phase1-foundation`  

---

## 1. Problem Statement

Modern knowledge work and AI-augmented generation require humans and autonomous AI specialists to work concurrently on shared artifacts—documents, source code, data spreadsheets, presentation decks, and architecture diagrams.

Prior to Phase 4C, the AIRA platform supported rich single-user artifact creation, AST spreadsheet evaluation, and OpenXML export (Phase 4B). However:
1. **Concurrent Modification Collision:** If a human user edits a document or spreadsheet while an AI agent (e.g. data analyst or copywriter) generates an update, the last write silently overwrites earlier changes, losing human edits or agent output.
2. **Lack of Real-Time Presence:** Collaborators cannot see who is currently viewing or modifying an artifact, leading to conflicting edits and confusion.
3. **Network Instability & Serverless Socket Timeouts:** On Vercel serverless deployments, WebSocket connections encounter a hard 300-second (5-minute) timeout (`FUNCTION_INVOCATION_TIMEOUT`), dropping active sockets and risking data loss if transport cannot seamlessly resume from state vectors.
4. **Agent Attribution & Trust:** Agent modifications must not be anonymous or untrusted; every operation must carry explicit cryptographic attribution, run identity, and permission scoping without granting arbitrary execution privileges.
5. **Phase 4B Targeted Closure:** Safe PDF export and server-authoritative atomic revision safety must be certified.

---

## 2. Solution

AIRA GenUI Phase 4C introduces **`aira-collab/v1`**, an enterprise-grade real-time collaborative canvas and CRDT synchronization protocol designed specifically for hybrid human-agent co-authoring on serverless and edge-compatible architectures.

### Architectural Pillars:
1. **Convergence Model Selected per Data Type:**
   - **Text & Documents (`document`, `code`, `markdown`):** Sequence-based CRDT operations (insert, delete, replace) with causal ordering, Lamport clocks, and client-generated `opId` deduplication.
   - **Spreadsheets (`sheet`):** Cell-level causal Last-Writer-Wins (LWW) with cell coordinate addressing (`A1`, `B2`), preserving deterministic recursive-descent AST formula evaluation, acyclic cycle detection (`#CYCLE!`), and explicit conflict detection on concurrent same-cell modifications.
   - **Presentations (`slide`):** Slide-level fractional indexing and keyed operations (`insert_slide`, `update_slide`, `reorder_slide`, `delete_slide`) with stable slide UUIDs.
   - **Diagrams (`diagram`):** Keyed node and edge graph operations with referential integrity validation (preventing dangling edges).
   - **Interactive Surfaces & MCP Apps (`surface`, `app`, `mcp-app`):** State-attribute synchronization with strict isolation—privileged tool calls and executable code require explicit user approval (zero silent execution).
2. **Dual Transport with Reconnection Resilience:**
   - **Primary Transport:** Authenticated WebSockets with heartbeat keep-alive (< 30s) and automatic exponential backoff with jitter.
   - **Serverless & Firewall Fallback:** SSE stream for downstream updates paired with authenticated REST endpoints (`POST /api/collab/sessions/:id/operations`) for upstream mutations, surviving Vercel 300s socket limits.
   - **State Vector Resumption:** Clients track `lastServerSeq` and send local state vectors on reconnection. The server computes the missing delta and replays it, guaranteeing zero lost edits.
3. **Separation of Durable Document Ops from Ephemeral Presence:**
   - Document operations are durable, append-only, sequenced by the server, and persisted to PostgreSQL.
   - Presence and awareness (user cursors, selections, active artifact, human vs. agent designation) are ephemeral, scoped by TTL (30s), rate-limited to <= 10 Hz, and never pollute the durable document log.
4. **Autonomous Multi-Agent Co-Authoring:**
   - Specialized agents (e.g. Research Specialist, Data Analyst, Presentation Designer) submit bounded, structured operations carrying `runId`, `taskId`, and `actorId`.
   - The collaboration engine validates agent operations against current base versions and merges them safely without overwriting concurrent human edits.
5. **Phase 4B Targeted Closure:**
   - Pure TypeScript OpenXML and PDF 1.4 binary exporter (`generatePdfArchive`) producing valid PDF documents with standard `%PDF-1.4` and `%%EOF` signatures with zero external dependencies.
   - Server-authoritative atomic version checks preventing lost updates under concurrent load.

---

## 3. User Stories

1. *As a human researcher*, I want to type notes into an artifact while an AI Research Agent populates citations, so that our work merges continuously without either of us losing progress.
2. *As a financial analyst*, I want to edit assumptions in cell `B2` of a spreadsheet while an AI Data Agent populates historical metrics in column `C`, so that formulas automatically recalculate in real time.
3. *As a financial analyst*, I want explicit notification and conflict attribution if an AI agent proposes a modification to the exact same cell I just modified, so that my intent is not silently overwritten.
4. *As a presenter*, I want to reorder slides in a presentation deck while an AI Presentation Agent formats bullet points on slide 3, so that slide identities remain stable and no slides are duplicated or lost.
5. *As an architect*, I want to add a database component to a system diagram while an agent adds an API gateway, so that the diagram updates cleanly without broken or dangling connector arrows.
6. *As a remote team member*, I want to see colored presence avatars and active selections indicating which artifact and section each collaborator is viewing, so that we avoid stepping on each other's work.
7. *As a mobile user on unstable cellular data*, I want to edit an artifact while offline and have my edits queue locally, so that when my connection restores, all queued changes replay in order and merge cleanly.
8. *As an enterprise user behind a restrictive corporate firewall*, I want collaborative editing to seamlessly fall back to HTTP long-polling/SSE if WebSockets are blocked, so that I can collaborate without IT network changes.
9. *As an enterprise user*, I want to export our collaboratively edited document to valid DOCX, XLSX, PPTX, and PDF formats, so that we can distribute final deliverables to external stakeholders.
10. *As a security administrator*, I want all collaboration session joins to require valid BFF session authentication, so that unauthorized users cannot eavesdrop on or inject edits into private workspaces.
11. *As a workspace owner*, I want to revoke a collaborator's access in real time, so that their active session is terminated immediately and subsequent edit operations are rejected.
12. *As a developer*, I want every collaborative operation to be idempotent and keyed by a client-generated UUID (`opId`), so that duplicate network transmissions never produce duplicate text or corrupted state.
13. *As an application engineer*, I want the server to assign sequential version numbers (`seq`), so that ordering is unambiguous and does not rely on unsynchronized client wall clocks.
14. *As a user reviewing history*, I want to undo my own edits without reverting concurrent edits made by other collaborators or AI agents, so that my undo action is strictly participant-scoped.
15. *As a user inspecting past work*, I want to view immutable revision checkpoints and see who authored each change (human name or specific agent role), so that provenance is fully transparent.
16. *As a system operator*, I want presence updates to be rate-limited to <= 10 Hz per room with a 30-second TTL, so that client cursor movements never overwhelm server memory or network bandwidth.
17. *As a serverless platform operator*, I want WebSocket clients to automatically reconnect with exponential backoff and jitter upon hitting Vercel's 300s timeout, so that sessions survive seamlessly without server crashes.
18. *As an autonomous agent coordinator*, I want multiple AI agents to co-author different artifacts within the same workspace simultaneously, so that multi-step pipelines complete with maximum parallelism.
19. *As an AI safety reviewer*, I want generated application code and MCP tool calls to execute inside isolated sandboxes with zero un-sandboxed access, so that collaborative inputs cannot compromise host security.
20. *As a commercial billing administrator*, I want local deterministic collaborative editing and spreadsheet recalculation to consume zero AI inference credits, so that users are only billed for actual LLM reasoning.
21. *As a database reliability engineer*, I want all durable artifact snapshots and operation logs to persist in PostgreSQL with atomic transaction boundaries, so that server restarts restore complete state without data corruption.
22. *As a frontend developer*, I want remote participant edits to update the DOM without stealing focus, resetting scroll position, or interrupting my active typing, so that the editing experience feels native and fluid.
23. *As a keyboard-first user*, I want accessible ARIA status announcements when peers join, leave, or make substantial edits, so that assistive technology users stay informed.
24. *As a compliance auditor*, I want the platform to reject payloads exceeding 512 KB per update and enforce strict tenant isolation, so that cross-tenant data leakage is physically impossible.
25. *As an engineering lead*, I want comprehensive test suites covering concurrent editing, conflict resolution, offline replay, and network partition recovery, so that collaboration guarantees are mathematically and empirically verified.

---

## 4. Implementation Decisions

### 4.1 Schema & Protocol Contracts (`packages/contracts/src/collaboration.ts`)
- **Protocol Version:** `AIRA_COLLAB_CONTRACT_VERSION = 'aira-collab/v1'`.
- **Actor Roles:** `'owner' | 'editor' | 'viewer' | 'agent'`.
- **Actor Attribution:**
  ```typescript
  interface CollabActor {
    actorId: string;
    principalId: string;
    displayName: string;
    role: 'owner' | 'editor' | 'viewer' | 'agent';
    isAgent: boolean;
    agentRole?: string; // e.g., 'researcher', 'data-analyst', 'designer'
    runId?: string;
    taskId?: string;
  }
  ```
- **Collaborative Operations:**
  ```typescript
  interface CollabOperation {
    opId: string; // Client-generated UUID for idempotency
    sessionId: string;
    artifactId: string;
    actor: CollabActor;
    baseSeq: number; // Server sequence number this operation is based on
    lamportClock: number;
    timestamp: number;
    type: 'text_insert' | 'text_delete' | 'text_replace' | 'cell_update' | 'slide_mutate' | 'diagram_mutate' | 'artifact_replace';
    payload: {
      position?: number;
      text?: string;
      length?: number;
      cellCoord?: string; // e.g. "A1"
      cellValue?: string | number | boolean;
      cellFormula?: string;
      slideId?: string;
      slideAction?: 'insert' | 'update' | 'reorder' | 'delete';
      slideData?: unknown;
      diagramData?: unknown;
    };
  }
  ```
- **Presence & Awareness:**
  ```typescript
  interface CollabPresence {
    actorId: string;
    actor: CollabActor;
    artifactId: string;
    cursor?: { line: number; ch: number } | { cellCoord: string } | { slideIndex: number };
    selection?: { start: number; end: number };
    status: 'active' | 'idle' | 'disconnected';
    updatedAt: number; // TTL checked (stale if > 30s)
  }
  ```
- **Wire Message Types:**
  - `0`: `SYNC_HANDSHAKE` (SyncStep1 / SyncStep2 state vector exchange)
  - `1`: `OPERATION_BROADCAST` (Sequenced durable operation)
  - `2`: `PRESENCE_BROADCAST` (Ephemeral awareness update)
  - `3`: `ACK` (Server sequence confirmation)
  - `4`: `AUTH_ERROR` / `REJECT` (Validation or permission error)

### 4.2 Core Collaboration Engine (`src/utils/collaborationEngine.ts`)
- In-memory pure TypeScript convergent CRDT engine maintaining:
  - `stateVector`: Map of `actorId => maxLamportClock`.
  - `appliedOps`: Set of `opId`s to enforce strict idempotency (duplicate operations are no-ops).
  - `operationLog`: Chronological list of sequenced operations for delta replay.
  - `documentState`: Reconstructed authoritative artifact state.
- **Participant-Scoped Undo/Redo:** Separate undo stacks per `actorId`, generating inverse operations that do not revert concurrent edits by other participants.
- **Offline Operation Queue:** Bounded client-side queue that replays on reconnection and reconciles with server sequence numbers.

### 4.3 Pure TypeScript PDF Export Engine (`src/utils/officeDocumentExporter.ts`)
- Implement `generatePdfArchive(title: string, markdownOrText: string): Uint8Array` adhering to standard PDF 1.4 specification:
  - Header: `%PDF-1.4\n%\xE2\xE3\xCF\xD3\n`
  - Catalog, Pages tree, Page object, Font resources (Helvetica, Helvetica-Bold), Content stream with text positioning (`BT`, `Tf`, `Td`, `Tj`, `ET`).
  - Standard byte offsets in `xref` table and trailer.
  - Zero external dependencies.

### 4.4 Server-Authoritative Mutation & Concurrency Guard (`src/server/collaborationManager.ts`)
- Manages active collaboration rooms.
- Assigns sequential `seq` numbers atomically.
- Validates actor permissions:
  - Viewers cannot submit mutating operations.
  - Tenant ID must match session owner.
  - Payload size must not exceed 512 KB.
- Persists snapshots to PostgreSQL (`conversation_messages.metadata` / `artifacts` table) with zero schema migrations.
- Broadcasts sequenced operations to all connected room participants.

### 4.5 Collaborative Canvas UI Integration (`src/components/ArtifactStudio.tsx` & `GenUICollaborativeCanvas.tsx`)
- Adds a Collaborative Presence Header displaying:
  - Active participant avatars (with human vs. agent badge).
  - Connection indicator (`CONNECTED`, `CONNECTING`, `OFFLINE`, `SYNCING`).
  - Save status (`DURABLY_SAVED`, `PENDING_SYNC`).
  - Active presence count.
- In-line selection indicators for remote collaborators without disrupting local editor focus.
- Export menu with direct DOCX, XLSX, PPTX, and PDF download triggers.

---

## 5. Testing Decisions

### Good Test Principles
- Test external observable behavior and convergence invariants, not internal private state.
- Hostile network tests: simulate out-of-order delivery, duplicate messages, and disconnections.
- Strict multi-client verification: run separate simulated clients and verify that all converge to identical content.

### Test Matrix
1. **Multimodal Core & PDF Engine (`test/artifact-multimodal-engine.test.ts`):**
   - PDF 1.4 binary signature (`%PDF-1.4`, `%%EOF`), cross-reference table validity.
   - Comprehensive DOCX, XLSX, PPTX OpenXML packaging checks.
2. **Collaboration CRDT & Concurrency Suite (`test/collaboration-crdt-engine.test.ts`):**
   - Causal ordering and Lamport clock updates.
   - Idempotency: duplicate `opId` must be ignored.
   - Out-of-order operation convergence.
   - Participant-scoped undo/redo: undoing User A does not revert User B.
   - Cell-level spreadsheet convergence with AST recalculation.
   - Slide deck reordering and insertion convergence.
   - Diagram node/edge integrity checks.
3. **Multi-Client Acceptance Suite (`test/collaboration-acceptance.test.ts`):**
   - Scenario A: Two human clients concurrently editing different sections of a document.
   - Scenario B: Human user editing spreadsheet while AI Data Agent populates cells.
   - Scenario C: Same-cell concurrent edit conflict resolution.
   - Scenario D: Collaborative slide deck creation and PPTX export.
   - Scenario E: Multi-agent co-authoring (Research Agent + Copywriter Agent).
   - Scenario F: Offline edit queueing and reconnection sync.
   - Scenario G: Server restart and PostgreSQL snapshot restoration.
   - Scenario H: Unauthorized participant rejection and tenant isolation.
   - Scenario I: Hostile network test (reconnect mid-operation with state vector replay).
   - Scenario J: Headless Chromium canvas mounting with live presence bar.

---

## 6. Out of Scope

1. **Unrestricted Remote Code Execution:** Merged collaborative code cannot execute outside existing opaque sandboxes.
2. **Remote MCP Egress:** `assertApprovedPublicMcpDestination()` remains fail-closed (503 `MCP_EGRESS_ENFORCEMENT_REQUIRED`).
3. **Paid External Realtime Services:** No external Redis, Ably, or Pusher subscriptions; runs entirely on self-hosted dual transport.
4. **Commercial Pricing Changes:** Preserves PR #215 commercial candidate, GST invoicing, Razorpay/Stripe gateways untouched.
5. **Production Database Migrations:** No schema changes; leverages existing JSONB columns.

---

## 7. Further Notes
All deliverables strictly adhere to the standing engineering rules: no fake mocks, zero release-blocking errors, and complete empirical verification.
