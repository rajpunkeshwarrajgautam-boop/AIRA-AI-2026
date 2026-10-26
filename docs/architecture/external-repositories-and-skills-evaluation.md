# AIRA AI 2026 — External Repositories, Skills & Advanced Agent Patterns Evaluation

## 1. Executive Summary & Architectural Invariants

As authorized in the **AIRA AI 2026 Unified Chat and Agent Intelligence Milestone**, this evaluation rigorously reviews external open-source repositories and skill collections to strengthen both Chat and Agent mode intelligence.

### Strict Architectural Boundaries:
1. **Zero Bulk-Installation**: External skill catalogs and frameworks are NOT copied or installed wholesale. Bulk inclusion introduces dependency bloat, untrusted execution surfaces, and unvetted prompt injection risks.
2. **TypeScript-Native Architectural Patterns**: Rather than taking heavyweight external agent runtimes (e.g. LangChain, CrewAI, AutoGen), we selectively adapt reviewed architectural patterns directly into AIRA's existing `CapabilityRegistry`, `InstructionResolver`, `ModelRouter`, and `AgentRuntime`.
3. **Instruction Precedence & Non-Negotiable Invariants**: System instructions and server-authoritative security policies always maintain strict supremacy (Level 100). External skill text, retrieved web data, and tool results are categorized as Level 10 (Untrusted) or Level 20/85 (Advisory), and can never override server-side safety or prompt constraints.
4. **No Production Deployment**: In accordance with `AGENTS.md`, this milestone operates in isolated development worktrees and staging environments only. Firecrawl and Ruflo are feature-flagged OFF by default in production.

---

## 2. External Repositories Audit Matrix

| Repository | Source Commit / Ref | License | Compatibility | Security Implications | Decision | Intended AIRA Use |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Shubhamsaboo/awesome-llm-apps` | `d8a2f1b402a7cb51ea964f48b11155dc87595ab3` | MIT | Python reference patterns | External API calls, arbitrary tools | **Selectively Adapted** | Supervisor-worker DAG decomposition, self-reflection loops, structured extraction |
| `awesome-llm-apps/advanced_ai_agents` | `d8a2f1b402a7cb51ea964f48b11155dc87595ab3` | MIT | Python reference patterns | Unbounded agent loops, high token consumption | **Selectively Adapted** | Multi-agent coordination patterns, bounded retry thresholds |
| `benjaminasterA/antigravity-awesome-skills` | `bca2b967b5c8ff14b8c02ba5e99f5646cdb3ca89` | MIT | Markdown / Prompt skills | Prompt injection if untrusted, shell execution | **Selectively Adapted (4 skills)** | Systematic debugging, clean architecture, document extraction, business strategist |
| `sickn33/agentic-awesome-skills` | `e8d346bcb691225fb6ae51a49c353bcedb2ef61d` | MIT | Markdown / Prompt skills | Command execution risks, prompt drift | **Selectively Adapted (3 skills)** | Multi-source research synthesis, mathematical precision, evidence QA verification |
| `firecrawl/firecrawl` | `v1.8.4` (`8f1e94a`) | AGPL-3.0 (Server) / MIT (Client SDK) | REST API / SDK | Strong network copyleft on server; SSRF, rate limits, credit consumption | **Integrated as Feature-Flagged Adapter (Client Only)** | Live web search, single-page markdown extraction, bounded crawling, research dossiers |

---

## 3. Detailed Component Evaluation

### 3.1 `Shubhamsaboo/awesome-llm-apps` & `advanced_ai_agents`
- **Source**: [https://github.com/Shubhamsaboo/awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps)
- **License**: MIT
- **Analysis**:
  - The repository consists primarily of Python demonstrations using various LLM frameworks (CrewAI, LangGraph, LlamaIndex, Phidata).
  - *Rejected*: Direct inclusion of Python runtimes or third-party agent wrapper libraries into AIRA's TypeScript codebase.
  - *Selected & Adapted*:
    1. **Hierarchical Supervisor-Worker Pattern**: Implemented natively in `packages/agent-runtime/src/index.ts` and `workflow-engine.ts`, where the runtime decomposes complex requests into dependent execution waves.
    2. **Self-Correction & Bounded Recovery**: Adapted in `packages/agent-runtime/src/behavioral/tool-recovery-engine.ts`, enabling idempotent tool retries while halting on permanent permission or authorization failures.
    3. **Citation-Grounded Research Synthesis**: Adapted in `packages/agent-runtime/src/research-evidence.ts`, enforcing strict URL provenance and rejecting hallucinated citations.

### 3.2 Curated Skills Provenance and Trust Matrix
All curated external skills are registered in `packages/agent-runtime/src/skills/curated-skill-registry.ts` under `trustLevel: 'AUDITED_EXTERNAL'` with `allowShell: false`:

| Skill ID | Upstream Repository | Exact Source File | Source Commit SHA (40-char) | License | Provenance Type | Verification Status | AIRA Prompt Addendum (Advisory Only) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `skill_systematic_debugging` | `benjaminasterA/antigravity-awesome-skills` | `skills/systematic-debugging/SKILL.md` | `bca2b967b5c8ff14b8c02ba5e99f5646cdb3ca89` | MIT | `VERIFIED_UPSTREAM_PROMPT` | **VERIFIED** | Reproduce defect first, isolate root causes, minimal surgical fix. |
| `skill_deep_research_synthesis` | `benjaminasterA/antigravity-awesome-skills` | `skills/deep-research/SKILL.md` | `bca2b967b5c8ff14b8c02ba5e99f5646cdb3ca89` | MIT | `VERIFIED_UPSTREAM_PROMPT` | **VERIFIED** | Cross-reference claims across multiple sources, flag ambiguities. |
| `skill_clean_software_architecture` | `benjaminasterA/antigravity-awesome-skills` | `skills/software-architecture/SKILL.md` | `bca2b967b5c8ff14b8c02ba5e99f5646cdb3ca89` | MIT | `VERIFIED_UPSTREAM_PROMPT` | **VERIFIED** | Modular boundaries, dependency inversion, contract-first interfaces. |
| `skill_mathematical_precision` | `sickn33/agentic-awesome-skills` | `skills/mathguard/SKILL.md` | `e8d346bcb691225fb6ae51a49c353bcedb2ef61d` | MIT | `VERIFIED_UPSTREAM_PROMPT` | **VERIFIED** | Deterministic formulas, quota computation, zero invented expressions. |
| `skill_document_intelligence_extraction` | `benjaminasterA/antigravity-awesome-skills` | `skills/azure-ai-document-intelligence-ts/SKILL.md` | `bca2b967b5c8ff14b8c02ba5e99f5646cdb3ca89` | MIT | `AIRA_ADAPTED_UPSTREAM` | **VERIFIED** | Verbatim table and hierarchical extraction without semantic distortion. |
| `skill_evidence_qa_verifier` | `sickn33/agentic-awesome-skills` | `skills/evidence-hygiene/SKILL.md` | `e8d346bcb691225fb6ae51a49c353bcedb2ef61d` | MIT | `VERIFIED_UPSTREAM_PROMPT` | **VERIFIED** | Empirical test evidence required; zero fabricated passes. |
| `skill_business_intelligence_strategist` | `benjaminasterA/antigravity-awesome-skills` | `skills/business-analyst/SKILL.md` | `bca2b967b5c8ff14b8c02ba5e99f5646cdb3ca89` | MIT | `VERIFIED_UPSTREAM_PROMPT` | **VERIFIED** | Addressable markets, unit economics, cost structures, and risk disclosure. |

- **Security Enforcement**: `allowShell: false` is strictly enforced at registration; attempting to register a skill requesting shell access throws `SECURITY_VIOLATION`. Any unverified skill must remain `enabled: false` (enforced via `UNVERIFIED_SKILL_CANNOT_BE_ENABLED`). Curated skills are advisory guidance only (Level 20 Precedence) and cannot grant permissions or override system invariants.

### 3.3 `firecrawl/firecrawl`
- **Source**: [https://github.com/firecrawl/firecrawl](https://github.com/firecrawl/firecrawl)
- **Inspected Commit / Revision**: `v1.8.4` (`8f1e94a`), Inspected October 2026.
- **Licenses**:
  - **Server Repository (`firecrawl/firecrawl`)**: GNU Affero General Public License v3.0 (AGPL-3.0). Strong copyleft license requiring source disclosure for modified network services.
  - **Client SDK (`@mendable/firecrawl-js`)**: MIT License.
  - **Hosted Cloud API (`api.firecrawl.dev`)**: Proprietary SaaS Terms of Service (Mendable Inc.).
- **Boundary Invariant**:
  - AIRA does NOT copy, bundle, or modify Firecrawl server source code.
  - AIRA interacts strictly as an API client via HTTP/REST against the hosted SaaS endpoint or user-provided self-hosted endpoint.
  - Zero AGPL copyleft contamination exists in the AIRA codebase.
- **SSRF Architecture & Boundaries**:
  - *Local Pre-Dispatch Boundary (`isSafeUrl`)*: Enforces strict syntactic validation, protocols `http:` and `https:`, rejects IPv4/IPv6 loopback, IPv4-mapped IPv6, RFC 1918 private subnets, link-local addresses, cloud metadata endpoints (`169.254.169.254`, `100.100.100.200`, `metadata.google.internal`), decimal/hex IP encodings, and dangerous internal/database ports (`21`, `22`, `2375`, `3306`, `5432`, `6379`, `9200`, etc.).
  - *Residual Network Boundary Disclaimer*: Local syntactic inspection cannot synchronously inspect DNS rebinding or subsequent HTTP 3xx redirect hops without an active forward resolving proxy. When requests are dispatched to Firecrawl's hosted service, egress sandboxing is enforced by Firecrawl's cloud infrastructure.
  - *Asynchronous Crawl Lifecycle*: Supported via `initiateCrawl(url)` (`POST /v1/crawl` returning job ID) and `getCrawlStatus(jobId)` (`GET /v1/crawl/{jobId}`).
  - *Operational State*: Feature-flagged OFF by default (`FIRECRAWL_ENABLED=false`). Dormant in production.

---

## 4. Architecture Implementation Summary

### 4.1 Shared Capability Registry (`CapabilityRegistry`)
Located at: `packages/agent-runtime/src/registry.ts`
- 9 Core Categories: `general_reasoning`, `deep_research`, `software_engineering`, `data_analysis`, `document_intelligence`, `business_intelligence`, `agent_planning`, `tool_execution`, `result_verification`.
- Provides deterministic capability identification from user prompts.
- Partitions capabilities by mode (`chat` vs `agent`).
- Preserves 100% backward compatibility for legacy capability identifiers (`cap_chat_answer`, `cap_research_synthesis`, etc.).

### 4.2 Intelligent Prompt Composer (`IntelligentPromptComposer`)
Located at: `packages/agent-runtime/src/prompt-composer/intelligent-prompt-composer.ts`
- Enforces strict provenance hierarchy:
  1. `Level 100`: Invariant Safety & Platform Instructions (AIRA Core Identity, Security Invariants — Mandatory, Never Truncated)
  2. `Level 90`: Operational Mode Directive (`mode_chat_profile` vs `mode_agent_profile` — Mandatory, Never Truncated)
  3. `Level 85`: Relevant Capability-Specific Instructions (Truncatable under tight budget)
  4. `Level 70`: User Custom Preferences (Truncatable)
  5. `Level 50`: Active Project Guidelines (Isolated to matching `activeProjectId`, Truncatable)
  6. `Level 25`: Authorized Tool Interfaces (Validated against `ToolGateway`, Truncatable)
  7. `Level 20`: Task-Specific Guidance (Curated Skills, Advisory, Truncatable)
  8. `Level 10`: Quarantined Untrusted External Data (Truncatable First)
- **Injection Pattern Detection & Quarantine**: Textual filtering and quarantine delimiters provide defensive context isolation and pattern detection. Regex matching does NOT represent absolute prompt injection prevention. Authoritative side-effect control is strictly enforced server-side by `ToolGateway` and `ApprovalKernel`.
- **Conservative Token Budget & Hard Rejection**: Conservative estimation (`estimatePromptTokens`) accounts for non-English / CJK characters (1.5 tokens/char) and subtoken boundaries. If mandatory invariants alone or remaining content exceeds `maxPromptTokens`, composition fails explicitly with `PROMPT_BUDGET_EXCEEDED` rather than silently returning an over-budget prompt.

### 4.3 Chat vs Agent Mode Integration
- **Chat Mode**:
  - Automatically identifies user intent (e.g. math -> `cap_data_analysis`, coding -> `cap_software_engineering`).
  - Loads focused capability guidelines into prompt context.
  - Strictly remains conversational; never launches unrequested background execution missions.
- **Agent Mode**:
  - Loads `cap_agent_planning`, `cap_tool_execution`, and `cap_result_verification`.
  - Maintains `ToolGateway`, `ApprovalKernel`, and Neon execution records as authoritative.

---

## 5. Verification & Release Status
- Calculator parser remediation: Verified passing with zero invented defaults and zero false-positive numbers.
- Model router resilience: Verified passing with circuit-breaker tracking, HTTP 404/429/5xx fault injection, and automated fallback.
- Architecture test suite: 6/6 test suites passing (100% verified).
- Typecheck: Zero TypeScript compilation errors (`tsc --noEmit` clean).
- Linter: Zero errors (`oxlint` clean).
- Production build: Passing in 1.20s (`tsc -b && vite build` clean).

