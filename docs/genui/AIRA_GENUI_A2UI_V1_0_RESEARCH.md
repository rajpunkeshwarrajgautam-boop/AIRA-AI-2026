# Authoritative A2UI v1.0 Protocol Research (AIRA GenUI Phase 2)

**Primary Source Repository:** `https://github.com/a2ui-project/a2ui` (canonical redirect target of `https://github.com/google/A2UI`)  
**Verified Revision:** `36725eee042da90c526f469f94246f96e16fdc35` (`main` verified on `2026-11-27`)  
**License:** Apache License, Version 2.0 (`LICENSE` in `a2ui-project/a2ui`; reuse of test fixtures and catalog schemas requires Apache-2.0 attribution)

---

## 1. Inspected Authoritative Sources (`a2ui-project/a2ui@36725eee`)

- `specification/v1_0/docs/a2ui_protocol.md` — Core v1.0 message flow, transports, catalog validation, data binding, lifecycle
- `specification/v1_0/docs/evolution_guide.md` — Breaking & additive changes from v0.9 / v0.9.1 to v1.0
- `specification/v1_0/docs/a2ui_custom_functions.md` — Custom catalog function schemas & `allowedCallers` enforcement
- `specification/v1_0/json/agent_to_renderer.json` — Agent-to-renderer wire envelope schema
- `specification/v1_0/json/renderer_to_agent.json` — Renderer-to-agent action, function call/response, and error schemas
- `specification/v1_0/json/common_types.json` — `ComponentCommon`, `DataBinding`, `DynamicValue`, `FunctionCall`, `Action`, `CheckRule`, `Extensions`, `Surface`
- `specification/v1_0/json/renderer_capabilities.json` & `agent_capabilities.json` — Capability negotiation contract
- `catalogs/basic/v1/catalog.json` — Basic v1.0 catalog (18 components, 14 functions)
- `specification/v1_0/test/cases/` — Conformance test vectors (`renderer_messages.json`, `dynamic_value_validation.json`, `contact_form_example.jsonl`, `composition_constraints.json`)

---

## 2. Differences Between A2UI v1.0 and v0.8 / v0.9 / v0.9.1

1. **Envelope Version & Surface Creation:** v1.0 mandates `"version": "1.0"` on every wire message (`agent_to_renderer.json`, `renderer_to_agent.json`). `createSurface` replaces `v0.8` `beginRendering` + `surfaceUpdate` bootstrap, **removes `theme`** (supplying `theme` on v1.0 `createSurface` is invalid), allows optional inline `components` and `dataModel` (single-message instantiation), and allows optional `catalogId` (surface default catalog) plus `metadata.extensions` (`evolution_guide.md`, `a2ui_protocol.md`).
2. **`@` System Namespace:** v1.0 renames structural metadata/binding keys to `@path`, `@call`, `@checks`, `@accessibility`, `@catalogId`, `@metadata`, and reserves `@index` inside `ChildList` template lists (`common_types.json`, `evolution_guide.md`).
3. **Reserved `Surface` Container:** `Surface` is a canonical implicit top-level container with fixed `child: "root"`; component definitions in `createSurface`/`updateComponents` MUST NOT redefine `"component": "Surface"` (`agent_to_renderer.json`, `common_types.json`).
4. **Full Component Replacement:** `updateComponents` replaces component definitions by `id` in full (including clearing `@metadata` if omitted) and requires one component with `id: "root"` for a complete tree (`agent_to_renderer.json`, `a2ui_protocol.md`).
5. **Typed Bidirectional Functions (`optional` extension messages):** Adds `callRendererFunction`, `agentFunctionResponse` (`agent_to_renderer.json`) and `callAgentFunction`, `rendererFunctionResponse` (`renderer_to_agent.json`) gated by `allowedCallers` (`rendererOnly`, `rendererOrAgent`, `agentOnly` in `a2ui_custom_functions.md`).
6. **Basic Catalog v1.0 Tightening (`catalogs/basic/v1/catalog.json`):** `Text.variant` narrowed to `caption` / `body` (headings use Markdown `#`–`#####` in `Text.text`); `TextField.value` required; `TextField.validationRegexp` removed in favor of `@checks` with `regex`; `Slider` gains `steps`; `openUrl` sets `requiresUserActivation: true`; validation checks (`required`, `regex`, `length`, `numeric`, `email`) return `{ valid: boolean }` coerced by `DynamicBoolean`.

---

## 3. Mandatory vs Optional Semantics in A2UI v1.0

| Area | Mandatory Semantics | Optional / Negotiated Semantics |
| :--- | :--- | :--- |
| **Wire Envelope** | Top-level `"version": "1.0"` with exactly one message key (`agent_to_renderer.json` / `renderer_to_agent.json`). | `metadata.extensions` (UAX #31 keys; unrecognized extensions MUST be ignored safely, never rejected). |
| **Surface Creation (`createSurface`)** | `surfaceId` (globally unique until deleted); implicit `Surface -> root`; reject duplicate `surfaceId` unless previously deleted; reject `theme`. | Inline `catalogId`, `sendDataModel`, `components`, `dataModel`, `metadata`. |
| **Component Tree (`updateComponents`)** | Pre-existing `surfaceId`; non-empty `components`; unique `id`; adjacency references via `ComponentId` / `ChildList`; one `id: "root"` node before render completion; no `"Surface"` override. | Per-component `@catalogId` override, `@accessibility` (`label`, `description`, `live`, `hidden`), `@checks`, `@metadata`. |
| **Data Model (`updateDataModel`)** | Pre-existing `surfaceId`; RFC 6901 JSON Pointer `path` (default `/`); `value: null` deletes target key. | Nested paths (`/a/b/c`); multi-turn partial updates. |
| **Surface Deletion (`deleteSurface`)** | Pre-existing `surfaceId`; removes surface tree and state cleanly. | Re-creation allowed only after deletion. |
| **Reactive Data Binding (`DynamicValue`)** | Literals, `{"@path": "/json/pointer"}`, and catalog-allowed `{"@call": "...", "args": {...}}`. | `ChildList` template `{ componentId, path }` with `@index`. |
| **Capabilities Negotiation** | `renderer_capabilities.json` (`"1.0": { supportedCatalogIds }`); `agent_capabilities.json` (`"1.0": { supportedCatalogIds?, acceptsInlineCatalogs? }`). | `inlineCatalogs` ONLY when agent declares `acceptsInlineCatalogs: true`. |
| **Renderer->Agent Events** | `action` (`name`, `surfaceId`, `sourceComponentId`, ISO 8601 `timestamp`, resolved `context`, optional `userMessage`, `metadata`) and `error` (`VALIDATION_FAILED`/`UNALLOWED_PARENT`/`UNALLOWED_CHILD` + `path`, OR generic error with exclusive `surfaceId` vs `functionCallId`). | `callAgentFunction` / `callRendererFunction` / `*FunctionResponse`. |
| **Conformance Rules** | Renderers declare supported catalogs, reject unknown/`rendererOnly` disallowed calls, isolate `$ref` resolution (never network-fetch remote schema `$ref`), enforce acyclic component trees. | Full Basic Catalog widget parity (e.g., native `Video`/`AudioPlayer`) when a domain catalog is negotiated instead. |
