# AIRA GenUI Phase 4B — Advanced Multimodal Artifact Workspace & Unified Interactive Canvas Specification

> **Specification Identifier:** `SPEC-AIRA-GENUI-PHASE4B-001`  
> **Status:** `APPROVED`  
> **Target Branch:** `feat/aira-genui-phase1-foundation`  
> **Baseline Commit:** `dfd01a2c35eaae23b8f25b15b3c58ceba41bbbc9`  
> **Target Release Lineage:** `6c90c12` -> `f77fb64` -> `a17982c` -> `f2e9b40` -> `f39ecab` -> `104ced7` -> `dfd01a2`  
> **Protected References:** `origin/prod-release` (`f429d90`) and PR #215 (`fd2f8b9` on STRICT HOLD) preserved unmodified.

---

## 1. Problem Statement

Modern AI conversational systems produce diverse deliverables beyond plain text, including rich documents, multi-file software projects, financial spreadsheets, executive presentations, architecture diagrams, and interactive applications.

Currently in AIRA:
1. `ArtifactStudio` and `UnifiedWorkspace` focus heavily on single-file code (`application/vnd.ant.code`), React components (`application/vnd.ant.react`), and HTML/SVG.
2. Spreadsheets are not natively modeled, lacking cell coordinates, structured recalculation, formula evaluation, and formula injection defense.
3. Presentations lack structured slide abstractions, layouts, speaker notes, and presentation file generation.
4. Export capabilities are fragmented: while ZIP export exists for multi-file bundles, true document (`.docx`), spreadsheet (`.xlsx`), and presentation (`.pptx`) exports are missing, often replaced in weaker systems by fake file renames.
5. AI-assisted artifact revision lacks granular patch contracts and conflict detection, causing whole-document overwrites and accidental data loss during multi-turn interactions.
6. Artifacts are not durably synchronized through the existing client-server conversation sync pipeline (`conversation_messages.metadata`), causing lost edits on page refresh.

---

## 2. Solution

AIRA GenUI Phase 4B introduces the **Unified Multimodal Artifact Architecture (`aira-artifact/v1`)**, expanding `ArtifactStudio` and `UnifiedWorkspace` into a comprehensive interactive canvas supporting 8 multimodal artifact classes:

1. **Rich Documents (`application/vnd.aira.doc` & `text/markdown`):** Structured documents with headings, lists, callouts, tables, citations, and verified DOCX/PDF export.
2. **Spreadsheets (`application/vnd.aira.sheet`):** Worksheets with cell grid addressing (`A1`..`Z100`), AST-based deterministic formula recalculation (`SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `PRODUCT`, `IF`), cycle detection (`#CYCLE!`), CSV formula injection sanitization, and verified XLSX export.
3. **Presentations (`application/vnd.aira.slide`):** Structured slide decks with layouts (`title-slide`, `content`, `split`, `stats`, `quote`), slide reordering, visual themes, speaker notes, live slide preview, and verified PPTX/HTML export.
4. **Diagrams (`application/vnd.ant.mermaid`):** Declarative architecture, flowchart, sequence, and dependency graphs rendered via local sanitized SVG/DOM with zero external CDNs.
5. **Code & Multi-File Projects (`application/vnd.ant.code`, `MultiFileArtifactBundle`):** Integrated syntax highlighting, file tree navigation, diff inspection, and standard PKZip archive export.
6. **Interactive GenUI Surfaces (`application/vnd.aira.surface` & `aira-genui/v1`):** Declarative component surfaces rendered with zero inference cost.
7. **Sandboxed Open Applications (`application/vnd.aira.app` & `aira-app/v1`):** Iframe isolation with opaque origin (`null`), CSP `connect-src 'none'`, and cryptographic bridge.
8. **Local MCP Apps (`application/vnd.aira.mcp-app` & `aira-mcp-app/v1`):** JSON-RPC 2.0 host bridge with side-effect ApprovalKernel gating and fail-closed remote MCP egress.

---

## 3. User Stories

1. As a research analyst, I want to generate a structured research document with tables and citations, edit sections locally, and export a genuine `.docx` file without formatting corruption.
2. As a financial modeler, I want to create a spreadsheet artifact, enter data into cells, use `=SUM(B2:B10)` and `=IF(...)` formulas, see instant recalculation without server roundtrips, and export a verified `.xlsx` workbook.
3. As a financial analyst, I want formula injection characters (`=`, `+`, `-`, `@`) automatically escaped when exporting spreadsheets to CSV so malicious formulas cannot execute in desktop Excel.
4. As a product manager, I want to create an executive slide deck artifact, navigate slides, reorder them, edit speaker notes, and export a clean `.pptx` presentation.
5. As a system architect, I want to generate a Mermaid architecture diagram, view the rendered SVG cleanly inside the canvas, edit the Mermaid text, and immediately see the updated diagram without external CDN requests.
6. As a software engineer, I want to inspect a multi-file project bundle, view diffs between revisions, restore previous versions, and export an uncorrupted `.zip` archive.
7. As a user collaborating with AIRA, I want to ask the AI to "update row 5 in the budget sheet" or "add a slide about security", and have the AI apply a targeted patch without overwriting my manual edits.
8. As a user, I want conflict detection to warn me if an AI response is based on a stale revision of my artifact so that my newer local edits are never silently wiped.
9. As a user, I want my opened artifacts, active sheet state, slide index, and draft edits to persist across page reloads and tab closures via PostgreSQL conversation metadata sync.
10. As a security operator, I want all document, spreadsheet, and presentation previews to execute under strict containment with zero ability to exfiltrate cookies or local storage.
11. As a mobile user, I want the ArtifactStudio to adapt seamlessly between desktop docking, tablet split-view, and mobile full-screen modal without breaking touch navigation.

---

## 4. Implementation Decisions

### D-01: Multimodal Artifact Contract (`aira-artifact/v1`)
- **Location:** `packages/contracts/src/artifacts.ts` (exported via `packages/contracts/src/index.ts`).
- **Schema:** `AiraArtifactDescriptorSchema` extending `Artifact` with:
  - `schemaVersion: 'aira-artifact/v1'`
  - `artifactClass: 'document' | 'code' | 'sheet' | 'slide' | 'diagram' | 'surface' | 'app' | 'mcp-app'`
  - `structuredPayload`: Typed JSON union holding document sections, spreadsheet workbook data, slide deck data, or diagram markup.
  - `capabilities`: `{ editable: boolean, previewable: boolean, executable: boolean, exportFormats: ExportFormat[] }`.
  - `revisions`: Immutable history with parent hashes and author attribution (`user` | `assistant`).

### D-02: Bounded AST Spreadsheet Recalculation Engine
- **Location:** `src/utils/spreadsheetEngine.ts`.
- **Design:**
  - Zero `eval()`, zero `new Function()`.
  - Tokenizer and recursive-descent parser building an AST of expressions (literal numbers, strings, cell references `[A-Z]+[0-9]+`, ranges `A1:B10`, unary/binary operators, and functions).
  - Built-in functions: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `PRODUCT`, `ABS`, `ROUND`, `IF`, `CONCAT`.
  - Topological dependency graph to evaluate cells in acyclic order. Detects cycles (`#CYCLE!`) and evaluation errors (`#VALUE!`, `#REF!`, `#DIV/0!`).
  - Formula injection defense: `sanitizeSpreadsheetCsvCell(value)` prepends a single quote `'` if value starts with `=`, `+`, `-`, or `@`.

### D-03: Structured Presentation Engine
- **Location:** `src/utils/presentationEngine.ts`.
- **Design:**
  - Pure TypeScript slide deck abstraction (`PresentationDeck`, `Slide`).
  - Standard layouts: `title-slide`, `content`, `split`, `stats`, `quote`.
  - Reordering, adding, deleting, and updating slides with undo/redo history.
  - Renderable directly in React via CSS-driven slide canvas with responsive aspect ratio (`16:9`).

### D-04: Declarative Diagram Renderer
- **Location:** `src/utils/diagramRenderer.ts` & `src/components/genui/GenUIDiagram.tsx`.
- **Design:**
  - Lightweight, safe parser for flowcharts (`graph TD/LR`), sequence diagrams, and class/architecture diagrams.
  - Generates sanitized pure SVG with responsive viewBox, clean layout nodes, arrows, and labels.
  - Offline, zero external CDNs, zero unsafe HTML injection.

### D-05: True Binary Document Exporter (DOCX, XLSX, PPTX, ZIP)
- **Location:** `src/utils/officeDocumentExporter.ts`.
- **Design:**
  - Builds on existing IEEE 802.3 CRC-32 and PKZip engine in `src/utils/artifactZipExporter.ts`.
  - Generates valid OpenXML packages:
    - **DOCX:** `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, `word/_rels/document.xml.rels`, `word/styles.xml`.
    - **XLSX:** `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1.xml`, `xl/styles.xml`.
    - **PPTX:** `[Content_Types].xml`, `_rels/.rels`, `ppt/presentation.xml`, `ppt/_rels/presentation.xml.rels`, `ppt/slides/slide1.xml`, `ppt/slideLayouts/slideLayout1.xml`.
  - Validated by independent zip uncompressors and standard file signatures (`PK\x03\x04`).

### D-06: Unified Canvas & Multimodal ArtifactStudio
- **Location:** `src/components/ArtifactStudio.tsx`, `src/components/genui/GenUISheetEditor.tsx`, `src/components/genui/GenUISlideEditor.tsx`.
- **Design:**
  - Detects `artifactClass` / MIME type and mounts appropriate specialized editor:
    - Document: Rich Markdown/Doc editor with live formatted preview.
    - Sheet: Interactive spreadsheet grid with formula bar, cell selection, row/column headers.
    - Slide: Interactive slide canvas with thumbnail navigator, layout selector, and speaker notes.
    - Diagram: Interactive SVG diagram viewer with source tab.
    - Code: Multi-file tree and Monaco/Ace-like lightweight syntax editor.
    - App: Sandboxed iframe with opaque origin and CSP `connect-src 'none'`.
  - Global toolbar: Mode toggle (`preview` / `edit` / `diff`), Export dropdown (supported formats), Version history dropdown with rollback, Save status indicator.

### D-07: Durable Conversation Metadata Persistence
- **Location:** `src/utils/conversationSearch.ts` and `src/App.tsx`.
- **Design:**
  - Extends `extractGenUIMetadata` and `hydrateGenUIMetadata` to include `artifacts` under `metadata.artifacts`.
  - Preserves full artifact content, structured payloads, and version history in existing `conversation_messages.metadata` (Migration `013` JSONB) with zero new DB migrations.

### D-08: AI-Assisted Patch & Conflict Detection Engine
- **Location:** `src/utils/artifactPatchEngine.ts`.
- **Design:**
  - Supports patch operations: `replace_section`, `update_cells`, `update_slide`, `insert_slide`, `replace_file`.
  - Detects stale base revision: rejects or flags when `patch.baseVersion !== artifact.version`.

---

## 5. Testing Decisions

1. **Unit Tests (`test/artifact-multimodal-engine.test.ts`):**
   - Spreadsheet calculation: arithmetic, cell references, range functions (`SUM`, `AVERAGE`, `MIN`, `MAX`), cycle detection (`#CYCLE!`), and CSV formula injection escaping.
   - Presentation model: slide ordering, layouts, note editing, and deck serialization.
   - Diagram rendering: SVG node generation, attribute sanitization, and invalid syntax resilience.
   - Office Document Exporter: Validates that generated DOCX, XLSX, and PPTX buffers are valid ZIP archives with correct internal OpenXML directory structures and XML files.
   - Artifact patch & conflict engine: targeted section replacement, stale revision detection.
2. **Acceptance Tests (`test/artifact-workspace-acceptance.test.ts`):**
   - Playwright headless Chromium verification: mounts sheet editor, slide editor, diagram viewer, and document editor.
   - Verifies cell editing and formula recalculation in live DOM.
   - Verifies slide navigation and layout switching.
   - Verifies export triggers without network leaks.
3. **Regression Tests:**
   - Existing GenUI tests (Phase 1, 2, 3, 3.5, 4A) must remain 100% passing.
   - Zero regression in `release-authorization-guard.test.ts` (52/52).

---

## 6. Out of Scope

- Multi-user synchronous real-time CRDT editing (deferred to Phase 4C).
- Unrestricted arbitrary Python / backend execution without sandboxing.
- Remote MCP egress infrastructure (strictly disabled under `MCP_EGRESS_ENFORCEMENT_REQUIRED`).
- Destructive production database migrations or commercial billing modifications.

---

## 7. Further Notes

- All changes are strictly code-only and backward-compatible.
- Works entirely within existing local React 19 / Vite frontend and Express BFF backend.
