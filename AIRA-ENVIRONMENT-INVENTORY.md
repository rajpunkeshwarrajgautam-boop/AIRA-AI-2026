# AIRA AI 2026 — Comprehensive Environment Inventory

## 1. Overview & Scope Boundaries

This inventory establishes authoritative records of all cloud, database, source control, and domain resources across the AIRA AI 2026 ecosystem, distinguishing between active in-scope environments, protected commercial resources, and strictly excluded legacy projects.

---

## 2. In-Scope Environments & Infrastructure

### 2.1 GitHub Infrastructure
- **Repository**: `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`
- **Owner**: `rajpunkeshwarrajgautam-boop` (Verified sole maintainer)
- **Account Tier**: GitHub Pro (Active)
- **Primary Branches**:
  - `prod-release`: Protected production release branch (Tracked by Vercel for production)
  - `staging`: Permanent integration and staging branch
  - `main`: Historical development trunk
- **GitHub Ruleset**:
  - Ruleset ID: `25079946` (`AIRA Production Protection`)
  - Target: `refs/heads/prod-release`
  - Enforcement: `active`
  - Rules: Deletion denied, non-fast-forward (force push) denied, PR required (reviews: 0, thread resolution: required), strict status checks:
    1. `Fast CI` (GitHub Actions integration `15368`)
    2. `Semantic Search CI` (GitHub Actions integration `15368`)
    3. `Main / PR certification` (GitHub Actions integration `15368`)
- **GitHub Environments**:
  - `staging` (ID: `24887859309`): Restricted to branch `staging`
  - `release-gate` (ID: `24313216760`): Stores GitHub App release publisher credentials
  - `Production` (ID: `23404804030`): Production deployment tracking
  - `Preview` (ID: `23406179957`): Ephemeral preview tracking

### 2.2 Vercel Cloud Platform
- **Project Name**: `aira-ai-2026`
- **Project ID**: `prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`
- **Owner / Team**: `team_0IZkX9o2Ab319UsAPW9oq1SL` (rajpunkeshwarrajgautam-boop's projects)
- **Account Tier**: Hobby (Personal)
- **Framework**: Vite
- **Node.js Version**: 24.x
- **Build Command**: `if [ "$VERCEL_ENV" = "production" ] || [ "$VERCEL_GIT_COMMIT_REF" = "staging" ]; then npm run db:verify:deploy || exit 1; fi; npm run build`
- **Output Directory**: `dist`
- **Install Command**: `npm ci`
- **Production Branch**: `prod-release`
- **Production URL**: `https://aira-ai-2026.vercel.app`
- **Staging Preview Host**: `https://aira-ai-2026-git-staging-rajpunkeshwarrajgautam-boops-projects.vercel.app`
- **Preferred Staging Domain**: `staging.virexaaiventures.com`

### 2.3 Neon PostgreSQL Databases

#### Permanent Staging Database:
- **Project Name**: `aira-ai-2026-staging`
- **Project ID**: `mute-frost-50372225`
- **Region**: `aws-ap-southeast-1` (Singapore)
- **Primary Staging Branch**: `main`
- **Branch ID**: `br-autumn-star-b36dfu5w`
- **Endpoint ID**: `ep-shiny-bird-b3xundyt`
- **Direct Host**: `ep-shiny-bird-b3xundyt.c-4.ap-southeast-1.aws.neon.tech`
- **Pooled Host**: `ep-shiny-bird-b3xundyt-pooler.c-4.ap-southeast-1.aws.neon.tech`
- **State**: `ready` / `active`
- **Role**: Permanent Staging persistence

#### Production Database:
- **Project Name**: `aira-ai-2026-production`
- **Project ID**: `old-sky-50952395`
- **Region**: `aws-ap-southeast-1` (Singapore)
- **Primary Production Branch**: `main`
- **Branch ID**: `br-shiny-moon-b3vy9xj7`
- **Endpoint ID**: `ep-withered-art-b36ox90b`
- **Direct Host**: `ep-withered-art-b36ox90b.c-4.ap-southeast-1.aws.neon.tech`
- **Pooled Host**: `ep-withered-art-b36ox90b-pooler.c-4.ap-southeast-1.aws.neon.tech`
- **State**: `ready` / `idle` (auto-resumes on connection)
- **Role**: Live Production persistence

---

## 3. Concurrent Commercial Development (Protected & Preserved)

The Commercial platform workstream is active and must remain strictly isolated:
- **Local Workspace**: `C:\Users\WORKSTATION\AIRA-AI-2026-COMMERCIAL`
- **Branch**: `feat/aira-commercial-platform-v1`
- **Pull Request**: `#92` (Draft)
- **Neon Staging Branch**: `pr92-commercial-platform-isolated`
- **Branch ID**: `br-green-snow-b3dsci5u` (under staging project `mute-frost-50372225`)
- **Endpoint ID**: `ep-ancient-sound-b3drtnp5`
- **Direct Host**: `ep-ancient-sound-b3drtnp5.c-4.ap-southeast-1.aws.neon.tech`
- **Pooled Host**: `ep-ancient-sound-b3drtnp5-pooler.c-4.ap-southeast-1.aws.neon.tech`
- **Protection Policy**: Zero modification, zero branch switching, zero schema resets, zero cherry-picks from PR #92 into CI/CD.

---

## 4. Strictly Excluded Resources

The following legacy and production external properties are completely outside the scope of this implementation. No interaction, deployment, migration, inspection, or DNS change may target:

| Resource Name | Identifier / URL | Type | Status |
| :--- | :--- | :--- | :--- |
| `aira-ai.in` | `https://aira-ai.in` | Production Domain | **STRICTLY EXCLUDED** |
| `www.aira-ai.in` | `https://www.aira-ai.in` | Production Domain | **STRICTLY EXCLUDED** |
| `aira-ai-live.vercel.app` | `https://aira-ai-live.vercel.app` | Vercel Deployment | **STRICTLY EXCLUDED** |
| Vercel Project `aira-ai-live` | `prj_fXrnG5khmADI8znZfJZBylUsnvKU` | Vercel Project | **STRICTLY EXCLUDED** |
| Unrelated Vercel Projects | `virexa-bidiq`, `cinway`, `primusai`, etc. | Vercel Projects | **STRICTLY EXCLUDED** |
| Unrelated Neon Projects | `little-scene-18512036`, `mute-voice-99987807`, etc. | Neon Projects | **STRICTLY EXCLUDED** |

---

## 5. Domain & DNS Inventory

| Domain | Purpose | Registrar / DNS Provider | Target Routing | Required Action |
| :--- | :--- | :--- | :--- | :--- |
| `aira-ai-2026.vercel.app` | Production Live URL | Vercel | Vercel Project `aira-ai-2026` | Active & Verified |
| `virexaaiventures.com` | Root Organization Domain | Third Party (Active in Vercel Account) | DNS managed externally | Preserved |
| `staging.virexaaiventures.com` | Preferred Permanent Staging Domain | Under `virexaaiventures.com` | Vercel Project `aira-ai-2026` (branch: `staging`) | **Pending Owner DNS CNAME creation** |
| `aira-ai-2026-git-staging-*.vercel.app` | Fallback Staging URL | Vercel Automated Alias | Branch `staging` | Active on push |

---

## 6. Vercel Environment Variables Scope Audit

| Variable Key | Scope in Vercel | Sensitive | Purpose |
| :--- | :--- | :---: | :--- |
| `DATABASE_URL` | Production | Yes | Points to `old-sky-50952395` `br-shiny-moon-b3vy9xj7` |
| `DATABASE_URL` | Preview (`staging`) | Yes | Points to `mute-frost-50372225` `br-autumn-star-b36dfu5w` |
| `NVIDIA_API_KEY` | Production, Preview | Yes | Primary LLM inference (Nemotron / Llama Vision) |
| `EXA_API_KEY` | Production, Preview | Yes | Live search grounding |
| `TAVILY_API_KEY` | Production, Preview | Yes | Auxiliary search failover |
| `AIRA_SESSION_SECRET` | Production, Preview | Yes | First-party BFF cookie session HMAC signing |
| `ALLOWED_ORIGINS` | Production | No | CORS policy allowlist |
| `AIRA_EXTERNAL_AUTH_ENABLED` | Production | No | External auth flag |
| `NEON_AUTH_BASE_URL` | Production | Yes | Neon Managed Better Auth base URL |
| `NEON_AUTH_JWKS_URL` | Production | Yes | Neon Managed Better Auth EdDSA JWKS URL |
| `AIRA_BUILDER_ENABLED` | Production | Yes | Cloud Builder runtime feature flag |
| `AIRA_BUILDER_SIGNING_SECRET` | Production | Yes | Cloud Builder dispatch HMAC signing key |
| `AIRA_BUILDER_ALLOWED_USER_IDS`| Production | Yes | Builder authorized user ID allowlist |
