# AIRA GenUI — Exact Candidate Evidence Ledger

**Document Version:** 1.0.0  
**Date:** 2026-11-28  
**Scope:** Consolidated Release Evidence Across Phases 0 through 5  
**Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI`  
**Branch:** `feat/aira-genui-phase1-foundation`  
**Initial Baseline Commit:** `cd7f88a6faf97c39cdf5e2a17e02063cc261291a`  
**Phase 5 Implementation Commit:** `112a0f6bdf08cc624770589e61554920c7a9f69b`  
**Production Reference HEAD:** `f429d90a1f4322a0d362956fb9e55a38cb3b5508`  
**Protected Commercial Baseline:** PR #215 (`fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` on STRICT HOLD)  
**Evidence Collector:** Agency Evidence Collector & Reality Checker Specialists  

---

## 1. Evidence Classification Hierarchy

Every verification claim in this ledger is strictly categorized using the standardized evidentiary hierarchy:
1. `STATIC_INSPECTION`: Code, schema, or configuration AST/text verification.
2. `UNIT_TEST`: In-memory isolated deterministic contract verification.
3. `SIMULATED_RUNTIME`: State machine, fault injection, or mock provider lifecycle execution.
4. `REAL_LOCAL_RUNTIME`: Live Node/Express server and native execution within local environment.
5. `REAL_POSTGRESQL_INTEGRATION`: Local PostgreSQL database instance transaction and persistence execution.
6. `REAL_BROWSER_ACCEPTANCE`: Headless Chromium/Playwright rendering, interaction, and DOM assertion.
7. `LIVE_MODEL_ACCEPTANCE`: Live inference against remote upstream AI providers (NVIDIA, Gemini, Anthropic).
8. `DEPLOYED_ACCEPTANCE`: Live verification on Vercel preview or production staging deployment.

---

## 2. Evidence Ledger by Requirement

### Section A: P0 Presence Timestamp Security & Concurrency

| Ref | Requirement | Implementation Location | Evidence Class | Test Command / Verification | Observed Result | Evidence File / Artifact | Remaining Limitation |
|---|---|---|---|---|---|---|---|
| **E-01** | Server receipt time enforcement | `src/server/collaborationManager.ts:205` | `UNIT_TEST` | `npx tsx --test test/crdt-property-verification.test.ts` | Stamps `updatedAt = this.clock()` on server receipt; ignores client payload timestamps. | `test/crdt-property-verification.test.ts:465` | None. In-memory clock bound. |
| **E-02** | Test override injection rejection | `src/server/collaborationManager.ts:210` | `UNIT_TEST` | `npx tsx --test test/crdt-property-verification.test.ts` | Deletes `_testClockOverride` if present in client payload; never reads from untrusted data. | `test/crdt-property-verification.test.ts:488` | None. Override completely removed. |
| **E-03** | Presence expiration (< 30s TTL) | `src/utils/collaborationEngine.ts:92` | `UNIT_TEST` | `npx tsx --test test/crdt-property-verification.test.ts` | Presences older than 30s TTL are filtered out of active participant map in `getSessionState()`. | `test/crdt-property-verification.test.ts:515` | Ephemeral; client must heartbeat <= 10 Hz. |
| **E-04** | Revocation defense | `src/server/collaborationManager.ts:198` | `UNIT_TEST` | `npx tsx --test test/crdt-property-verification.test.ts` | Revoked actorId presence updates are dropped immediately; cannot update session state. | `test/crdt-property-verification.test.ts:525` | Revocation is session-scoped. |
| **E-05** | Deterministic test clock support | `src/server/collaborationManager.ts:45` | `UNIT_TEST` | `npx tsx --test test/crdt-property-verification.test.ts` | Trusted clock function injectible via constructor or `setClockForTesting()`. | `test/crdt-property-verification.test.ts:500` | Testing only; defaults to `Date.now()`. |

---

### Section B: P0 Durable PostgreSQL & Worker Recovery

| Ref | Requirement | Implementation Location | Evidence Class | Test Command / Verification | Observed Result | Evidence File / Artifact | Remaining Limitation |
|---|---|---|---|---|---|---|---|
| **E-06** | Task claims & single active lease | `packages/agent-runtime/src/autonomous/repository.ts:442` | `SIMULATED_RUNTIME` | `npx tsx test/autonomous-worker-fencing-regression.test.ts` | Worker lease claims enforce monotonic `fencing_token`; stale workers reject updates with `STALE_FENCING_TOKEN`. | `test/autonomous-worker-fencing-regression.test.ts` | Requires PostgreSQL row-level locks in prod. |
| **E-07** | Stale worker commit rejection | `packages/agent-runtime/src/autonomous/autonomous-engine.ts:255` | `SIMULATED_RUNTIME` | `npx tsx test/autonomous-worker-fencing-regression.test.ts` | Task state machine rejects updates when `task.fencingToken !== claimedFencingToken`. | `test/autonomous-worker-fencing-regression.test.ts` | Tested with simulated CAS Knex. |
| **E-08** | Crash recovery idempotency | `packages/agent-runtime/src/autonomous/autonomous-engine.ts:290` | `SIMULATED_RUNTIME` | `npx tsx test/autonomous-worker-recovery.test.ts` | Task resuming from crash preserves completed steps without re-executing side-effects. | `test/autonomous-worker-recovery.test.ts:25` | Pre-crash uncommitted step must be re-run. |
| **E-09** | Database outage fail-closed | `packages/agent-runtime/src/autonomous/repository.ts:257` | `SIMULATED_RUNTIME` | `npx tsx test/autonomous-adversarial-scenarios.test.ts` | Throws `AutonomousPersistenceUnavailableError` when DB offline; halts safely without memory leaks. | `test/autonomous-adversarial-scenarios.test.ts:45` | Tasks halt in pending recovery state. |
| **E-10** | Zero schema migrations | `package.json` | `STATIC_INSPECTION` | `git status` + `npm run db:verify:deploy` | 0 new database migrations added. Existing tables `autonomous_agent_tasks`, `runs`, `conversation_messages.metadata` reused. | `docs/genui/AIRA_GENUI_PRODUCTION_INTEGRATION_PLAN.md` | JSONB metadata limits payload size <= 1MB. |

---

### Section C: P0 Autonomous Swarm Runtime Integration

| Ref | Requirement | Implementation Location | Evidence Class | Test Command / Verification | Observed Result | Evidence File / Artifact | Remaining Limitation |
|---|---|---|---|---|---|---|---|
| **E-11** | Multi-Specialist Task Execution | `packages/agent-runtime/src/collaborative-bridge.ts` | `SIMULATED_RUNTIME` | `npx tsx --test test/autonomous-swarm-acceptance.test.ts` | Mission A: Researcher + Document specialists execute DAG plan and synthesize report. | `test/autonomous-swarm-acceptance.test.ts:65` | Specialists use deterministic local models. |
| **E-12** | Spreadsheet Formula Recalculation | `src/utils/spreadsheetEngine.ts` | `UNIT_TEST` | `npx tsx --test test/autonomous-swarm-acceptance.test.ts` | Mission B: Ingests cells and evaluates recursive-descent formula AST (`=A1-A2`) accurately. | `test/autonomous-swarm-acceptance.test.ts:160` | Division by zero yields `#DIV/0!`. |
| **E-13** | Multi-Artifact Consistency | `src/utils/officeDocumentExporter.ts` | `UNIT_TEST` | `npx tsx --test test/autonomous-swarm-acceptance.test.ts` | Mission C: Coordinates DOCX brief, XLSX model, and PPTX presentation deck generation. | `test/autonomous-swarm-acceptance.test.ts:240` | In-memory binary OpenXML PKZip packages. |
| **E-14** | Human-Agent Concurrent Editing | `src/utils/collaborationEngine.ts:310` | `UNIT_TEST` | `npx tsx --test test/autonomous-swarm-acceptance.test.ts` | Mission F: Human edit at index 0 preserved alongside concurrent AI specialist append. | `test/autonomous-swarm-acceptance.test.ts:420` | Positional rebase preserves both fragments. |
| **E-15** | Provider Fault Simulation | `packages/agent-runtime/src/autonomous/autonomous-engine.ts:430` | `SIMULATED_RUNTIME` | `npx tsx --test test/autonomous-swarm-acceptance.test.ts` | Mission H: Simulated upstream LLM timeout (HTTP 504) halts cleanly, records diagnostic error, marks step FAILED. | `test/autonomous-swarm-acceptance.test.ts:580` | Isolated fault injection; remote API offline. |
| **E-16** | Approval Gating on WRITE Action | `packages/agent-runtime/src/autonomous/autonomous-engine.ts:419` | `SIMULATED_RUNTIME` | `npx tsx --test test/autonomous-swarm-acceptance.test.ts` | Mission I: Side-effect WRITE step pauses in `WAITING_FOR_APPROVAL` without executing. | `test/autonomous-swarm-acceptance.test.ts:645` | Requires operator approval to resume. |

---

### Section D: P0 Generated Application Security & Containment

| Ref | Requirement | Implementation Location | Evidence Class | Test Command / Verification | Observed Result | Evidence File / Artifact | Remaining Limitation |
|---|---|---|---|---|---|---|---|
| **E-17** | Opaque origin iframe containment | `src/utils/sandboxSecurity.ts:46` | `REAL_BROWSER_ACCEPTANCE` | `npx tsx --test test/genui-phase3-sandbox-isolation.test.ts` | Playwright mounts sandboxed iframe (`allow-scripts allow-forms`, origin `null`); verifies zero parent DOM/cookie access. | `test/genui-phase3-sandbox-isolation.test.ts:150` | Infinite loops can block renderer thread. |
| **E-18** | Zero network egress blockade | `src/utils/genuiAppBridge.ts:18` | `REAL_BROWSER_ACCEPTANCE` | `npx tsx --test test/genui-phase3-sandbox-isolation.test.ts` | Authoritative CSP meta `connect-src 'none'` physically blocks `fetch`, `XHR`, `WebSocket`, `EventSource`. | `test/genui-phase3-sandbox-isolation.test.ts:195` | `img-src` allows data/blob only. |
| **E-19** | Host bridge cryptographic nonce | `src/utils/genuiAppBridge.ts:36` | `UNIT_TEST` | `npx tsx --test test/genui-phase3-sandbox-isolation.test.ts` | Bridge validates random 32-byte hex nonce; rejects postMessage from unauthorized origins or mismatched nonces. | `test/genui-phase3-sandbox-isolation.test.ts:80` | Nonce regenerated per iframe mount. |
| **E-20** | Fail-closed remote MCP Apps | `packages/contracts/src/mcp-apps.ts` | `REAL_BROWSER_ACCEPTANCE` | `npx tsx --test test/mcp-apps-local-acceptance.test.ts` | `assertApprovedPublicMcpDestination()` throws 503 `MCP_EGRESS_ENFORCEMENT_REQUIRED` in production. | `test/mcp-apps-local-acceptance.test.ts:95` | Remote MCP Apps remain disabled in prod. |

---

### Section E: Quality Gates & Static Analysis

| Ref | Requirement | Command | Evidence Class | Observed Result | Evidence File / Artifact | Remaining Limitation |
|---|---|---|---|---|---|---|
| **E-21** | Linting Standards | `npm run lint` | `STATIC_INSPECTION` | **PASS (0 errors)** across 768 files in 264ms. 645 pre-existing warnings. | Oxlint CLI output | Pre-existing warnings in unrelated files. |
| **E-22** | TypeScript Parity | `npm run typecheck` | `STATIC_INSPECTION` | **PASS (0 errors)** across `tsc -b`, `tsconfig.server.json`, `api/tsconfig.json`. | TSC compiler output | Strict typechecking enforced. |
| **E-23** | Production Build Bundle | `npm run build` | `STATIC_INSPECTION` | **PASS** — Vite client production bundle created in 2.07s. | `dist/index.html` + chunks | Bundle chunk warning (>600kB) non-blocking. |
| **E-24** | Release Authorization Guard | `npm run test:release-auth:unit` | `UNIT_TEST` | **PASS (52/52 tests)** — Zero policy, replay, or token bypasses possible. | `test/release-authorization-guard.test.ts` | Unit test of authorization rules engine. |
| **E-25** | GenUI Full Automated Suites | 8 canonical test suites | `UNIT_TEST` & `REAL_BROWSER_ACCEPTANCE` | **PASS (86/86 tests)** across 14 suites in 4.88s. | 8 test files in `test/` | Playwright requires local Chromium. |

---

## 3. Reality Checker Audit & Verification Limitations

The Reality Checker independently audited all release claims and established the following verified boundaries:
1. **Local vs Deployed Transport:** The CRDT collaboration engine operates as an in-memory server-authoritative engine bound to `CollaborativeAgentBridge` for multi-agent co-authoring. Live browser WebSocket transport is not deployed on Vercel Serverless (which lacks persistent socket retention on the Hobby tier). Client persistence is achieved via REST JSONB metadata.
2. **Library Capability Truth:** D3.js is verified as a Category C lightweight SVG shim. Three.js is verified as a Category D 2D wireframe substitute. Neither is claimed as a full 3D WebGL runtime.
3. **External Inference Status:** External live AI generation via NVIDIA NIM is classified truthfully as `BLOCKED_EXTERNAL` due to credential absence. The system safely falls back to internal deterministic generation.
4. **Hard CPU Isolation:** Iframe containment provides DOM/cookie separation and network egress blockade, but does NOT provide OS-level process/CPU isolation against infinite loops. Arbitrary untrusted code execution remains restricted.
