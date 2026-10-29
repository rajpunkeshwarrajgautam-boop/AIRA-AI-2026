import { z } from 'zod';

// ==========================================
// 0. TRUSTED PRINCIPAL
// ==========================================

export const ExecutionPrincipalSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  sessionId: z.string().min(1, "sessionId is required"),
  workspaceId: z.string().optional(),
  projectId: z.string().optional(),
  roles: z.array(z.string()).optional(),
  scopes: z.array(z.string()).optional()
});
export type ExecutionPrincipal = z.infer<typeof ExecutionPrincipalSchema>;

// ==========================================
// 1. RUN STATES & INTENT TAXONOMY
// ==========================================

export const RunStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_TOOL',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED'
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const ExecutionCheckpointSchema = z.enum([
  'CREATED',
  'KNOWLEDGE_READY',
  'TOOL_SELECTED',
  'WAITING_FOR_APPROVAL',
  'TOOL_APPROVED',
  'TOOL_EXECUTING',
  'TOOL_COMPLETED',
  'WORKFLOW_RUNNING',
  'SYNTHESIZING',
  'FINALIZING',
  'COMPLETED'
]);
export type ExecutionCheckpoint = z.infer<typeof ExecutionCheckpointSchema>;

export const IntentTaxonomySchema = z.enum([
  'ANSWER',
  'RESEARCH',
  'TOOL_ACTION',
  'WORKFLOW',
  'AUTOMATION_CREATE',
  'AGENT_MISSION'
]);
export type IntentTaxonomy = z.infer<typeof IntentTaxonomySchema>;

export const SideEffectLevelSchema = z.enum([
  'NONE',
  'READ',
  'WRITE',
  'DESTRUCTIVE'
]);
export type SideEffectLevel = z.infer<typeof SideEffectLevelSchema>;

export const ExecutionTargetSchema = z.enum([
  'CHAT_STREAM',
  'RESEARCH_SYNTHESIS',
  'TOOL_PIPELINE',
  'AGENT_PLANNER',
  'WORKFLOW_ENGINE',
  'AUTOMATION_ENGINE',
  'CAPABILITY_NOT_READY'
]);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

export const RoutingDecisionSchema = z.object({
  intent: IntentTaxonomySchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().max(280),
  executionTarget: ExecutionTargetSchema,
  sideEffectLevel: SideEffectLevelSchema,
  approvalRequired: z.boolean(),
  capabilities: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.any()).default({})
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

import { CapabilityCategorySchema, type CapabilityCategory } from './behavioral.js';
export { CapabilityCategorySchema, type CapabilityCategory };

export const ExecutionModeSchema = z.enum(['chat', 'agent']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const ResourceLimitsSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  maxSteps: z.number().int().positive().optional(),
  maxPromptTokens: z.number().int().positive().optional()
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const EvaluationRequirementsSchema = z.object({
  minAccuracy: z.number().min(0).max(1).optional(),
  benchmarkSuite: z.string().optional(),
  requiresGrounding: z.boolean().default(false),
  requiresToolVerification: z.boolean().default(false),
  maxAllowedDrift: z.number().min(0).max(1).optional()
});
export type EvaluationRequirements = z.infer<typeof EvaluationRequirementsSchema>;

export const CapabilityDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  category: CapabilityCategorySchema.default('general_reasoning'),
  executionType: IntentTaxonomySchema,
  supportedModes: z.array(ExecutionModeSchema).default(['chat', 'agent']),
  requiredTools: z.array(z.string()).default([]),
  requiredPermissions: z.array(z.string()).default([]),
  promptProfileId: z.string().default('profile_general_reasoning'),
  resourceLimits: ResourceLimitsSchema.default({}),
  evaluationRequirements: EvaluationRequirementsSchema.default({}),
  enabled: z.boolean().default(true),
  availability: z.enum(['GA', 'BETA', 'PREVIEW', 'COMING_SOON', 'DISABLED']),
  sideEffectClass: SideEffectLevelSchema,
  approvalPolicy: z.enum(['autonomous', 'require_approval', 'always_ask']),
  requiredPrincipalScope: z.array(z.string()).default([]),
  handler: z.string(),
  status: z.enum(['READY', 'PARTIAL', 'DEGRADED', 'NOT_READY', 'DEPRECATED'])
});
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;

export const PromptProfileSchema = z.object({
  id: z.string().min(1),
  version: z.string().default('1.0.0'),
  category: CapabilityCategorySchema,
  mode: z.enum(['chat', 'agent', 'universal']).default('universal'),
  instructions: z.string(),
  tokenBudget: z.number().int().positive().default(1500),
  priority: z.number().int().default(50),
  metadata: z.record(z.string(), z.any()).default({})
});
export type PromptProfile = z.infer<typeof PromptProfileSchema>;

// ==========================================
// 2. MODEL ROUTING & POLICIES
// ==========================================

export const ModelIdSchema = z.enum([
  'aira-auto',
  'aira-fast',
  'aira-pro',
  'aira-deep',
  'claude-3-7-sonnet',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-opus', // Legacy UI ID; model router maps it to a supported Aira policy.
  'gpt-4o',
  'gpt-4o-mini',
  'gemini-2-5-pro',
  'gemini-2-5-flash',
  'gemini-3.5-flash-lite',
  'meta/llama-3.1-405b-instruct',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'nv-mistralai/mistral-nemo-12b-instruct',
  'nvidia/mistral-nemo-minitron-8b-8k-instruct',
  'nvidia/llama-3.1-nemotron-51b-instruct',
  'nvidia/nemotron-nano-3-30b-a3b',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
  'llama3.1-8b',
  'llama3.1-70b',
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  'accounts/fireworks/models/llama-v3p1-8b-instruct',
  'mock-deterministic'
]);
export type ModelId = z.infer<typeof ModelIdSchema>;

export class UnsupportedModelIdentifierError extends Error {
  readonly code = 'UNSUPPORTED_MODEL_IDENTIFIER';
  constructor() { super('Unsupported model identifier.'); }
}

/** One allowlist for browser aliases, API admission and provider routing. */
export function normalizeModelIdentifier(value: unknown = 'aira-auto'): ModelId {
  const parsed = ModelIdSchema.safeParse(value);
  if (!parsed.success || (parsed.data === 'allam-2-7b' || parsed.data === 'gemini-2-5-flash')) throw new UnsupportedModelIdentifierError();
  switch (parsed.data) {
    case 'claude-3-7-sonnet': return 'aira-auto';
    case 'claude-3-5-sonnet': return 'aira-pro';
    case 'claude-3-5-haiku': return 'aira-fast';
    case 'claude-3-opus': return 'aira-deep';
    case 'meta/llama-3.1-405b-instruct': return 'nvidia/nemotron-3-super-120b-a12b';
    default: return parsed.data;
  }
}


export const ModelPolicySchema = z.object({
  model: ModelIdSchema,
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  extendedThinking: z.boolean().default(false),
  reasoningBudget: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().default(60000)
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

// ==========================================
// 3. TOOLS & MCP DEFINITIONS
// ==========================================

export const PermissionLevelSchema = z.enum([
  'READ',
  'WRITE',
  'DESTRUCTIVE',
  'FINANCIAL',
  'EXTERNAL_COMMUNICATION'
]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const ExecutionRuntimeSchema = z.enum(['CLOUD', 'LOCAL']);
export type ExecutionRuntime = z.infer<typeof ExecutionRuntimeSchema>;

export const IdempotencyClassSchema = z.enum([
  'SAFE_READ',
  'IDEMPOTENT_WRITE',
  'EXTERNAL_SIDE_EFFECT',
  'NON_IDEMPOTENT'
]);
export type IdempotencyClass = z.infer<typeof IdempotencyClassSchema>;

export const ToolCategorySchema = z.enum([
  'browser',
  'files',
  'repo',
  'mcp',
  'connector',
  'utility',
  'system'
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

export const ToolAvailabilitySchema = z.enum([
  'READY',
  'DEGRADED',
  'NOT_READY',
  'DISABLED'
]);
export type ToolAvailability = z.infer<typeof ToolAvailabilitySchema>;

export const ToolAdapterTypeSchema = z.enum([
  'browser',
  'files',
  'repo',
  'mcp',
  'connector',
  'native',
  'local-runner'
]);
export type ToolAdapterType = z.infer<typeof ToolAdapterTypeSchema>;

export const ToolApprovalPolicySchema = z.enum([
  'autonomous',
  'require_approval',
  'always_ask'
]);
export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicySchema>;

export const ToolExecutionModeSchema = z.enum(['sync', 'async']);
export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;

export const ToolRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  backoffMs: z.number().int().min(0).default(500),
  factor: z.number().min(1).default(2),
  retryableErrorCodes: z.array(z.string()).default([])
});
export type ToolRetryPolicy = z.infer<typeof ToolRetryPolicySchema>;

export const ToolIdempotencyPolicySchema = z.object({
  required: z.boolean().default(false),
  keyField: z.string().optional()
});
export type ToolIdempotencyPolicy = z.infer<typeof ToolIdempotencyPolicySchema>;

export const ToolLifecycleStateSchema = z.enum([
  'DISCOVERED',
  'RESOLVED',
  'VALIDATED',
  'WAITING_FOR_APPROVAL',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);
export type ToolLifecycleState = z.infer<typeof ToolLifecycleStateSchema>;

export const ToolDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.any()),
  inputSchema: z.record(z.string(), z.any()).optional(),
  outputSchema: z.record(z.string(), z.any()).optional(),
  source: z.enum(['native', 'mcp', 'connector', 'local-runner']),
  permissionLevel: PermissionLevelSchema,
  executionRuntime: ExecutionRuntimeSchema,
  idempotencyClass: IdempotencyClassSchema.default('NON_IDEMPOTENT'),
  // Enhanced Unified Tool Contract Properties
  version: z.union([z.string(), z.number()]).default(1),
  category: ToolCategorySchema.default('utility'),
  sideEffectLevel: SideEffectLevelSchema.optional(),
  permissionScopes: z.array(z.string()).default([]),
  approvalPolicy: ToolApprovalPolicySchema.default('autonomous'),
  executionMode: ToolExecutionModeSchema.default('sync'),
  timeoutMs: z.number().int().positive().default(30000),
  retryPolicy: ToolRetryPolicySchema.default({ maxAttempts: 1, backoffMs: 500, factor: 2, retryableErrorCodes: [] }),
  idempotencyPolicy: ToolIdempotencyPolicySchema.default({ required: false }),
  availability: ToolAvailabilitySchema.default('READY'),
  adapter: ToolAdapterTypeSchema.default('native'),
  provider: z.string().default('aira-built-in'),
  metadata: z.record(z.string(), z.any()).default({})
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolCallStatusSchema = z.enum([
  'PENDING',
  'WAITING_FOR_APPROVAL',
  'APPROVED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED'
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  toolId: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.any()),
  timestamp: z.number(),
  status: ToolCallStatusSchema.default('PENDING'),
  idempotencyKey: z.string().optional()
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const DurableToolCallSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workflowRunId: z.string().optional(),
  agentMissionId: z.string().optional(),
  principalId: z.string(),
  toolId: z.string(),
  toolName: z.string(),
  adapter: ToolAdapterTypeSchema.default('native'),
  sideEffectLevel: SideEffectLevelSchema.default('NONE'),
  permissionScopes: z.array(z.string()).default([]),
  lifecycleState: ToolLifecycleStateSchema.default('RESOLVED'),
  arguments: z.record(z.string(), z.any()).default({}),
  output: z.any().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  attemptCount: z.number().int().positive().default(1),
  approvalId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().nonnegative().optional()
});
export type DurableToolCall = z.infer<typeof DurableToolCallSchema>;

export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  output: z.any(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  isError: z.boolean().default(false),
  durationMs: z.number().nonnegative(),
  timestamp: z.number(),
  artifacts: z.array(z.any()).default([])
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ToolGatewayErrorCodes = {
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  CAPABILITY_NOT_READY: 'CAPABILITY_NOT_READY',
  TOOL_PERMISSION_DENIED: 'TOOL_PERMISSION_DENIED',
  TOOL_INPUT_INVALID: 'TOOL_INPUT_INVALID',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_APPROVAL_DENIED: 'TOOL_APPROVAL_DENIED',
  TOOL_CANCELLED: 'TOOL_CANCELLED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT'
} as const;
export type ToolGatewayErrorCode = typeof ToolGatewayErrorCodes[keyof typeof ToolGatewayErrorCodes];

// ==========================================
// 4. APPROVAL KERNEL
// ==========================================

export const ApprovalDecisionSchema = z.enum([
  'ALLOW_ONCE',
  'ALLOW_SESSION',
  'ALLOW_ALWAYS_FOR_TOOL',
  'REJECT'
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  toolCall: ToolCallSchema,
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  title: z.string(),
  reason: z.string(),
  sanitizedPreview: z.record(z.string(), z.any()),
  requestedAt: z.number(),
  /** Server-derived workspace boundary for reusable authorization. */
  workspaceId: z.string().min(1).optional(),
  permissionLevel: PermissionLevelSchema.optional(),
  toolDefinitionVersion: z.number().int().positive().optional(),
  toolPolicyFingerprint: z.string().min(1).optional(),
  resolvedAt: z.number().optional(),
  decision: ApprovalDecisionSchema.optional(),
  resolvedBy: z.string().optional()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ==========================================
// 5. CITATIONS, SOURCES & ARTIFACTS
// ==========================================

export const CitationSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceTitle: z.string(),
  uri: z.string().optional(),
  publishedDate: z.string().optional(),
  snippet: z.string(),
  score: z.number().min(0).max(1).optional(),
  provenance: z.object({
    toolCallId: z.string().optional(),
    retrievalMechanism: z.string(),
    timestamp: z.number()
  }).optional()
});
export type Citation = z.infer<typeof CitationSchema>;

export const ArtifactVersionSchema = z.object({
  version: z.number().int().positive(),
  content: z.string(),
  timestamp: z.number()
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  title: z.string(),
  type: z.enum([
    'application/vnd.ant.code',
    'application/vnd.ant.react',
    'image/svg+xml',
    'text/html',
    'text/markdown',
    'application/vnd.ant.mermaid'
  ]),
  language: z.string().optional(),
  content: z.string(),
  version: z.number().int().positive().default(1),
  versions: z.array(ArtifactVersionSchema).default([])
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// ==========================================
// 5.5 MODEL PROVENANCE & EXECUTION CONTRACT
// ==========================================

export const ModelProvenanceSchema = z.object({
  requestedModel: z.string(),
  resolvedPolicyModel: z.string(),
  provider: z.enum(['nvidia', 'anthropic', 'openai', 'groq', 'cerebras', 'together', 'fireworks', 'mock', 'unknown']),
  requestedProvider: z.string().optional(),
  executedProvider: z.string().optional(),
  executedModel: z.string(),
  plannedModel: z.string().optional(),
  outboundModel: z.string().optional(),
  upstreamResponseModel: z.string().optional(),
  fallbackOccurred: z.boolean(),
  fallbackReason: z.string().optional(),
  verified: z.boolean(),
  executionStatus: z.enum(['PENDING', 'SUCCESS', 'FALLBACK', 'FAILED', 'UNKNOWN']),
  timestamp: z.number()
});
export type ModelProvenance = z.infer<typeof ModelProvenanceSchema>;

// ==========================================
// 6. RUN CONTRACT
// ==========================================

export const RunSchema = z.object({
  id: z.string(),
  principalId: z.string().min(1, "principalId is required"),
  principalScopes: z.array(z.string()).default([]),
  agentId: z.string().nullable().optional(),
  sessionId: z.string().min(1, "sessionId is required"),
  workspaceId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  intent: IntentTaxonomySchema.default('ANSWER'),
  routingDecision: RoutingDecisionSchema.optional(),
  provenance: ModelProvenanceSchema.optional(),
  state: RunStateSchema.default('QUEUED'),
  modelPolicy: ModelPolicySchema,
  prompt: z.string(),
  systemPrompt: z.string().optional(),
  context: z.record(z.string(), z.any()).default({}),
  content: z.string().default(''),
  thinking: z.string().default(''),
  toolsUsed: z.array(z.string()).default([]),
  toolCalls: z.array(ToolCallSchema).default([]),
  toolResults: z.array(ToolResultSchema).default([]),
  pendingApproval: ApprovalRequestSchema.optional(),
  artifacts: z.array(ArtifactSchema).default([]),
  citations: z.array(CitationSchema).default([]),
  error: z.string().optional(),
  stepCount: z.number().int().nonnegative().default(0),
  maxSteps: z.number().int().positive().default(10),
  executionCheckpoint: ExecutionCheckpointSchema.optional(),
  recoveryOwner: z.string().optional(),
  recoveryClaimedAt: z.number().optional(),
  recoveryLeaseUntil: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional()
});
export type Run = z.infer<typeof RunSchema>;

export const CreateRunRequestSchema = z.object({
  prompt: z.string().min(1),
  intent: IntentTaxonomySchema.optional(),
  modelPolicy: z.object({
    model: ModelIdSchema.optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    extendedThinking: z.boolean().optional(),
    reasoningBudget: z.number().optional()
  }).optional(),
  systemPrompt: z.string().optional(),
  context: z.record(z.string(), z.any()).optional(),
  conversationId: z.string().optional(),
  projectId: z.string().optional(),
  attachments: z.array(z.any()).optional()
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;


// ==========================================
// 7. EVENTS & STREAMING ENVELOPES
// ==========================================

export const StreamingEventTypeSchema = z.enum([
  'run.created',
  'run.started',
  'routing.decision',
  'model.provenance',
  'thinking.delta',
  'content.delta',
  'tool.requested',
  'tool.resolved',
  'tool.validation_failed',
  'tool.approval_required',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.failed',
  'tool.cancelled',
  'browser.navigation',
  'browser.action',
  'browser.download',
  'approval.required',
  'approval.resolved',
  'capability.unready',
  'artifact.created',
  'artifact.updated',
  'source.added',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'workflow.created',
  'workflow.started',
  'workflow.step.ready',
  'workflow.step.started',
  'workflow.step.progress',
  'workflow.step.completed',
  'workflow.step.failed',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled'
]);
export type StreamingEventType = z.infer<typeof StreamingEventTypeSchema>;

export const StreamingEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  sequence: z.number().optional(),
  type: StreamingEventTypeSchema,
  timestamp: z.number(),
  data: z.any()
});
export type StreamingEvent = z.infer<typeof StreamingEventSchema>;

// ==========================================
// 8. KNOWLEDGE GRAPH & BRAIN V2
// ==========================================

export const PrincipalScopeSchema = z.object({
  principalId: z.string().optional(),
  workspaceId: z.string().optional(),
  isSystem: z.boolean().default(false)
});
export type PrincipalScope = z.infer<typeof PrincipalScopeSchema>;

export const KnowledgeSourceSchema = z.object({
  id: z.string(),
  principalId: z.string().optional(),
  workspaceId: z.string().optional(),
  isSystem: z.boolean().default(false),
  visibility: z.enum(['private', 'workspace', 'system', 'quarantined']).default('private'),
  projectId: z.string().optional(),
  title: z.string(),
  uri: z.string().optional(),
  mimeType: z.string(),
  contentHash: z.string(), // SHA-256
  rawContent: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

export const KnowledgeChunkSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  principalId: z.string().optional(),
  isSystem: z.boolean().default(false),
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  tokenCount: z.number().int().positive(),
  contentHash: z.string()
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

export const KnowledgeEntitySchema = z.object({
  id: z.string(),
  principalId: z.string().optional(),
  workspaceId: z.string().optional(),
  isSystem: z.boolean().default(false),
  name: z.string(),
  type: z.string(), // concept, service, decision, constraint, person, task
  confidence: z.number().min(0).max(1),
  sourceIds: z.array(z.string()),
  needsReview: z.boolean().default(false),
  contested: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type KnowledgeEntity = z.infer<typeof KnowledgeEntitySchema>;

export const KnowledgeEdgeSchema = z.object({
  id: z.string(),
  principalId: z.string().optional(),
  isSystem: z.boolean().default(false),
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  relation: z.string(), // DEPENDS_ON, CONFLICTS_WITH, DEFINES, REFERENCES
  confidence: z.number().min(0).max(1),
  provenanceSourceId: z.string(),
  createdAt: z.number()
});
export type KnowledgeEdge = z.infer<typeof KnowledgeEdgeSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string(),
  principalId: z.string().optional(),
  workspaceId: z.string().optional(),
  isSystem: z.boolean().default(false),
  key: z.string(),
  value: z.string(),
  category: z.enum(['fact', 'decision', 'preference', 'pattern', 'constraint']),
  confidence: z.number().min(0).max(1),
  provenance: z.string(),
  stale: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

// ==========================================
// 9. AGENT & AUTOMATIONS
// ==========================================

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  principalId: z.string().optional(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  modelPolicy: ModelPolicySchema,
  tools: z.array(z.string()),
  memoryScopes: z.array(z.string()).default(['workspace']),
  approvalPolicy: z.enum(['always_ask', 'risky_only', 'autonomous']).default('risky_only'),
  maxSteps: z.number().int().positive().default(10),
  timeoutMs: z.number().int().positive().default(60000)
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AutomationTriggerTypeSchema = z.enum([
  'MANUAL',
  'CRON',
  'ONE_TIME',
  'EVENT',
  'WEBHOOK'
]);
export type AutomationTriggerType = z.infer<typeof AutomationTriggerTypeSchema>;

export const SchedulerCapabilitiesSchema = z.object({
  active: z.boolean(),
  mode: z.enum(['IN_PROCESS', 'SERVERLESS_CRON', 'UNAVAILABLE']),
  reason: z.string().optional()
});
export type SchedulerCapabilities = z.infer<typeof SchedulerCapabilitiesSchema>;

export const AutomationDefinitionSchema = z.object({
  id: z.string(),
  principalId: z.string().optional(),
  name: z.string(),
  enabled: z.boolean().default(false),
  trigger: AutomationTriggerTypeSchema,
  cronExpression: z.string().optional(),
  targetRunAt: z.number().optional(),
  timezone: z.string().optional(),
  conditions: z.record(z.string(), z.any()).default({}),
  agentId: z.string(),
  objective: z.string(),
  approvalPolicy: z.enum(['always_ask', 'risky_only', 'autonomous']).default('autonomous'),
  lastRun: z.number().optional(),
  nextRun: z.number().optional(),
  failureState: z.string().optional()
});
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;

export const AutomationRunSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  runId: z.string().optional(),
  scheduledFor: z.number(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  attempt: z.number().int().positive().default(1),
  status: z.enum(['CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED']),
  error: z.string().optional(),
  claimedAt: z.number().optional()
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

// ==========================================
// 9.5 WORKFLOW CONTRACTS & DAG ENGINE
// ==========================================

export const WorkflowStateSchema = z.enum([
  'CREATED',
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const WorkflowStepStateSchema = z.enum([
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED'
]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

export const WorkflowStepTypeSchema = z.enum([
  'CAPABILITY',
  'TOOL',
  'SYNTHESIS',
  'APPROVAL',
  'TRANSFORM'
]);
export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;

export const StepRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(3),
  backoffMs: z.number().int().min(50).default(1000),
  factor: z.number().min(1).default(2)
});
export type StepRetryPolicy = z.infer<typeof StepRetryPolicySchema>;

export const WorkflowStepDefinitionSchema = z.object({
  stepId: z.string().min(1),
  name: z.string().min(1),
  type: WorkflowStepTypeSchema.default('CAPABILITY'),
  capability: IntentTaxonomySchema.optional(),
  toolName: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  input: z.record(z.string(), z.any()).default({}),
  sideEffectLevel: SideEffectLevelSchema.default('NONE'),
  approvalRequired: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(60000),
  retry: StepRetryPolicySchema.default({ maxAttempts: 3, backoffMs: 1000, factor: 2 }),
  idempotencyKey: z.string().optional()
});
export type WorkflowStepDefinition = z.infer<typeof WorkflowStepDefinitionSchema>;

export const WorkflowDefinitionSchema = z.object({
  workflowId: z.string().min(1),
  version: z.number().int().positive().default(1),
  name: z.string().min(1),
  description: z.string().optional(),
  principalId: z.string().optional(),
  inputSchema: z.record(z.string(), z.any()).default({}),
  steps: z.array(WorkflowStepDefinitionSchema).min(1),
  executionPolicy: z.object({
    maxConcurrentSteps: z.number().int().positive().default(3),
    timeoutMs: z.number().int().positive().default(300000)
  }).default({ maxConcurrentSteps: 3, timeoutMs: 300000 }),
  outputSchema: z.record(z.string(), z.any()).default({}),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now())
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WorkflowStepExecutionSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  stepId: z.string(),
  name: z.string(),
  state: WorkflowStepStateSchema,
  dependsOn: z.array(z.string()),
  attempt: z.number().int().positive().default(1),
  input: z.any().optional(),
  output: z.any().optional(),
  error: z.string().optional(),
  sideEffectLevel: SideEffectLevelSchema,
  approvalRequired: z.boolean(),
  idempotencyKey: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional()
});
export type WorkflowStepExecution = z.infer<typeof WorkflowStepExecutionSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  runId: z.string(),
  principalId: z.string(),
  sessionId: z.string(),
  state: WorkflowStateSchema,
  stepStates: z.record(z.string(), WorkflowStepStateSchema),
  stepOutputs: z.record(z.string(), z.any()).default({}),
  stepAttempts: z.record(z.string(), z.number()).default({}),
  pendingApprovalStepId: z.string().optional(),
  artifacts: z.array(ArtifactSchema).default([]),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional()
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export interface DagValidationResult {
  valid: boolean;
  error?: string;
  executionWaves?: string[][];
}

export function validateWorkflowDag(definition: WorkflowDefinition): DagValidationResult {
  const stepIds = new Set<string>();
  for (const step of definition.steps) {
    if (stepIds.has(step.stepId)) {
      return { valid: false, error: `Duplicate step ID: "${step.stepId}"` };
    }
    stepIds.add(step.stepId);
  }

  // Validate dependencies exist and no self-dependency
  for (const step of definition.steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.stepId) {
        return { valid: false, error: `Step "${step.stepId}" cannot depend on itself.` };
      }
      if (!stepIds.has(dep)) {
        return { valid: false, error: `Step "${step.stepId}" depends on non-existent step "${dep}".` };
      }
    }
  }

  // Topological wave sort (Kahn's algorithm)
  const inDegree: Map<string, number> = new Map();
  const outgoing: Map<string, string[]> = new Map();

  for (const step of definition.steps) {
    inDegree.set(step.stepId, step.dependsOn.length);
    outgoing.set(step.stepId, []);
  }

  for (const step of definition.steps) {
    for (const dep of step.dependsOn) {
      outgoing.get(dep)!.push(step.stepId);
    }
  }

  const waves: string[][] = [];
  let remainingCount = definition.steps.length;

  while (remainingCount > 0) {
    const currentWave: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        currentWave.push(id);
      }
    }

    if (currentWave.length === 0) {
      return { valid: false, error: 'Cycle detected in workflow dependency graph.' };
    }

    waves.push(currentWave);
    for (const id of currentWave) {
      inDegree.set(id, -1); // mark visited
      remainingCount--;
      for (const next of outgoing.get(id)!) {
        const d = inDegree.get(next)!;
        inDegree.set(next, d - 1);
      }
    }
  }

  return { valid: true, executionWaves: waves };
}

// ==========================================
// 10. ERROR ENVELOPE
// ==========================================

export const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.any().optional(),
  timestamp: z.number()
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export * from './behavioral.js';
export * from './commercial.js';
export * from './agent-specialists.js';

