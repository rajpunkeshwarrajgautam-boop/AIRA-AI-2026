# AIRA AI 2026 — PR #115 COMBINED RECERTIFICATION PLAN
## Stacked PR Integration Verification, Comprehensive Invariants & Release Candidate Gates

**Document Version:** 1.0.0-INTEGRATION-PLAN  
**Date:** 2026-10-27  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Dedicated Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-M2A-DURABLE-EXECUTION`  
**Stacked Head Branch:** `fix/m2a-production-activation-preflight-20261027` (PR #116)  
**Stacked Integration Target:** `feat/aira-m2a-durable-specialist-execution-20261027` (PR #115)  
**Parent Candidate:** PR #115 (Head SHA `bf3cec65c6ad29370b48c58020c6cb6376a4353f`, targeting `prod-release`, State: `OPEN / DRAFT`)  
**Production Authority Invariant:** **DO NOT MERGE PR #115. DO NOT REMOVE PR #115 FROM DRAFT. DO NOT MUTATE PRODUCTION.**

---

## 1. Stacked PR Architecture & Read-Only Integration Assessment

### 1.1 Branch Hierarchy
```
prod-release (Vercel Production Auto-Deploy Target)
   ▲
   │ [PR #115: OPEN / DRAFT — M2-A Durable Specialist Execution]
   │
feat/aira-m2a-durable-specialist-execution-20261027 (Head SHA: bf3cec65c6ad29370b48c58020c6cb6376a4353f)
   ▲
   │ [PR #116: OPEN — Production Activation Preflight & Hardening]
   │
fix/m2a-production-activation-preflight-20261027 (PR #116 branch)
```

### 1.2 Merge-Readiness Gate for PR #116 into PR #115
1. **Target Accuracy**: PR #116 cleanly targets `feat/aira-m2a-durable-specialist-execution-20261027` (NOT `prod-release`).
2. **Conflict Evaluation**: 
   - Base commit of `fix/m2a-production-activation-preflight-20261027` is `bf3cec65c6ad29370b48c58020c6cb6376a4353f`.
   - `git merge-base` matches `HEAD` of PR #115 exactly. Fast-forward or clean merge guaranteed with ZERO conflicts.
3. **CI Gate**: Fast CI, Semantic Search CI, Tracked Secrets Hygiene, and Main PR Certification must be green on PR #116.
4. **Owner Authorization**: PR #116 requires explicit human review and approval before merging.
5. **No Automatic Merge**: Neither automated agent nor CI script may merge PR #116 or PR #115.

---

## 2. Invariants Governing the Combined M2-A Release Candidate

Once PR #116 is approved and merged into `feat/aira-m2a-durable-specialist-execution-20261027`, the resulting single commit on PR #115 must be recertified against the following 20 core invariants:

1. **M1 Specialist Role Taxonomy**: Exactly 9 canonical roles defined; contracts, inputs, outputs, error taxonomies, and status codes strictly preserved.
2. **PostgreSQL Durable Task State**: `specialist_tasks`, `specialist_task_events`, `specialist_tool_receipts`, and `specialist_worker_leases` correctly schematized in migration `026_specialist_execution.sql`.
3. **DAG Coordination & Dependencies**: Waves executed in topological order; circular, self, and dangling dependencies rejected at compile time.
4. **Transactional Worker Claims**: `SELECT ... FOR UPDATE SKIP LOCKED` guarantees exactly one worker acquires claim even under concurrent races.
5. **Distributed Leases**: TTL-bounded leases renewed during execution; stale leases reclaimed by replacement workers upon expiration.
6. **Monotonically Increasing Fencing Tokens**: Any worker operating with an outdated fencing token is rejected on task update or lease renewal.
7. **ToolGateway Authorization**: Side-effect levels (`NONE`, `READ_ONLY`, `WORKSPACE_WRITE`, `IRREVERSIBLE_EXTERNAL`) and required permissions strictly verified before tool execution.
8. **Cross-Principal Idempotency**: Tool receipts tied to specific principal IDs; distinct principals cannot share or replay tool executions.
9. **Cross-Run Idempotency**: Tool receipts tied to specific run IDs; distinct runs cannot share or replay tool executions.
10. **Worker Crash Recovery (Crash-Window A & B)**: Tasks aborted midway or during outcome persistence are reclaimed and completed up to `maxRetries`.
11. **Graceful Worker Shutdown**: In-flight tasks drained cleanly before worker process termination.
12. **Production Activation Default-Deny**: Production workers without explicit `AIRA_PRODUCTION_WORKER_ENABLED=true` refuse startup.
13. **Structural Preflight Separation**: Static configuration validation emits `CONFIGURATION_VALID` (`runtimeAuthorized: false`) and cannot trigger task polling.
14. **Authoritative Neon Identity Verification**: Production workers must verify live Neon project `old-sky-50952395` and endpoint `ep-withered-art-b36ox90b` before emitting `ACTIVATION_AUTHORIZED` (`runtimeAuthorized: true`).
15. **Strict TLS 1.3 Handshake & CA Verification**: Self-signed, invalid CA, and spoofed hostnames are rejected fail-closed with `rejectUnauthorized: true`.
16. **Staging/Production Crossover Rejection**: Production worker connecting to Staging Neon OR Staging worker connecting to Production Neon is instantly blocked.
17. **Worker Health & Readiness Probes**: HTTP `/healthz` and `/readyz` probes report 503 until database connected and runtime activation authorized.
18. **Bounded Memory Footprint**: Worker memory usage bounded under 512 MB Node.js V8 heap constraint with strict queue limits.
19. **Adaptive Database Polling**: Exponential backoff polling (50ms base up to 5000ms max) prevents Neon connection starvation during idle windows.
20. **Existing AIRA API Compatibility**: Full backwards compatibility with `RunStateSchema`, `WorkflowEngine`, `ApprovalKernel`, and existing chat workflows.

---

## 3. Post-Merge Recertification Procedure

Upon merging PR #116 into `feat/aira-m2a-durable-specialist-execution-20261027`, execute the exact sequential test checklist on the resulting HEAD commit:

```bash
# Step 1: Pull updated feature branch
git checkout feat/aira-m2a-durable-specialist-execution-20261027
git pull origin feat/aira-m2a-durable-specialist-execution-20261027

# Step 2: Verify exact commit SHA
git rev-parse HEAD

# Step 3: Run comprehensive verification suite
npm run test:m1-specialists
npm run test:m2a
npm run test:m2a:postgres
npm run test:m2a:tls
npx tsx --test test/m2a-production-activation-security.test.ts
npm run test:release-auth:unit
npm run test:secrets
npm run typecheck
npm run lint
npm run build
```

---

## 4. Certification Statement Boundary

> **CRITICAL REMINDER**:  
> The combined release candidate on PR #115 CANNOT and MUST NOT be marked as "Production-Certified" until:  
> 1. PR #116 is merged into `feat/aira-m2a-durable-specialist-execution-20261027`.  
> 2. The combined commit SHA is generated and recorded.  
> 3. The full post-merge verification suite runs successfully against that exact SHA.  
> 4. PR #115 remains in **DRAFT** state throughout all verification steps.
