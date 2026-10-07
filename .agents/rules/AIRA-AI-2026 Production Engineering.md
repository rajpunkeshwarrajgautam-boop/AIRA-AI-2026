# AIRA-AI-2026 PRODUCTION ENGINEERING RULE

This is a real production software repository.

Never treat work in this workspace as a mockup, toy project, speculative prototype,
or superficial coding exercise unless the user explicitly requests a prototype.

For every user request, silently evaluate:

1. What is the actual objective?
2. Which parts require repository/runtime inspection?
3. Which engineering disciplines are involved?
4. Which installed Agency Agents are best suited?
5. Which installed Agent Skills are best suited?
6. Which MCP servers/tools provide authoritative evidence?
7. What could affect Production, Git history, credentials, databases, deployments,
   user work, or external services?
8. What evidence is required before success can be claimed?
9. What is the smallest safe production-grade implementation path?

Then dynamically select the strongest relevant specialist capabilities.

Never invent an agent, skill, MCP server, tool, command, API, test, integration,
deployment, or capability.

If a capability is not available, report that accurately.

------------------------------------------------------------
TRUTH BEFORE ACTION
------------------------------------------------------------

Never guess repository or runtime state when it can be inspected.

Before significant engineering changes inspect relevant facts such as:

- working directory
- current Git branch
- git status
- HEAD SHA
- remote branch state
- existing implementation
- package scripts
- tests
- CI workflows
- runtime configuration
- database schema/migrations
- deployment state
- provider configuration

Repository/runtime evidence overrides stale assumptions or previous conversational context.

Unknown is not PASS.

------------------------------------------------------------
NO FAKE PRODUCTION WORK
------------------------------------------------------------

Never substitute real production functionality with:

- mock APIs
- fake API responses
- dummy integrations
- fake connectors
- simulated success
- hard-coded success states
- placeholder routes
- placeholder buttons
- fake model execution
- fake authentication
- fake tool execution
- dummy deployment states
- tests that only prove mocked behavior

Mocks are acceptable only inside isolated tests where technically appropriate.

A mock test does NOT prove a real external integration works.

If credentials or infrastructure prevent real verification:

implement the production path correctly
and report:

BLOCKED — OWNER ACTION REQUIRED

Do not fabricate success.

------------------------------------------------------------
PRODUCTION ENGINEERING STANDARD
------------------------------------------------------------

For applicable changes consider:

- correctness
- validation
- authentication
- authorization
- secrets handling
- error handling
- failure modes
- concurrency
- race conditions
- idempotency
- transactions
- retries where appropriate
- observability
- performance
- accessibility
- deployment implications
- backwards compatibility
- maintainability
- testability

Do not optimize only for the happy path.

------------------------------------------------------------
AGENT / SKILL ORCHESTRATION
------------------------------------------------------------

For every prompt, inspect currently installed/available capabilities and use
the best combination for that specific task.

Examples of useful specialist categories:

- software/system architecture
- frontend engineering
- backend/API engineering
- PostgreSQL/database engineering
- AI/model integration
- security
- authentication/authorization
- DevOps
- GitHub Actions
- Vercel/deployment
- testing/QA
- browser automation
- debugging
- performance
- accessibility
- code review
- release engineering

Do NOT fan out to many agents unnecessarily.

Use the minimum effective specialist team.

For substantial production work, separate responsibilities when possible:

INVESTIGATE
→ DESIGN/PLAN
→ IMPLEMENT
→ TEST
→ INDEPENDENT VERIFY
→ REPORT

When installed and relevant, strongly prefer independent evidence/reality checking
capabilities such as:

agency-evidence-collector
agency-reality-checker

or equivalent installed specialists.

The final verifier must challenge the implementation rather than merely repeat the
implementing agent's claims.

------------------------------------------------------------
DEBUGGING STANDARD
------------------------------------------------------------

When something fails:

OBSERVE
→ REPRODUCE
→ COLLECT LOGS/EVIDENCE
→ ISOLATE LAYER
→ DETERMINE ROOT CAUSE
→ MINIMUM FIX
→ RE-RUN ORIGINAL FAILURE
→ REGRESSION TEST
→ VERIFY

Do not randomly edit code until the symptom disappears.

Distinguish root cause from symptom.

------------------------------------------------------------
GIT SAFETY
------------------------------------------------------------

Before significant repository work inspect:

git status
git branch --show-current
git rev-parse HEAD

and remote state when relevant.

Never:

- force-push main
- rewrite shared Git history without explicit authorization
- reset unrelated user work
- discard local modifications silently
- delete unrelated branches
- merge unrelated branches
- commit unrelated files
- hide failing tests
- weaken CI merely to get green

Treat main as production-sensitive.

Read-only investigation on main is allowed.

Prefer scoped feature/certification branches for substantial changes.

------------------------------------------------------------
SECRETS
------------------------------------------------------------

Never commit or expose real credentials.

Use environment variables, provider secrets, or secret-management mechanisms.

If a real credential is discovered:

- redact it
- remove it from the active tree where appropriate
- treat it as compromised
- report rotation/revocation requirement
- do not automatically rewrite shared history without explicit authorization

Never print complete secrets in reports.

------------------------------------------------------------
TESTING AND CERTIFICATION
------------------------------------------------------------

Do not declare completion merely because:

- code compiles
- lint passes
- a page renders
- one unit test passes
- CI starts
- a deployment reaches READY

Use the strongest applicable verification:

- lint
- typecheck
- build
- unit tests
- integration tests
- database tests
- concurrency tests
- recovery tests
- identity/auth tests
- E2E tests
- browser tests
- API execution
- deployment verification
- runtime smoke testing
- Production smoke testing

Never remove or weaken a valid failing test simply to obtain green CI.

------------------------------------------------------------
CI/CD
------------------------------------------------------------

Treat CI/CD as Production infrastructure.

Configuration alone is not proof.

Use evidence:

CODE
→ CI
→ DEPLOYMENT
→ RUNTIME/SMOKE CHECK

Verify each relevant stage.

A local green test does not prove GitHub Actions.

GitHub Actions green does not prove Production.

A READY deployment does not prove the application works.

------------------------------------------------------------
AIRA AI FUNCTIONALITY
------------------------------------------------------------

AIRA-AI-2026 is intended to be a real production AI workspace.

AI features must be verified end-to-end where applicable:

UI
→ state
→ backend/API
→ model/provider router
→ real provider execution
→ response/streaming
→ error handling
→ usage/metadata
→ UI result

Do not certify a model because it appears in a dropdown.

Do not certify a connector because its UI exists.

Do not certify an agent because configuration exists.

Do not certify an automation because a database row exists.

Prove execution.

------------------------------------------------------------
DEFINITION OF DONE
------------------------------------------------------------

Production work is complete only when supported by:

IMPLEMENTATION
+
RELEVANT TESTS
+
REAL EXECUTION
+
INDEPENDENT VERIFICATION
+
EVIDENCE

Classify final status only as:

PASS
FAIL
PARTIAL
BLOCKED

Use:

NOT VERIFIED

for unverified claims.

Use:

BLOCKED — OWNER ACTION REQUIRED

for actions requiring external credentials/account access/human approval.

------------------------------------------------------------
FINAL REPORTING
------------------------------------------------------------

For substantial engineering tasks report:

Task:
Branch:
Starting SHA:
Final SHA:

Changed files:

Verification performed:

Tests:

CI:

Deployment:

Known limitations:

Blockers:

Final verdict:

Only report evidence actually observed.

Never convert assumptions into PASS.
