export type RufloAdapterState =
  | 'DISABLED'
  | 'UNAVAILABLE'
  | 'CONNECTING'
  | 'AVAILABLE'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface RufloAdapterConfig {
  enabled?: boolean;
  timeoutMs?: number;
  sessionPrefix?: string;
  maxParallelTasks?: number;
  transport?: RufloTransport;
}

export interface RufloSpecialistTask {
  id: string;
  name: string;
  specialistRole: string;
  instructions: string;
  allowedToolScopes: string[];
}

export interface RufloTaskCoordinationResult {
  taskId: string;
  coordinated: boolean;
  fallbackToNative: boolean;
  status: RufloAdapterState;
  summary?: string;
  reason?: string;
  specialistDispatched?: string;
  synchronizedState?: Record<string, any>;
  durationMs: number;
}

export interface RufloTransport {
  ping(): Promise<boolean>;
  dispatchTask(task: RufloSpecialistTask, context: { runId?: string; principalId?: string; tenantId?: string }, signal?: AbortSignal): Promise<{ externalTaskId: string; status: 'RUNNING' | 'COMPLETED' | 'FAILED'; result?: any }>;
}

export class RufloOrchestrationAdapter {
  private enabled: boolean;
  private timeoutMs: number;
  private sessionPrefix: string;
  private maxParallelTasks: number;
  private transport?: RufloTransport;
  private currentState: RufloAdapterState = 'DISABLED';

  constructor(config?: RufloAdapterConfig) {
    // Strictly disabled by default in production and this milestone unless explicitly enabled via environment
    this.enabled = config?.enabled ?? (process.env.RUFLO_ORCHESTRATION_ENABLED === 'true');
    this.timeoutMs = config?.timeoutMs ?? 60000;
    this.sessionPrefix = config?.sessionPrefix ?? 'aira-ruflo';
    this.maxParallelTasks = config?.maxParallelTasks ?? 4;
    this.transport = config?.transport;
    this.currentState = this.enabled ? (this.transport ? 'AVAILABLE' : 'UNAVAILABLE') : 'DISABLED';
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getState(): RufloAdapterState {
    return this.currentState;
  }

  /**
   * Health and availability check for local Ruflo daemon or transport.
   * Returns true ONLY if a real, live transport connection is established and responds to a ping.
   * NEVER returns true for a simulated or missing backend.
   */
  public async isAvailable(): Promise<boolean> {
    if (!this.enabled) {
      this.currentState = 'DISABLED';
      return false;
    }

    if (!this.transport) {
      this.currentState = 'UNAVAILABLE';
      return false;
    }

    try {
      this.currentState = 'CONNECTING';
      const ok = await this.transport.ping();
      this.currentState = ok ? 'AVAILABLE' : 'UNAVAILABLE';
      return ok;
    } catch {
      this.currentState = 'UNAVAILABLE';
      return false;
    }
  }

  /**
   * Coordinates a specialist task with Ruflo.
   * If Ruflo is disabled or unavailable, seamlessly falls back to native AIRA execution.
   * NEVER produces synthetic completion receipts or fabricated specialist messages.
   */
  public async coordinateTask(
    task: RufloSpecialistTask,
    runContext?: { runId?: string; principalId?: string; tenantId?: string },
    options?: { signal?: AbortSignal }
  ): Promise<RufloTaskCoordinationResult> {
    const t0 = Date.now();

    // 1. Invariant Guard: If Ruflo is disabled, trigger seamless native fallback immediately
    if (!this.enabled) {
      this.currentState = 'DISABLED';
      return {
        taskId: task.id,
        coordinated: false,
        fallbackToNative: true,
        status: 'DISABLED',
        reason: 'Ruflo orchestration is feature-flagged OFF. Native AIRA runtime handles task.',
        durationMs: Date.now() - t0
      };
    }

    // 2. Permission Boundary Invariant:
    // Ruflo tasks cannot acquire root shell, production write, or bypass the authoritative ToolGateway
    const dangerousScopes = ['system:root', 'db:production_write', 'deploy:production'];
    for (const scope of task.allowedToolScopes) {
      if (dangerousScopes.includes(scope)) {
        throw new Error(`SECURITY_BOUNDARY_VIOLATION: Ruflo task "${task.id}" attempted to request unauthorized scope "${scope}".`);
      }
    }

    // 3. Check for caller cancellation
    if (options?.signal?.aborted) {
      this.currentState = 'CANCELLED';
      return {
        taskId: task.id,
        coordinated: false,
        fallbackToNative: false,
        status: 'CANCELLED',
        reason: `Task cancelled before dispatch: ${options.signal.reason || 'User aborted'}.`,
        durationMs: Date.now() - t0
      };
    }

    // 4. Transport Availability Check:
    // Requires a verified live transport. If transport is absent or unreachable, return UNAVAILABLE with native fallback.
    const isDaemonReady = await this.isAvailable();
    if (!isDaemonReady || !this.transport) {
      return {
        taskId: task.id,
        coordinated: false,
        fallbackToNative: true,
        status: 'UNAVAILABLE',
        reason: 'Ruflo daemon or transport is not connected. Seamlessly falling back to native AIRA execution.',
        durationMs: Date.now() - t0
      };
    }

    // 5. Genuine Transport Dispatch (requires live transport)
    this.currentState = 'RUNNING';
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`RUFLO_TIMEOUT: Ruflo task coordination exceeded ${this.timeoutMs}ms deadline.`));
    }, this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const dispatchResult = await this.transport.dispatchTask(
        task,
        {
          runId: runContext?.runId || 'aira-run-default',
          principalId: runContext?.principalId || 'aira-principal-default',
          tenantId: runContext?.tenantId || 'aira-default'
        },
        controller.signal
      );

      this.currentState = dispatchResult.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';

      return {
        taskId: task.id,
        coordinated: dispatchResult.status === 'COMPLETED',
        fallbackToNative: dispatchResult.status !== 'COMPLETED',
        status: this.currentState,
        specialistDispatched: task.specialistRole,
        summary: `Specialist task "${task.name}" executed via Ruflo transport (external ID: ${dispatchResult.externalTaskId}).`,
        synchronizedState: dispatchResult.result,
        durationMs: Date.now() - t0
      };
    } catch (err: any) {
      const isCancelled = controller.signal.aborted || options?.signal?.aborted;
      this.currentState = isCancelled ? 'CANCELLED' : 'FAILED';

      return {
        taskId: task.id,
        coordinated: false,
        fallbackToNative: true,
        status: this.currentState,
        reason: `Ruflo transport execution failed (${err?.message || 'Unknown error'}). Seamlessly falling back to native AIRA execution.`,
        durationMs: Date.now() - t0
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
