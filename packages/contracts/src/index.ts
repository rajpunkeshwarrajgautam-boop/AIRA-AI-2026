import { z } from 'zod';

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
  'gpt-4o',
  'gpt-4o-mini',
  'gemini-2-5-pro',
  'gemini-2-5-flash',
  'mock-deterministic'
]);
export type ModelId = z.infer<typeof ModelIdSchema>;

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

export const ToolDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.any()),
  outputSchema: z.record(z.string(), z.any()).optional(),
  source: z.enum(['native', 'mcp', 'connector', 'local-runner']),
  permissionLevel: PermissionLevelSchema,
  executionRuntime: ExecutionRuntimeSchema,
  idempotencyClass: IdempotencyClassSchema.default('NON_IDEMPOTENT')
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

export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  output: z.any(),
  error: z.string().optional(),
  isError: z.boolean().default(false),
  durationMs: z.number().nonnegative(),
  timestamp: z.number()
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

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
  snippet: z.string(),
  score: z.number().min(0).max(1).optional()
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
// 6. RUN CONTRACT
// ==========================================

export const RunSchema = z.object({
  id: z.string(),
  userId: z.string().default('user-default'),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
  intent: IntentTaxonomySchema.default('ANSWER'),
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
  projectId: z.string().optional()
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;


// ==========================================
// 7. EVENTS & STREAMING ENVELOPES
// ==========================================

export const StreamingEventTypeSchema = z.enum([
  'run.created',
  'run.started',
  'thinking.delta',
  'content.delta',
  'tool.requested',
  'tool.started',
  'tool.completed',
  'approval.required',
  'approval.resolved',
  'artifact.created',
  'artifact.updated',
  'source.added',
  'run.completed',
  'run.failed',
  'run.cancelled'
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

export const KnowledgeSourceSchema = z.object({
  id: z.string(),
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
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  tokenCount: z.number().int().positive(),
  contentHash: z.string()
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

export const KnowledgeEntitySchema = z.object({
  id: z.string(),
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
  'EVENT',
  'WEBHOOK'
]);
export type AutomationTriggerType = z.infer<typeof AutomationTriggerTypeSchema>;

export const AutomationDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  trigger: AutomationTriggerTypeSchema,
  cronExpression: z.string().optional(),
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
// 10. ERROR ENVELOPE
// ==========================================

export const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.any().optional(),
  timestamp: z.number()
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
