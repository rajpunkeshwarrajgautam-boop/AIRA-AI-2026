---
description: Certify every AIRA-AI-2026 release from clean branch state through CI, preview, browser smoke, security review, Reality Checker, merge, and production verification with SHA-matched evidence.
---

# AIRA-AI-2026 — RELEASE CERTIFICATION

## MISSION

Certify an AIRA-AI-2026 release safely from branch inspection through preview,
merge, production deployment, and final browser verification.

This workflow is for ANY release candidate, not just chat/runtime work.

Never declare PASS because:

- build succeeds
- CI is green
- Vercel says READY
- PR merges
- HTTP returns 200

PASS requires evidence that the intended release behavior works on the exact
deployed commit.

---

## WORKSPACE

Repository:

C:\Users\WORKSTATION\AIRA-AI-2026

GitHub:

rajpunkeshwarrajgautam-boop/AIRA-AI-2026

Production branch:

main

Canonical production URL:

https://aira-ai-2026.vercel.app

Never certify production using an old immutable deployment URL.

---

## 1. PRE-FLIGHT

Run:

git status
git branch --show-current
git rev-parse HEAD
git log -5 --oneline
git remote -v

Record:

- current branch
- current SHA
- base branch
- worktree state

If current branch is main and release work is not already committed:

STOP.

Never implement release changes directly on main unless explicitly ordered.

If worktree contains unknown changes:

STOP and identify them.

Do not:

- reset unknown work
- git clean unknown files
- discard local edits
- force push
- overwrite user work

---

## 2. DISCOVER AGENCY AGENTS + SKILLS

Enumerate the Agency Agents and Agent Skills actually installed.

Use exact installed names only.

Choose specialists relevant to the changed scope.

Potential roles:

- principal release engineer
- backend engineer
- frontend engineer
- AI runtime engineer
- authentication/security engineer
- database engineer
- QA/test engineer
- browser/E2E engineer
- DevOps/CI engineer
- performance engineer

Final independent reviewers should include installed equivalents of:

- Evidence Collector
- Reality Checker

If installed, prefer:

agency-evidence-collector
agency-reality-checker

The Reality Checker runs LAST before merge approval.

Use only skills relevant to this release, such as:

- Git/GitHub
- TypeScript
- React
- Node/Express
- testing
- Playwright
- DOM/browser automation
- API testing
- CI/CD
- Vercel
- security review
- database/PostgreSQL
- debugging
- code review

Do not invoke design/whimsy skills unless UI work is actually in scope.

Record agents and skills actually used.

---

## 3. DEFINE RELEASE SCOPE

Determine exactly what this release changes.

Run:

git diff --stat main...HEAD
git diff --name-only main...HEAD
git log --oneline main..HEAD

Classify affected domains:

- FRONTEND
- BACKEND
- AI_RUNTIME
- AUTH_SECURITY
- DATABASE
- DEVOPS_CI
- BROWSER_E2E
- UI_DESIGN
- PERFORMANCE

Create a concise release-risk matrix:

FILE / AREA
CHANGE
RISK
REQUIRED TEST

Do not test unrelated systems blindly.

Do not omit critical tests for touched systems.

---

## 4. SECURITY + SECRET CHECK

Inspect the branch before release.

Verify:

- no .env files committed
- no API keys committed
- no tokens
- no private credentials
- no hardcoded production secrets
- no debug auth bypass
- no test-only production flags
- no hidden mock provider
- no identity spoofing
- no accidental admin privilege
- no insecure CORS change
- no destructive migration without review

Run available credential/secret scans.

An NVIDIA key was historically exposed in this project.

Never retrieve or reuse leaked credentials from Git history.

Only use currently provisioned secure environment secrets.

Any credential exposure = FAIL.

---

## 5. CODE QUALITY GATES

Inspect package.json and repository tooling first.

Run relevant existing scripts.

Typical gates when present:

npm ci
npm run lint
npm run typecheck
npm run build

Also run scoped test suites relevant to the release.

Possible scripts include:

npm run test:identity
npm run test:session-auth
npm run test:startup
npm run test:integration
npm run test:recovery
npm run test:runtime
npm run test:e2e

Also check for repository-specific tests covering:

- model provider routing
- isolation
- orchestration
- worker leases
- skills/connectors
- API contracts
- migrations

Never invent scripts.

If a required-looking script is absent, report:

NOT PRESENT

Any failing required gate = FAIL until fixed.

---

## 6. DATABASE / MIGRATION CHECK

If database files or migrations changed:

- inspect migration order
- inspect reversibility
- verify idempotency where applicable
- test against non-production database
- verify constraints/indexes
- verify compatibility with existing data
- verify user/workspace/project isolation

Prefer transaction + rollback for certification when possible.

Do not perform destructive production writes during certification.

If DB is not touched, record:

DATABASE IMPACT: NONE

---

## 7. API / BACKEND CERTIFICATION

If backend/API code changed:

Verify affected endpoints directly.

Record:

- request
- auth state
- HTTP status
- relevant response body
- failure behavior

Test both success and expected failure paths.

For authenticated routes verify:

- valid auth succeeds
- missing auth fails
- forged auth fails
- cross-user access fails

Do not certify backend behavior from source inspection alone.

---

## 8. AI / MODEL RUNTIME CERTIFICATION

If model/runtime/provider code changed:

Verify:

- frontend model ID
- normalized server model
- provider selected
- exact remote model
- provider HTTP status
- non-empty provider output
- runtime events
- terminal state
- visible browser result

No production mock fallback.

Aira product aliases must not be mistaken for provider model IDs.

If NVIDIA is used, verify the real remote model ID.

For streaming paths verify content actually reaches the UI.

---

## 9. FRONTEND CERTIFICATION

If frontend behavior changed:

Use Playwright and/or Antigravity DOM browser.

Verify:

- app loads
- changed component renders
- core interaction works
- keyboard behavior works where relevant
- no obvious console exceptions
- no broken responsive layout
- no inaccessible interaction introduced
- reduced-motion behavior remains valid for animated UI

Do not certify frontend changes from build output alone.

---

## 10. CRITICAL USER JOURNEYS

Run a targeted smoke suite against the release candidate.

At minimum verify:

1. application loads
2. new chat can start
3. user can send a prompt
4. Aira returns visible non-empty output OR meaningful error
5. conversation navigation works
6. model selector works
7. settings opens
8. project/library routes touched by release still open
9. no release-blocking console errors

Add release-specific journeys based on changed scope.

If auth changed, include auth flow.

If artifacts changed, create/open artifact.

If agents changed, run an agent mission.

If automations changed, test an automation path.

If research changed, run research path.

---

## 11. EMPTY / SILENT FAILURE RULE

Never accept silent failure.

For any user action, terminal outcome must be either:

A. successful visible result

or

B. visible actionable error

Never accept:

- blank assistant response
- endless spinner
- swallowed API exception
- silent provider failure
- completed run with no content
- unhandled promise with no UI feedback

Any silent terminal state = FAIL.

---

## 12. CI CERTIFICATION

Wait for the exact branch/PR CI.

Record:

- workflow run ID
- branch SHA
- each required job
- conclusion

Require:

CI SHA == branch HEAD

Do not use results from an older commit.

If CI is rerun after new changes, discard earlier certification evidence and
certify the new HEAD.

---

## 13. PREVIEW DEPLOYMENT

Wait for Vercel preview deployment for the exact release branch.

Record:

- deployment ID
- deployment URL
- deployment SHA
- branch HEAD SHA
- deployment state

Require:

preview SHA == branch HEAD SHA
preview state == READY

READY is deployment evidence only, not functional certification.

---

## 14. PREVIEW BROWSER SMOKE

Test the exact new preview URL.

Use Playwright/DOM browser.

Run:

- app load
- primary changed feature
- critical chat smoke
- relevant release-specific tests
- console inspection
- network inspection if needed

For chat smoke:

User:
Reply exactly with PREVIEW_RELEASE_OK

Require visible:

PREVIEW_RELEASE_OK

If model/provider behavior is not part of the release but chat is a critical
global path, still perform a minimal smoke.

Capture evidence.

Any blocker = DO NOT MERGE.

---

## 15. EVIDENCE COLLECTOR

Assign Evidence Collector before merge.

Collect:

- starting SHA
- branch
- final branch SHA
- files changed
- diff summary
- tests executed
- test results
- CI run ID
- preview deployment ID
- preview SHA
- browser screenshots/evidence
- provider/API evidence where relevant
- security review evidence

Evidence Collector must flag unsupported claims.

---

## 16. REALITY CHECKER

Run Reality Checker LAST before merge.

Its job is to try to prove the release is NOT ready.

Check:

- stale branch
- stale CI
- stale preview
- preview SHA mismatch
- skipped tests
- hidden mock behavior
- secret leakage
- auth bypass
- swallowed errors
- wrong provider/model
- migration risk
- event race
- serverless detached execution
- stale React state
- blank response path
- missing browser test
- production-only configuration difference
- unrelated scope creep

If Reality Checker identifies a material unresolved issue:

FAIL
DO NOT MERGE

Fix, rerun affected gates, and review again.

---

## 17. PR + MERGE

Before merge:

git status
git diff --stat main...HEAD
git diff main...HEAD

Require:

- clean working tree
- scoped changes
- no secrets
- CI PASS
- preview PASS
- Evidence Collector PASS
- Reality Checker PASS

Create/update PR into main.

Record PR number.

Merge only after all required gates are green.

Record merge commit SHA.

---

## 18. PRODUCTION DEPLOYMENT

Wait for Vercel production deployment.

Record:

- production deployment ID
- deployment SHA
- merged main SHA
- state
- production alias

Require:

production SHA == merged main SHA
state == READY

Use canonical production URL:

https://aira-ai-2026.vercel.app

Do not test an older immutable deployment.

---

## 19. PRODUCTION SMOKE

Perform real production smoke testing.

At minimum:

TEST 1
Load production home.

Require successful render.

TEST 2
Start new chat.

TEST 3
Send:

Reply exactly with PRODUCTION_RELEASE_OK

Require visible:

PRODUCTION_RELEASE_OK

TEST 4
Open the primary feature changed in this release.

Require expected behavior.

TEST 5
Check browser console/network for release-blocking errors.

Add release-specific production tests as necessary.

Do not perform destructive production actions unnecessarily.

---

## 20. PRODUCTION SECURITY CHECK

Confirm after deployment:

- no debug/test auth enabled
- expected environment variables exist
- no secret exposed in client bundle
- production provider/runtime configuration is correct
- production alias points to intended deployment
- deployment SHA matches main

Any mismatch = FAIL.

---

## 21. FINAL EVIDENCE

Produce factual final report:

Starting SHA:
Branch:
Final branch SHA:
Files changed:
Release scope:

Agents used:
Skills used:

Lint:
Typecheck:
Build:
Tests:
CI run:
CI result:

Security review:
Database impact:
API result:
Runtime/provider result:
Frontend result:
Browser result:

Preview deployment ID:
Preview SHA:
Preview state:
Preview smoke:

Evidence Collector:
Reality Checker:

PR:
Merge SHA:

Production deployment ID:
Production SHA:
Main SHA:
Production state:
Production alias:
Production smoke:
PRODUCTION_RELEASE_OK:

Known limitations:

FINAL VERDICT:
PASS / FAIL

---

## PASS RULE

PASS requires ALL applicable evidence:

correct branch
+ correct SHA
+ required tests green
+ security review clear
+ preview SHA match
+ preview functional smoke
+ independent evidence review
+ independent reality check
+ production SHA match
+ production functional smoke

If any required item is missing or uncertain:

FINAL VERDICT = FAIL