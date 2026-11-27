import { randomUUID } from 'node:crypto';
import type {
  CollabActor,
  CollabOperation,
  CollabOperationType,
  CollabOperationPayload,
} from '../../contracts/src/collaboration.js';
import type { AutonomousAgentTask } from '../../contracts/src/autonomous-agent.js';
import type { Artifact } from '../../../src/types/index.js';
import { CollaborationSessionManager, type SessionAuthContext } from '../../../src/server/collaborationManager.js';
import { CollaborativeDocumentEngine, type ApplyOpResult } from '../../../src/utils/collaborationEngine.js';

export interface CollaborativeAgentBridgeOptions {
  sessionManager?: CollaborationSessionManager;
}

/**
 * CollaborativeAgentBridge binds the Autonomous Intelligence Platform (AutonomousAgentEngine & Specialist Agents)
 * to the Phase 4C Real-Time Collaborative Canvas (aira-collab/v1 and aira-artifact/v1).
 *
 * Guarantees:
 * - Every agent edit is strictly attributed (isAgent: true, agentRole, runId, taskId, principalId).
 * - Multi-tenant isolation: operations must match task principal and workspace authority.
 * - Human edits are never silently overwritten: concurrent edits undergo causal positional rebase and AST recalculation.
 * - Same-cell conflicts on spreadsheets surface collision alerts and actor attribution.
 * - Bounded payload enforcement (<= 512 KB per operation).
 * - Automatic synchronization of convergent artifact state back to AutonomousAgentTask.artifacts.
 */
export class CollaborativeAgentBridge {
  private sessionManager: CollaborationSessionManager;

  constructor(options: CollaborativeAgentBridgeOptions = {}) {
    this.sessionManager = options.sessionManager || new CollaborationSessionManager();
  }

  public getSessionManager(): CollaborationSessionManager {
    return this.sessionManager;
  }

  /**
   * Constructs an authoritative CollabActor for an autonomous specialist agent.
   */
  public createAgentActor(
    task: AutonomousAgentTask,
    stepId: string,
    role = 'specialist',
    displayName?: string
  ): CollabActor {
    const formattedRole = role.charAt(0).toUpperCase() + role.slice(1);
    return {
      actorId: `agent_${role}_${stepId}`,
      principalId: task.principal.userId,
      displayName: displayName || `${formattedRole} Agent`,
      role: 'editor',
      isAgent: true,
      agentRole: role,
      runId: task.taskId,
      taskId: stepId,
      color: '#8B5CF6',
    };
  }

  /**
   * Creates or joins a collaborative session for an artifact under task authorization.
   */
  public getOrCreateSession(
    sessionId: string,
    initialArtifact: Artifact,
    task: AutonomousAgentTask
  ): CollaborativeDocumentEngine {
    const authContext: SessionAuthContext = {
      principalId: task.principal.userId,
      tenantId: task.principal.workspaceId,
      conversationId: task.taskId,
    };
    return this.sessionManager.getOrCreateSession(sessionId, initialArtifact, authContext);
  }

  /**
   * Submits a targeted collaborative operation on behalf of an autonomous agent.
   */
  public async submitAgentOperation(
    sessionId: string,
    actor: CollabActor,
    opType: CollabOperationType,
    payload: CollabOperationPayload,
    task: AutonomousAgentTask,
    options?: { baseSeq?: number }
  ): Promise<ApplyOpResult> {
    const authContext: SessionAuthContext = {
      principalId: task.principal.userId,
      tenantId: task.principal.workspaceId,
      conversationId: task.taskId,
    };

    const sessionState = this.sessionManager.getSessionState(sessionId);
    const baseSeq = options?.baseSeq !== undefined ? options.baseSeq : (sessionState ? sessionState.currentSeq : 1);
    const currentClock = sessionState?.stateVector[actor.actorId] || 0;

    const op: CollabOperation = {
      opId: randomUUID(),
      sessionId,
      artifactId: sessionState?.artifactId || sessionId,
      actor,
      baseSeq,
      lamportClock: currentClock + 1,
      timestamp: Date.now(),
      type: opType,
      payload,
    };

    const result = await this.sessionManager.submitOperation(sessionId, op, authContext);

    // If this mutation caused a conflict, record it into task working memory
    if (result.conflictDetected) {
      if (!task.workingMemory) task.workingMemory = {};
      const conflicts = (task.workingMemory.collabConflicts as any[]) || [];
      conflicts.push({
        sessionId,
        opId: op.opId,
        actorId: actor.actorId,
        details: result.conflictDetails,
        timestamp: Date.now(),
      });
      task.workingMemory.collabConflicts = conflicts;
    }

    return result;
  }

  /**
   * Synchronizes the latest convergent artifact state from the collaborative session
   * back into the autonomous task's artifacts collection.
   */
  public syncArtifactToTask(sessionId: string, task: AutonomousAgentTask): Artifact {
    const session = this.sessionManager.getSessionState(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    // Retrieve engine to get latest content and attributes
    const dummyArtifact: Artifact = {
      id: session.artifactId,
      title: 'Sync',
      type: 'text/markdown',
      content: '',
      version: session.currentSeq,
      versions: [],
    };
    const engine = this.getOrCreateSession(sessionId, dummyArtifact, task);

    const updatedArtifact: Artifact = {
      id: engine.artifactId,
      title: engine.title,
      type: engine.artifactType,
      content: engine.getContent(),
      version: engine.getCurrentSeq(),
      versions: [],
    };

    // Update or insert into task.artifacts
    if (!task.artifacts) task.artifacts = [];
    const existingIdx = task.artifacts.findIndex((a) => a.id === updatedArtifact.id);
    if (existingIdx !== -1) {
      task.artifacts[existingIdx] = updatedArtifact;
    } else {
      task.artifacts.push(updatedArtifact);
    }

    return updatedArtifact;
  }

  /**
   * Coordinates multi-agent concurrent co-authoring on a shared artifact.
   * Multiple distinct specialist agents submit edits that converge safely.
   */
  public async coAuthorMultiAgent(
    sessionId: string,
    operations: Array<{
      role: string;
      stepId: string;
      displayName?: string;
      opType: CollabOperationType;
      payload: CollabOperationPayload;
    }>,
    task: AutonomousAgentTask
  ): Promise<ApplyOpResult[]> {
    const results: ApplyOpResult[] = [];
    for (const item of operations) {
      const actor = this.createAgentActor(task, item.stepId, item.role, item.displayName);
      const res = await this.submitAgentOperation(sessionId, actor, item.opType, item.payload, task);
      results.push(res);
    }
    this.syncArtifactToTask(sessionId, task);
    return results;
  }
}
