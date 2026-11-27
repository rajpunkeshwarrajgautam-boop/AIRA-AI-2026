import { z } from 'zod';

export const AIRA_COLLAB_CONTRACT_VERSION = 'aira-collab/v1' as const;

export const CollabActorRoleSchema = z.enum([
  'owner',
  'editor',
  'viewer',
  'agent',
]);
export type CollabActorRole = z.infer<typeof CollabActorRoleSchema>;

export const CollabActorSchema = z.object({
  actorId: z.string().min(1).max(128),
  principalId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  role: CollabActorRoleSchema,
  isAgent: z.boolean().default(false),
  agentRole: z.string().max(64).optional(),
  runId: z.string().max(128).optional(),
  taskId: z.string().max(128).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'),
});
export type CollabActor = z.infer<typeof CollabActorSchema>;

export const CollabOperationTypeSchema = z.enum([
  'text_insert',
  'text_delete',
  'text_replace',
  'cell_update',
  'slide_mutate',
  'diagram_mutate',
  'artifact_replace',
]);
export type CollabOperationType = z.infer<typeof CollabOperationTypeSchema>;

export const CollabOperationPayloadSchema = z.object({
  position: z.number().int().min(0).optional(),
  text: z.string().optional(),
  length: z.number().int().min(0).optional(),
  cellCoord: z.string().regex(/^[A-Z]+[0-9]+$/).optional(),
  cellValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  cellFormula: z.string().optional(),
  sheetName: z.string().optional(),
  slideId: z.string().optional(),
  slideAction: z.enum(['insert', 'update', 'reorder', 'delete']).optional(),
  slideIndex: z.number().int().min(0).optional(),
  slideData: z.unknown().optional(),
  diagramData: z.unknown().optional(),
  fullContent: z.string().optional(),
});
export type CollabOperationPayload = z.infer<typeof CollabOperationPayloadSchema>;

export const CollabOperationSchema = z.object({
  opId: z.string().uuid(),
  sessionId: z.string().min(1).max(128),
  artifactId: z.string().min(1).max(128),
  actor: CollabActorSchema,
  baseSeq: z.number().int().min(0),
  lamportClock: z.number().int().min(0),
  timestamp: z.number().int().min(0),
  type: CollabOperationTypeSchema,
  payload: CollabOperationPayloadSchema,
});
export type CollabOperation = z.infer<typeof CollabOperationSchema>;

export const CollabCursorSchema = z.union([
  z.object({ line: z.number().int().min(0), ch: z.number().int().min(0) }),
  z.object({ cellCoord: z.string() }),
  z.object({ slideIndex: z.number().int().min(0) }),
]);
export type CollabCursor = z.infer<typeof CollabCursorSchema>;

export const CollabPresenceSchema = z.object({
  actorId: z.string(),
  actor: CollabActorSchema,
  artifactId: z.string(),
  cursor: CollabCursorSchema.optional(),
  selection: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
  status: z.enum(['active', 'idle', 'disconnected']).default('active'),
  updatedAt: z.number().int(),
});
export type CollabPresence = z.infer<typeof CollabPresenceSchema>;

export const CollabSessionStateSchema = z.object({
  sessionId: z.string(),
  artifactId: z.string(),
  currentSeq: z.number().int().min(0),
  stateVector: z.record(z.string(), z.number().int().min(0)), // actorId => maxLamport
  participants: z.record(z.string(), CollabPresenceSchema),
  lastDurableSaveAt: z.number().int().optional(),
});
export type CollabSessionState = z.infer<typeof CollabSessionStateSchema>;

export const CollabWireMessageTypeSchema = z.enum([
  'SYNC_STEP1',
  'SYNC_STEP2',
  'OPERATION',
  'PRESENCE',
  'ACK',
  'REJECT',
]);
export type CollabWireMessageType = z.infer<typeof CollabWireMessageTypeSchema>;

export const CollabWireMessageSchema = z.object({
  version: z.literal(AIRA_COLLAB_CONTRACT_VERSION),
  type: CollabWireMessageTypeSchema,
  sessionId: z.string(),
  artifactId: z.string(),
  seq: z.number().int().min(0).optional(),
  operation: CollabOperationSchema.optional(),
  presence: CollabPresenceSchema.optional(),
  stateVector: z.record(z.string(), z.number().int().min(0)).optional(),
  missingOps: z.array(CollabOperationSchema).optional(),
  error: z.string().optional(),
});
export type CollabWireMessage = z.infer<typeof CollabWireMessageSchema>;
