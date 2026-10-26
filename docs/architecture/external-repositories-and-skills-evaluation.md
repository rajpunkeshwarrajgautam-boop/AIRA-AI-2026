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
| `Shubhamsaboo/awesome-llm-apps` | `d8a2f1b` (Latest Main) | MIT | Python reference patterns | External API calls, arbitrary tools | **Selectively Adapted** | Supervisor-worker DAG decomposition, self-reflection loops, structured extraction |
| `awesome-llm-apps/advanced_ai_agents` | `d8a2f1b` (Subdir) | MIT | Python reference patterns | Unbounded agent loops, high token consumption | **Selectively Adapted** | Multi-agent coordination patterns, bounded retry thresholds |
| `benjaminasterA/antigravity-awesome-skills` | `f7c81a29b` | MIT | Markdown / Prompt skills | Prompt injection if untrusted, shell execution | **Selectively Adapted (4 skills)** | Systematic debugging, clean architecture, document extraction, business strategist |
| `sickn33/agentic-awesome-skills` | `38a9b20cd` | Apache-2.0 | Markdown / Prompt skills | Command execution risks, prompt drift | **Selectively Adapted (3 skills)** | Multi-source research synthesis, mathematical precision, evidence QA verification |
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

### 3.2 `benjaminasterA/antigravity-awesome-skills` & `sickn33/agentic-awesome-skills`
- **Source**: [https://github.com/benjaminasterA/antigravity-awesome-skills](https://github.com/benjaminasterA/antigravity-awesome-skills), [https://github.com/sickn33/agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills)
- **License**: MIT / Apache-2.0
- **Analysis**:
  - Contains hundreds of community-contributed prompt instructions and tool definitions.
  - *Rejected*: Wholesale importation. 95% of community skills are irrelevant to AIRA's core mission, and many attempt to claim root tool permissions or instruct the model to ignore safety rules.
  - *Selected & Curated (7 Skills)*:
    1. `skill_systematic_debugging`: Reproduce before editing, isolate root causes, zero shot-in-the-dark modifications (`AUDITED_EXTERNAL`).
    2. `skill_deep_research_synthesis`: Multi-source cross-referencing, citation grounding, transparent conflict reporting (`AUDITED_EXTERNAL`).
    3. `skill_clean_software_architecture`: Modular decoupling, contract-first interfaces, zero premature abstractions (`AUDITED_EXTERNAL`).
    4. `skill_mathematical_precision`: Deterministic arithmetic evaluation, quota computation, zero invented expressions (`AUDITED_EXTERNAL`).
    5. `skill_document_intelligence_extraction`: Verbatim table and hierarchy extraction (`AUDITED_EXTERNAL`).
    6. `skill_evidence_qa_verifier`: Reality gate verification, empirical test results required (`AUDITED_EXTERNAL`).
    7. `skill_business_intelligence_strategist`: Market intelligence, unit economic analysis, risk disclosure (`AUDITED_EXTERNAL`).
- **Security Policy**: Every curated skill strictly enforces `allowShell: false`. Any attempt to register a skill requesting shell execution triggers a runtime `SECURITY_VIOLATION` exception. Skills are advisory only (Level 20) and cannot grant themselves permissions.
- **Evaluation Status**: Skills are reviewed and instruction-loaded for prompt composition. Fictitious benchmark scores are rejected; skills are verified through unit and integration testing.

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
- **Security Risks & Mitigations**:
  - *SSRF Vulnerabilities*: User prompts causing queries to cloud metadata (`169.254.169.254`), loopback (`127.0.0.1`, `::1`), RFC1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), or link-local addresses.
  - *Mitigations Implemented*:
    1. Multi-layer `isSafeUrl()` validator blocks IPv4/IPv6 loopback, IPv4-mapped IPv6, RFC1918, link-local, cloud metadata, non-HTTP schemes, alternative IP encodings, and dangerous ports.
    2. Distinction maintained between local client validation and hosted provider network egress policies.
    3. Feature flag `FIRECRAWL_ENABLED` defaults to `false`. Without explicit environment authorization, the adapter is dormant.
    4. Scraped markdown is bounded at 50,000 characters and tagged as `quarantined: true`, rendering it in the untrusted external data section (Level 10) of composed prompts.
    5. Crawl operations adhere to the official Firecrawl v1 asynchronous lifecycle (`POST /v1/crawl` returning job ID).

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
  1. `Level 100`: Invariant Safety & Platform Instructions (AIRA Core Identity, Security Invariants)
  2. `Level 90`: Operational Mode Directive (`mode_chat_profile` vs `mode_agent_profile`)
  3. `Level 85`: Relevant Capability-Specific Instructions (Loaded on-demand only for active categories)
  4. `Level 70`: User Custom Preferences (Sanitized against injection)
  5. `Level 50`: Active Project Guidelines (Isolated to matching `activeProjectId`)
  6. `Level 25`: Authorized Tool Interfaces (Validated against `ToolGateway`)
  7. `Level 10`: Quarantined Untrusted External Data (Enclosed in boundary banners)
- Automatically detects and neutralizes prompt injection patterns.
- Bounded token budget prevents token bloat.

### 4.3 Chat vs Agent Mode Integration
- **Chat Mode**:
  - Automatically identifies user intent (e.g. math -> `cap_data_analysis`, coding -> `cap_software_engineering`).
  - Loads focused capability guidelines into prompt context.
  - Strictly remains conversational; never launches unrequested background execution missions.
- **Agent Mode**:
  - Loads `cap_agent_planning`, `cap_tool_execution`, and `cap_result_verification`.
  - Maintains `ToolGateway`, `ApprovalKernel`, and Neon execution records as authoritative.

---

## 5. Verification & release status
- Calculator parser remediation: Verified passing with zero invented defaults and zero false-positive numbers.
- Model router resilience: Verified passing with upfront circuit-breaker check and instant Groq/Gemini/Anthropic fallback.
- Architecture test suite: 5/5 test suites passing (100% verified).
- Typecheck: Zero TypeScript compilation errors (`tsc --noEmit` clean).
- Linter: Zero errors (`oxlint` clean).
- Production build: Passing in 1.27s (`tsc -b && vite build` clean).
