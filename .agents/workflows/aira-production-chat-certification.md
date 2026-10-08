---
description: Diagnose, fix, certify, and release AIRA-AI-2026 production chat end-to-end using real auth, NVIDIA inference, SSE streaming, browser tests, Agency specialists, CI, preview, and production verification.
---

# AIRA PRODUCTION CHAT — FIX + CERTIFY + RELEASE

## MISSION

Own the AIRA-AI-2026 production chat path from reproduction through verified production release.

Do not stop at code changes, HTTP 200, CI green, or Vercel READY.

PASS requires:

REAL browser prompt
→ trusted auth
→ ExecutionPrincipal
→ real provider
→ real model response
→ content deltas
→ SSE
→ React state
→ visible non-empty Aira answer.

Never use fake/mock production answers.

---

## WORKSPACE

Repository:
C:\Users\WORKSTATION\AIRA-AI-2026

GitHub:
rajpunkeshwarrajgautam-boop/AIRA-AI-2026

Production:
main

Working branch:
fix/production-chat-final-certification

Known baseline:
6256b9c324733b712beb03df0c8c0d279d112faa

Production URL:
https://aira-ai-2026.vercel.app

Do not use old immutable Vercel deployment URLs for final certification.

---

## 1. SAFETY CHECK

Run first:

git status
git branch --show-current
git rev-parse HEAD
git remote -v
git log -5 --oneline

Require branch:

fix/production-chat-final-certification

If branch or repository is wrong, STOP.

Do not:
- reset unknown work
- git clean unknown files
- discard user changes
- force push
- commit secrets
- work directly on main

---

## 2. DISCOVER AGENCY AGENTS + SKILLS

Before substantial work, enumerate installed:

- Agency Agents
- Agent Skills

Use exact installed names only.
Never invent an agent or skill.

Select appropriate specialists for this mission.

Preferred roles:

LEAD
- principal full-stack / AI systems engineer

SPECIALISTS
- AI/LLM runtime engineer
- backend/API engineer
- authentication/security engineer
- debugging/incident investigator
- SSE/streaming engineer
- QA/test engineer
- browser/E2E engineer
- DevOps/CI/CD engineer

FINAL REVIEW
- Evidence Collector equivalent
- Reality Checker equivalent

If installed, strongly prefer:

agency-evidence-collector
agency-reality-checker

Reality Checker runs LAST and tries to DISPROVE readiness.

Use relevant installed skills for:

- TypeScript
- React
- Node/Express
- debugging
- authentication/security
- API testing
- Playwright
- DOM/browser automation
- SSE/streaming
- Git/GitHub
- CI/CD
- Vercel
- PostgreSQL
- testing/code review

Do not use design/whimsy skills unless an actual UI problem requires them.

Record which agents and skills were really used.

---

## 3. REPRODUCE BEFORE MODIFYING

Use DOM browser / Playwright.

Start a fresh chat and send:

Hi

Trace:

browser
→ POST /api/auth/session
→ cookie
→ POST /api/chat/stream
→ session middleware
→ req.user
→ ExecutionPrincipal
→ AgentRuntime
→ ModelRouter
→ provider adapter
→ NVIDIA
→ provider response
→ content.delta
→ SSE content_delta
→ frontend parser
→ onContentChunk
→ React state
→ ChatMessage DOM

Find the FIRST point where expected data disappears.

Do not guess the root cause.

---

## 4. AUTH BRIDGE

Inspect:

apps/api/src/auth/session-auth.ts
apps/api/src/auth/principal-provider.ts
apps/api/src/middleware/principal.ts
apps/api/src/index.ts
src/utils/aiEngine.ts

Prove:

- /api/auth/session succeeds
- signed HttpOnly cookie is issued
- chat request sends cookie
- req.user.id exists
- req.user.sessionId exists
- ExecutionPrincipal exists

Production must reject:

x-test-user-id
x-test-session-id

Never weaken auth to make chat work.

Run:

npm run test:identity
npm run test:session-auth

---

## 5. MODEL ROUTING

Inspect:

src/types/index.ts
src/utils/constants.ts
src/components/ModelSelector.tsx
src/App.tsx
src/utils/storage.ts
src/utils/aiEngine.ts
packages/contracts/src/index.ts
packages/model-router/src/index.ts
packages/agent-runtime/src/index.ts

Create a mapping:

UI LABEL
→ frontend ID
→ normalized Aira mode
→ provider
→ actual remote model

Test:

Aira Auto
Aira Pro
Aira Fast
Aira Deep
Llama 3.1 405B
Nemotron 3 Super 120B-A12B

Aira product aliases are NOT remote provider model names.

Never send:

aira-auto
aira-pro
aira-fast
aira-deep

directly to NVIDIA.

Important NVIDIA model:

nvidia/nemotron-3-super-120b-a12b

NVIDIA base:

https://integrate.api.nvidia.com/v1

---

## 6. REAL NVIDIA TEST

Using the configured secure NVIDIA_API_KEY, perform a real provider request.

Never print the secret.

Model:

nvidia/nemotron-3-super-120b-a12b

Prompt:

Reply exactly with NVIDIA_ADAPTER_OK

Require:

- successful HTTP status
- valid response body
- non-empty content
- NVIDIA_ADAPTER_OK returned

If rejected, inspect exact provider error and fix payload/model/options correctly.

Never add a production mock fallback.

---

## 7. CONVERSATION HISTORY

Verify frontend history reaches model synthesis.

Inspect:

src/utils/aiEngine.ts
apps/api/src/index.ts
packages/agent-runtime/src/index.ts

Ensure valid history is included before current user prompt:

system
user
assistant
user
assistant
...
current user

Test:

Remember the codeword ORBIT-927.

Then:

What is the codeword?

Require:

ORBIT-927

Add regression coverage if missing.

---

## 8. EVENT RACE

Investigate:

createAndExecuteRun()
getEventStream()
emitRunEvent()
stream.on('event')
setImmediate()

Determine whether these events can occur before HTTP subscription:

run.started
content.delta
run.failed
run.completed

If yes, fix architecturally.

Valid approaches:

- subscriber before execution
- persistent event replay
- sequence cursor
- dedicated streaming execution API
- replay stored events after subscribing

Do NOT use arbitrary sleep/setTimeout fixes.

Add a deterministic regression test.

---

## 9. VERCEL SERVERLESS LIFETIME

Investigate detached execution:

setImmediate(...)
unawaited Promise
background execution

The /api/chat/stream request must remain alive until model execution reaches a terminal state.

Required:

create run
→ establish event delivery
→ execute
→ provider response
→ content stream
→ terminal event
→ close response

Do not depend on background work surviving after request completion.

Preserve non-streaming runtime behavior.

---

## 10. SSE PARSER

Inspect:

src/utils/aiEngine.ts

Prefer a dedicated parser utility if useful.

Certify:

1. event + data same chunk
2. event and data split across chunks
3. JSON split across chunks
4. multiple events per chunk
5. LF
6. CRLF
7. final event without trailing newline
8. error event
9. done + [DONE]
10. unexpected close
11. UTF-8 split across chunks
12. blank separator lines

Event type must persist across network chunks.

No model content may disappear.

Add tests against real parser implementation.

---

## 11. FRONTEND STATE

Inspect:

src/App.tsx
src/utils/aiEngine.ts
src/components/ChatMessage.tsx

Trace:

handleSendMessage
→ streamAIResponse
→ onThinkingChunk
→ onContentChunk
→ onComplete/onError

Test chunks:

Hel
lo
 
world

Final assistant content must equal:

Hello world

Check for:

- stale closures
- wrong chat ID
- duplicate assistant object
- blank overwrite
- message replacement after complete
- active-chat race

---

## 12. NO BLANK ANSWERS

Terminal assistant state must be either:

A. non-empty model-generated answer

OR

B. visible meaningful error

Never allow:

Aira + model badge + Copy button + empty body

Never swallow:

- provider failure
- run.failed
- parser error
- stream close
- SSE error

Add regression protection.

---

## 13. DIRECT API E2E

Create real authenticated session.

Then POST:

/api/chat/stream

Body:

{
  "prompt": "Reply exactly with AIRA_RUNTIME_OK",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "history": []
}

Require:

HTTP 200
text/event-stream
at least one non-empty content_delta
terminal done

Reject:

401
500
empty stream
silent close

Repeat using default Aira mode.

---

## 14. LOCAL BROWSER CERTIFICATION

Use Playwright/DOM browser.

TEST A:
Hi

Require visible non-empty answer.

TEST B:
Reply exactly with LOCAL_AIRA_OK

Require LOCAL_AIRA_OK.

TEST C:
Select Nemotron.

Reply exactly with LOCAL_NEMOTRON_OK

Require LOCAL_NEMOTRON_OK.

TEST D:
Remember ORBIT-927.
Then ask:
What is the codeword?

Require ORBIT-927.

Capture browser evidence.

---

## 15. TEST GATES

Inspect package.json.

Run all relevant scripts that actually exist.

At minimum when present:

npm ci
npm run lint
npm run typecheck
npm run build
npm run test:identity
npm run test:session-auth
npm run test:startup
npm run test:integration
npm run test:recovery
npm run test:runtime
npm run test:e2e

Also run existing:

- provider routing
- orchestration
- isolation
- worker lease
- skills/connectors

If absent, record:

NOT PRESENT

Never pretend a missing test passed.

---

## 16. SECURITY REVIEW

Use security specialist.

Verify:

- no secret committed
- no .env committed
- no test auth in production
- no identity spoofing
- no production mock
- no hardcoded fake answer
- user/workspace isolation preserved

A NVIDIA credential was historically exposed.

Never retrieve or reuse it from Git history.

Use only current secure environment variables.

---

## 17. EVIDENCE COLLECTOR

Before completion, independently collect:

- starting SHA
- branch
- final SHA
- diff
- tests
- provider result
- SSE evidence
- browser evidence
- preview deployment ID
- preview SHA
- PR
- merge SHA
- production deployment ID
- production SHA

Every important PASS claim requires evidence.

---

## 18. REALITY CHECKER

Run LAST.

Try to prove the release is NOT ready.

Check specifically:

- stale deployment URL
- wrong SHA
- wrong branch
- hidden mocks
- model alias mismatch
- swallowed provider error
- lost SSE event
- event subscription race
- detached serverless execution
- ignored history
- stale React state
- blank message path
- security regression
- tests that only test mocks
- preview SHA mismatch
- production SHA mismatch

Any material unresolved issue means FAIL.

---

## 19. COMMIT + PR

Before commit:

git status
git diff --stat main...HEAD
git diff main...HEAD

Require scoped changes and no secrets.

Commit only after gates pass.

Suggested commit:

fix(chat): complete production streaming execution path

Push:

git push -u origin fix/production-chat-final-certification

Create PR into:

main

Do NOT merge before preview certification.

---

## 20. PREVIEW CERTIFICATION

Wait for preview from this exact branch.

Require:

preview SHA == branch HEAD

Test exact new preview:

Hi

Reply exactly with PREVIEW_AIRA_OK

Select Nemotron:
Reply exactly with PREVIEW_NEMOTRON_OK

History:
ORBIT-927

Any blank assistant message means:

STOP
DO NOT MERGE
FIX ROOT CAUSE

---

## 21. MERGE + PRODUCTION

Merge only if:

- CI PASS
- preview READY
- real NVIDIA PASS
- direct API PASS
- browser PASS
- history PASS
- no blank response
- Evidence Collector PASS
- Reality Checker PASS

Merge to main.

Wait for Vercel production.

Require:

production SHA == merged main SHA
production state == READY

---

## 22. FINAL PRODUCTION CERTIFICATION

Use ONLY:

https://aira-ai-2026.vercel.app

TEST 1:

Hi

Require visible non-empty response.

TEST 2:

Reply exactly with PRODUCTION_AIRA_OK

Require PRODUCTION_AIRA_OK.

TEST 3:

Select Nemotron.

Reply exactly with NEMOTRON_PRODUCTION_OK

Require NEMOTRON_PRODUCTION_OK.

TEST 4:

Remember ORBIT-927.

Then:
What is the codeword?

Require ORBIT-927.

---

## FINAL REPORT

Report factual evidence only:

Start SHA:
Branch:
Final SHA:
Files changed:
Agents used:
Skills used:
Root cause:

Auth:
Principal:
Frontend model:
Normalized model:
Provider:
Remote model:
Provider HTTP status:

First content.delta:
First SSE content_delta:
Terminal event:

History:
Event race:
Serverless lifetime:
SSE parser:
Frontend accumulation:
Blank-response prevention:

Lint:
Typecheck:
Build:
Identity:
Session auth:
Integration:
Recovery:
Startup:
Runtime:
Provider routing:
E2E:

Preview ID/SHA:
Preview Hi:
Preview Aira:
Preview Nemotron:
Preview history:

PR:
Merge SHA:

Production ID/SHA:
Production state:
Production alias:
Production Hi:
PRODUCTION_AIRA_OK:
NEMOTRON_PRODUCTION_OK:
ORBIT-927:

Evidence Collector:
Reality Checker:

FINAL VERDICT: PASS / FAIL

PASS only when:
real browser prompt → real provider → real model text → visible non-empty Aira answer.l text → RE