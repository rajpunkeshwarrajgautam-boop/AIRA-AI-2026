# Graph Report - AIRA-AI-2026  (2026-10-07)

## Corpus Check
- 91 files · ~225,051 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 6 file(s) not represented in the graph (top: (none) 2, .css 2, .example 1)

## Summary
- 899 nodes · 1699 edges · 52 communities (42 shown, 10 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 84 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `41e4a533`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- approvals/src/index.ts
- db
- AgentRuntime
- AutomationDefinition
- BrainV2KnowledgeEngine
- contracts/src/index.ts
- AgentMemoryEngine
- model-router/src/index.ts
- AIRA PRODUCTION CHAT — FIX + CERTIFY + RELEASE
- AIRA-AI-2026 — RELEASE CERTIFICATION
- identity.ts
- package.json
- knex
- ChatInput.tsx
- auth/session-auth.ts
- react
- App.tsx
- dependencies
- Design System: Aira AI Workspace
- scripts
- Project
- compilerOptions
- api/src/index.ts
- devDependencies
- compilerOptions
- types/index.ts
- Communities (44 total, 10 thin omitted)
- firebase.ts
- knowledgeGraph.ts
- agentmemory
- vercel.json
- Rowboat Upstream Architecture Reference
- markdown.ts
- .oxlintrc.json
- verify-runtime.ts
- vite.config.ts
- agent-runtime/src/repositories.ts
- playwright
- Third-Party Notices and Licenses
- tsconfig.json
- AIRA-AI-2026 Production Engineering.md
- agent-runtime/src/index.ts
- SettingsModal.tsx
- Graph Report - AIRA-AI-2026  (2026-10-07)
- db/src/index.ts
- GreetingScreen.tsx
- recovery.ts
- integration.ts

## God Nodes (most connected - your core abstractions)
1. `db` - 52 edges
2. `Communities (44 total, 10 thin omitted)` - 35 edges
3. `AIRA PRODUCTION CHAT — FIX + CERTIFY + RELEASE` - 26 edges
4. `App()` - 25 edges
5. `AIRA-AI-2026 — RELEASE CERTIFICATION` - 25 edges
6. `AgentRuntime` - 23 edges
7. `AgentMemoryEngine` - 22 edges
8. `ToolRegistry` - 21 edges
9. `scripts` - 20 edges
10. `BrainV2KnowledgeEngine` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Suggested Questions` --references--> `ToolRegistry`  [INFERRED]
  .planning/graphs/GRAPH_REPORT.md → packages/tool-runtime/src/index.ts
- `7. Persist-Before-Emit Contract Check` --references--> `AgentRuntime`  [INFERRED]
  phase3_3_task4_certification.md → packages/agent-runtime/src/index.ts
- `God Nodes (most connected - your core abstractions)` --references--> `AgentRuntime`  [INFERRED]
  .planning/graphs/GRAPH_REPORT.md → packages/agent-runtime/src/index.ts
- `8. Repository Layer Roundtrip` --references--> `PostgresRunRepository`  [INFERRED]
  phase3_3_task4_certification.md → packages/agent-runtime/src/repositories.ts
- `Surprising Connections (you probably didn't know these)` --references--> `ExecutionPrincipal`  [INFERRED]
  .planning/graphs/GRAPH_REPORT.md → packages/contracts/src/index.ts

## Import Cycles
- None detected.

## Communities (52 total, 10 thin omitted)

### Community 0 - "approvals/src/index.ts"
Cohesion: 0.14
Nodes (9): ApprovalKernel, ApprovalManagerOptions, ApprovalRepository, PostgresApprovalRepository, SessionGrantRepository, ApprovalDecision, ApprovalRequest, PermissionLevel (+1 more)

### Community 1 - "db"
Cohesion: 0.15
Nodes (3): PostgresSessionGrantRepository, db, PostgresKnowledgeRepository

### Community 2 - "AgentRuntime"
Cohesion: 0.06
Nodes (25): AgentRuntime, PostgresRunRepository, RunRepository, CreateRunRequest, Run, StreamingEvent, 10. Phase 3.3 Task 4 Complete Report, 1. Migration Drift Remediation (+17 more)

### Community 3 - "AutomationDefinition"
Cohesion: 0.09
Nodes (8): seedDefaultAutomation(), AutomationEngine, AutomationRepository, AutomationRunRepository, PostgresAutomationRepository, PostgresAutomationRunRepository, AutomationDefinition, AutomationRun

### Community 4 - "BrainV2KnowledgeEngine"
Cohesion: 0.11
Nodes (8): Citation, KnowledgeChunk, KnowledgeEdge, KnowledgeEntity, KnowledgeSource, MemoryRecord, BrainV2KnowledgeEngine, KnowledgeRepository

### Community 5 - "contracts/src/index.ts"
Cohesion: 0.06
Nodes (34): AgentDefinitionSchema, ApprovalRequestSchema, ArtifactSchema, ArtifactVersion, ArtifactVersionSchema, AutomationRunSchema, AutomationTriggerType, AutomationTriggerTypeSchema (+26 more)

### Community 6 - "AgentMemoryEngine"
Cohesion: 0.15
Nodes (11): MemoryItem, MemoryQuery, MemoryStats, MemoryTier, agentMemory, AgentMemoryEngine, INITIAL_SEED_MEMORIES, scrubSecrets() (+3 more)

### Community 7 - "model-router/src/index.ts"
Cohesion: 0.13
Nodes (12): IntentTaxonomy, ModelId, ModelPolicy, ModelPolicySchema, AnthropicAdapter, ChatMessageInput, DeterministicMockAdapter, ModelAdapter (+4 more)

### Community 8 - "AIRA PRODUCTION CHAT — FIX + CERTIFY + RELEASE"
Cohesion: 0.07
Nodes (26): 10. SSE PARSER, 11. FRONTEND STATE, 12. NO BLANK ANSWERS, 13. DIRECT API E2E, 14. LOCAL BROWSER CERTIFICATION, 15. TEST GATES, 16. SECURITY REVIEW, 17. EVIDENCE COLLECTOR (+18 more)

### Community 9 - "AIRA-AI-2026 — RELEASE CERTIFICATION"
Cohesion: 0.08
Nodes (25): 10. CRITICAL USER JOURNEYS, 11. EMPTY / SILENT FAILURE RULE, 12. CI CERTIFICATION, 13. PREVIEW DEPLOYMENT, 14. PREVIEW BROWSER SMOKE, 15. EVIDENCE COLLECTOR, 16. REALITY CHECKER, 17. PR + MERGE (+17 more)

### Community 10 - "identity.ts"
Cohesion: 0.08
Nodes (19): DevPrincipalProvider, PrincipalProvider, createPrincipalMiddleware(), defaultPrincipalProvider, Express, Request, ExecutionPrincipal, ExecutionPrincipalSchema (+11 more)

### Community 11 - "package.json"
Cohesion: 0.07
Nodes (28): name, private, type, version, autoprefixer, canvas-confetti, clsx, cron-parser (+20 more)

### Community 13 - "ChatInput.tsx"
Cohesion: 0.20
Nodes (12): ChatInputProps, MODE_OPTIONS, STYLE_OPTIONS, modelGlyph(), ModelSelector(), ModelSelectorProps, Attachment, ModelId (+4 more)

### Community 14 - "auth/session-auth.ts"
Cohesion: 0.19
Nodes (19): attachUser(), clearSessionCookie(), createSessionAuthMiddleware(), createSessionPayload(), encodePayload(), ensureAuthenticatedSession(), getSessionSecret(), parseCookieHeader() (+11 more)

### Community 15 - "react"
Cohesion: 0.15
Nodes (14): framer-motion, lucide-react, react, react-dom, ArtifactStudioProps, ConversationActionsDropdown(), ConversationActionsDropdownProps, MenuPosition (+6 more)

### Community 16 - "App.tsx"
Cohesion: 0.21
Nodes (19): App(), ArtifactStudio, MODE_CONTEXT, ProjectsModal, SettingsModal, ChatInput(), CommandPalette(), InlineToast() (+11 more)

### Community 17 - "dependencies"
Cohesion: 0.09
Nodes (22): dependencies, canvas-confetti, clsx, cors, cron-parser, dotenv, express, firebase (+14 more)

### Community 18 - "Design System: Aira AI Workspace"
Cohesion: 0.10
Nodes (20): 1. Visual Theme & Atmosphere, 2. Color Palette & Roles, 3. Brand Emblem: The Aira Neural Cognition Knot, 4. Typography Rules, 5. Component Stylings, 6. Layout Principles, 7. Motion & Interaction Philosophy, 8. Anti-Patterns (Banned AI Tells) (+12 more)

### Community 19 - "scripts"
Cohesion: 0.10
Nodes (20): scripts, build, db:migrate, db:up, dev, lint, memory:init, memory:start (+12 more)

### Community 20 - "Project"
Cohesion: 0.29
Nodes (10): CommandPaletteProps, PaletteItem, GreetingScreenProps, ProjectsModal(), ProjectsModalProps, SidebarProps, Conversation, Project (+2 more)

### Community 21 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowArbitraryExtensions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection (+11 more)

### Community 22 - "api/src/index.ts"
Cohesion: 0.12
Nodes (16): agentRepo, agentRuntime, app, approvalKernel, automationEngine, autoRepo, autoRunRepo, knowledgeEngine (+8 more)

### Community 23 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, autoprefixer, oxlint, playwright, postcss, tailwindcss, @types/canvas-confetti, @types/cors (+9 more)

### Community 24 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, noEmit, noFallthroughCasesInSwitch (+8 more)

### Community 25 - "types/index.ts"
Cohesion: 0.24
Nodes (12): ArtifactCard(), ArtifactCardProps, ChatMessage(), ChatMessageProps, ThinkingBlock(), ThinkingBlockProps, AIProvider, Artifact (+4 more)

### Community 26 - "Communities (44 total, 10 thin omitted)"
Cohesion: 0.06
Nodes (35): Communities (44 total, 10 thin omitted), Community 0 - "ToolRegistry", Community 10 - "identity.ts", Community 11 - "package.json", Community 13 - "types/index.ts", Community 14 - "auth/session-auth.ts", Community 15 - "react", Community 16 - "App.tsx" (+27 more)

### Community 27 - "firebase.ts"
Cohesion: 0.15
Nodes (6): firebase, app, auth, db, firebaseConfig, storage

### Community 28 - "knowledgeGraph.ts"
Cohesion: 0.27
Nodes (9): buildKnowledgeGraphFromDocs(), calculateSha256(), EntityNode, estimateTokens(), KnowledgeGraph, RelationshipEdge, retrieveRelevantSubgraph(), SourceNode (+1 more)

### Community 29 - "agentmemory"
Cohesion: 0.18
Nodes (10): args, command, description, env, AGENTMEMORY_AUTO_SYNC, AGENTMEMORY_PORT, AGENTMEMORY_PRIVACY_FILTER, mcpServers (+2 more)

### Community 30 - "vercel.json"
Cohesion: 0.25
Nodes (7): buildCommand, framework, headers, installCommand, outputDirectory, rewrites, $schema

### Community 31 - "Rowboat Upstream Architecture Reference"
Cohesion: 0.29
Nodes (6): 1. `apps/harbor` (Contracts & Centralized Policy), 2. `apps/x/packages/core` (Runtime, Models, MCP, Knowledge), Adaptation Rules for AIRA AI 2026, Rowboat Upstream Architecture Reference, Subsystems Analyzed, Upstream Tracking

### Community 32 - "markdown.ts"
Cohesion: 0.43
Nodes (6): marked, BLOCKED_TAGS, escapeHtml(), renderMarkdownToHtml(), sanitizeHtml(), URL_ATTRS

### Community 33 - ".oxlintrc.json"
Cohesion: 0.33
Nodes (5): plugins, rules, react/only-export-components, react/rules-of-hooks, $schema

### Community 34 - "verify-runtime.ts"
Cohesion: 0.14
Nodes (7): McpHost, McpServerConfig, ToolRegistry, @modelcontextprotocol/sdk, runTest(), runTests(), sleep()

### Community 36 - "agent-runtime/src/repositories.ts"
Cohesion: 0.25
Nodes (4): seedDefaultAgent(), AgentRepository, PostgresAgentRepository, AgentDefinition

### Community 44 - "agent-runtime/src/index.ts"
Cohesion: 0.21
Nodes (7): Artifact, RunState, StreamingEventType, ToolDefinition, ToolResult, ExecutableTool, ToolExecutionContext

### Community 45 - "SettingsModal.tsx"
Cohesion: 0.23
Nodes (9): PRESET_THEMES, PresetTheme, SettingsModalProps, SettingsTab, AppSettings, ModelInfo, AVAILABLE_MODELS, DEFAULT_SETTINGS (+1 more)

### Community 46 - "Graph Report - AIRA-AI-2026  (2026-10-07)"
Cohesion: 0.18
Nodes (10): SessionPayload, Community Hubs (Navigation), Corpus Check, God Nodes (most connected - your core abstractions), Graph Freshness, Graph Report - AIRA-AI-2026  (2026-10-07), Import Cycles, Knowledge Gaps (+2 more)

### Community 47 - "db/src/index.ts"
Cohesion: 0.54
Nodes (5): closeDb(), __dirname, runMigrations(), main(), main()

### Community 48 - "GreetingScreen.tsx"
Cohesion: 0.38
Nodes (5): AiraMark(), AiraMarkProps, sizeMap, GreetingScreen(), PromptCard

### Community 49 - "recovery.ts"
Cohesion: 0.57
Nodes (6): createRun(), killApiServer(), runRecoveryTests(), seedRun(), sleep(), startApiServer()

### Community 51 - "integration.ts"
Cohesion: 0.60
Nodes (4): collectSseEvents(), INT_HEADERS, runIntegration(), sleep()

## Knowledge Gaps
- **347 isolated node(s):** `$schema`, `plugins`, `react/rules-of-hooks`, `react/only-export-components`, `modelRouter` (+342 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 418 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `God Nodes (most connected - your core abstractions)` connect `Graph Report - AIRA-AI-2026  (2026-10-07)` to `db`, `AgentRuntime`, `verify-runtime.ts`, `BrainV2KnowledgeEngine`, `AgentMemoryEngine`, `App.tsx`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **What connects `$schema`, `plugins`, `react/rules-of-hooks` to the rest of the system?**
  _347 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `approvals/src/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.13763440860215054 - nodes in this community are weakly interconnected._
- **Why does `Graph Report - AIRA-AI-2026  (2026-10-07)` connect `Graph Report - AIRA-AI-2026  (2026-10-07)` to `Communities (44 total, 10 thin omitted)`, `AgentRuntime`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Should `AgentRuntime` be split into smaller, more focused modules?**
  _Cohesion score 0.06487434248977206 - nodes in this community are weakly interconnected._
- **Why does `Surprising Connections (you probably didn't know these)` connect `AgentRuntime` to `identity.ts`, `verify-runtime.ts`, `Graph Report - AIRA-AI-2026  (2026-10-07)`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Should `AutomationDefinition` be split into smaller, more focused modules?**
  _Cohesion score 0.09371980676328502 - nodes in this community are weakly interconnected._