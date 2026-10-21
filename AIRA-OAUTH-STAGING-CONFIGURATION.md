# AIRA AI 2026 — Centralized Staging & OAuth Configuration Guide

## 1. Overview & Strategy

This specification details the permanent staging configuration for AIRA AI 2026. It establishes a fixed-branch staging environment that follows the `staging` git branch, bound to the preferred domain `staging.virexaaiventures.com` (fallback: `https://aira-ai-2026-git-staging-rajpunkeshwarrajgautam-boops-projects.vercel.app`), connected to Neon Staging project `mute-frost-50372225` (`br-autumn-star-b36dfu5w`).

This eliminates the need for developers to provision new OAuth apps, Neon branches, or Vercel projects for each feature.

---

## 2. Centralized Staging Environment Variable Architecture

The following variables are configured under Vercel Project `aira-ai-2026` (`prj_FZLU4vBIYSsBn28AI6drkpD5WfbH`), scoped to **Preview** with Git branch target **`staging`**:

| Variable Key | Scope / Target | Sensitive | Example Pattern / Target Specification |
| :--- | :--- | :---: | :--- |
| `DATABASE_URL` | Preview (`staging`) | **Yes** | `postgresql://neondb_owner@ep-shiny-bird-b3xundyt-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` |
| `AIRA_SESSION_SECRET` | Preview (`staging`) | **Yes** | 256-bit cryptographically random hex string for staging cookie signing |
| `ALLOWED_ORIGINS` | Preview (`staging`) | No | `https://staging.virexaaiventures.com,https://aira-ai-2026-git-staging-rajpunkeshwarrajgautam-boops-projects.vercel.app` |
| `NVIDIA_API_KEY` | Preview (`staging`) | **Yes** | Shared non-production or preview NVIDIA NIM inference token |
| `EXA_API_KEY` | Preview (`staging`) | **Yes** | Grounded research search API key |
| `TAVILY_API_KEY` | Preview (`staging`) | **Yes** | Auxiliary search failover API key |
| `AIRA_EXTERNAL_AUTH_ENABLED`| Preview (`staging`) | No | `true` |
| `NEON_AUTH_BASE_URL` | Preview (`staging`) | **Yes** | `https://ep-shiny-bird-b3xundyt.neonauth.c-4.ap-southeast-1.aws.neon.tech` |
| `NEON_AUTH_JWKS_URL` | Preview (`staging`) | **Yes** | `https://ep-shiny-bird-b3xundyt.neonauth.c-4.ap-southeast-1.aws.neon.tech/.well-known/jwks.json` |
| `VITE_NEON_AUTH_URL` | Preview (`staging`) | **Yes** | `https://ep-shiny-bird-b3xundyt.neonauth.c-4.ap-southeast-1.aws.neon.tech` |
| `AIRA_BUILDER_ENABLED` | Preview (`staging`) | No | `true` |
| `AIRA_BUILDER_SIGNING_SECRET`| Preview (`staging`)| **Yes** | Staging builder dispatch HMAC signing key |
| `AIRA_BUILDER_ALLOWED_USER_IDS`| Preview (`staging`)| No | Staging test user identifiers |

> [!CAUTION]
> **Strict Isolation Rule**: Never copy Production `DATABASE_URL` (`old-sky-50952395`) or live production signing keys into Preview or Staging variables. Any detection triggers immediate `ENVIRONMENT_CROSSOVER_VIOLATION`.

---

## 3. Direct Google & GitHub OAuth Configuration for Staging

The Commercial workstream (`feat/aira-commercial-platform-v1`, PR #92) is migrating to direct Google and GitHub OAuth providers. The permanent staging pipeline is prepared to support:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
```

### 3.1 Google OAuth Application Settings
1. In [Google Cloud Console — APIs & Services — Credentials](https://console.cloud.google.com/apis/credentials):
   - Application Name: `AIRA AI 2026 (Staging)`
   - Authorized JavaScript origins:
     - `https://staging.virexaaiventures.com`
     - `https://aira-ai-2026-git-staging-rajpunkeshwarrajgautam-boops-projects.vercel.app`
   - **Authorized redirect URIs**:
     - `https://ep-shiny-bird-b3xundyt.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/callback/google`
     - `https://staging.virexaaiventures.com/api/auth/callback/google`

### 3.2 GitHub OAuth Application Settings
1. In [GitHub Developer Settings — OAuth Apps](https://github.com/settings/developers):
   - Application Name: `AIRA AI 2026 Staging`
   - Homepage URL: `https://staging.virexaaiventures.com`
   - **Authorization callback URL**:
     - `https://ep-shiny-bird-b3xundyt.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/callback/github`
     - `https://staging.virexaaiventures.com/api/auth/callback/github`

### 3.3 Adding Providers to Neon Staging Database
Execute using Neon CLI against the permanent staging project:
```bash
# Add Google OAuth to Staging Neon Auth:
npx neonctl neon-auth oauth-provider add \
  --project-id mute-frost-50372225 \
  --branch main \
  --provider-id google \
  --oauth-client-id "<GOOGLE_CLIENT_ID>" \
  --oauth-client-secret "<GOOGLE_CLIENT_SECRET>"

# Add GitHub OAuth to Staging Neon Auth:
npx neonctl neon-auth oauth-provider add \
  --project-id mute-frost-50372225 \
  --branch main \
  --provider-id github \
  --oauth-client-id "<GITHUB_CLIENT_ID>" \
  --oauth-client-secret "<GITHUB_CLIENT_SECRET>"
```

---

## 4. Custom Domain & DNS Configuration (`staging.virexaaiventures.com`)

### 4.1 Domain Verification Status
- **Root Domain**: `virexaaiventures.com`
- **Account Verification**: Confirmed registered and active in account `rajpunkeshwarrajgautam-boop`.
- **Target Hostname**: `staging.virexaaiventures.com`
- **DNS Audit**: `Resolve-DnsName staging.virexaaiventures.com` returns no conflicting records (clean).

### 4.2 Required DNS Record Setup (Pending Owner Execution)
To finalize live SSL and routing for `staging.virexaaiventures.com`:
1. In the DNS control panel for `virexaaiventures.com`, add a CNAME record:
   - **Type**: `CNAME`
   - **Host / Name**: `staging`
   - **Target / Value**: `cname.vercel-dns.com.`
   - **TTL**: `3600` (or Automatic)

2. In Vercel Project `aira-ai-2026`:
   - Navigate to **Settings** → **Domains**.
   - Add `staging.virexaaiventures.com`.
   - Under **Git Branch**, configure: `staging`.
   - Vercel automatically associates the domain with all deployments from branch `staging`.

> [!NOTE]
> Until the DNS CNAME is created by the owner, the staging pipeline automatically uses the permanent Vercel branch preview URL:
> `https://aira-ai-2026-git-staging-rajpunkeshwarrajgautam-boops-projects.vercel.app`
