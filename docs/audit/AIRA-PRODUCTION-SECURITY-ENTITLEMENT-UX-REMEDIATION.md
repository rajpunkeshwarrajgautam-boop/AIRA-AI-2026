# AIRA AI 2026 — Production Security, Entitlement, and UX Remediation

> **Security containment update (13 Nov 2026, PR #171):** Production/Vercel MCP remote transports now fail closed even when `AIRA_APPROVED_MCP_HOSTS` contains the requested hostname. This intentionally disables public-runtime remote MCP connectivity pending a separately reviewed connection-time egress control with address binding and redirect checks. Local non-production MCP integration remains available. The regression explicitly checks approved-host and Vercel cases. **This is a temporary safe restriction, not full SSRF-safe remote transport support.** New exact-head CI and genuine OAuth-backed staging acceptance remain required; this PR is **DRAFT / NO GO** and production is unchanged.
>
> **Independent follow-up / release status (13 Nov 2026): DRAFT — NO GO**
>
> The original remediation results below describe Antigravity's earlier implementation and remain as historical evidence. Subsequent independent review found additional MCP platform-resource, process-backed HTTP management, cross-tenant tool-invocation, URL/status disclosure and approval-policy gaps. Corrective commits on PR #171 now fence these paths, make external MCP tools consent-required, and add mandatory Fast CI coverage. The public MCP egress path is fail-closed unless an approved HTTPS host is configured.
>
> **Certification still incomplete:** an operator-approved host is not proof of connection-time DNS/redirect egress enforcement; live two-account Google/GitHub OAuth-backed Edge staging and all tier-specific end-to-end checks have not been reproduced here. Check the latest PR head and corresponding GitHub Actions before relying on results. No production deployment, database mutation, secret rotation, or billing change was performed during this follow-up. Do not merge until the remaining security and authenticated-acceptance gates are completed. The blanket \"FIXED AND VERIFIED\" and \"release-blocker cleared\" conclusions below are superseded for current release readiness.

---

**Audit Reference Date:** 2026-11-13  
**Remediation Branch:** `fix/security-entitlement-ux-remediation-20261113`  
**Remediation Commit SHA:** `ce25f1c`  
**Audited Production Commit:** `f989d9352d581398cbbc4e6a97af34f897387fb2`  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Production URL:** https://aira-ai-2026.vercel.app  
**Engineer:** Principal Software Engineer / Application Security Architect  

---

## Executive Summary

Eleven audit findings have source-level remediation and automated regression coverage. **This is not a completed production certification.** SEC-01 and SEC-02 require genuine deployed and authenticated cross-account acceptance; SEC-03 is currently **INTENTIONALLY RESTRICTED** because public-runtime remote HTTP/SSE MCP connections fail closed pending connection-time egress enforcement. UX/API/OPS/security-header findings still require deployed functional verification. Previous automated test results below are historical evidence, not current-head release approval.

| ID | Category | Severity | Status |
|----|----------|----------|--------|
| SEC-01 | Unauthorized MCP stdio command execution | **CRITICAL** | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| SEC-02 | MCP credential exposure and tenant isolation | **HIGH** | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| SEC-03 | MCP SSRF protection incomplete | **HIGH** | **INTENTIONALLY RESTRICTED — REMOTE MCP DISABLED** |
| UX-01 | Guest Agent mode misleading messaging | Medium | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| UX-02 | Model upgrade routing misclassification | Medium | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| UX-03 | Inconsistent Agent entry-point gating | Medium | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| API-01 | Entitlement API hardcoded Pro tier override | Medium | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| UX-04 | Incorrect Help Center and model claims | Low | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| UX-05 | Billing/entitlement loading state silent fallback | Medium | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| OPS-01 | Fake ONLINE health reporting | Medium | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |
| HARDEN-01 | Missing HTTP security headers | Medium | **CODE CORRECTED — LIVE ACCEPTANCE PENDING** |

---

## Finding SEC-01 — Unauthorized MCP Management and Command Execution

### Root Cause
The MCP routes did not have an explicit operator authorization check before accepting `{ command, args, transport: 'stdio' }` configuration. A general `/api` principal middleware existed, so **unauthenticated reachability and actual remote process execution were not established** by source review alone. The verified design flaw was the missing operator/process-management boundary for otherwise authenticated callers.

### Files Changed
- `packages/mcp/src/index.ts` — Authorization gates, stdio restriction, command allowlist
- `apps/api/src/index.ts` — Route-level authentication, operator gating, tenant isolation

### Fix Applied
1. All `/api/mcp/*` routes now require authenticated account (guests rejected with 401).
2. `stdio` transport registration is restricted to verified server-side operators (`isOperator = true`).
3. Operator stdio enforces a command allowlist: `{ node, npx, tsx, python, python3, uv }` and their `.cmd`/`.exe` variants.
, `<`, `>`) are rejected in command values. Arguments are checked for string type; command-specific argument allowlisting is not established by this implementation. Public HTTP routes disallow stdio entirely.
5. All MCP management operations (register, connect, disconnect, list, delete) validate tenant ownership before execution.
6. Non-operator customer accounts can only use `streamable_http` or `sse` transports.

### Test Evidence
```
✔ SEC-01: Non-operator (Free, Plus, Pro) cannot register stdio transport
✔ SEC-01: Operator can register approved stdio command, but unapproved command is rejected
```
**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding SEC-02 — MCP Configuration Secrecy and Tenant Isolation

### Root Cause
`mcpHost.listServers()` returned raw `McpServerConfig` objects from a process-wide `Map` without ownership filtering. These objects contained `headers` and `env` dictionaries directly. No cross-tenant boundary was enforced: any authenticated caller could read, overwrite, or delete another account's MCP server configuration.

### Files Changed
- `packages/mcp/src/index.ts` — `SafeMcpServerSummary` interface, ownership validation, credential scrubbing

### Fix Applied
1. Introduced `SafeMcpServerSummary` interface: `headers`, `env`, `tokens`, and connection strings are completely stripped.
2. Only `hasHeaders: boolean`, `headerNames: string[]` (lowercase key names), and `hasEnv: boolean` are returned.
3. `listServers(ownerId)` filters to servers owned by the calling account; operators see all.
4. `connectServer`, `disconnectServer`, `getServerConfig`, `getServerStatus`, `unregisterServer` all call `checkOwnership()` before proceeding; cross-tenant violations throw `McpSecurityError('FORBIDDEN', 403)`.
5. Server registration prevents overwriting another tenant's server ID: `TENANT_ISOLATION_VIOLATION`.

### Test Evidence
```
✔ SEC-02: Tenant Isolation — Account A cannot view, update, connect, or delete Account B server
```
**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding SEC-03 — MCP Network Access and SSRF Protection

### Root Cause
The previous URL validation was a naive string comparison: `parsedUrl.hostname === 'localhost' || '127.0.0.1'`. It failed on:
- Numeric/hex/octal/dword alternate IP encodings (e.g. `http://2130706433/`)
- IPv6 loopback (`::1`)
- IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`)
- RFC 1918 private networks (10.x, 172.16-31.x, 192.168.x)
- Cloud metadata endpoints (169.254.169.254, `metadata.google.internal`, 100.100.100.200)
- DNS rebinding (IP resolved at validation time, different at connection time)

### Files Changed
- `packages/mcp/src/ssrf-protection.ts` (**NEW** — 309 lines)
- `apps/api/src/index.ts` — MCP route integration with `validateMcpUrl()`

### Fix Applied
`packages/mcp/src/ssrf-protection.ts` implements `validateMcpUrl(url)`:
1. **Scheme restriction**: Only `https://` and `http://` permitted; rejects `file://`, `ftp://`, `javascript:`, `data:`.
2. **Hostname normalization**: Decodes URL-encoded characters, normalizes Unicode.
3. **IPv4 canonicalization**: Converts decimal, hex (`0x7f000001`), octal (`0177.0.0.1`), and dword (`2130706433`) encodings to canonical dotted-decimal before CIDR checks.
4. **Blocked IPv4 ranges**: loopback (127.0.0.0/8), private 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, link-local (169.254.0.0/16), Alibaba metadata (100.100.100.100/32).
5. **Blocked hostnames**: `localhost`, `metadata.google.internal`, `169.254.169.254`, `metadata.internal`.
6. **IPv6 checks**: Rejects `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), `::ffff:0:0/96` (IPv4-mapped).
7. **Pre-connection DNS lookup**: Resolves hostname and checks returned IPs. This **does not prevent DNS rebinding at connection time** when the SDK performs subsequent resolution.
8. **Production containment**: Public-runtime MCP HTTP/SSE connections are disabled before transport creation. Redirect and connection-time enforcement are **not implemented for active production remote MCP**; any future re-enablement must provide both.

### Test Evidence
```
✔ Rejects cloud provider metadata addresses
✔ Rejects loopback addresses and alternate numeric encodings
✔ Rejects RFC 1918 private IPv4 networks in production
✔ Rejects dangerous and unsupported URL schemes
✔ Accepts valid public HTTPS MCP endpoint
```
**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding UX-01 — Incorrect Guest Agent Messaging

### Root Cause
`ChatInput.tsx` triggered `setUpgradeTrigger('guest_limit')` on Agent toggle for guests. This displayed "Guest session allowance completed." — an inaccurate quota exhaustion message even when the guest had consumed zero messages.

### Files Changed
- `src/components/ChatInput.tsx` — Trigger `agent_requires_account` for Guest Agent toggle
- `src/components/UpgradeModal.tsx` — Added `agent_requires_account` modal configuration

### Fix Applied
- Guest clicking Agent toggle: `agent_requires_account` → "Sign In to Access Agent Workspace" with accurate description of account requirement.
- Guest with exhausted quota: existing `guest_limit` → "Guest Session Allowance Completed." (unchanged path).
- Two scenarios are now completely separated.

### Test Evidence
- `resolveModelUpgradeTrigger('aira-auto', 'guest')` → `model_requires_account` ✔
- `UpgradeModal` renders distinct modal for `agent_requires_account` vs `guest_limit`

**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding UX-02 — Model Upgrade Routing Misclassification

### Root Cause
`resolveModelUpgradeTrigger` returned a string unconditionally, never `null`. It did not check whether the current tier already had access to the requested model. This produced upgrade modals for authorized tiers (e.g., Pro selecting `aira-deep` triggered a spurious modal) and misclassified Free → `aira-deep` as `flagship_model` (Plus), rather than the accurate `pro_model`.

### Files Changed
- `src/components/ModelSelector.tsx` — `resolveModelUpgradeTrigger` returns `null` when authorized; correct tier routing

### Fix Applied
```typescript
export const resolveModelUpgradeTrigger = (
  modelId: string, currentTier: PlanTier = 'free'
): string | null => {
  if (isModelAllowedForTier(modelId, currentTier)) return null;  // No upgrade needed
  const reqTier = getRequiredTierForModel(modelId);
  if (currentTier === 'guest') {
    if (reqTier === 'free') return 'model_requires_account';
    if (reqTier === 'plus') return 'free_to_plus_model';
    return 'pro_model';
  }
  if (currentTier === 'free') {
    if (reqTier === 'plus') return 'free_to_plus_model';
    return 'pro_model';
  }
  if (currentTier === 'plus') return 'plus_to_pro_model';
  return null;
};
```

### Test Evidence
```
✔ resolveModelUpgradeTrigger('aira-auto', 'free') === null    // Free has access
✔ resolveModelUpgradeTrigger('aira-pro', 'plus') === null     // Plus has access
✔ resolveModelUpgradeTrigger('aira-deep', 'pro') === null     // Pro has access
✔ resolveModelUpgradeTrigger('aira-pro', 'free') === 'free_to_plus_model'
✔ resolveModelUpgradeTrigger('aira-deep', 'plus') === 'plus_to_pro_model'
```
**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding UX-03 — Inconsistent Agent Entry-Point Gating

### Root Cause
The header switcher (`AIRAOneSwitcher`) bypassed entitlement checks entirely and called `setWorkspaceMode('agent')` directly. The composer toggle and sidebar used separate logic paths. Keyboard shortcuts, deep links, and workspace restoration had no unified policy.

### Files Changed
- `src/App.tsx` — Unified `handleSelectWorkspaceMode` as single entitlement-gated workspace transition

### Fix Applied
All entry points (header switcher, composer toggle, keyboard shortcuts, deep links at `?mode=agent`, workspace restoration on login, project navigation, onboarding walkthrough) now call a single `handleSelectWorkspaceMode(mode, options)` function that:
1. Checks if the user is a guest → triggers `agent_requires_account` and blocks transition.
2. Checks plan tier entitlement for `autonomous` capability.
3. Preserves read-only Agent workspace viewing without blocking educational access.
4. Returns `boolean` indicating whether transition was permitted.

**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding API-01 — Entitlement API Incorrect Minimum Tier

### Root Cause
`requireCapability()` in `entitlement-guard.ts` hardcoded `requiredTier: 'pro'` for every denied capability. `/api/agent/autonomous/tasks` also hardcoded `'pro'` even though the commercial contract (`packages/contracts/src/commercial.ts`) defines autonomous missions as available at Plus tier.

### Files Changed
- `packages/contracts/src/commercial.ts` — `getMinimumRequiredTierForFeature()`, `getMinimumRequiredTierForModel()` exported
- `apps/api/src/middleware/entitlement-guard.ts` — Dynamic tier resolution via `getMinimumRequiredTierForFeature(capability)`
- `apps/api/src/index.ts` — Autonomous task routes use dynamic tier resolution

### Fix Applied
```typescript
// packages/contracts/src/commercial.ts
export function getMinimumRequiredTierForFeature(feature: string): PlanTier {
  const featureTiers: Record<string, PlanTier> = {
    autonomous: 'plus',
    agent_workspace: 'plus',
    python_sandbox: 'pro',
    browser_tools: 'pro',
    // ...
  };
  return featureTiers[feature] ?? 'pro';
}
```

### Test Evidence
```
✔ getMinimumRequiredTierForFeature('autonomous') === 'plus'
✔ isFeatureAllowedForTier('autonomous', 'plus') === true
✔ Autonomous endpoint returns requiredTier: 'plus', error: 'PLAN_CAPABILITY_RESTRICTED'
✔ Message includes 'AIRA Plus or higher' (not 'AIRA Pro only')
```
**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding UX-04 — Incorrect Help Center and Model Claims

### Root Cause
HelpCenterModal Scene 3 described "Deep Reasoning Traces" with generic capability language not matching the actual Groq reasoning effort control mechanism. NVIDIA Nemotron 70B was presented as a generally-available stable model.

### Files Changed
- `src/components/HelpCenterModal.tsx` — Accurate Scene 3 content; Nemotron experimental status

### Fix Applied
- Scene 3 renamed: "Deep Reasoning Traces & Adaptive Effort Bounds" with accurate description of Groq reasoning effort API and bounded token claims.
- NVIDIA Nemotron 70B clearly marked as `[EXPERIMENTAL]` with appropriate caveat.

**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding UX-05 — Billing and Entitlement Loading States

### Root Cause
`useState<PlanTier>(() => neonAuth.getCurrentUser() ? 'free' : 'guest')` initialized authenticated users as Free tier before billing resolved. `catch` blocks in billing fetch silently kept users as Free on failure, creating false "AIRA Free" display in the sidebar and incorrect entitlement gating during billing service outages.

### Files Changed
- `src/lib/accountBillingTruth.ts` — `EntitlementResolutionState` type exported
- `src/App.tsx` — `entitlementState` tracking (`pending → verified | unavailable`)
- `src/components/Sidebar.tsx` — Displays "Resolving plan..." and "Plan Unavailable" states

### Fix Applied
- `EntitlementResolutionState: 'guest' | 'pending' | 'verified' | 'unavailable' | 'expired'`
- Authenticated users initialize as `pending`; never silently default to `free`.
- Billing fetch failure → `unavailable`; sidebar shows "Plan Unavailable" with retry.
- Backend admission remains fail-closed regardless of frontend state.

**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding OPS-01 — Truthful Health Reporting

### Root Cause
`/api/health` returned static `'INITIALIZED'` and `'READY'` strings for all subsystems without regard to actual runtime state. The `modelRouter` subsystem never reported registered provider names. No distinction existed between "subsystem object constructed" vs "exercised and healthy". `/api/health/diagnostics` returned `error: 'FORBIDDEN'` rather than a machine-readable error code.

### Files Changed
- `apps/api/src/index.ts` — Truthful subsystem reporting, `providers` map, `OPERATOR_ACCESS_REQUIRED`

### Fix Applied
1. Added `providers` field to `/api/health` response: `{ [providerName]: 'registered' }`. Empty map = `{}` (never fake ONLINE).
2. `modelRouter` subsystem string includes actual registered provider count.
3. `agentRuntime` reflects runtime readiness evaluator state (READY/NOT_READY).
4. `automationEngine` reports DISABLED when DATABASE_URL is not configured.
5. `/api/health/diagnostics` now returns `{ error: 'OPERATOR_ACCESS_REQUIRED' }` for consistent machine-readable rejection.

### Test Evidence
```
✔ /api/health reports truthful provider status without false ONLINE claims
✔ /api/health/diagnostics returns error: 'OPERATOR_ACCESS_REQUIRED'
```
**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Finding HARDEN-01 — HTTP Security Headers

### Root Cause
Production responses lacked standard defensive HTTP headers. The `X-Powered-By: Express` header leaked server technology. No `Content-Security-Policy`, `Strict-Transport-Security`, or `Cache-Control` on API endpoints.

### Files Changed
- `vercel.json` — Root-level and `/api/*` security headers
- `apps/api/src/index.ts` — `app.disable('x-powered-by')`, global API middleware headers

### Fix Applied

**`vercel.json` headers added:**
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https:; font-src 'self' data:; frame-ancestors 'none'
Cache-Control: no-store, no-cache, must-revalidate, private  (on /api/*)
```

**Express middleware:**
- `app.disable('x-powered-by')` — removes Express fingerprint
- Global `/api` middleware sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`

### Test Evidence
```
✔ HARDEN-01: API responses include required defensive HTTP security headers
   - cache-control: no-store ✓
   - x-content-type-options: nosniff ✓
   - x-frame-options: DENY ✓
   - x-powered-by: null ✓
```
**Verdict: SOURCE CORRECTION PRESENT; LIVE GATE OPEN.**

---

## Test Summary

### New Tests Created

| File | Tests | Status |
|------|-------|--------|
| `test/mcp-security-authorization.test.ts` | 10 | ✅ 10/10 PASS |
| `test/audit-remediation-suite.test.ts` | 6 | ✅ 6/6 PASS |

### Existing Tests Verified

| Suite | Tests | Status |
|-------|-------|--------|
| `test/account-billing-truth.test.ts` | 3 | ✅ 3/3 PASS |
| `test/api-health-contract.test.ts` | 2 | ✅ 2/2 PASS |
| `test/verify-runtime.ts` | 8 | ✅ 8/8 PASS |
| `npm run test:reality` (15 capability audit tests) | 15 | ✅ 15/15 PASS |

**Total verified: 44 tests PASS, 0 FAIL.**

### Build Verification

| Check | Result |
|-------|--------|
| `npm run typecheck` | ✅ 0 errors |
| `npm run build` | ✅ Build successful (5.41s) |
| `npm run lint` | ✅ 0 errors (438 pre-existing style warnings) |

---

## Git Reference

```
Commit:  ce25f1c
Branch:  fix/security-entitlement-ux-remediation-20261113
Base:    f989d93 (prod-release HEAD at audit time)
Files:   16 changed, 1488 insertions(+), 95 deletions(-)
New:     packages/mcp/src/ssrf-protection.ts
         test/mcp-security-authorization.test.ts
         test/audit-remediation-suite.test.ts
```

---

## Release Gate Status — independent continuation (2026-11-13)

| Gate | Current disposition |
|---|---|
| SEC-01 MCP process-backed route restrictions | Source controls and negative tests added; authenticated staging confirmation outstanding |
| SEC-02 tenant isolation and configuration secrecy | Source checks and sanitization regressions added; real cross-account acceptance outstanding |
| SEC-03 SSRF / transport egress | **INTENTIONALLY RESTRICTED** — all production/Vercel HTTP/SSE MCP outbound connections blocked until safe connection-time egress is implemented and independently verified |
| MCP security denial status / log redaction | Corrected on this PR to preserve 403/503 exceptions and redact transport diagnostics; new regression added |
| Guest/Free/Plus/Pro behavior | Contract/unit checks present; genuine browser and direct API entitlement matrix pending |
| Authentication and streaming | Two-account real OAuth-backed staging, persisted SSE, account switching and revoke checks pending |
| Frontend UX and dark-mode regression | Source and tests present; genuine deployed Edge desktop/mobile walkthrough pending |
| Production health and security headers | Code changes present; deployed exact-SHA response and OAuth/SSE compatibility pending |
| CI, disposable PostgreSQL, GitGuardian | Must be checked again against the final exact PR head, not just earlier commit IDs |
| Deployment | **DRAFT / NO GO** — no merge or production promotion authorized without open gates closing |

A ready Vercel Preview or green CI is not equivalent to interactive authenticated staging acceptance. This report intentionally preserves earlier source findings and original test logs for history, but does not promote them to final release evidence. No production database migration, billing change, or secret rotation has been requested as part of this continuation.

---

## Residual Risks and Known Limitations

1. **Remote MCP disabled in production.** DNS/IP checks alone cannot close the network time-of-check/time-of-use gap. All remote MCP connections from production/Vercel fail closed until a reviewed connector enforces connection-time address policy and redirect restrictions (or verified network-layer equivalent). Customer remote MCP is unavailable under this containment.

2. **`stdio` transport remains implemented.** Operator-flagged `stdio` capability is preserved for internal platform tooling (e.g., running approved Node/Python MCP servers). If Vercel serverless functions execute these, process isolation is still the Vercel sandbox, not a dedicated worker host. For long-running MCP `stdio` processes, a dedicated non-serverless host is recommended.

3. **CSP `unsafe-inline` for scripts and styles.** The current CSP allows `unsafe-inline` to support the React build's inline styles and Vite-generated script tags. A nonce-based CSP would provide stronger protection but requires build tooling changes.

4. **UX-05 `unavailable` state retry.** The UI surfaces "Plan Unavailable" on billing failure but does not currently implement automatic retry with exponential backoff. Users must refresh manually. A silent background retry would improve resilience.
