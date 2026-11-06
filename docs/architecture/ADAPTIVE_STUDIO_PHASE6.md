# Adaptive Studio — Phase 6 integration checkpoint

Status: **integration candidate; Windows Edge acceptance pending**. This is not a release certificate.

## Isolation and authority

- Baseline: `origin/prod-release` at `478dd40` when the isolated design branch was created.
- Working branch: `design/adaptive-studio-phase6`.
- No commits are merged into `prod-release`; PR #127 and PR #137 are not touched.
- No production or staging database migration, worker activation, infrastructure change, or deployment is part of this slice.
- The existing Phase 7 prototype at `D:\aira adaptive studio\aira-adaptive-studio` on `127.0.0.1:4173` is not modified. It is a reference, not a replacement backend.

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

## Local verification executed

- `node --import tsx --test test/adaptive-studio-preview.test.tsx` — 2/2 PASS.
- `npm run typecheck:client` — PASS.
- `npm run typecheck` — PASS during the initial integration slice.
- `npm run lint` — exit 0, with pre-existing warnings; no clean-warning claim.
- `npm run build` with flag unset — PASS; the experimental empty-state content was eliminated from the default bundle.
- `VITE_ADAPTIVE_STUDIO_PREVIEW=true npm run build` — PASS; the preview content was included.
- `git diff --check` — no whitespace errors.

The production-style build emits an existing large-chunk advisory. Do not equate successful typecheck/build with browser or authenticated workflow acceptance.

## Next acceptance gate — actual Windows Edge

Use a **new isolated worktree**; do not overwrite the certified Phase 7 prototype or switch PR #127/#137 worktrees. Avoid copying secrets or `.env` files from production.

Example PowerShell sequence after the remote design branch is available:

```powershell
git fetch origin design/adaptive-studio-phase6
git worktree add 'D:\AIRA-ADAPTIVE-INTEGRATION' origin/design/adaptive-studio-phase6
Set-Location 'D:\AIRA-ADAPTIVE-INTEGRATION'
npm ci
$env:VITE_ADAPTIVE_STUDIO_PREVIEW = 'true'
npm run dev -- --host 127.0.0.1 --port 4174 --strictPort
```

Launch Edge against `http://127.0.0.1:4174/` while leaving the original prototype on `4173` undisturbed. Inspect at least 1600×1000, 1280×800, 768×1024, 390×844, and 320×700.

Required evidence before Phase 6 can be called complete:

1. No clipped header actions, horizontal page overflow, overlapping sidebar/chat/artifact columns, or inaccessible composer at any viewport.
2. Chat/Agent changes update both toggles and the active AIRA mode; model selection and deep reasoning remain functional.
3. Open an existing *test* artifact and verify the same sandboxed preview, nonce-validated messages, code tab, version selector, safe download, close, and expanded-mode behavior.
4. Verify dark/light styles, keyboard focus, navigation drawer, project/chats, and accessibility labels.
5. Verify signed-out behavior and two isolated test accounts in nonproduction only; never use production credentials for this design gate.
6. Run the unaffected/default-off UI and compare against baseline. Record screenshots, console logs, failing cases, and exact SHA.

If any gate fails, keep this as a draft design candidate. Do not merge or enable `VITE_ADAPTIVE_STUDIO_PREVIEW` on a production deployment without the repository's explicit exact-SHA GO LIVE process.
