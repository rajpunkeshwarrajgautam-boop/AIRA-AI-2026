# AIRA GenUI Phase 4A — MCP Apps Implementation Specification

**Document Status:** Approved Engineering Contract  
**Protocol Version:** `aira-mcp-app/v1`  
**Upstream Reference:** Model Context Protocol Extension Apps (`modelcontextprotocol/ext-apps`)  
**Target Repository:** `rajpunkeshwarrajgautam-boop/AIRA-AI-2026`  
**Implementation Branch:** `feat/aira-genui-phase1-foundation`  
**Author:** Software Architect & Application Security Engineer  
**Date:** 2026-11-27  

---

## 1. Executive Summary & Architectural Overview

Phase 4A introduces declarative and interactive **MCP Applications** (`aira-mcp-app/v1`) into the AIRA AI 2026 ecosystem. While Phase 3 established self-contained, model-generated HTML/canvas applications (`aira-app/v1`), Phase 4A connects UI applications directly to Model Context Protocol (MCP) servers, enabling servers to export rich interactive user interfaces for complex tools and resources.

```
+-----------------------------------------------------------------------------------+
| Host Application (AIRA UI - Next.js / React)                                      |
|                                                                                   |
|  +-------------------------+      +-------------------+      +------------------+ |
|  | PresentationRouter      |      | ToolGateway       |      | ApprovalKernel   | |
|  | mode: 'mcp_app'         |      | (Entitlements)    |      | (Policy/Confirm) | |
|  +------------+------------+      +---------^---------+      +--------^---------+ |
|               |                             |                         |           |
|               v                             +------------+------------+           |
|  +-------------------------------------------------------|----------------------+ |
|  | GenUIMcpApp Host Container & JSON-RPC Bridge          |                      | |
|  | - Nonce-verified postMessage router                   |                      | |
|  | - Validates origin === 'null'                         |                      | |
|  | - Enforces Tool Confirmation Dialogs                  |                      | |
|  +----------------------------+--------------------------+----------------------+ |
+-------------------------------|---------------------------------------------------+
                                | postMessage (RPC)
                                v
+-----------------------------------------------------------------------------------+
| Sandboxed Opaque Iframe (sandbox="allow-scripts allow-forms")                     |
| Origin: window.origin === 'null'                                                  |
| CSP: default-src 'none'; script-src 'unsafe-inline'; connect-src 'none';          |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  | window.airaMcpBridge (Client JSON-RPC Runtime)                              |  |
|  | - rpc.call('tools/call', { name: 'query_db', arguments: {...} })             |  |
|  | - rpc.call('ui/resize', { height: 600 })                                    |  |
|  | - rpc.on('ui/stateUpdate', (state) => {...})                                 |  |
|  +-----------------------------------------------------------------------------+  |
|  | MCP App Render Surface (HTML5, Canvas, React Micro-bundle, SVG)             |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 2. Core Security Invariants & Fail-Closed Egress Boundary

### Invariant 1: Physical Network Egress Denial inside UI Frames
Every MCP App iframe is served with the strict authoritative CSP meta header:
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
```
No MCP App UI frame is permitted to open direct HTTP/S, WebSocket, or WebRTC network connections. All data exchange and tool invocations must route through the host JSON-RPC postMessage bridge.

### Invariant 2: Authoritative Host Tool Execution & Approval Kernel
When an MCP App calls `tools/call`:
1. The host bridge receives the request and validates the cryptographic nonce.
2. The requested tool name must belong to the MCP App's declared `supportedTools`.
3. The invocation is forwarded to `ToolGateway`, which checks caller tenant entitlements.
4. If the tool has side effects (`permissionLevel !== 'READ'`), execution is paused and routed to `ApprovalKernel` for mandatory user approval. The UI frame cannot bypass or simulate user confirmation.

### Invariant 3: Remote MCP Egress Guard (`MCP_EGRESS_ENFORCEMENT_REQUIRED`)
In accordance with `packages/mcp/src/index.ts` and `ssrf-protection.ts`:
- Remote MCP server endpoints (HTTP/SSE) in production / cloud environments remain **strictly disabled by default** via `assertApprovedPublicMcpDestination()`.
- Standard application-level URL allowlists are vulnerable to DNS rebinding (TOCTOU between DNS resolution and connection) and HTTP redirect abuse into internal cloud metadata addresses (`169.254.169.254`).
- **Phase 4A Policy:** Remote MCP execution remains disabled until connection-time IP pinning and kernel-level egress filtering are certified. Phase 4A enables local MCP apps, stdio processes (operators only), and local test harness fixtures.

---

## 3. Descriptor Contract Schema (`aira-mcp-app/v1`)

The contract is codified in `packages/contracts/src/mcp-apps.ts`:

```typescript
import { z } from 'zod';

export const AIRA_MCP_APP_CONTRACT_VERSION = 'aira-mcp-app/v1' as const;

export const McpAppDisplayModeSchema = z.enum(['inline', 'fullscreen', 'pip', 'modal']);
export type McpAppDisplayMode = z.infer<typeof McpAppDisplayModeSchema>;

export const McpAppCapabilitiesSchema = z.object({
  requiresToolExecution: z.boolean().default(false),
  requiresStateSync: z.boolean().default(true),
  readOnly: z.boolean().default(false),
  maxHeightPx: z.number().int().min(200).max(1600).default(800),
});

export const McpAppDescriptorSchema = z.object({
  schemaVersion: z.literal(AIRA_MCP_APP_CONTRACT_VERSION),
  appId: z.string().min(1).max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/),
  serverId: z.string().min(1).max(96),
  title: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  entrypointHtml: z.string().min(1).max(512 * 1024),
  supportedTools: z.array(z.string().min(1).max(96)).max(32).default([]),
  displayMode: McpAppDisplayModeSchema.default('inline'),
  capabilities: McpAppCapabilitiesSchema.default({}),
  initialState: z.record(z.string().max(64), z.unknown()).default({}),
  textFallback: z.string().min(1).max(4096),
}).strict();

export type McpAppDescriptor = z.infer<typeof McpAppDescriptorSchema>;
```

---

## 4. Host-to-App JSON-RPC Protocol

Communication across the iframe boundary adheres to JSON-RPC 2.0 over `window.postMessage`:

| Method | Initiator | Parameters | Purpose |
| :--- | :--- | :--- | :--- |
| `ui/ready` | Iframe App | `{ appId: string }` | Notifies host that app scripts have initialized |
| `ui/resize` | Iframe App | `{ height: number }` | Requests container height adjustment (clamped 200-1400px) |
| `ui/stateUpdate` | Iframe App | `{ state: Record<string, unknown> }` | Syncs client state to host conversation metadata |
| `tools/call` | Iframe App | `{ name: string, arguments: Record<string, unknown> }` | Invokes an MCP tool subject to ToolGateway & ApprovalKernel |
| `tools/result` | Host | `{ callId: string, result: unknown, error?: string }` | Returns tool execution output back to the app |
| `ui/error` | Iframe App | `{ error: string, fatal: boolean }` | Reports client runtime or script failure |

---

## 5. Implementation Roadmap & Verification Gates

1. **Contract Definition:** `packages/contracts/src/mcp-apps.ts` with validation functions.
2. **Host Bridge Component:** `src/components/genui/GenUIMcpApp.tsx` managing postMessage routing and tool approval dialogs.
3. **Local Test Fixture:** `test/fixtures/local-mcp-server.ts` implementing a compliant local MCP server.
4. **Acceptance Test Suite:** `test/mcp-apps-local-acceptance.test.ts` verifying descriptor parsing, tool call authorization, approval gating, and CSP isolation.
5. **Phase 4A Certification:** Author `docs/genui/AIRA_GENUI_PHASE4A_MCP_APPS_CERTIFICATION.md`.
