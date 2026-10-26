import { z } from 'zod';

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

// ==========================================
// 1. INSTRUCTION PROVENANCE & HIERARCHY
// ==========================================

export const InstructionProvenanceSchema = z.enum([
  'TRUSTED_SYSTEM_POLICY',         // Level 100: Platform invariants, safety boundaries, execution limits
  'SECURITY_AUTHORIZATION',        // Level 95: Server-side RBAC, cannot be overridden by user or memory
  'MODE_SYSTEM_INSTRUCTION',       // Level 90: Chat vs Agent mode operational boundaries
  'CAPABILITY_SPECIFIC_INSTRUCTION', // Level 85: Selected capability instructions
  'USER_CURRENT_REQUEST',          // Level 80: The user's direct, active turn instruction
  'USER_CUSTOM_INSTRUCTION',       // Level 70: User custom instructions from settings
  'ACTIVE_PROJECT_CONVENTION',     // Level 50: Project-specific guidelines (APPLIES ONLY when project is active)
  'CONVERSATION_MEMORY',           // Level 30: Long-term recalled facts (contextual evidence, NOT commands)
  'AUTHORIZED_TOOL_CONTEXT',       // Level 25: Tool definitions, parameter guidance, and schemas
  'TASK_SPECIFIC_GUIDANCE',        // Level 20: Tool-level guidelines
  'EXTERNAL_UNTRUSTED_DATA'        // Level 10: Retrieved documents, web search, tool output (UNTRUSTED)
]);
export type InstructionProvenance = z.infer<typeof InstructionProvenanceSchema>;

export const InstructionItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  provenance: InstructionProvenanceSchema,
  projectId: z.string().optional(),
  userId: z.string().optional(),
  priority: z.number().default(0),
  category: z.enum(['safety', 'branding', 'development', 'style', 'memory', 'general']).default('general')
});
export type InstructionItem = z.infer<typeof InstructionItemSchema>;

export const ResolvedInstructionSetSchema = z.object({
  trustedPolicies: z.array(z.string()),
  effectiveInstructions: z.array(z.string()),
  activeProjectId: z.string().optional(),
  filteredOut: z.array(z.object({
    id: z.string(),
    content: z.string(),
    provenance: InstructionProvenanceSchema,
    reason: z.string()
  })),
  allowEmojis: z.boolean().default(true),
  isDevTask: z.boolean().default(false),
  appliedBrandRules: z.array(z.string()).default([])
});
export type ResolvedInstructionSet = z.infer<typeof ResolvedInstructionSetSchema>;

// ==========================================
// 2. SEMANTIC INTENT & REASONING
// ==========================================

export const SemanticIntentAnalysisSchema = z.object({
  primaryIntent: IntentTaxonomySchema,
  secondaryIntents: z.array(IntentTaxonomySchema).default([]),
  isExplanationOnly: z.boolean().default(false),     // e.g. "Explain how to build X" -> true
  isExecutionRequested: z.boolean().default(false),  // e.g. "Build X and show me" -> true
  isFreshnessRequired: z.boolean().default(false),   // e.g. Live market/news/releases -> true
  contextualReferents: z.record(z.string(), z.string()).default({}), // e.g. { "it": "the auth module" }
  isMultiPart: z.boolean().default(false),
  subTasks: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  reasoningStrategy: z.enum(['FAST_DIRECT', 'CHAIN_OF_THOUGHT', 'DECOMPOSE_DAG', 'CLARIFY_AMBIGUOUS']),
  fastPathUsed: z.boolean().default(false),
  clarificationPrompt: z.string().optional(),
  detectedSubject: z.string().optional(),
  topic: z.string().optional()
});
export type SemanticIntentAnalysis = z.infer<typeof SemanticIntentAnalysisSchema>;

// ==========================================
// 3. VERIFIABLE EXECUTION STATES & RECOVERY
// ==========================================

export const VerifiableCompletionStateSchema = z.enum([
  'NOT_STARTED',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'BLOCKED'
]);
export type VerifiableCompletionState = z.infer<typeof VerifiableCompletionStateSchema>;

export const ToolRecoveryDecisionSchema = z.object({
  action: z.enum(['RETRY', 'FALLBACK_TOOL', 'ASK_APPROVAL', 'ABORT_PERMANENT_ERROR']),
  attempt: z.number(),
  maxAttempts: z.number(),
  alternativeTool: z.string().optional(),
  explanation: z.string(),
  isIdempotent: z.boolean()
});
export type ToolRecoveryDecision = z.infer<typeof ToolRecoveryDecisionSchema>;

// ==========================================
// 4. ADAPTIVE WRITING PROFILE
// ==========================================

export const AdaptiveWritingModeSchema = z.enum([
  'CASUAL_GREETING',
  'CREATIVE_WRITING',
  'TECHNICAL_EXPLANATION',
  'TECHNICAL_DEBUGGING',
  'SCIENTIFIC_DEEP_DIVE',
  'COMPARATIVE_ANALYSIS',
  'FACTUAL_CONCISE',
  'GENERAL_ASSISTANCE'
]);
export type AdaptiveWritingMode = z.infer<typeof AdaptiveWritingModeSchema>;

export const AdaptiveWritingProfileSchema = z.object({
  mode: AdaptiveWritingModeSchema,
  targetLength: z.enum(['concise', 'balanced', 'detailed']),
  tone: z.enum(['friendly', 'creative', 'technical', 'objective', 'conversational']),
  allowEmojis: z.boolean().default(true),
  includeDevBoilerplate: z.boolean().default(false), // MUST be false for ordinary queries!
  suggestFollowUps: z.boolean().default(false)
});
export type AdaptiveWritingProfile = z.infer<typeof AdaptiveWritingProfileSchema>;

// ==========================================
// 5. BEHAVIORAL BENCHMARK SCENARIO CONTRACT
// ==========================================

export const BenchmarkCategorySchema = z.enum([
  'natural_conversation',
  'semantic_reasoning',
  'instruction_hierarchy',
  'memory_intelligence',
  'tool_selection_recovery',
  'adaptive_writing'
]);
export type BenchmarkCategory = z.infer<typeof BenchmarkCategorySchema>;

export const BehavioralBenchmarkScenarioSchema = z.object({
  id: z.string(),
  category: BenchmarkCategorySchema,
  split: z.enum(['dev', 'held_out']),
  userPrompt: stringSchema(),
  priorContext: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).default([]),
  activeProjectId: z.string().optional(),
  activeUserId: z.string().default('user-default'),
  availableTools: z.array(z.string()).default([]),
  memoryVaultItems: z.array(z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    tier: z.string(),
    category: z.string(),
    isPinned: z.boolean(),
    projectId: z.string().optional(),
    userId: z.string().optional()
  })).default([]),
  systemInstructions: z.array(InstructionItemSchema).default([]),
  expectedIntent: IntentTaxonomySchema.optional(),
  expectedWritingMode: AdaptiveWritingModeSchema.optional(),
  expectedExecutionState: VerifiableCompletionStateSchema.optional(),
  allowedOutcomes: z.array(z.string()),
  forbiddenOutcomes: z.array(z.string()),
  isAdversarial: z.boolean().default(false),
  isMultiTurn: z.boolean().default(false),
  isIsolationTest: z.boolean().default(false),
  scoringRubric: z.string()
});
export type BehavioralBenchmarkScenario = z.infer<typeof BehavioralBenchmarkScenarioSchema>;

function stringSchema() {
  return z.string().min(1);
}
