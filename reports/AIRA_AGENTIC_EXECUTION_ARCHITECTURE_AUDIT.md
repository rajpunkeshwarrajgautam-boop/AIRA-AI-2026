# AIRA-AI-2026 — Agentic Application Building: Forensic Architecture Audit

**Investigated:** 2026-10-10  
**Baseline main SHA:** `20439a972cc71c0146ec1fdcbf4f7959781d3db0`  
**Audit branch:** `audit/app-build-execution-truth-20261010`  
**Release recommendation:** **DO NOT DEPLOY AS A FUNCTIONING APP BUILDER.** This PR is a fail-closed truthfulness/routing correction, not a new application-building service.

## 1. Executive verdict

**ROOT CAUSE VERIFIED — EXECUTION INFRASTRUCTURE INCOMPLETE (source-level evidence).**

The user requested `BUILD A PINBALL GAME 3D` and received a tutorial presented as a production-ready game. The supplied response does not import Three.js or Cannon-es, never advances its physics world, never creates a collidable playfield floor, and includes no build/test execution evidence.

This is **not just a prompt-writing or model-quality issue**. The baseline server intent classifier has no build taxonomy, `AGENT_MISSION` chooses a fixed sequence of keyword-selected tools and Git inspection operations rather than project scaffolding/build/test, and Artifact Studio previews HTML snippets rather than provisioned multi-file project builds. The capability registry has no actual application-building handler.

**Evidence boundary:** The user's original generated answer was inspected, and current repository source was traced. The production request ID, its exact router trace, registered environment-specific providers, and an authenticated deployed reproduction were **not available**; therefore we cannot prove which particular intent branch ran for that one historic request. The deterministic router fallback for this prompt and architectural inability to build software are verified from source; added tests must establish runtime behavior on the modified branch.

## 2. Observed source trace

```text
src/App.tsx:handleSendMessage
  -> src/utils/aiEngine.ts:streamAIResponse
  -> POST /api/chat/stream
  -> apps/api/src/index.ts:AgentRuntime.createRun/startRun
  -> packages/agent-runtime/src/router.ts:ServerIntentRouter
  -> packages/agent-runtime/src/registry.ts:CapabilityRegistry
  -> packages/agent-runtime/src/index.ts:executeRunLoop
  -> packages/tool-runtime/src/gateway.ts OR ToolRegistry
  -> apps/api/src/index.ts:SSE
  -> src/utils/aiEngine.ts:stream callback
  -> ArtifactCard / ArtifactStudio
```

| Layer | Baseline evidence | Impact | Confidence |
| --- | --- | --- | --- |
| Intent routing | `router.ts` taxonomy six intents, no build rule; unmatched prompt falls back to `ANSWER` if classifier unavailable | Short creation commands can become ordinary answers | High (source), production trace unavailable |
| Capability registry | `registry.ts` has no application-build capability or sandbox handler | No correct build execution target | Confirmed |
| Model classifier | `router.ts` classification prompt only lists six intents; low-confidence privileged classifications revert to `ANSWER` | Model classification cannot express app-build as a separate state | Confirmed |
| Agent loop | `agent-runtime/index.ts` hard-coded selected tool; mission follow-up `repo_git_status` then `repo_git_log`, up to 3 steps | Not an iterative software engineering agent | Confirmed |
| Model-to-tool connection | `model-router/index.ts` adapter exposes `toolCalls`, but synthesis uses `adapter.stream` text/thinking deltas rather than a dynamic execution plan | General model tool-calling is not proven | High (examined path) |
| Shell | `tool-runtime/index.ts` has `system_shell` but rejects production unless `AIRA_ALLOW_SHELL=true` | No approved production build sandbox; enabling shell on app host is unsafe | Confirmed |
| Gateway | `gateway.ts` registers browser/read-write files/git inspection/calculator, not an isolated build job manager | No production project install/build/test/preview lifecycle | Confirmed for built-ins |
| Artifact lifecycle | `agent-runtime/index.ts` turns code-fence text into `Generated Analysis Artifact` | Text artifact can be mistaken for validated project output | Confirmed |
| Preview | `ArtifactStudio.tsx` uses iframe `srcDoc` for HTML; other content displayed in `pre`; single-file downloads | Cannot prove a compiled Vite/Three.js preview | Confirmed |
| Frontend transport | `src/utils/aiEngine.ts` showed `capability_unready` and `content_delta` using the same message | Duplicate unavailable response | Confirmed from source, fixed in PR |
| Observability | `apps/api/src/index.ts` exposes routing/approval/tool/artifact SSE events; no original incident trace supplied | Cannot retrospectively attribute incident to particular provider | Blocked by evidence |

### Artifact content versus completed application

An artifact with `application/vnd.ant.code` may contain an answer with Markdown code fences. That does **not** attest file writes, dependency installation, exit code 0, live rendering, or gameplay checks. `ArtifactStudio` iframe HTML preview is a different capability from running a multi-file 3D game.

### Historical generated game defects

- Referenced `THREE` and `CANNON` without import or global registration.
- Physics world never stepped using `world.step`.
- Table floor visual only; ball cannot collide with a floor there.
- No source files, build logs, functioning demo or screenshot proven.
- Claims of “zero dependencies” and “production-ready” were unsupported.

## 3. Remediation implemented on this audit branch

1. **Contracts:** register `APPLICATION_BUILD` as an explicit intent.
2. **Registry:** advertise `cap_application_build` as `COMING_SOON / NOT_READY`, with `projects.write` scope and approval requirement. **Do not** advertise a sandbox that does not exist.
3. **Router:** route explicit build/create/develop/scaffold requests for software to this capability, before the model classifier; preserve automation, research, ordinary questions and destructive overrides.
4. **Model classification:** include `APPLICATION_BUILD` in allowed classifier options and require `WRITE` side-effect policy.
5. **Runtime:** send a truthful `APPLICATION_BUILD_NOT_AVAILABLE` notice; no tools, project files, test reports or fake live artifacts are created.
6. **Frontend:** consume `capability_unready` as status metadata while `content_delta` carries the user-visible notice once.
7. **Tests:** router examples for pinball/website/dashboard/program vs informational requests and reality test for a blocked build run with zero fabricated tools/artifacts.

**Do not confuse this mitigation with an actual application builder.** It deliberately fails closed until the required isolated execution infrastructure is implemented and separately certified.

## 4. Capability reality matrix (baseline)

| Capability | Evidence-backed status | Notes |
| --- | --- | --- |
| Conversational replies | PARTIAL | Live provider/prod response not reproduced here |
| Deterministic intent routing | WORKING for tested original intents | New APPLICATION_BUILD regression pending CI |
| Tool gateway | PARTIAL | Built-in browser/files/repo utilities; scoped approval checks |
| Local file writes | PRESENT, NOT DEPLOYED-BUILD CERTIFIED | Gateway adapter exists; workspace context and principal scopes matter |
| Repository status/log | PRESENT | No dynamic multi-file build planning |
| Local shell | PRODUCTION-DISABLED | Not an isolated build sandbox |
| Model-directed engineering plan | NOT IMPLEMENTED in examined mission loop | Hardcoded tool selection and up to three steps |
| Dependency installation in isolated project | NOT IMPLEMENTED in examined platform |
| Multi-file source build/test lifecycle | NOT IMPLEMENTED in examined platform |
| Compiled preview environment | NOT IMPLEMENTED in examined platform |
| Single HTML iframe artifact preview | PARTIAL | Single-file srcDoc only |
| Truthful handling of unsupported app builds | MODIFIED, CI PENDING |
| Authenticated staging replay | BLOCKED | Protected staging deployment/credentials |
| Production game execution | NOT TESTED | No claim of a playable game |

## 5. Required next architecture for real builds

Build a dedicated **isolated project-execution service**, separate from Vercel web/API functions, with tenant-scoped ephemeral workspaces; allowlisted runtime images; bounded command APIs (`install`, `build`, `test`, `serve`), resource/CPU/memory/time limits; network policies; secret isolation; secure artifact storage; authenticated preview URLs and lifecycle expiry; per-step evidence/event logs; and explicit user approvals before mutations or external actions.

Add a durable, dynamic planner that selects authorized tools based on actual observations; retry based on compiler/runtime/browser failures rather than hardcoded repo status/log. A complete build should have explicit verifiable invariants (created files, compiled output, browser tests, artifact identity) and a typed `BLOCKED`/not-ready state when prerequisites are absent.

Build a trusted artifact bridge linking run ID, project ID, source tree manifest, build attempt, verified preview URL and test results. UI must only show a **Verified Preview** state when that evidence exists. Treat a code-fenced text response as text, not a compiled app.

## 6. Regression and verification matrix

| Check | Test location | Result at report creation |
| --- | --- | --- |
| Pinball request routes to app-build | `test/intent-router.ts` | Pending branch CI |
| Informational request remains ANSWER | `test/intent-router.ts` | Pending branch CI |
| Destructive spoof blocked | `test/intent-router.ts` | Pending branch CI |
| Build registry is NOT_READY | `test/intent-router.ts` | Pending branch CI |
| Run emits typed unsupported event | `test/capability-reality-audit-suite.ts` | Pending branch CI |
| Run creates no fake tool calls/artifacts | `test/capability-reality-audit-suite.ts` | Pending branch CI |
| Full GitHub CI | `.github/workflows/ci.yml` | Pending branch CI |
| Deployed game application run | N/A | NOT TESTED — no sandbox |
| Multi-file preview / download | N/A | NOT IMPLEMENTED |
| Real original incident router replay | Requires authenticated run evidence | NOT TESTED |

## 7. Safety

- Development confined to `audit/app-build-execution-truth-20261010`, branched from existing `main`; no force-push or merge.
- No new shell privilege, host sandbox escape, database mutation, secret use, or production deployment.
- Preserve Vercel projects `aira-ai-2026` and `aira-ai-live`, Neon staging/production isolation, and custom domains `aira-ai.in` and `www.aira-ai.in`.
- Do **not** set `AIRA_ALLOW_SHELL=true` on production Vercel.
- PR #38 and staging release work remain independent.

## 8. Release verdict

**ROOT CAUSE VERIFIED — EXECUTION INFRASTRUCTURE INCOMPLETE.**

The mitigation improves truthful routing and prevents false runnable-project claims for identified build requests; it does **not** create a functioning application-building agent. Further engineering work, isolation security review, build/preview testing and release certification remain mandatory. Authenticated deployed reproduction of the historical request is still needed to identify its exact production trace.
