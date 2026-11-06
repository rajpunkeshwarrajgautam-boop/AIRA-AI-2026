# Adaptive Studio — Phase 6 integration checkpoint

Status: **PHASE 6 — PASS (Windows Edge acceptance certified)**.

## Isolation and authority

- Baseline: `origin/prod-release` at `478dd40` when the isolated design branch was created.
- Working branch: `design/adaptive-studio-phase6`.
- Certified head commit: `21e325f61b64dfb705cb546e44c3d87f0f823ec6`.
- No commits are merged into `prod-release`; PR #127 and PR #137 are not touched.
- No production or staging database migration, worker activation, infrastructure change, or deployment is part of this slice.
- The existing Phase 7 prototype at `D:\aira adaptive studio\aira-adaptive-studio` on `127.0.0.1:4173` is not modified and remained running persistently on PID `19916`.

## Integration contract

The environment variable `VITE_ADAPTIVE_STUDIO_PREVIEW=true` enables the experimental presentation shell. With the variable absent or set to any other value, the existing AIRA UI remains the default.

| Surface | Real AIRA owner | Phase 6 change |
| --- | --- | --- |
| Chat, history, streaming | `src/App.tsx`, `src/components/ChatMessage.tsx` | Existing state and handlers retained. |
| Chat/Agent mode | `src/App.tsx`, `src/components/ChatInput.tsx` | Additional top toggle calls the existing `setWorkspaceMode`; composer toggle remains. |
| Model selection/reasoning | `src/components/ModelSelector.tsx` | Existing model router and thinking settings retained. |
| Projects, navigation, account | `src/components/Sidebar.tsx` | Existing navigation retained; opt-in color and width styling only. |
| Artifact previews | `src/components/ArtifactStudio.tsx`, `src/utils/artifactSandbox.ts` | Real sandbox and source/export controls remain; optional dock width aligns with empty-state panel. |
| Empty artifact dock | `src/components/AdaptiveStudioEmptyState.tsx` | Explicitly non-executable guidance; never fabricates an artifact or iframe. |
| Visual styling | `src/styles/adaptiveStudio.css` | Namespaced under `.aira-adaptive-shell` to avoid changing the default shell. |

This is a **visual shell bridge**, not a replacement for runtime orchestration, authentication, persistence, tool execution, or the artifact sandbox. The mock solar system and scripted chat response from the standalone prototype are intentionally excluded.

## Windows Edge Acceptance Results

Executed against live Vite development server at `http://127.0.0.1:4174/` on Windows 11 host using Chrome DevTools Protocol (CDP):

| Verification Check | Viewports | Evidence & Result |
| --- | --- | --- |
| **No page overflow or clipped actions** | 1600×1000, 1280×800, 768×1024, 390×844, 320×700 | `hasHorizontalOverflow: false` across all viewports; clean composer and header alignment. |
| **Chat / Agent Mode synchronization** | Desktop 1600×1000 | Toggling top button sets `aria-pressed`, updates workspace mode to `agent`, and updates greeting to `"Delegate multi-step goals, scaffold complete web applications..."`. |
| **Model selector & deep reasoning** | Desktop 1600×1000 | Model selector opens dropdown cleanly; model routing and thinking settings preserved. |
| **Empty Artifact Studio Dock** | Desktop (1600 & 1280) vs Mobile (< 1280) | Dock displays `AdaptiveStudioEmptyState` at >= 1280px; hidden at tablet and mobile. |
| **Real Artifact Studio sandbox** | Desktop 1600×1000 | Opening real test artifact mounts `ArtifactStudio` with `sandbox="allow-scripts allow-modals allow-forms"` in docked 46% column (`736px`). Verified Preview tab, Code tab syntax display, Copy, Expand (full viewport), Restore, and Close (returns to empty dock). |
| **Light & Dark theme switching** | All viewports | CSS variables `--adaptive-surface`, `--adaptive-rail`, etc., update cleanly between light and dark palettes. |
| **Navigation drawer** | Mobile 390×844 | Sidebar drawer opens on mobile menu click and dismisses cleanly. |
| **Default-off baseline UI** | Port 4175 (flag false) | Verified complete absence of `.aira-adaptive-shell` and empty studio dock; legacy AIRA UI 100% preserved. |
| **Browser console clean** | All viewports | 0 errors; 0 unhandled exceptions. |

## Automated Verification Harness

- `node --import tsx --test test/adaptive-studio-preview.test.tsx` — **2/2 PASS**.
- `npm run typecheck:client` — **PASS**.
- `npm run lint` — exit 0.
- `npm run build` (flag unset) — **PASS** (preview content tree-shaken from bundle).
- `VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build` — **PASS** (preview content included).
- `git diff --check` — **PASS**.

**Verdict: PHASE 6 — PASS**
