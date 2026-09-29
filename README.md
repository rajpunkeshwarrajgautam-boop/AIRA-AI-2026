# Aira AI — Phase 1 Frontend Transformation

**Aira AI — One workspace. Every intelligence.**

This package is the first transformation pass of the supplied Claude-style frontend into an Aira-native workspace shell.

## What changed

- Aira product identity, mark, title, copy, and default dark visual language.
- Workspace navigation for Chat, Research, Library, Projects, Agents, and Automations.
- Aira intelligence selector (`Aira Auto`, `Aira Pro`, `Aira Fast`, `Aira Deep`).
- Research / Agent modes in the composer and workspace-aware prompt context.
- `Artifacts` renamed to **Output Studio** as the beginning of a broader result/execution surface.
- New Aira-first empty state and starter missions.
- Clean Aira local-storage namespace so the transformed UI does not resurrect old Claude demo data.
- Markdown output sanitation before `dangerouslySetInnerHTML`.
- Output iframe sandbox tightened by removing `allow-same-origin`.
- Existing `ArtifactType` TypeScript build blocker fixed.

## Important Phase 1 compatibility choice

The visible intelligence modes are Aira abstractions, but the existing provider/model IDs remain underneath for now. This intentionally keeps the current prototype streaming path working while Aira's server-authoritative model router is integrated later.

The direct browser BYOK provider path is still prototype code. Production provider credentials should be proxied and stored server-side.

## Run on Windows

```powershell
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal.

For a production compile:

```powershell
npm run build
```

## Validation performed

The transformed TypeScript project passes:

```text
node node_modules/typescript/bin/tsc -b
```

A full Vite bundle was not generated in the Linux inspection environment because the uploaded `node_modules` contained Windows-native Vite/Rolldown dependencies. The source bundle intentionally excludes `node_modules`; reinstalling on your Windows machine resolves the platform-native dependency selection.

## Next transformation pass

Phase 2 should wire the Aira shell into the real Aira execution architecture: intent routing, research/citations, library persistence, provider routing, tool actions, workflows, automations, agents, authentication, and the production data layer.
