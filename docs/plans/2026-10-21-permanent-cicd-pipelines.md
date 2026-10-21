# AIRA AI 2026 — Permanent Preview & Production CI/CD Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, harden, and certify two permanent CI/CD pipelines (Preview/Staging and Production) for AIRA AI 2026, eliminating repetitive infrastructure setup while enforcing strict database isolation, zero environment crossover, and owner-only production release gating.

**Architecture:** 
- Preview / Staging Pipeline: Triggered on PRs targeting `staging`, `main`, and `prod-release` plus pushes to `staging`. Runs comprehensive lint, typecheck, secrets hygiene, database isolation validation, migration compatibility, unit and API regression tests. On merge/push to `staging`, deploys to permanent staging deployment and runs smoke/health certification.
- Production Pipeline: Protected release gating requiring immutable commit SHA, passing CI (`Fast CI`, `Semantic Search CI`, `Main / PR certification`), staging certification, database migration approval, security audits, and cryptographic owner GO LIVE authorization (`release/go-live-authorized`). Production deployments cannot execute automatically.
- Database Isolation Guard: Hard boundary validator separating Neon Staging (`mute-frost-50372225`, main `br-autumn-star-b36dfu5w`), Production (`old-sky-50952395`, main `br-shiny-moon-b3vy9xj7`), and Commercial PR #92 (`br-green-snow-b3dsci5u`).

**Tech Stack:** GitHub Actions, Node.js 24, TypeScript, Knex, PostgreSQL, Neonctl, Vercel CLI, Oxlint.

**Spec:** USER_REQUEST and AGENTS.md

## Global Constraints
- Target workspace: `C:\Users\WORKSTATION\AIRA-AI-2026-CICD` on branch `infra/aira-permanent-preview-production-cicd`.
- Excluded resources: Never access or modify `aira-ai.in`, `www.aira-ai.in`, `aira-ai-live.vercel.app`, Vercel project `aira-ai-live` (`prj_fXrnG5khmADI8znZfJZBylUsnvKU`).
- Commercial workstream protection: Never modify `C:\Users\WORKSTATION\AIRA-AI-2026-COMMERCIAL`, branch `feat/aira-commercial-platform-v1`, PR #92, or Neon branch `br-green-snow-b3dsci5u`.
- Zero credentials committed or printed in logs.
- Never force push or bypass release authority.

---

### Task 1: Database Isolation & Environment Crossover Guard Engine
**Files:**
- Create: `packages/db/src/security/database-isolation-guard.ts`
- Test: `test/database-isolation-guard.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing database isolation test**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Implement database isolation guard**
- [ ] **Step 4: Run test to verify pass**
- [ ] **Step 5: Add npm test:db-isolation script and verify**

### Task 2: Enhance Preview / Staging CI/CD Workflows
**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/staging-deployment.yml`

- [ ] **Step 1: Update .github/workflows/ci.yml with staging branch triggers and db-isolation check**
- [ ] **Step 2: Create .github/workflows/staging-deployment.yml for automated staging validation, deployment, and certification**
- [ ] **Step 3: Validate workflow syntax and YAML structure**

### Task 3: Protected Production Release Gate Workflow
**Files:**
- Create: `.github/workflows/production-release-gate.yml`
- Create: `scripts/verify-production-release-readiness.ts`

- [ ] **Step 1: Create scripts/verify-production-release-readiness.ts**
- [ ] **Step 2: Create .github/workflows/production-release-gate.yml**
- [ ] **Step 3: Test production release readiness script locally in dry-run mode**

### Task 4: Centralized Staging Configuration & OAuth Documentation
**Files:**
- Create: `AIRA-OAUTH-STAGING-CONFIGURATION.md`
- Create: `AIRA-ENVIRONMENT-INVENTORY.md`
- Create: `AIRA-CICD-ARCHITECTURE.md`
- Create: `AIRA-PREVIEW-PIPELINE-CERTIFICATION.md`
- Create: `AIRA-PRODUCTION-PIPELINE-READINESS.md`
- Create: `AIRA-CICD-ROLLBACK-PLAN.md`

- [ ] **Step 1: Draft all architecture, environment, certification, and rollback deliverables**
- [ ] **Step 2: Verify all specifications, IDs, URLs, and branch mappings match repository reality**

### Task 5: Full Local Verification, Commit, Push & Draft PR
**Files:**
- All touched files

- [ ] **Step 1: Run typecheck, lint, test:secrets, test:release-auth:unit, test:db-isolation**
- [ ] **Step 2: Verify Commercial workspace and Production resources remain untouched**
- [ ] **Step 3: Commit changes with descriptive commit message**
- [ ] **Step 4: Push branch infra/aira-permanent-preview-production-cicd to origin**
- [ ] **Step 5: Open Draft Pull Request targeting prod-release**
- [ ] **Step 6: Monitor and report GitHub Actions execution on the PR**
