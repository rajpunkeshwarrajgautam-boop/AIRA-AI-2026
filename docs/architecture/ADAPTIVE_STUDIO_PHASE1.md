# Adaptive Studio Phase 1 — Architecture Specification & Final Integration Checkpoint

Status: **Milestones 1.1–1.7 verified; Microsoft Edge browser acceptance PASS; Unit/component tests 22/22 PASS; Client typecheck PASS; Linter PASS; Production builds PASS; Live backend execution gates deferred.**

## 1. Executive Summary & Redesign Culmination

Phase 1 brings together the entire redesign arc across **Phases 7 through 1** into a unified, hardened, production-quality interface for AIRA Adaptive Studio:
- **Phase 7:** Component anatomy, spatial hierarchy, and visual truth on port `4173`.
- **Phase 6:** Opt-in presentation shell bridge and feature-flag baseline on port `4174` (PR #138).
- **Phase 5:** Artifact streaming, SSE agent timeline events, sandboxed runtime repairs, and line diffs (PR #139).
- **Phase 4:** Responsive canvas controls, device viewport presets, bounded zoom [0.5–1.5x], and HITL approvals (PR #140).
- **Phase 3:** Multi-agent orchestration, interactive DAG visualization, execution wave scheduling, and task artifact binding (PR #141).
- **Phase 2:** Multi-file artifact bundling, workspace file tree explorer, module dependency graph, and PKZip exporter (PR #142).
- **Phase 1 (Final Implementation Phase):** Unified Adaptive Studio experience, multi-modal asset previews (images, SVG, audio, video, PDF), universal non-invasive keyboard navigation, WAI-ARIA accessibility compliance, and cross-phase security hardening.

```
+---------------------------------------------------------------------------------------------------------+
|                                           TOPBAR (AIRA SHELL)                                           |
|  [Logo: Sheared Portal]   Project Title   [Mode: Chat / Agent]   Model: Auto   Theme   User             |
+-------------------------------------------------------+-------------------------------------------------+
|  LEFT NAVIGATION     |  CONVERSATION TIMELINE         |  UNIFIED ADAPTIVE ARTIFACT STUDIO (48% DOCK)    |
|  - Recent Chats      |  - User Messages               |  - Carousel: [Artifact 1 of N] (< >)            |
|  - Projects          |  - Assistant Messages          |  - Tabs: [Preview (Alt+1)] [Code (Alt+2)]       |
|  - Sandboxes         |  - Multi-file Project Cards    |          [Diff (Alt+3)]    [Graph (Alt+4)]      |
|                      |                                |  - Actions: [Files (Cmd+P)] [Project] [Zip]     |
|                      |                                +------------------------+------------------------+
|                      |                                |  WORKSPACE EXPLORER    |  MULTI-MODAL STAGE     |
|                      |                                |  - Search: [Filter...] |  - Interactive Code    |
|                      |                                |  - [Folder] assets     |  - SVG (Visual/Source) |
|                      |                                |    |- branding.svg     |  - Raster Image (Zoom) |
|                      |                                |    |- hero.png         |  - Audio Player (Scrub)|
|                      |                                |  - [Folder] audio      |  - Video Player        |
|                      |                                |    |- alert.mp3        |  - Sandboxed PDF       |
|                      |                                |  - index.html (Entry)  |  - Strict Nonce Bridge |
|                      |                                |  - [Dependencies View] |  - Live Announcer      |
+-------------------------------------------------------+------------------------+------------------------+
```

---

## 2. Implemented & Verified Capabilities

### Pillar 1.1: Multi-Modal Asset Viewer (`MultiModalAssetViewer.tsx`)
- **Safe Vector Graphics (SVG):**
  - Integrated `sanitizeSvgMarkup` to strictly strip `<script>`, `<foreignObject>`, inline event handlers (`onload`, `onclick`, `onerror`), and `javascript:` URIs before rendering.
  - Interactive toggle between high-fidelity **Visual Preview** and raw syntax-highlighted **Source Code**.
  - Integrated zoom controls [50%–300%] with centered transform origin and SVG dimension metadata.
- **High-Resolution Raster Images (PNG, JPEG, WebP, GIF):**
  - Transparency checkerboard grid background (`radial-gradient`) with rounded framing.
  - Natural dimension extraction (`naturalWidth` × `naturalHeight`), byte size formatting, and MIME metadata tag.
  - Granular zoom stepping with 100% reset and boundary limits [0.5x, 3.0x].
- **HTML5 Audio Player (MP3, WAV, OGG, AAC, M4A):**
  - Custom dark theme player card with waveform-style progress slider, play/pause controls, time display, and duration readout.
  - Graceful audio decoding error handling.
- **Video Player (MP4, WebM, OGV):**
  - Native video controls with `playsInline`, `preload="metadata"`, and responsive aspect ratio fitting.
- **Document / PDF Previews:**
  - Sandboxed iframe preview (`sandbox="allow-scripts allow-forms"`) isolating parent DOM and origin.
- **Safe Object URL Management:**
  - Guaranteed `URL.revokeObjectURL` cleanup upon component unmount and file navigation to prevent memory leaks during long-running agent workflows.

### Pillar 1.2: Universal Keyboard Navigation & Accessibility
- **Non-Invasive Tab Switching:**
  - `Alt+1`: Instant jump to **Preview** tab.
  - `Alt+2`: Instant jump to **Code** inspection tab.
  - `Alt+3`: Instant jump to **Diff** comparison tab (when multiple revisions exist).
  - `Alt+4`: Instant jump to **Graph** multi-agent execution tab (when execution graph exists).
  - Keyboard listeners automatically yield when typing in text fields, textareas, or content-editable elements.
- **Quick File Jump (`Cmd/Ctrl+P`):**
  - Pressing `Cmd+P` (macOS) or `Ctrl+P` (Windows/Linux) opens the Workspace File Explorer drawer and immediately focuses and selects the file search input.
- **Drawer & Focus Dismissal (`Escape`):**
  - Pressing `Escape` closes the console drawer, dismisses search focus, or collapses expanded studio width without unexpected layout jumps.
- **WAI-ARIA Conformance:**
  - Studio view buttons configured with `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, and unique element IDs.
  - Display containers bound with `role="tabpanel"` and `aria-labelledby`.
  - Workspace File Explorer equipped with `role="tree"` and `role="treeitem"`, tracking `aria-expanded` and `aria-selected`.
- **Screen Reader Announcements (`aria-live="polite"`):**
  - Added an accessible offscreen announcer communicating view tab changes, file selection, and drawer state changes to assistive technologies.
- **Reduced Motion Support (`prefers-reduced-motion`):**
  - Detects `(prefers-reduced-motion: reduce)` and disables animated slide transitions in Framer Motion to honor system accessibility preferences.

### Pillar 1.3: Cross-Phase Security Hardening
- **Iframe Sandbox Boundary:** Live code sandbox remains strictly restricted to `sandbox="allow-scripts allow-modals allow-forms"` without `allow-same-origin`, preventing artifact code from reading parent cookies, `localStorage`, or tokens.
- **Per-Session Crypto Nonces:** Cross-frame postMessage console bridge requires an unguessable 128-bit cryptographic nonce regenerated upon every artifact change and session reset.
- **Windows Reserved Device Names:** Hardened `normalizeAndValidateArtifactPath` to strictly prohibit Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) preventing local file descriptor hangs or filesystem crashes on Windows hosts.
- **ZIP Export Safety Gates:** Enforces strict archive guards in `artifactZipExporter.ts` limiting uncompressed project sizes to <= 50MB and <= 500 files.
- **Session Transition Invalidation:** Switching conversations or accounts immediately unmounts active sandboxes and clears revision caches to prevent cross-account leakage.

### Pillar 1.4: Cross-Phase Integration Defect Resolution
- Harmonized `activeBundle` resolution across legacy single-file and multi-file artifacts.
- Resolved type divergence between `ArtifactType` and `ArtifactFileKind` by incorporating multi-modal MIME identifiers.
- Added defensive topological wave derivation and node map normalization in `AgentExecutionGraphView`.
- Eliminated redundant iframe remounts and synchronized selection between Execution Graph task nodes, conversation artifact cards, and Workspace File Explorer items.

---

## 3. Verification & Acceptance Gates Summary

| Verification Gate | Command / Target | Outcome | Status |
| :--- | :--- | :--- | :--- |
| **Multi-Modal & Security Unit Tests** | `npx tsx --test test/phase1-multimodal-security.test.ts` | 5/5 passed | **PASS** |
| **All Design Phase Regressions** | `npx tsx --test test/*.test.tsx test/*.test.ts` | 22/22 passed | **PASS** |
| **Client Typecheck** | `npm run typecheck:client` (`tsc -b`) | Zero errors (exit code 0) | **PASS** |
| **Code Style & Linter** | `npm run lint` (`oxlint`) | Zero errors (exit code 0) | **PASS** |
| **Default-Off Production Build** | `npm run build` | Built in 5.12s (exit code 0) | **PASS** |
| **Flag-Enabled Production Build** | `VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build` | Built in 1.08s (exit code 0) | **PASS** |
| **Whitespace & Formatting Integrity** | `git diff --check` | Zero whitespace errors | **PASS** |
| **Microsoft Edge Baseline Acceptance** | 1600x1000 default-off | Legacy UI preserved; Studio dock hidden | **PASS** |
| **Microsoft Edge Desktop Acceptance** | 1600x1000 flag-enabled | Unified Studio, Carousel, Tablist, Ctrl+P, Alt+1..4 | **PASS** |
| **Microsoft Edge SVG Preview Acceptance** | 1600x1000 flag-enabled | Visual render, Source code toggle, Zoom | **PASS** |
| **Microsoft Edge Image Preview Acceptance** | 1600x1000 flag-enabled | Image stage, Checkerboard, Zoom in 125% | **PASS** |
| **Microsoft Edge Audio Player Acceptance** | 1600x1000 flag-enabled | Audio card, Time scrubber, Play/pause | **PASS** |
| **Microsoft Edge Tablet Acceptance** | 768x1024 flag-enabled | Zero document overflow | **PASS** |
| **Microsoft Edge Mobile Acceptance** | 390x844 flag-enabled | Zero document overflow, full-width overlay | **PASS** |
| **Microsoft Edge Small Mobile Acceptance**| 320x700 flag-enabled | Zero document overflow (320px width) | **PASS** |

---

## 4. Live Backend & Production Execution Gates Status

In strict accordance with the Global Antigravity Rules and project instructions:

> [!IMPORTANT]
> **Production Status: BLOCKED (Deliberately Deferred)**
> 1. PR #127 (Model Router & Worker Runtime) and PR #137 (Postgres Outbox & Durable Workers) remain untouched and out of scope.
> 2. Live durable-worker execution, production Neon migrations, and remote cloud infrastructure remain unactivated.
> 3. Feature flag `VITE_ADAPTIVE_STUDIO_PREVIEW` remains set to `false` by default, ensuring existing production behavior is 100% preserved.
> 4. All Phase 1 deliverables exist on isolated branch `design/adaptive-studio-phase1` in worktree `D:\AIRA-PHASE1-WORKTREE` stacked on Phase 2 (PR #142).
