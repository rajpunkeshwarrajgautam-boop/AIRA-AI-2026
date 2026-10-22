# AIRA AI 2026 — PR #96 Staging Write-Path Inventory

This inventory documents all persistent write paths from external requests to database storage, detailing the route, HTTP method, executor, database connection role, and the dual-layer maintenance barrier enforcement boundary.

| Subsystem | Route / Entry Point | Method | Target Tables | Executor / Service | Enforcement Boundary |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Authentication** | `/api/auth/sign-up` | `POST` | `users`, `bff_sessions` | `handleBffSignUp` | Express 503 + DB Trigger `55P03` |
| **Authentication** | `/api/auth/sign-in` | `POST` | `bff_sessions` | `handleBffSignIn` | Express 503 + DB Trigger `55P03` |
| **Authentication** | `/api/auth/session` | `POST` | `bff_sessions` | `ensureAuthenticatedSession` | Express 503 + DB Trigger `55P03` |
| **Authentication** | `/api/auth/sign-out` | `POST` | `bff_sessions` | `handleBffSignOut` | Express 503 + DB Trigger `55P03` |
| **Authentication** | `/api/auth/oauth-exchange` | `POST` | `users`, `oauth_accounts`, `bff_sessions` | `handleBffOAuthExchange` | Express 503 + DB Trigger `55P03` |
| **Authentication** | `/api/auth/link-guest` | `POST` | `conversations`, `conversation_messages` | `conversationSearchRepo.transferGuestData` | Express 503 + DB Trigger `55P03` |
| **OAuth (Mutating GET)** | `/api/auth/oauth/google/callback` | `GET` | `users`, `oauth_accounts`, `bff_sessions` | `handleBffOAuthGoogleCallback` | Express 503 (`MUTATING_GET_PATHS`) + DB Trigger `55P03` |
| **OAuth (Mutating GET)** | `/api/auth/oauth/github/callback` | `GET` | `users`, `oauth_accounts`, `bff_sessions` | `handleBffOAuthGithubCallback` | Express 503 (`MUTATING_GET_PATHS`) + DB Trigger `55P03` |
| **OAuth (Mutating GET)** | `/api/auth/oauth/google/start` | `GET`/`POST`| `bff_sessions` (OAuth state) | `handleBffOAuthGoogleStart` | Express 503 (`MUTATING_GET_PATHS`) + DB Trigger `55P03` |
| **OAuth (Mutating GET)** | `/api/auth/oauth/github/start` | `GET`/`POST`| `bff_sessions` (OAuth state) | `handleBffOAuthGithubStart` | Express 503 (`MUTATING_GET_PATHS`) + DB Trigger `55P03` |
| **OAuth (Mutating GET)** | `/api/auth/oauth/google/link` | `GET` | `bff_sessions` (Link state) | `handleBffOAuthLinkStart` | Express 503 (`MUTATING_GET_PATHS`) + DB Trigger `55P03` |
| **OAuth (Mutating GET)** | `/api/auth/oauth/github/link` | `GET` | `bff_sessions` (Link state) | `handleBffOAuthLinkStart` | Express 503 (`MUTATING_GET_PATHS`) + DB Trigger `55P03` |
| **Account** | `/api/auth/providers/:provider/unlink` | `POST` | `oauth_accounts` | `handleBffUnlinkProvider` | Express 503 + DB Trigger `55P03` |
| **Account** | `/api/auth/recovery/request` | `POST` | `account_recovery_requests` | `handleBffRecoveryRequest` | Express 503 + DB Trigger `55P03` |
| **Account Profile** | `/api/account/profile` | `PUT` | `users` | `createAccountRoutes` | Express 503 + DB Trigger `55P03` |
| **Account Profile** | `/api/user/profile` | `PUT` | `users` | `createAccountRoutes` | Express 503 + DB Trigger `55P03` |
| **Account Security** | `/api/account/forgot-password` | `POST` | `account_recovery_requests` | `createAccountRoutes` | Express 503 + DB Trigger `55P03` |
| **Account Security** | `/api/account/reset-password` | `POST` | `users` | `createAccountRoutes` | Express 503 + DB Trigger `55P03` |
| **Account Security** | `/api/account/verify-email` | `POST` | `users` | `createAccountRoutes` | Express 503 + DB Trigger `55P03` |
| **Chat & Streaming** | `/api/chat/stream` | `POST` | `conversations`, `conversation_messages`, `conversation_search_documents` | `ModelRouter`, `conversationSearchRepo` | Express 503 + DB Trigger `55P03` |
| **Conversations** | `/api/conversations/sync` | `POST` | `conversations`, `conversation_messages` | `conversationSearchRepo.saveConversation` | Express 503 + DB Trigger `55P03` |
| **Conversations** | `/api/conversations/:id` | `DELETE` | `conversations`, `conversation_messages` | `conversationSearchRepo.deleteConversation` | Express 503 + DB Trigger `55P03` |
| **Agent Runs** | `/api/runs` | `POST` | `runs`, `run_events` | `AgentRuntime.createRun` | Express 503 + DB Trigger `55P03` |
| **Agent Runs** | `/api/runs/:id/cancel` | `POST` | `runs`, `run_events` | `AgentRuntime.cancelRun` | Express 503 + DB Trigger `55P03` |
| **Agent Runs** | `/api/runs/:id/approve` | `POST` | `approvals`, `runs` | `ApprovalKernel.submitDecision` | Express 503 + DB Trigger `55P03` |
| **Agent Management** | `/api/agents` | `POST` | `agents` | `PostgresAgentRepository` | Express 503 + DB Trigger `55P03` |
| **Agent Management** | `/api/agents/:id` | `PATCH` | `agents` | `PostgresAgentRepository` | Express 503 + DB Trigger `55P03` |
| **Agent Management** | `/api/agents/:id` | `DELETE` | `agents` | `PostgresAgentRepository` | Express 503 + DB Trigger `55P03` |
| **Automations** | `/api/automations` | `POST` | `automations` | `PostgresAutomationRepository` | Express 503 + DB Trigger `55P03` |
| **Automations** | `/api/automations/:id` | `PATCH` | `automations` | `PostgresAutomationRepository` | Express 503 + DB Trigger `55P03` |
| **Automations** | `/api/automations/:id` | `DELETE` | `automations` | `PostgresAutomationRepository` | Express 503 + DB Trigger `55P03` |
| **Automations** | `/api/automations/:id/trigger` | `POST` | `automation_runs` | `AutomationEngine.triggerAutomation` | Express 503 + DB Trigger `55P03` |
| **Automations** | `/api/automations/cron/execute` | `POST` | `automation_runs` | `AutomationEngine.executeDueCrons` | Express 503 + DB Trigger `55P03` |
| **Workflows** | `/api/workflows/runs` | `POST` | `workflow_runs`, `workflow_steps` | `WorkflowEngine.createRun` | Express 503 + DB Trigger `55P03` |
| **Workflows** | `/api/workflows/runs/:id/cancel` | `POST` | `workflow_runs`, `workflow_steps` | `WorkflowEngine.cancelRun` | Express 503 + DB Trigger `55P03` |
| **Workflows** | `/api/workflows/runs/:id/steps/:stepId/approve` | `POST` | `workflow_steps` | `WorkflowEngine.approveStep` | Express 503 + DB Trigger `55P03` |
| **Tool Gateway** | `/api/tools/execute` | `POST` | `tool_calls` | `ToolGateway.execute` | Express 503 + DB Trigger `55P03` |
| **Tool Gateway** | `/api/tools/calls/:id/cancel` | `POST` | `tool_calls` | `ToolGateway.cancelCall` | Express 503 + DB Trigger `55P03` |
| **Knowledge Engine** | `/api/knowledge/ingest` | `POST` | `knowledge_sources`, `knowledge_chunks` | `BrainV2KnowledgeEngine.ingestSource` | Express 503 + DB Trigger `55P03` |
| **Knowledge Engine** | `/api/knowledge/sources/:id` | `DELETE` | `knowledge_sources`, `knowledge_chunks` | `BrainV2KnowledgeEngine.deleteSource` | Express 503 + DB Trigger `55P03` |
| **Knowledge Engine** | `/api/knowledge/memories` | `POST` | `memory_records` | `BrainV2KnowledgeEngine.recordMemory` | Express 503 + DB Trigger `55P03` |
| **Builder Runtime** | `/api/builder/stream` | `POST` | Builder internal sessions | `BuilderService.stream` | Express 503 + DB Trigger `55P03` |
| **Builder Runtime** | `/api/builder/cancel` | `POST` | Builder internal sessions | `BuilderService.cancel` | Express 503 + DB Trigger `55P03` |
| **Billing & Top-ups** | `/api/billing/checkout/subscription` | `POST` | `subscriptions`, `billing_customers` | `commercialBillingService.checkout` | Express 503 + DB Trigger `55P03` |
| **Billing & Top-ups** | `/api/billing/subscription/cancel` | `POST` | `subscriptions` | `commercialBillingService.cancel` | Express 503 + DB Trigger `55P03` |
| **Webhooks** | `/api/billing/webhook/razorpay` | `POST` | `payment_gateway_events`, `credit_accounts`, `credit_transactions` | `commercialBillingService.processWebhook` | Express 503 + DB Trigger `55P03` |
| **Webhooks** | `/api/billing/webhook/cashfree` | `POST` | `payment_gateway_events`, `credit_accounts`, `credit_transactions` | `commercialBillingService.processWebhook` | Express 503 + DB Trigger `55P03` |
| **Older Vercel Deployments** | Any API Route on old immutable URL | ANY | Any public schema table | Old Serverless Handler (bypasses PR #96 Express code) | **PostgreSQL Kernel Trigger `55P03` + `default_transaction_read_only = on`** |
| **Direct Connections** | Direct `psql` / external script | ANY | Any public schema table | External client | **PostgreSQL Kernel Trigger `55P03` + `default_transaction_read_only = on`** |
| **Privileged Migration** | `npm run db:migrate` | CLI | `knex_migrations`, schema DDL | Knex Migration Runner | **AUTHORIZED ELEVATED**: `SET READ WRITE` + `SET aira.privileged_token` |
| **Historical Import** | `scripts/import-verified-commercial-identities.ts` | CLI | `users`, `oauth_accounts`, `credit_accounts`, `credit_grants` | Historical Import Script | **AUTHORIZED ELEVATED**: Atomic transaction with verified bypass token |
