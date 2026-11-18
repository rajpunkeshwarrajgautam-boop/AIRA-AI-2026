# Gate 3 Production Deployment Certification & Readiness Package

**Target Environment:** Production (`https://aira-ai-2026.vercel.app`)  
**Vercel Project:** `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` (`aira-ai-2026`)  
**Production Git Branch:** `prod-release`  
**Current Production SHA:** `d988a6bd26d49a000d59cf906b13fcfe9e170058`  
**Known Good Rollback Deployment:** `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` (Ready, Nov 14 2026)  
**Target Release Candidate SHA:** `415ba39b1a5e173e6d1c4ea3ee6406e22e5797f7` (PR #189)  
**Status:** **LOCKED — GATED BY GATE 2 SUCCESS & EXPLICIT OWNER DEPLOYMENT APPROVAL**  
*(Strict Policy: Zero Production Deployments Without Explicit Written Authorization)*

---

## 1. Executive Summary & Gate 3 Boundary

Gate 3 governs the final production deployment and cutover of AIRA AI 2026 to canonical production (`https://aira-ai-2026.vercel.app`).

### Gate Hierarchy & Dependencies
```
[ Gate 1: Candidate Promotion ] ──► COMPLETE (SHA 3040b14b promoted to release/candidate-pr178-pr184-combined)
              │
[ Blocker Remediation PR #189 ] ──► CERTIFIED (SHA 415ba39b passes Fast CI & Semantic Search CI)
              │
[ Gate 2: Database Migration 032 ] ──► READY / LOCKED (Awaiting written authorization)
              │
[ Gate 3: Production Deployment ] ──► LOCKED (Precondition: Gate 2 must be COMPLETE and verified)
```

Gate 3 cannot be executed until:
1. PR #189 (`fix/gate2-migration-032-cli-readiness`) is merged into `release/candidate-pr178-pr184-combined`.
2. Gate 2 has successfully applied migration 032 to `old-sky-50952395` with `workflow_runs.artifacts` verified.
3. Explicit written authorization is provided by the owner naming Gate 3 production deployment.

---

## 2. Production Baseline & Environment Inventory

| Component | Target Identity | Current Live Baseline | Planned Release Target |
|---|---|---|---|
| **Vercel Project** | `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH` | `aira-ai-2026` | Unchanged |
| **Canonical URL** | `https://aira-ai-2026.vercel.app` | Deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` | New candidate deployment |
| **Git Production Branch** | `prod-release` | `d988a6bd26d49a000d59cf906b13fcfe9e170058` | Fast-forward to candidate SHA |
| **Release Candidate SHA** | `release/candidate-pr178-pr184-combined` | `3040b14b` (base) | `415ba39b` (via PR #189) |
| **Production Database** | `old-sky-50952395` (Neon) | PostgreSQL 18.7, 31 migrations | 32 migrations (post-Gate 2) |
| **Database Endpoint** | `ep-withered-art-b36ox90b` | `main` (`br-shiny-moon-b3vy9xj7`) | Unchanged |
| **Rollback Target** | Vercel Deployment | `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` | Standby instant rollback |

---

## 3. Subsystem Certification Status Matrix

All candidate functional domains have completed rigorous pre-deployment certification:

| Subsystem / Domain | Evaluation Scope | Test Evidence | Verdict |
|---|---|---|:---:|
| **Identity & Authentication** | Fail-closed auth, session persistence, credential isolation | `test/auth-fail-closed-policy.test.ts` (3/3 pass), `test/release-authorization-guard.ts` (52/52 pass) | **CERTIFIED** |
| **Adversarial Entitlements** | Plan models, tool restrictions, token races, tenant isolation | `test/integration/entitlements/adversarial-entitlements.test.ts` (20/20 scenarios pass) | **CERTIFIED** |
| **Inference & SSE Streaming** | SSE deltas, cursor replay, terminal frames, Gemini fallback | `test/gemini-fallback-empty-stream-regression.test.ts` (7/7 pass), `test/streaming-artifact-parser.test.ts` (7/7 pass) | **CERTIFIED** |
| **Model Routing & Intent** | Multi-provider routing, fast path (<5ms), intent classification | `test/model-router-provider-routing.ts` (2/2 pass), `test/p1-multi-provider-fast-routing.test.ts` (6/6 pass), `test/intent-router.ts` (13/13 pass) | **CERTIFIED** |
| **Durable Agent Runtime** | Specialist worker claim race, lease heartbeat, DAG scheduler | `test/m2a-durable-specialist-execution.test.ts` (17/17 pass), `test/m2a-production-activation-security.test.ts` (52/52 pass) | **CERTIFIED** |
| **Workflow Approval Authority** | Contextual permissions, unpersisted run rejection, owner check | `test/workflow-approval-authority.test.ts` (5/5 pass), `test/aira-one-execution-safety.test.ts` (15/15 pass) | **CERTIFIED** |
| **Strict TLS Encryption** | Neon endpoint TLS 1.3, strict cert validation, fail-closed CA | `test/verify-strict-tls.ts` (5/5 pass against Neon endpoint) | **CERTIFIED** |
| **Secrets Hygiene** | Clean repository audit across all tracked files | `test/tracked-secrets-hygiene.test.ts` (1,051 tracked files clean, 0 secrets) | **CERTIFIED** |
| **Migration CLI Runner** | Flag parsing, fail-closed validation, advisory locks | `test/guarded-migration-cli-validation.test.ts` (13/13 pass) | **CERTIFIED** |
| **GitHub Actions CI** | Fast CI, Semantic Search CI on SHA `415ba39b` | Run `44305513120` (All jobs green) | **CERTIFIED** |

---

## 4. Production Deployment Procedure (Step-by-Step)

Once Gate 2 is complete and explicit owner authorization for Gate 3 is granted:

### Step 1: Pre-Deployment Verification
- Confirm Gate 2 postcondition check passed: `workflow_runs.artifacts` exists as JSONB.
- Confirm production database `knex_migrations` contains migration 032.
- Verify `prod-release` git tree is clean and points to `d988a6bd`.

### Step 2: Merge Candidate to Production Branch
```bash
# In release worktree:
git checkout prod-release
git merge --ff-only release/candidate-pr178-pr184-combined
git push origin prod-release
```

### Step 3: Trigger and Monitor Vercel Production Build
- Monitor Vercel deployment triggered by push to `prod-release`.
- Verify build command (`npm run build` -> `tsc -b && vite build`) succeeds without error.
- Verify serverless function bundle compilation (`api/**/*.ts`).
- Record new Vercel deployment ID (`dpl_...`).

### Step 4: Post-Deployment Smoke & Verification Gates
Run the automated post-deployment verification suite against canonical production (`https://aira-ai-2026.vercel.app`):
1. **Health Check:**
   `GET https://aira-ai-2026.vercel.app/api/health` -> HTTP 200, `status: "HEALTHY"`, `readiness: "READY"`.
2. **Ready Probe:**
   `GET https://aira-ai-2026.vercel.app/api/ready` -> HTTP 200.
3. **Fail-Closed Authentication:**
   `GET https://aira-ai-2026.vercel.app/api/conversations` (no auth) -> HTTP 401.
   `POST https://aira-ai-2026.vercel.app/api/chat/stream` (no CSRF) -> HTTP 403.
   `POST https://aira-ai-2026.vercel.app/api/chat/stream` (no auth, with CSRF) -> HTTP 401.
4. **Model Router Diagnostics:**
   Verify registered providers (`groq`, `gemini`, `nvidia`) are active in health output.
5. **Interactive UI Smoke Test:**
   Inspect greeting screen, model selector, settings menu, and guest session handling.

---

## 5. Rollback Runbook & Contingency Plan

If any critical post-deployment failure occurs:

### Immediate Rollback Trigger Conditions
- `GET /api/health` returns status != 200 or `appState: "DEGRADED"` for > 60 seconds.
- Runtime uncaught exceptions in serverless API logs.
- Failure of model routing or streaming responses.
- Database connection errors or connection pool exhaustion.

### Instant Rollback Procedure (< 30 Seconds)
1. **Rollback Vercel Alias:**
   Using Vercel CLI or Dashboard, immediately promote known-good deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8` to production:
   ```bash
   vercel alias set dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8 aira-ai-2026.vercel.app
   ```
2. **Database Backward Compatibility:**
   Because migration 032 is strictly additive (`ADD COLUMN artifacts JSONB DEFAULT '[]'`), prior code (which does not select or insert `artifacts`) remains 100% compatible with the schema. No database rollback is required for an application-only rollback.
3. **Verify Rollback:**
   Confirm `https://aira-ai-2026.vercel.app/api/health` returns 200 on deployment `dpl_3vZXiXwBWgZeeAyiyUVgYixsNMb8`.

---

## 6. Gate 3 Final Lock & Sign-Off Requirement

**Current Status:** **STRICTLY LOCKED**

No production branch merge, Vercel promotion, or environment variable change will take place without explicit written authorization from the owner following the completion of Gate 2.
