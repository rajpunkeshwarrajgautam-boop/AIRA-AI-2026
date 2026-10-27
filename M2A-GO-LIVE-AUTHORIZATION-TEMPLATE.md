# AIRA AI 2026 — M2-A EXACT-SHA GO LIVE AUTHORIZATION TEMPLATE
## Formal Production Release Gating, Dual-Evidence Attestation & Rollback Plan

**Document Version:** 1.0.0-PROPOSAL  
**Date:** 2026-10-27  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Dedicated Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-M2A-DURABLE-EXECUTION`  
**Target Production Branch:** `prod-release`  
**Canonical Production URL:** `https://aira-ai-2026.vercel.app/`  
**Production Neon Project:** `old-sky-50952395` (Endpoint: `ep-withered-art-b36ox90b`)  
**Parent Pull Request:** PR #115 (Target: `prod-release`, State: `OPEN / DRAFT`)  
**Child Pull Request:** PR #116 (Target: `feat/aira-m2a-durable-specialist-execution-20261027`)  
**Legal Notice:** **THIS DOCUMENT IS A PROPOSAL TEMPLATE. IT DOES NOT CONSTITUTE AUTHORIZATION TO DEPLOY. MERGING AND PRODUCTION ACTIVATION REQUIRE EXPLICIT HUMAN APPROVAL.**

---

## 1. Five Independent Operational Authorization Boundaries

In strict compliance with repository release governance (`AGENTS.md`), the deployment process strictly decouples five operational gates. Under no circumstances may an agent or operator infer permission for one gate from another:

```
[GATE A] Infrastructure Provisioning Authorization
   │ (Authorize creating worker container hosting environment on approved provider)
   ▼
[GATE B] Production Migration Authorization
   │ (Authorize applying migration 026_specialist_execution.sql to Neon old-sky-50952395)
   ▼
[GATE C] GitHub PR Merge Authorization
   │ (Authorize merging PR #116 into PR #115, then PR #115 into prod-release)
   ▼
[GATE D] Vercel Production Rollout Authorization
   │ (Triggered automatically upon prod-release push; verified via build check)
   ▼
[GATE E] Production Worker Activation Authorization
   │ (Authorize setting AIRA_PRODUCTION_WORKER_ENABLED=true on container host)
```

---

## 2. Production Release Authorization Submission Form

*(To be completed by repository owner `rajpunkeshwarrajgautam-boop` only after PR #116 is merged into PR #115 and the final commit SHA is generated)*

### 2.1 Release Metadata
- **Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`
- **Candidate Pull Request:** PR #115
- **Exact Candidate Release SHA:** `[INSERT_FINAL_MERGED_COMMIT_SHA]`
- **Target Branch:** `prod-release`
- **Approved Worker Hosting Provider:** `[AWS ECS Fargate / Railway / Fly.io]`
- **Approved Monthly Hosting Budget:** `$[INSERT_BUDGET]`
- **Approved Neon Migration:** `026_specialist_execution.sql`
- **Target Neon Project:** `old-sky-50952395`
- **Target Neon Endpoint:** `ep-withered-art-b36ox90b`

### 2.2 Dual-Evidence GitHub Actions Dispatch Template
To execute cryptographic release authorization under repository policy, the owner executes the `authorize-release` GitHub Actions workflow:

```bash
gh workflow run authorize-release.yml \
  -R rajpunkeshwarrajgautam-boop/AIRA-AI-2026 \
  -f pr_number=115 \
  -f candidate_sha=[INSERT_FINAL_MERGED_COMMIT_SHA] \
  -f approval_phrase="I hereby authorize production deployment of SHA [INSERT_FINAL_MERGED_COMMIT_SHA] to prod-release"
```

---

## 3. Step-by-Step Production Rollout Sequence

### Step 1: Pre-Release Neon Snapshot & Backup
1. In Neon Console (`old-sky-50952395`), create a point-in-time branch snapshot of production branch `main` named `backup-pre-m2a-[TIMESTAMP]`.
2. Verify snapshot creation and record branch ID.

### Step 2: Apply Migration 026 to Production Neon
1. Apply migration `026_specialist_execution.sql` using standard migration runner:
   ```bash
   DATABASE_URL="postgres://...@ep-withered-art-b36ox90b.us-east-2.aws.neon.tech/neondb?sslmode=verify-full" npm run db:migrate
   ```
2. Verify table creation:
   - `specialist_tasks`
   - `specialist_task_events`
   - `specialist_tool_receipts`
   - `specialist_worker_leases`
3. Verify zero schema drift.

### Step 3: Deploy Worker Container (Activation Disabled)
1. Deploy worker container image built from the exact release SHA to the approved hosting provider.
2. Injected environment:
   ```bash
   NODE_ENV=production
   AIRA_ENV=production
   AIRA_PRODUCTION_WORKER_ENABLED=false   # STRICTLY DISABLED
   NODE_OPTIONS="--max-old-space-size=512"
   DATABASE_URL="postgres://...@ep-withered-art-b36ox90b.us-east-2.aws.neon.tech/neondb?sslmode=verify-full"
   ```
3. Verify container starts cleanly, health probe `/healthz` returns 200, readiness `/readyz` returns 503 (correctly refusing tasks), and log output confirms:
   `[ActivationPolicy] Worker activation disabled: AIRA_PRODUCTION_WORKER_ENABLED is false.`

### Step 4: Merge PR #115 into `prod-release` & Vercel Auto-Deploy
1. Execute authorized merge of PR #115 into `prod-release`.
2. Vercel automatically detects push, executes `vercel.json` build preflight (`npm run db:verify:deploy`), builds frontend, and promotes to live canonical URL: `https://aira-ai-2026.vercel.app/`.
3. Verify live Vercel HTTP 200 response and smoke test chat UI.

### Step 5: Controlled Worker Activation
1. Update worker container environment on hosting provider:
   ```bash
   AIRA_PRODUCTION_WORKER_ENABLED=true
   ```
2. Restart worker container.
3. Verify container startup log confirms:
   `[ActivationPolicy] Production specialist worker activation successfully authorized under verified live Neon identity.`
4. Verify readiness probe `/readyz` returns HTTP 200.

### Step 6: Controlled Production Acceptance Test
1. From authenticated UI on `https://aira-ai-2026.vercel.app/`, submit test objective requiring mathematical specialist:
   `Calculate 2^22 + 100`
2. Verify:
   - Task recorded in `specialist_tasks` with state `COMPLETED`.
   - Tool execution receipt recorded in `specialist_tool_receipts` with exact output `4194404`.
   - Audit trail recorded in `specialist_task_events`.
   - Output returned to chat interface without errors.

---

## 4. Production Rollback & Emergency Incident Runbook

If any regression occurs (e.g., worker crash loop, high database connection contention, unhandled tool error):

### Emergency Action 1: Instant Worker Deactivation (T + 1 minute)
- Set `AIRA_PRODUCTION_WORKER_ENABLED=false` on worker hosting environment and trigger rolling restart.
- Result: Workers immediately cease polling and claiming tasks. Existing web frontend continues operating standard non-specialist workflows without downtime.

### Emergency Action 2: Vercel Instant Rollback (T + 3 minutes)
- In Vercel Dashboard, promote previous production deployment (`104a323` or pre-M2A candidate).
- Reverts frontend to pre-M2A release instantly.

### Emergency Action 3: Database Rollback (T + 10 minutes)
- Migration `026` creates additive tables. The pre-existing schema and data remain 100% backward-compatible.
- If necessary, run rollback migration:
   ```bash
   npm run db:migrate:down
   ```
- Alternatively, restore Neon point-in-time snapshot created in Step 1.

---

## 5. Formal Approval Sign-Off Block

| Role | Name | Status | Timestamp |
| :--- | :--- | :---: | :---: |
| **Repository Owner / Authorizer** | `rajpunkeshwarrajgautam-boop` | **PENDING** | `[YYYY-MM-DD HH:MM UTC]` |
| **Release Certification Lead** | Autonomous Release Engine | **CERTIFIED (PRE-MERGE)** | 2026-10-27 22:05 UTC |
