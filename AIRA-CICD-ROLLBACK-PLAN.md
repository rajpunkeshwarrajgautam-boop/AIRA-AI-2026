# AIRA AI 2026 — CI/CD Contingency & Rollback Plan

## 1. Rollback Authority & Trigger Policy

Rollbacks may be initiated immediately under any of the following conditions:
1. **Critical Production Regression**: Elevating HTTP 5xx error rates, chat response blanking, or model routing collapse following a release.
2. **Database Integrity Violation**: Migration failure, lock contention, or unrecoverable schema mismatch.
3. **Security Incident**: Exposure of sensitive keys, authentication bypass, or unauthorized deployment detection.
4. **Owner Direct Order**: Explicit instruction from repository owner `rajpunkeshwarrajgautam-boop`.

---

## 2. Production Rollback Procedures

### 2.1 Instant Release Authorization Revocation
If an authorization was granted but the release must be immediately halted prior to or during deployment:

#### Method A: Workflow Revocation (GitHub Actions)
1. Repository owner navigates to **Actions** → **Revoke Release Authorization via GitHub App (No Deployment)**.
2. Inputs:
   - `pr_number`: The release PR number.
   - `candidate_sha`: The exact 40-character candidate SHA.
   - `revoke_phrase`: `REVOKE <candidate_sha>`.
3. Runs workflow on `prod-release`.
4. Dedicated App publisher instantly posts commit status `release/go-live-authorized` = `failure` (`REVOKED by owner`), immediately blocking PR merge and release gates.

#### Method B: CLI Revocation
```bash
npm run revoke:release-auth -- --pr <PR_NUMBER> --sha <CANDIDATE_SHA>
```

---

### 2.2 Vercel Production Deployment Rollback
Because Vercel on the Hobby tier promotes the latest commit on `prod-release` to production:

#### Instant Traffic Rollback via Vercel Console / CLI:
1. Identify the previous certified production deployment:
   - Rollback Anchor SHA: `dfe337563538335bd2f61c30230064a4a88a2647` (or previous stable commit).
2. To roll back instantly to the prior deployment ID:
   ```bash
   # Inspect prior deployments:
   npx vercel deployment ls --project aira-ai-2026

   # Re-alias canonical production domain to prior known-good deployment:
   npx vercel alias set <PREVIOUS_DEPLOYMENT_URL> aira-ai-2026.vercel.app
   ```
3. In Git: Revert the merge commit on `prod-release`:
   ```bash
   git revert -m 1 <MERGE_COMMIT_SHA>
   git push origin prod-release
   ```

---

### 2.3 Neon Production Database Rollback
Production Neon database (`old-sky-50952395`) maintains point-in-time branch state:

#### Fast Branch Rollback (Point-in-Time Restore):
1. In Neon Console or via `neonctl`:
   ```bash
   # Create a recovery branch from the pre-migration snapshot:
   npx neonctl branches create \
     --project-id old-sky-50952395 \
     --name prod-recovery-snapshot \
     --parent main
   ```
2. If individual knex down-migrations are safe and authorized:
   ```bash
   # Roll back the most recent migration batch:
   npx knex migrate:rollback --knexfile packages/db/src/index.ts
   ```
3. Point Vercel `DATABASE_URL` for Production to the verified recovery snapshot endpoint if data corruption occurred.

---

## 3. Permanent Staging Rollback Procedures

Because Staging is automated on branch `staging`:
1. **Git Revert on Staging**:
   ```bash
   git checkout staging
   git pull origin staging
   git revert <BAD_COMMIT_SHA> -m 1
   git push origin staging
   ```
2. `.github/workflows/staging-deployment.yml` automatically triggers on the revert push, runs preflight and database checks, and redeploys the stable commit to staging.
3. If Staging database schema requires reset, Neon Staging (`mute-frost-50372225`) can be restored to branch snapshot `br-autumn-star-b36dfu5w`.

---

## 4. Emergency Contacts & Responsibility Escalation

| Role | Name | Responsibility |
| :--- | :--- | :--- |
| **Release Authority** | `rajpunkeshwarrajgautam-boop` | Authorize GO LIVE, revoke authorizations, manage DNS |
| **DevOps Specialist** | `agency-devops-automator` | CI/CD pipeline health, Vercel alias restoration |
| **Database Reliability** | `agency-database-reliability-engineer` | Neon branch point-in-time recovery, schema rollback |
| **Reality QA Gate** | `agency-reality-checker` | Post-rollback smoke verification & reality confirmation |
