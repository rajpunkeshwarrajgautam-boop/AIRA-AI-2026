# Adaptive Studio Phase 2 — Architecture Specification & Execution Checkpoint

Status: **Milestones 2.1–2.7 verified; Microsoft Edge browser acceptance PASS; Unit/component tests 43/43 PASS; Live backend execution gates deferred.**

## 1. Executive Summary & Context

Phase 7 established the visual truth and component anatomy on port `4173`.  
Phase 6 established the opt-in presentation shell bridge on port `4174` (PR #138).  
Phase 5 established real-time artifact streaming, agent timeline events, and diff views (PR #139).  
Phase 4 established responsive canvas controls, device presets, zoom, and HITL approval integration (PR #140).  
Phase 3 established multi-agent orchestration, interactive DAG visualization, and execution wave scheduling (PR #141).  

**Phase 2 establishes the Multi-File Artifact Bundling & Workspace File Tree Explorer**, extending AIRA's single-file artifact model into a complete, modular, multi-file project workspace with in-studio file navigation, code inspection, safe sandboxed bundle execution, module dependency analysis, and zero-dependency PKZip project export.

```
+---------------------------------------------------------------------------------------------------------+
|                                           TOPBAR (AIRA SHELL)                                           |
|  [Logo: Sheared Portal]   Project Title   [Mode: Chat / Agent]   Model: Auto   Theme   User             |
+-------------------------------------------------------+-------------------------------------------------+
|  LEFT NAVIGATION     |  CONVERSATION TIMELINE         |  ADAPTIVE ARTIFACT STUDIO (48% DOCK)            |
|  - Recent Chats      |  - User Messages               |  - Studio Tabs: [Preview] [Code] [Diff] [Graph] |
|  - Projects          |  - Assistant Messages          |  - Actions: [Files (5)] [Project] [Copy] [Zip]  |
|  - Sandboxes         |  - Multi-file Project Cards    +------------------------+------------------------+
|                      |                                |  WORKSPACE EXPLORER    |  EXECUTION SANDBOX     |
|                      |                                |  - Search: [Filter...] |  - Bundled HTML/CSS/JS |
|                      |                                |  - [Folder] src        |  - Strict Nonce Bridge |
|                      |                                |    |- styles.css       |  - Console Log Drawer  |
|                      |                                |    |- app.js           |  - Device Viewports    |
|                      |                                |  - index.html (Entry)  |  - Zero Parent Origin  |
|                      |  [Composer: Chat/Agent toggle] |  - [Dependencies View] |  - Error Boundary      |
+-------------------------------------------------------+------------------------+------------------------+
```

---

## 2. Implemented & Verified Capabilities

### Pillar 2.1: Multi-File Artifact Data Model & Manifests
- **Structured Project Format:** Introduced `MultiFileArtifactBundle` and `ArtifactProjectFile` ([`src/types/multiFileArtifact.ts`](file:///D:/AIRA-PHASE2-WORKTREE/src/types/multiFileArtifact.ts)), supporting arbitrary nested directories, multiple languages (`html`, `css`, `javascript`, `typescript`, `json`, `markdown`, `svg`, `asset`), file sizes, modification timestamps, and designated entrypoints.
- **Deterministic Manifests:** Generates `project-manifest.json` containing SHA-256 checksums, byte counts, and entrypoint declarations for every bundle.
- **100% Backwards Compatibility:** Preserved legacy single-file artifacts via `adaptSingleFileArtifactToBundle`, ensuring all existing components, revisions, and sandbox routines work identically whether given a single file or a multi-file project.

### Pillar 2.2: Path Normalization & Traversal Security Boundary
- **Strict Normalization:** Enforced strict path sanitization via `normalizeAndValidateArtifactPath` ([`src/utils/artifactPathSecurity.ts`](file:///D:/AIRA-PHASE2-WORKTREE/src/utils/artifactPathSecurity.ts)):
  - Rejects directory traversal sequences (`..`).
  - Rejects POSIX absolute paths (`/`) and Windows drive letters (`C:\`, `D:\`).
  - Rejects UNC network paths (`\\`).
  - Rejects null bytes (`\0`) and ASCII control characters.
  - Blocks secret-bearing file names (`.env`, `.env.local`, `id_rsa`, `passwd`, `credentials.json`).
  - Blocks dangerous cryptographic extensions (`.pem`, `.key`, `.p12`, `.pfx`, `.crt`, `.kdbx`).
  - Blocks internal control directories (`.git`, `.ssh`).

### Pillar 2.3: Module Dependency Analyzer & Reference Extraction
- **Cross-File Reference Discovery:** Implemented `analyzeFileDependencies` and `buildProjectDependencyGraph` ([`src/utils/artifactDependencyAnalyzer.ts`](file:///D:/AIRA-PHASE2-WORKTREE/src/utils/artifactDependencyAnalyzer.ts)).
- **AST / Regex Extraction:**
  - HTML `<link rel="stylesheet">`, `<script src="...">`, `<img src="...">`.
  - JS/TS static imports (`import ... from '...'`), dynamic imports (`import('...')`).
  - CSS `@import` rules.
- **Specifier Resolution:** Resolves relative specifiers (e.g. `./components/Card` -> `src/components/Card.tsx`) while distinguishing verified local files from external dependencies.

### Pillar 2.4: Interactive Workspace File Explorer
- **Accessible Tree Component:** Created `WorkspaceFileExplorer` ([`src/components/WorkspaceFileExplorer.tsx`](file:///D:/AIRA-PHASE2-WORKTREE/src/components/WorkspaceFileExplorer.tsx)) conforming to WAI-ARIA Treeview patterns (`role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-selected`).
- **Interactive Capabilities:**
  - Collapsible/expandable folder hierarchies.
  - Active file selection with syntax-specific file icons.
  - Instant source code inspection in the Code view.
  - Instant live filter / search input across paths and filenames.
  - Collapsible Dependency Panel displaying outgoing imports and inbound references for the selected file.
  - Unsaved change indicators and designated `ENTRY` badges.
- **Zero-Restart Guarantee:** Selecting a file in the tree switches the active file in the Code inspector without triggering iframe reloads or restarting unrelated sandbox previews.

### Pillar 2.5: Sandboxed Multi-File Preview Runtime
- **In-Memory Bundler:** Built `generateMultiFileArtifactSandboxHtml` ([`src/utils/multiFileSandbox.ts`](file:///D:/AIRA-PHASE2-WORKTREE/src/utils/multiFileSandbox.ts)) to inline local stylesheets, scripts, and assets in memory.
- **Origin Isolation:** Rendered in an isolated iframe with `sandbox="allow-scripts allow-modals allow-forms"` (never `allow-same-origin`). Artifact code has no access to AIRA session tokens, host storage, or parent cookies.
- **Security Bridge:** Integrated cryptographically random per-session nonces for console log streaming and structured runtime error forwarding (`AIRA_ARTIFACT_RUNTIME_ERROR`).

### Pillar 2.6: Pure Zero-Dependency PKZip Project Exporter
- **Clean PKZip Implementation:** Implemented standard IEEE 802.3 CRC-32 and PKZip binary archive generation in pure JavaScript and DataView ([`src/utils/artifactZipExporter.ts`](file:///D:/AIRA-PHASE2-WORKTREE/src/utils/artifactZipExporter.ts)). Zero external npm dependencies.
- **Hard Safety Limits:** Enforces a maximum archive size of 50MB and a maximum of 500 files per export to prevent ZIP bomb vulnerabilities.

### Pillar 2.7: Controlled Workspace Synchronization
- **Identity-Bound Persistence:** Built `syncBundleToWorkspace` ([`src/utils/artifactWorkspaceSync.ts`](file:///D:/AIRA-PHASE2-WORKTREE/src/utils/artifactWorkspaceSync.ts)) with strict identity checking (`neonAuth.getCurrentUser()`) and project authorization.
- **Isolation Preserved:** Local prototype operations remain sandboxed to client storage; remote database writes and durable workers remain guarded and blocked.

---

## 3. Microsoft Edge Browser Acceptance & Evidence Matrix

Executed on Windows workstation using Microsoft Edge (`scripts/adaptive-phase2-browser-acceptance.mjs`):

| Viewport | Mode | Result | Verified Capabilities |
| :--- | :--- | :--- | :--- |
| **1600x1000** | Flag Enabled (`:4184`) | **PASS** | File Explorer rendered, nested tree navigation, file inspection, dependency summary, search filtering, ZIP trigger, sync trigger, zero overflow. |
| **768x1024** | Flag Enabled (`:4184`) | **PASS** | Responsive docked studio layout on tablet, zero horizontal overflow. |
| **390x844** | Flag Enabled (`:4184`) | **PASS** | Mobile studio drawer, responsive navigation, zero horizontal overflow. |
| **320x700** | Flag Enabled (`:4184`) | **PASS** | Small mobile layout, touch targets preserved, zero horizontal overflow. |
| **1600x1000** | Default-Off (`:4185`) | **PASS** | Legacy layout 100% preserved; Adaptive shell and explorer absent. |

### Visual Artifacts Captured
- [`phase2-edge-desktop-1600x1000-file-tree.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-desktop-1600x1000-file-tree.png)
- [`phase2-edge-desktop-1600x1000-file-inspection.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-desktop-1600x1000-file-inspection.png)
- [`phase2-edge-desktop-1600x1000-dependencies.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-desktop-1600x1000-dependencies.png)
- [`phase2-edge-desktop-1600x1000-search.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-desktop-1600x1000-search.png)
- [`phase2-edge-tablet-768x1024.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-tablet-768x1024.png)
- [`phase2-edge-mobile-390x844.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-mobile-390x844.png)
- [`phase2-edge-small-mobile-320x700.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-small-mobile-320x700.png)
- [`phase2-edge-default-off-baseline.png`](file:///C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84/phase2-edge-default-off-baseline.png)

---

## 4. Verification & Release Gates Summary

- **Unit & Integration Tests:** 43/43 tests passing (`npm test` suite).
- **Client Typecheck:** `npm run typecheck:client` (`tsc -b`) passed with 0 errors.
- **Linter:** `npm run lint` (`oxlint`) passed with 0 errors.
- **Default-Off Production Build:** `npm run build` succeeded cleanly.
- **Flag-Enabled Production Build:** `VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build` succeeded cleanly.
- **Whitespace Hygiene:** `git diff --check` passed with 0 errors.
- **Runtime Error Ingestion:** Zero console exceptions across all browser acceptance runs.
- **Isolation Compliance:** Zero mutations to PR #127, PR #137, `prod-release`, `main`, Neon databases, or durable workers. Ports 4173 and 4174 remained undisturbed.
