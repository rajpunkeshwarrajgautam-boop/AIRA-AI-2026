# PR #92 — Owner Action & External Integration Checklist

**Repository**: `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Target Environment**: Staging & Production  
**Branch**: `feat/aira-commercial-platform-v1` (PR #92)  

This checklist details every external console, credential, and environment variable configuration required by repository owner `rajpunkeshwarrajgautam-boop` to move from **PARTIALLY CERTIFIED — OWNER CONFIGURATION REQUIRED** to **FULL PRODUCTION CERTIFICATION**.

---

## 1. Google OAuth Provider Setup (Google Cloud Console)

Neon Auth currently uses Neon's shared development OAuth app on staging. For production, a branded OAuth client is required.

### Steps:
1. Navigate to [Google Cloud Console — APIs & Services — Credentials](https://console.cloud.google.com/apis/credentials).
2. Configure **OAuth consent screen**:
   - User Type: **External**
   - App Name: `AIRA AI 2026`
   - User Support Email: Owner email
   - Authorized Domains: `vercel.app`, `neon.tech`
3. Click **Create Credentials** -> **OAuth client ID**:
   - Application type: **Web application**
   - Name: `AIRA Production Client`
   - **Authorized JavaScript origins**:
     - `https://aira-ai-2026.vercel.app`
     - `https://aira-ai-2026-git-f-093ec5-rajpunkeshwarrajgautam-boops-projects.vercel.app`
     - `http://localhost:5173`
   - **Authorized redirect URIs**:
     - Production: `https://<prod-neonauth-domain>/neondb/auth/callback/google`
     - Staging: `https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/callback/google`
4. Copy `Client ID` and `Client Secret`.
5. Configure in Neon Auth:
   ```bash
   npx neonctl neon-auth oauth-provider add \
     --project-id mute-frost-50372225 \
     --branch pr92-commercial-platform-isolated \
     --provider-id google \
     --oauth-client-id "<GOOGLE_CLIENT_ID>" \
     --oauth-client-secret "<GOOGLE_CLIENT_SECRET>"
   ```

---

## 2. GitHub OAuth App Setup (GitHub Developer Settings)

GitHub does not support shared OAuth on Neon and requires explicit credentials.

### Steps:
1. Navigate to [GitHub Developer Settings — OAuth Apps](https://github.com/settings/developers).
2. Click **New OAuth App**:
   - Application name: `AIRA AI 2026`
   - Homepage URL: `https://aira-ai-2026.vercel.app`
   - Application description: `AIRA AI Multi-Model Intelligence Workspace`
   - **Authorization callback URL**:
     - Production: `https://<prod-neonauth-domain>/neondb/auth/callback/github`
     - Staging: `https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/callback/github`
3. Click **Register application**.
4. Generate a new **Client Secret**.
5. Copy `Client ID` and `Client Secret`.
6. Configure in Neon Auth:
   ```bash
   npx neonctl neon-auth oauth-provider add \
     --project-id mute-frost-50372225 \
     --branch pr92-commercial-platform-isolated \
     --provider-id github \
     --oauth-client-id "<GITHUB_CLIENT_ID>" \
     --oauth-client-secret "<GITHUB_CLIENT_SECRET>"
   ```

---

## 3. Multimodal Image Generation & Inpainting (FLUX Engine)

AIRA Vision currently uses live NVIDIA NIM Llama 3.2 Vision for visual understanding, and the fallback SVG canvas synthesizer for image generation. To enable photorealistic FLUX rendering:

### Option A: Replicate
1. Sign up / log in to [Replicate](https://replicate.com).
2. Create an API token with read/write model access.
3. Add to Vercel Environment Variables:
   - Name: `REPLICATE_API_TOKEN`
   - Value: `r8_...`
   - Scope: Production, Preview

### Option B: Fal.ai
1. Sign up / log in to [Fal.ai](https://fal.ai).
2. Create a Server Key.
3. Add to Vercel Environment Variables:
   - Name: `FAL_KEY`
   - Value: `key_...`
   - Scope: Production, Preview

---

## 4. Builder Remote MicroVM Sandbox Execution

The Builder runtime securely validates all signed tickets and seccomp constraints. To connect remote firecracker microVMs:

### Steps:
1. Sign up / log in to [E2B.dev](https://e2b.dev).
2. Generate an API Key under Account Settings.
3. Add to Vercel Environment Variables:
   - Name: `E2B_API_KEY`
   - Value: `e2b_...`
   - Scope: Production, Preview

*(Alternative: `LIGHTNING_API_KEY` and `LIGHTNING_USER_ID` from Lightning.ai)*

---

## 5. Payment Gateways (When Authorized for Commercial Billing)

Payment gateway activation is currently **DEFERRED** per non-payment staging scope. When ready to activate live charges:

### Razorpay:
- Register on [Razorpay Dashboard](https://dashboard.razorpay.com).
- Webhook URL: `https://aira-ai-2026.vercel.app/api/billing/webhooks/razorpay`
- Webhook Secret: Set `RAZORPAY_WEBHOOK_SECRET` in Vercel.
- API Keys: Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.

### Cashfree:
- Register on [Cashfree Merchant Portal](https://merchant.cashfree.com).
- Webhook URL: `https://aira-ai-2026.vercel.app/api/billing/webhooks/cashfree`
- Webhook Secret: Set `CASHFREE_WEBHOOK_SECRET` in Vercel.
- API Keys: Set `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY`.

---

## 6. Summary Environment Variable Reference Table

| Variable Name | Purpose | Current Staging Status | Action Required |
| :--- | :--- | :---: | :--- |
| `DATABASE_URL` | Neon PostgreSQL pooled connection | **ACTIVE** | None (Set to isolated staging branch) |
| `NEON_AUTH_BASE_URL` | Neon Auth service endpoint | **ACTIVE** | None |
| `NEON_AUTH_JWKS_URL` | Neon Auth EdDSA JWKS endpoint | **ACTIVE** | None |
| `VITE_NEON_AUTH_URL` | Frontend Neon Auth endpoint | **ACTIVE** | None |
| `AIRA_SESSION_SECRET` | Cookie & Ticket HMAC signing secret | **ACTIVE** | None |
| `AIRA_EXTERNAL_AUTH_ENABLED` | Feature flag for external Neon Auth | **ACTIVE** (`true`) | None |
| `NVIDIA_API_KEY` | Vision Understand & Chat inference | **ACTIVE** | None |
| `GOOGLE_CLIENT_ID` | Custom Google OAuth App | Shared Dev Active | Supply custom app for production branding |
| `GITHUB_CLIENT_ID` | Custom GitHub OAuth App | Unconfigured | **REQUIRED** for GitHub sign-in |
| `REPLICATE_API_TOKEN` | FLUX.1 image synthesis | Unconfigured | Optional for photorealistic rendering |
| `E2B_API_KEY` | Remote Firecracker microVMs | Unconfigured | Optional for live cloud code execution |
| `RAZORPAY_KEY_ID` | Live payment processing | Deferred | Deferred per non-payment scope |
| `CASHFREE_APP_ID` | Live payment processing | Deferred | Deferred per non-payment scope |
