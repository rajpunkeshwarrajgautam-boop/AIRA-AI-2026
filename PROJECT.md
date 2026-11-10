# Project: AIRA AI 2026 — UNSLOP Final Corrective Certification

## Architecture
- **Storage Layer** (`src/utils/storage.ts`):
  - `loadProjects(userId?: string): Project[]` — strictly synchronous, returns pure `Project[]` from memory cache or `localStorage`. Zero Promise/Thenable monkey-patching.
  - `hydrateProjectsFromIndexedDb(userId?: string): Promise<Project[] | null>` — asynchronous background hydration from IndexedDB.
- **Application State & Callers** (`src/App.tsx`):
  - State initialization via synchronous `loadProjects`.
  - Account login (line 327) and logout (line 367) updated to synchronous assignments (`const userProjects = loadProjects(...)`).
  - Account hydration hook (`useEffect([currentUserId])`) secured with cancellation token and owner ref check to prevent cross-account hydration overwrites.
- **Deterministic Regression Test Suite** (`test/projects-storage-regression.test.ts`):
  - 12 comprehensive test scenarios covering thenable deadlock avoidance, microtask starvation defense (via isolated child-process with hard OS-level timeout), account transitions, storage fallbacks, and multi-tenant isolation.
- **Release Certification & Governance**:
  - `AIRA_UNSLOP_FINAL_CORRECTIVE_CERTIFICATION.md` reconciling exact production baseline (`22eb4fb36af892aa6d1ce06ed247e5b6e113af83`, PR #161, `dpl_2dk5hpg3bozg8LDxHLgqGMdQUGJM`, CI `42681116609`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Branch Setup | Create dedicated corrective branch from origin/prod-release (22eb4fb36af892aa6d1ce06ed247e5b6e113af83) | M1 | survey 3 |
| 2 | Pure Synchronous loadProjects | Remove Project[] & PromiseLike<Project[]> hybrid and .then monkey-patching in src/utils/storage.ts | M1 | survey 1 |
| 3 | Caller Synchronization | Update src/App.tsx lines 327 and 367 to call loadProjects synchronously, matching loadConversations | M1 | survey 2 |
| 4 | Hydration Race Guard | Add isCancelled / authEpoch guard in src/App.tsx useEffect([currentUserId]) to prevent cross-account hydration leak | M1 | survey 1, 2 |
| 5 | Deterministic Regression Suite (Items 1-6) | Storage load/caching/resolve/await/hydration/concurrency tests in test/projects-storage-regression.test.ts | M2 | original request §2, survey 3 |
| 6 | Deterministic Regression Suite (Items 7-12) | Account switching, guest transitions, updates/deletions, cold restarts, fallback, isolation | M2 | original request §2, survey 3 |
| 7 | Full Certification Revalidation | Execute typecheck, lint, build, test:secrets, test:release-auth:unit, storage fidelity | M3 | original request §3, survey 3 |
| 8 | Certification Documentation Reconciliation | Author AIRA_UNSLOP_FINAL_CORRECTIVE_CERTIFICATION.md with corrected SHA, Vercel deployment, and CI run IDs | M4 | original request §4 |
| 9 | Corrective PR Creation | Commit exact changes, push branch, open pull request targeting prod-release, verify CI run | M4 | original request §5 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Branch Setup & Storage Correction | Create branch from origin/prod-release (22eb4fb), fix loadProjects in storage.ts, update App.tsx callers and hydration race guard | none | DONE |
| 2 | Deterministic Regression Suite | Implement 12-item regression suite with isolated child process runner | M1 | DONE |
| 3 | Full Certification Revalidation | Run all verification gates (typecheck, lint, build, tests, secrets) | M2 | DONE |
| 4 | PR & Certification Evidence | Generate final certification doc, push branch, open PR to prod-release | M3 | DONE |

## Interface Contracts
### `src/utils/storage.ts` ↔ `src/App.tsx`
- `loadProjects(userId?: string): Project[]`
  - Input: optional string `userId`
  - Output: pure array of `Project` objects (no `.then`, not thenable)
  - Throws: never (falls back to memory cache or empty array)
- `hydrateProjectsFromIndexedDb(userId?: string): Promise<Project[] | null>`
  - Input: optional string `userId`
  - Output: Promise resolving to array of projects from IndexedDB or null
- `saveProjects(projects: Project[], userId?: string): void`
  - Persists to in-memory map, LocalStorage, and IndexedDB

## Code Layout
- `src/utils/storage.ts`: Core client-side storage, IndexedDB / LocalStorage / in-memory cache
- `src/App.tsx`: Main application component, state holder for projects & conversations
- `test/projects-storage-regression.test.ts`: Dedicated 12-scenario regression test file
- `AIRA_UNSLOP_FINAL_CORRECTIVE_CERTIFICATION.md`: Release certification report at repo root
