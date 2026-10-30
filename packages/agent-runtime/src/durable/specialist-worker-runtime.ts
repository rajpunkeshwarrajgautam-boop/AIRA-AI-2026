import {
  SpecialistExecutionContext,
  SpecialistExecutionResult,
  ISpecialistAgent
} from '../specialists/specialist-interface.js';
import {
  ExecutionPrincipal,
  SpecialistTaskOutcome
} from '../../../contracts/src/index.js';
import { SpecialistRegistry } from '../specialists/specialist-registry.js';
import {
  SpecialistTaskRepository,
  DurableSpecialistTask
} from './specialist-task-repository.js';
import { TaskLeaseManager } from './task-lease-manager.js';
import { StaleFencingTokenError } from './task-state-machine.js';
import { validateDurableToolScopes } from './tool-authorization.js';

export interface WorkerRuntimeOptions {
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

export class SpecialistWorkerRuntime {
  public readonly workerId: string;
  private leaseDurationMs: number;
  private heartbeatIntervalMs: number;
  private running = false;
  private activeTasks: Map<string, { abortController: AbortController; heartbeatTimer: NodeJS.Timeout }> = new Map();

  constructor(
    private repository: SpecialistTaskRepository,
    private leaseManager: TaskLeaseManager,
    private registry: SpecialistRegistry,
    options: WorkerRuntimeOptions = {}
  ) {
    this.workerId = options.workerId || `worker_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
  }

  private async assertActiveTaskWorkspace(task: DurableSpecialistTask): Promise<void> {
    const identity = await this.repository.getAuthoritativeExecutionIdentity?.(task.id);
    if (
      !identity || !task.principalId || !task.workspaceId ||
      identity.taskPrincipalId !== task.principalId ||
      identity.runPrincipalId !== task.principalId ||
      identity.taskWorkspaceId !== task.workspaceId ||
      identity.runWorkspaceId !== task.workspaceId ||
      identity.workspaceAuthorityActive !== true
    ) {
      throw Object.assign(new Error('Durable task owner or workspace authority is missing, revoked, or mismatched.'), {
        code: 'WORKER_AUTHORIZATION_DENIED'
      });
    }
  }

  /**
   * Executes a single assigned task through the full durable specialist lifecycle.
   */
  public async executeTask(task: DurableSpecialistTask): Promise<SpecialistExecutionResult> {
    const startedAt = Date.now();

    // 1. Claim task lease atomically
    const claimResult = await this.leaseManager.acquireLease(
      task.id,
      this.workerId,
      this.leaseDurationMs,
      task.fencingToken
    );

    if (!claimResult.success || !claimResult.task) {
      throw new Error(`Failed to claim task "${task.id}": ${claimResult.error}`);
    }

    const claimedTask = claimResult.task;
    const fencingToken = claimedTask.fencingToken;

    // Transition state from CLAIMED to RUNNING
    await this.repository.updateTaskState(claimedTask.id, 'RUNNING', fencingToken);
    await this.repository.appendCheckpoint(claimedTask.id, fencingToken, 'RUNNING');

    // 2. Setup Heartbeat and Cancellation
    const abortCtrl = new AbortController();
    const heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await this.leaseManager.renewLease(
          claimedTask.id,
          this.workerId,
          fencingToken,
          this.leaseDurationMs
        );
        if (!renewed) {
          console.warn(`[SpecialistWorkerRuntime] Lease renewal rejected for task ${claimedTask.id} (worker fenced out).`);
          abortCtrl.abort();
        }
      } catch (err) {
        console.error(`[SpecialistWorkerRuntime] Heartbeat failed for task ${claimedTask.id}:`, err);
      }
    }, this.heartbeatIntervalMs);

    this.activeTasks.set(claimedTask.id, { abortController: abortCtrl, heartbeatTimer });

    // Setup task timeout
    const timeoutTimer = setTimeout(() => {
      abortCtrl.abort(new Error(`Task exceeded timeout limit of ${claimedTask.timeoutMs}ms.`));
    }, claimedTask.timeoutMs);

    try {
      // 3. Resolve Specialist Implementation
      const specialist = this.registry.getSpecialist(claimedTask.role);
      if (!specialist) {
        // Truthful report: Role contract exists, but no runnable implementation is registered
        await this.repository.updateTaskState(claimedTask.id, 'UNAVAILABLE', fencingToken, {
          errorDetails: {
            code: 'SPECIALIST_UNAVAILABLE',
            message: `Specialist role "${claimedTask.role}" has no runnable implementation registered in this environment.`,
            retryable: false
          }
        });

        return {
          taskId: claimedTask.id,
          runId: claimedTask.runId,
          role: claimedTask.role,
          outcome: 'UNAVAILABLE',
          usage: { tokensUsed: 0, durationMs: Date.now() - startedAt },
          provenance: { workerId: this.workerId },
          error: {
            code: 'SPECIALIST_UNAVAILABLE',
            message: `Specialist role "${claimedTask.role}" is UNAVAILABLE.`,
            retryable: false
          },
          timing: { startedAt, completedAt: Date.now() }
        };
      }

      // 4. Verify the worker's persisted owner/workspace against the authoritative parent run.
      await this.assertActiveTaskWorkspace(claimedTask);

      const scopes = validateDurableToolScopes(claimedTask.role, claimedTask.executionConstraints?.allowedTools || []);
      if (!scopes.valid) {
        throw Object.assign(new Error(scopes.error || 'Durable task tool allowlist is invalid.'), {
          code: 'WORKER_AUTHORIZATION_DENIED'
        });
      }

      // A durable execution gets a task-scoped worker session, not an invented
      // long-lived user session. Authorization is still bound to the persisted owner.
      const principal: ExecutionPrincipal = {
        userId: claimedTask.principalId,
        sessionId: `durable_${claimedTask.id}`,
        workspaceId: claimedTask.workspaceId,
        role: 'user'
      };

      const executionContext: SpecialistExecutionContext = {
        runId: claimedTask.runId,
        taskId: claimedTask.id,
        principal,
        tenantId: claimedTask.workspaceId,
        workspaceId: claimedTask.workspaceId,
        authorizedCapabilities: specialist.requiredCapabilities,
        effectiveToolScopes: scopes.requested,
        executionPolicyVersion: '2026.2.0',
        promptProfileId: 'profile_specialist_default',
        promptProfileVersion: '1.0.0',
        modelRoutingRequirements: {},
        remainingBudget: {
          maxTokens: claimedTask.budgetLimits.maxTokens || 8192,
          remainingTokens: claimedTask.budgetLimits.maxTokens || 8192,
          maxSpendUsd: claimedTask.budgetLimits.maxSpendUsd
        },
        cancellationSignal: abortCtrl.signal,
        correlationId: `corr_${claimedTask.id}`,
        inputPayload: claimedTask.inputPayload || {}
      };

      // Revalidate at the actual recovery/dispatch boundary; the earlier identity
      // read is not treated as an enduring authorization lease.
      await this.assertActiveTaskWorkspace(claimedTask);
      await this.repository.appendCheckpoint(claimedTask.id, fencingToken, 'SPECIALIST_DISPATCHED', {
        role: claimedTask.role,
        specialistName: specialist.name
      });

      const result = await specialist.execute(executionContext);
      // Do not persist a successful outcome if authority was revoked mid-task.
      await this.assertActiveTaskWorkspace(claimedTask);

      // 6. Record Terminal Outcome
      const isSuccess = result.outcome === 'COMPLETED';
      const finalState = isSuccess ? 'COMPLETED' : (result.outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED');

      await this.repository.appendCheckpoint(claimedTask.id, fencingToken, 'SPECIALIST_FINISHED', {
        outcome: result.outcome
      });

      await this.repository.updateTaskState(claimedTask.id, finalState, fencingToken, {
        resultOutput: result.output,
        errorDetails: result.error,
        usageTelemetry: result.usage,
        provenance: {
          workerId: this.workerId,
          promptProfileId: executionContext.promptProfileId
        }
      });

      return result;
    } catch (err: any) {
      const isAbort = abortCtrl.signal.aborted;
      const isStale = err instanceof StaleFencingTokenError;

      if (isStale) {
        console.error(`[SpecialistWorkerRuntime] Task ${claimedTask.id} update rejected: stale fencing token.`);
        throw err;
      }

      const authorizationDenied = err?.code === 'WORKER_AUTHORIZATION_DENIED';
      const hasRetriesLeft = claimedTask.attemptCount < claimedTask.maxRetries && !isAbort && !authorizationDenied;
      const finalState = isAbort ? 'CANCELLED' : (hasRetriesLeft ? 'RETRY_WAIT' : 'FAILED');
      const errorCode = isAbort ? 'TASK_ABORTED' : (err?.code || 'WORKER_EXECUTION_ERROR');

      await this.repository.updateTaskState(claimedTask.id, finalState, fencingToken, {
        errorDetails: {
          code: errorCode,
          message: err?.message || 'An unexpected worker failure occurred.',
          retryable: hasRetriesLeft
        }
      });

      return {
        taskId: claimedTask.id,
        runId: claimedTask.runId,
        role: claimedTask.role,
        outcome: isAbort ? 'CANCELLED' : (hasRetriesLeft ? 'FAILED' : 'FAILED'),
        usage: { tokensUsed: 0, durationMs: Date.now() - startedAt },
        provenance: { workerId: this.workerId },
        error: {
          code: errorCode,
          message: err?.message || 'Worker execution failed.',
          retryable: hasRetriesLeft
        },
        timing: { startedAt, completedAt: Date.now() }
      };
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
      this.activeTasks.delete(claimedTask.id);
    }
  }

  /**
   * Graceful shutdown of worker: aborts active tasks cleanly.
   */
  public async shutdown(): Promise<void> {
    this.running = false;
    for (const [taskId, { abortController, heartbeatTimer }] of this.activeTasks.entries()) {
      clearInterval(heartbeatTimer);
      abortController.abort(new Error(`Worker ${this.workerId} shutting down.`));
    }
    this.activeTasks.clear();
  }
}
