# AIRA GenUI Phase 4A — MCP Apps Engineering Certification

**Document Status:** Certified Technical Engineering Record  
**Target Architecture:** AIRA AI 2026 Model Context Protocol Apps (`aira-mcp-app/v1`)  
**Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Worktree:** `C:\Users\WORKSTATION\AIRA-AI-2026-GENUI`  
**Branch:** `feat/aira-genui-phase1-foundation`  
**Certification Date:** 2026-11-27  
**Commercial Release Candidate:** PR #215 (`fd2f8b9a3df8bd226a1bf05c1c79aab721e0e568` on STRICT HOLD)  
**Protected Production Reference:** `f429d90a1f4322a0d362956fb9e55a38cb3b5508`  

---

## 1. Executive Verdict

### **Verdict: PHASE_4A_MCP_APPS_LOCAL_ONLY_REMOTE_DISABLED**

AIRA GenUI Phase 4A establishes a production-grade, secure container for interactive Model Context Protocol Extension Applications (`aira-mcp-app/v1`). 

Key Certified Findings:
1. **Contract & Schema Complete:** `aira-mcp-app/v1` descriptor schema, capability profile, and JSON-RPC 2.0 message contracts are codified in `packages/contracts/src/mcp-apps.ts` and exported in the unified contracts package.
2. **Local MCP Apps Verified:** Local MCP server fixtures, descriptor validation, and tool execution pass 100% of acceptance criteria (`test/mcp-apps-local-acceptance.test.ts` - 14/14 tests pass).
3. **Tool Execution Approval Gating:** All tool invocations from sandboxed MCP App frames route through `GenUIMcpApp.tsx`, which validates declared `supportedTools` and mandates explicit user approval before executing side-effecting operations.
4. **Physical UI Frame Network Egress Blockade:** MCP App UI frames execute inside opaque sandboxed iframes (`sandbox="allow-scripts allow-forms"`, `window.origin === 'null'`) with CSP `connect-src 'none'`. Direct network calls (`fetch`, `XHR`, `WebSocket`, `EventSource`) are physically blocked.
5. **Fail-Closed Remote MCP Policy:** In production environments (`NODE_ENV === 'production'`), remote HTTP/SSE MCP destinations are strictly blocked fail-closed with `MCP_EGRESS_ENFORCEMENT_REQUIRED` (HTTP 503) via `assertApprovedPublicMcpDestination()`. Remote MCP remains disabled until connection-time IP pinning and kernel egress controls are established.
6. **Commercial Safety Guarantee:** PR #215, commercial billing, GST invoicing, and production database schemas remain 100% untouched.

---

## 2. Specification & Implementation Evidence

### A. Contract Definition (`packages/contracts/src/mcp-apps.ts`)
- **Version:** `AIRA_MCP_APP_CONTRACT_VERSION = 'aira-mcp-app/v1'`
- **Limits:** Max entrypoint 512KB, max state 64KB, max supported tools 32, height bounded 200–1600px.
- **Validation:** `validateMcpAppDescriptor(raw)` verifies descriptor fields, schemaVersion, tool lists, and JSON boundaries.
- **JSON-RPC Schema:** `McpAppRpcMessageSchema` strictly validates `2.0` protocol messages: `tools/call`, `tools/result`, `ui/ready`, `ui/resize`, `ui/stateUpdate`, `ui/error`.

### B. Host Bridge Container (`src/components/genui/GenUIMcpApp.tsx`)
- Embeds entrypoint HTML within an opaque-origin iframe (`sandbox="allow-scripts allow-forms"`).
- Injects `window.airaMcpBridge` runtime exposing `callTool(toolName, args)`, `getState()`, `setState(patch)`, and `resize(heightPx)`.
- Implements interactive **Tool Approval Modal** for side-effecting tools before dispatching `tools/call` to `ToolGateway`.
- Rejects undeclared tools not listed in `supportedTools`.

### C. Automated Test Coverage (`test/mcp-apps-local-acceptance.test.ts`)
```
▶ Phase 4A — MCP Apps Local Acceptance & Security Suite
  ▶ 1. aira-mcp-app/v1 Descriptor Contract Validation
    ✔ validates compliant local MCP app descriptor
    ✔ rejects descriptor with invalid schemaVersion
    ✔ rejects descriptor with missing entrypointHtml
    ✔ rejects descriptor exceeding supportedTools limit
  ▶ 2. JSON-RPC 2.0 Message Schema Validation
    ✔ validates tools/call JSON-RPC message
    ✔ validates ui/resize JSON-RPC message
    ✔ rejects message missing jsonrpc 2.0 version specifier
    ✔ rejects message with invalid RPC method
  ▶ 3. Tool Authorization & Side-Effect Confirmation Gating
    ✔ authorizes execution when tool is declared in supportedTools
    ✔ denies tool invocation when tool is NOT declared in supportedTools
    ✔ differentiates read-only tools from side-effecting mutation tools
    ✔ enforces caller ownership on MCP server configuration
  ▶ 4. Fail-Closed Remote MCP Egress Enforcement
    ✔ throws MCP_EGRESS_ENFORCEMENT_REQUIRED in production environments
  ▶ 5. Headless Browser Iframe Mount & CSP Containment (Playwright)
    ✔ mounts MCP App entrypoint and enforces connect-src none blockade
✔ 14 passed (100%), 0 failed
```

---

## 3. Remote MCP Security & Threat Model

### The Remote MCP SSRF Hazard
Remote MCP endpoints using HTTP/SSE transports present severe security risks if connected naively:
1. **DNS Rebinding & TOCTOU:** An attacker-controlled domain can resolve to a public IP during pre-flight checks, and then resolve to an internal cloud metadata address (`169.254.169.254`) or VPC endpoint during the actual HTTP fetch.
2. **HTTP Redirect Exploitation:** Upstream MCP servers can issue HTTP 301/302 redirects targeting private infrastructure.
3. **Credential Exfiltration:** Stdio child processes can inadvertently inherit host environment secrets (database connection strings, Stripe keys, JWT secrets).

### AIRA Containment Invariants
- **Local MCP Apps Only:** Phase 4A enables local stdio processes (operators only) and non-production localhost fixtures.
- **Fail-Closed Gate:** `assertApprovedPublicMcpDestination()` throws `MCP_EGRESS_ENFORCEMENT_REQUIRED` on any remote HTTP/SSE connection attempt in production.
- **Environment Sanitization:** `sanitizeStdioEnv()` strips all database, token, secret, auth, and credential variables from child process environments.

---

## 4. Phase 4A Gate Matrix

| Verification Gate | Requirement | Evidence | Verdict |
| :--- | :--- | :--- | :--- |
| **Gate 1: Contract** | `aira-mcp-app/v1` schema and RPC validation | `packages/contracts/src/mcp-apps.ts` | **PASS** |
| **Gate 2: Container** | Opaque sandboxed iframe + CSP `connect-src 'none'` | `src/components/genui/GenUIMcpApp.tsx` | **PASS** |
| **Gate 3: Approval** | ApprovalKernel & ToolGateway confirmation | Unit & Playwright acceptance tests | **PASS** |
| **Gate 4: Egress** | Physical network blockade in UI frame | Playwright fetch attempt blocked | **PASS** |
| **Gate 5: Remote Guard** | Remote MCP disabled fail-closed (503) | `assertApprovedPublicMcpDestination` check | **PASS** |
| **Gate 6: Commercial** | Zero mutation to PR #215 commercial baseline | Clean git status across billing/invoicing | **PASS** |

**Final Phase 4A Determination: PHASE_4A_MCP_APPS_LOCAL_ONLY_REMOTE_DISABLED**
