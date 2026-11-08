# AIRA AI 2026 — Change Impact Map

This map records source-backed relationships observed on `prod-release` at
`bb14406a32f82eba8a2ae22736a80406bb129f44`. A dependency edge is *verified*
only where source imports, calls, routes, or CI declarations show it. Possible
runtime consequences are marked *potential* until exercised in integration tests.
This is a living impact map, not a claim that an import graph proves every
dependency or that an isolated unit test proves a production rollout.

## Verified relationships and consumers

| Change surface | Direct producers and consumers | Indirect or runtime consequence supported by source | Relevant tests and checks |
| --- | --- | --- | --- |
| `src/utils/agentMemoryEngine.ts` | Imported by `src/utils/aiEngine.ts`, `src/App.tsx`, and `src/components/MemoryVaultModal.tsx`; methods `assembleMemoryContext`, `consolidateFromTurn`, `recall`, `remember`, `getSnapshot` | Chat prompt context and automatic per-turn memory persistence; modal statistics and search; account transitions can change which memory is visible | `test/behavioral/migration.test.ts`, `test/behavioral/security.test.ts`, `test/behavioral/model-provenance-identity.test.ts`, account-switching regression |
| `src/utils/agentMemoryMigration.ts` | Imported by `agentMemoryEngine.ts`; defines legacy `aira_agentmemory_vault_v1` key and versioned migration | Migration changes which historical browser memories are loaded; a malformed or unowned record must not silently acquire a signed-in owner's identity | `test/behavioral/migration.test.ts`, memory account-isolation test |
| `src/lib/neonAuth.ts` | Imported by `src/App.tsx`, `src/utils/aiEngine.ts` and other UI/auth clients; emits auth transitions and exposes current user/epoch | Session changes must invalidate in-flight chat streams and prior user data; memory vault scope must track the authenticated principal | `test/auth-identity-transition-lifecycle.test.ts`, `test/auth-account-switching-isolation.test.ts`, `test/neon-auth-token-race.test.ts` |
| `src/utils/storage.ts` | Imported by `src/App.tsx`; calls `indexedDbStorage.ts` for browser persistence and migration | Legacy browser key deletion after IDB migration; conversation/project restore, quota fallback, and identity-scoped conversation keys | `test/browser-storage-migration-fidelity.test.ts`, `test/long-prompt-persistence.ts`, browser storage acceptance |
| `src/utils/indexedDbStorage.ts` | Called by `storage.ts`, project/workspace persistence helpers | A failed readback must preserve legacy LocalStorage; IDB store name/version changes affect existing browser data | Browser migration/failure-injection tests; live browser acceptance |
| `packages/agent-runtime/src/autonomous/repository.ts` | `autonomous-engine.ts` and `autonomous-worker-host.ts` call task state, claim, renew, update and persistence operations; PostgreSQL implementation uses `packages/db/src/index.ts` | State transitions, optimistic fencing, task progress persistence, multi-worker lease ownership and crash recovery | `test/autonomous-worker-recovery.test.ts`, `test/autonomous-persistence-failclosed.test.ts`, `test/autonomous-task-postgres-certification.test.ts`, worker-fencing regression |
| `packages/agent-runtime/src/autonomous/autonomous-worker-host.ts` | Consumes repository and `AutonomousAgentEngine`; exported via `autonomous/index.ts` and `agent-runtime/src/index.ts` | Heartbeat failure/lease loss must stop in-flight specialist execution before the next side effect | `test/autonomous-api-worker-integration.test.ts`, `test/operational-staging-acceptance-and-fault-injection.test.ts`, worker-fencing regression |
| `packages/agent-runtime/src/autonomous/autonomous-engine.ts` | Uses `SpecialistRegistry`, `ToolGateway`, `ApprovalKernel`, `ModelRouter`; publishes progress and calls repository | Plan, approval, execution, cancellation and verification state; a late tool result can race with a revoked worker lease | `test/specialist-orchestration-depth.test.ts`, `test/autonomous-worker-recovery.test.ts`, `test/autonomous-adversarial-scenarios.test.ts` |
| `apps/api/src/index.ts` | Imports `AgentRuntime`, `ModelRouter`, `ToolGateway`, `ApprovalKernel`, `BrainV2KnowledgeEngine`, `McpHost`, automation and retrieval packages | Express middleware order guards every later API route; auth and CSRF precede `/api/agent`, tool, knowledge, chat, automation and workflow routes | `test/auth-security-authorization.test.ts`, `test/tool-gateway-certification.ts`, `test/aira-backend-correctness.test.ts`, `test/automation-policy-b.test.ts` |
| `src/App.tsx` | Imports `storage`, `aiEngine`, `neonAuth`, artifact tools and UI components | Shared conversation state, streaming, chat selection, auth switching, multi-modal and project UI; split components must preserve state/event ownership | `test/auth-identity-transition-lifecycle.test.ts`, `test/mobile-sidebar-responsive.ts`, browser visual acceptance |
| `packages/tool-runtime/src/gateway.ts` | Consumed by `apps/api/src/index.ts`, `agent-runtime` and tests | Tool side effects depend on authorization and approval controls; no route may bypass the gateway accidentally | `test/tool-gateway-certification.ts`, `test/durable-worker-authorization.test.ts` |
| `.github/workflows/ci.yml`, `vercel.json` | GitHub PR checks and Vercel `buildCommand` respectively; `vercel.json` invokes `db:verify:deploy` for Production before `npm run build` | Merging an eligible PR to `prod-release` triggers production deployment; changing deployment rules or DB gate is separately restricted | Required CI checks and live `/api/version` + `/api/health` verification |

## Cross-layer paths verified by source

1. **Chat memory:** `App.tsx` → `aiEngine.ts` → `agentMemoryEngine.ts`
   → browser LocalStorage; `aiEngine.ts` also streams via first-party API.
   Authentication state is read through `neonAuth.ts`; an account switch can
   happen while a stream is completing.
2. **Autonomous execution:** `apps/api/src/index.ts` mounts task API handlers
   → `AgentRuntime` (`packages/agent-runtime/src/index.ts`) → autonomous engine
   and repository → PostgreSQL task state. Worker host claims/renews leases
   through the same repository and asks the engine to execute.
3. **Browser persistence:** `App.tsx` → `storage.ts` →
   `indexedDbStorage.ts`; migration reads legacy LocalStorage, writes to
   IndexedDB, verifies the saved value, then removes only that legacy key.
4. **Release:** protected GitHub PR checks → `prod-release` merge → Vercel
   production build with DB verification → canonical domain alias verification.

## Potential or unverified impact (not certified)

- Concurrent updates sharing a *single* fencing token can still race even when
  stale tokens are rejected. The PostgreSQL task JSON fields need actual
  multi-connection serialization tests on a disposable, identity-verified DB.
- The local memory vault may remain in other open tabs; confirm account switches
  and storage events across real browsers before treating tenant isolation as certified.
- `src/App.tsx`, `apps/api/src/index.ts` and `packages/agent-runtime/src/index.ts`
  own multiple concerns, but size alone does not prove a bug. Trace individual
  call sites, event ordering and integration tests before extraction.
- A simulated browser session cannot establish production encrypted-snapshot
  durability. Run real browser process recovery on an isolated staging target.
- Preview deployments may lack the autonomous PostgreSQL database even when
  Production is healthy; preview failure must not be mistaken for production
  regression or vice versa.

## Change protocol

For any touched file, update the corresponding row with exact consumers,
downstream effects, the reproduction, the regression test, and the CI/browser
result. Record unresolved edges as unknown rather than inventing certainty.
Neither this map nor passing local tests authorizes migrations, production
environment edits, paid resources, or bypassing the protected release process.
