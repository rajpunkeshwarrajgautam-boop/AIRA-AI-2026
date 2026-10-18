import crypto from 'node:crypto';
import { PrivateBetaCapacityConfig, resolveCapacityConfig } from './capacity-config.js';
import { CapacityStore, InMemoryCapacityStore } from './capacity-store.js';
import { ProviderHealthTracker } from '../health-tracker.js';

export type AdmissionDecisionType = 'ADMIT_NOW' | 'QUEUE' | 'REJECT_CAPACITY';

export interface AdmissionPermit {
  permitId: string;
  scope: 'global' | 'user';
  principalId: string;
  acquiredAt: number;
  release: () => Promise<void>;
}

export interface AdmissionResult {
  decision: AdmissionDecisionType;
  permit?: AdmissionPermit;
  queuePosition?: number;
  estimatedWaitMs?: number;
  retryAfterSeconds?: number;
  reason?: string;
  rejectionCode?: 'AIRA_PRIVATE_BETA_CAPACITY' | 'PROMPT_TOO_LARGE' | 'CIRCUITS_OPEN' | 'USER_RATE_LIMIT';
  userMessage?: string;
  telemetry?: {
    dbRoundTrips?: number;
    transactionMs?: number;
    lockWaitMs?: number;
  };
}

export interface AdmitOptions {
  principalId: string;
  model?: string;
  intent?: string;
  promptText?: string;
  contextHistory?: any[];
  abortSignal?: AbortSignal;
}

export interface QueueProgressEvent {
  status: 'QUEUED';
  queuePosition: number;
  estimatedWaitMs: number;
  message: string;
}

interface QueuedItem {
  id: string;
  principalId: string;
  options: AdmitOptions;
  enqueuedAt: number;
  resolve: (res: AdmissionResult) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

export class PrivateBetaCapacityGuard {
  private config: PrivateBetaCapacityConfig;
  private store: CapacityStore;
  private healthTracker?: ProviderHealthTracker;
  private queue: QueuedItem[] = [];
  private queuePollTimer: NodeJS.Timeout | null = null;

  // Observability counters
  private metrics = {
    admitted: 0,
    queued: 0,
    rejected: 0,
    totalWaitMs: 0,
    lastWaitMs: 0
  };

  private startQueuePoll(): void {
    if (this.queuePollTimer) return;
    this.queuePollTimer = setInterval(() => {
      if (this.queue.length === 0) {
        this.stopQueuePoll();
        return;
      }
      this.processNextQueued().catch(() => {});
    }, 50);
    if (this.queuePollTimer.unref) this.queuePollTimer.unref();
  }

  private stopQueuePoll(): void {
    if (this.queuePollTimer) {
      clearInterval(this.queuePollTimer);
      this.queuePollTimer = null;
    }
  }

  constructor(
    config?: Partial<PrivateBetaCapacityConfig>,
    store?: CapacityStore,
    healthTracker?: ProviderHealthTracker
  ) {
    this.config = { ...resolveCapacityConfig(), ...(config || {}) };
    this.store = store || new InMemoryCapacityStore();
    this.healthTracker = healthTracker;
  }

  public getConfig(): PrivateBetaCapacityConfig {
    return { ...this.config };
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public updateConfig(patch: Partial<PrivateBetaCapacityConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  public isFastTarget(model?: string, intent?: string): boolean {
    const cleanModel = (model || 'aira-auto').toLowerCase().trim();
    if (cleanModel === 'aira-deep') return false;
    if (intent === 'RESEARCH' || intent === 'AGENT_MISSION' || intent === 'WORKFLOW') return false;
    return cleanModel === 'aira-fast' || cleanModel === 'aira-auto';
  }

  public estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  public calculateJitteredRetryAfter(baseSeconds: number): number {
    // Add 1 to 3 seconds of randomized jitter to prevent thundering herd
    const jitter = Math.floor(Math.random() * 3) + 1;
    return baseSeconds + jitter;
  }

  public async admit(
    options: AdmitOptions,
    onQueued?: (progress: QueueProgressEvent) => void
  ): Promise<AdmissionResult> {
    // 1. Feature Flag / Kill Switch: If disabled, admit immediately
    if (!this.config.enabled) {
      return { decision: 'ADMIT_NOW' };
    }

    // 2. Route separation: only Fast route is guarded by Free-Tier Private Beta Guard
    if (!this.isFastTarget(options.model, options.intent)) {
      return { decision: 'ADMIT_NOW' };
    }

    // 2.5 Fail-Closed Capacity Store Readiness Check (Sections 3 & 4)
    if (typeof this.store.isAvailable === 'function') {
      const available = await this.store.isAvailable();
      if (!available) {
        this.metrics.rejected++;
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
          reason: 'CAPACITY_STORE_UNAVAILABLE',
          retryAfterSeconds: this.calculateJitteredRetryAfter(this.config.retryAfterSeconds),
          userMessage: 'Private beta capacity is temporarily unavailable. Please retry in a few moments.'
        };
      }
    }

    const principalId = options.principalId || 'anonymous';
    const promptText = options.promptText || '';

    // 3. Token-sensitive prompt cost check (Section 19)
    const promptTokens = this.estimateTokens(promptText);
    if (promptTokens > this.config.maxPromptTokensApprox) {
      this.metrics.rejected++;
      return {
        decision: 'REJECT_CAPACITY',
        rejectionCode: 'PROMPT_TOO_LARGE',
        reason: 'PROMPT_EXCEEDS_FAST_CAPACITY',
        retryAfterSeconds: 5,
        userMessage: 'Prompt length exceeds Private Beta Fast capacity limit. Please shorten your prompt or select Deep mode.'
      };
    }

    // 4. Circuit Breaker Integration & Provider-Aware Budgeting (Section 9 & 16)
    let effectiveGlobalMaxConcurrent = this.config.globalMaxConcurrent;
    let effectiveGlobalRpm = this.config.globalRpm;

    if (this.healthTracker) {
      const groqState = this.healthTracker.getCircuitState('groq', 'openai/gpt-oss-120b');
      const geminiState = this.healthTracker.getCircuitState('gemini', 'gemini-3.5-flash-lite');

      if (groqState === 'OPEN' && geminiState === 'OPEN') {
        // Both primary and fallback are open; admitting would predictably cascade to failure
        this.metrics.rejected++;
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'CIRCUITS_OPEN',
          reason: 'ALL_PROVIDERS_UNAVAILABLE',
          retryAfterSeconds: 15,
          userMessage: 'Private beta capacity is temporarily unavailable. Please retry in a few moments.'
        };
      } else if (groqState === 'OPEN') {
        // Only Gemini fallback available -> throttle concurrency to 1 and RPM to 10
        effectiveGlobalMaxConcurrent = 1;
        effectiveGlobalRpm = Math.min(10, this.config.globalRpm);
      } else if (geminiState === 'OPEN') {
        // Gemini fallback offline -> throttle to 1 concurrent to safeguard Groq TPM
        effectiveGlobalMaxConcurrent = 1;
      }
    }

    // 5. Consolidated Atomic Admission Evaluation (P1.6.5)
    // If the capacity store supports atomicAdmit, evaluate concurrency and rate limits
    // in one atomic PostgreSQL transaction / round-trip with deterministic 64-bit advisory locking.
    if (typeof this.store.atomicAdmit === 'function') {
      const atomicRes = await this.store.atomicAdmit({
        principalId,
        userMaxConcurrent: this.config.perUserMaxConcurrent,
        userRpmLimit: this.config.perUserRpm,
        globalMaxConcurrent: effectiveGlobalMaxConcurrent,
        globalRpmLimit: effectiveGlobalRpm,
        userWindowMs: 60000,
        globalWindowMs: 60000,
        permitTtlSeconds: 30
      });

      if (atomicRes.decision === 'ADMIT' && atomicRes.globalPermitId) {
        this.metrics.admitted++;
        const permitId = atomicRes.globalPermitId;
        const userPermitId = atomicRes.userPermitId;

        let released = false;
        const releaseHandle = async () => {
          if (released) return;
          released = true;
          if (typeof this.store.releasePermits === 'function') {
            await this.store.releasePermits([permitId, userPermitId].filter(Boolean) as string[]);
          } else {
            await Promise.all([
              this.store.releasePermit(permitId),
              userPermitId ? this.store.releasePermit(userPermitId) : Promise.resolve()
            ]);
          }
          this.processNextQueued();
        };

        return {
          decision: 'ADMIT_NOW',
          permit: {
            permitId,
            scope: 'global',
            principalId,
            acquiredAt: Date.now(),
            release: releaseHandle
          },
          telemetry: atomicRes.telemetry
        };
      }

      if (atomicRes.decision === 'USER_CONCURRENCY_EXCEEDED') {
        this.metrics.rejected++;
        const retryAfter = this.calculateJitteredRetryAfter(this.config.retryAfterSeconds);
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
          reason: 'USER_CONCURRENCY_EXCEEDED',
          retryAfterSeconds: retryAfter,
          userMessage: 'You have an active request in progress. Please wait for it to complete.',
          telemetry: atomicRes.telemetry
        };
      }

      if (atomicRes.decision === 'USER_RPM_EXCEEDED') {
        this.metrics.rejected++;
        const retryAfter = Math.max(1, Math.ceil((atomicRes.resetMs?.userRpm || 8000) / 1000));
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'USER_RATE_LIMIT',
          reason: 'USER_RPM_EXCEEDED',
          retryAfterSeconds: retryAfter,
          userMessage: 'Private beta per-user request limit reached. Please retry in a moment.',
          telemetry: atomicRes.telemetry
        };
      }

      if (atomicRes.decision === 'GLOBAL_RPM_EXCEEDED') {
        this.metrics.rejected++;
        const retryAfter = Math.max(1, Math.ceil((atomicRes.resetMs?.globalRpm || 8000) / 1000));
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
          reason: 'GLOBAL_RPM_EXCEEDED',
          retryAfterSeconds: retryAfter,
          userMessage: 'AIRA Private Beta is at capacity. Please retry shortly.',
          telemetry: atomicRes.telemetry
        };
      }

      if (atomicRes.decision === 'STORE_UNAVAILABLE') {
        this.metrics.rejected++;
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
          reason: 'CAPACITY_STORE_UNAVAILABLE',
          retryAfterSeconds: this.calculateJitteredRetryAfter(this.config.retryAfterSeconds),
          userMessage: 'Private beta capacity is temporarily unavailable. Please retry in a few moments.'
        };
      }

      // GLOBAL_CONCURRENCY_EXCEEDED falls through to queue evaluation
    } else {
      // Legacy sequential store fallback
      const userPermitAcquisition = await this.store.acquirePermit('user', principalId, this.config.perUserMaxConcurrent, 30);
      if (!userPermitAcquisition.acquired) {
        this.metrics.rejected++;
        const retryAfter = this.calculateJitteredRetryAfter(this.config.retryAfterSeconds);
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
          reason: 'USER_CONCURRENCY_EXCEEDED',
          retryAfterSeconds: retryAfter,
          userMessage: 'You have an active request in progress. Please wait for it to complete.'
        };
      }
      const userPermitId = userPermitAcquisition.permitId;

      const userRpmCheck = await this.store.recordAndCheckRpm('user', principalId, this.config.perUserRpm, 60000);
      if (!userRpmCheck.allowed) {
        if (userPermitId) await this.store.releasePermit(userPermitId);
        this.metrics.rejected++;
        const retryAfter = Math.max(1, Math.ceil(userRpmCheck.resetMs / 1000));
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'USER_RATE_LIMIT',
          reason: 'USER_RPM_EXCEEDED',
          retryAfterSeconds: retryAfter,
          userMessage: 'Private beta per-user request limit reached. Please retry in a moment.'
        };
      }

      const globalRpmCheck = await this.store.recordAndCheckRpm('global', 'system', effectiveGlobalRpm, 60000);
      if (!globalRpmCheck.allowed) {
        if (userPermitId) await this.store.releasePermit(userPermitId);
        this.metrics.rejected++;
        const retryAfter = Math.max(1, Math.ceil(globalRpmCheck.resetMs / 1000));
        return {
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
          reason: 'GLOBAL_RPM_EXCEEDED',
          retryAfterSeconds: retryAfter,
          userMessage: 'AIRA Private Beta is at capacity. Please retry shortly.'
        };
      }

      const globalPermitAcquisition = await this.store.acquirePermit('global', principalId, effectiveGlobalMaxConcurrent, 30);
      if (globalPermitAcquisition.acquired && globalPermitAcquisition.permitId) {
        const permitId = globalPermitAcquisition.permitId;
        this.metrics.admitted++;

        let released = false;
        const releaseHandle = async () => {
          if (released) return;
          released = true;
          await Promise.all([
            this.store.releasePermit(permitId),
            userPermitId ? this.store.releasePermit(userPermitId) : Promise.resolve()
          ]);
          this.processNextQueued();
        };

        return {
          decision: 'ADMIT_NOW',
          permit: {
            permitId,
            scope: 'global',
            principalId,
            acquiredAt: Date.now(),
            release: releaseHandle
          }
        };
      }

      if (userPermitId) {
        await this.store.releasePermit(userPermitId);
      }
    }

    // 9. Concurrency is saturated -> Evaluate Queue (Section 10)
    if (this.queue.length >= this.config.queueMaxDepth) {
      this.metrics.rejected++;
      const retryAfter = this.calculateJitteredRetryAfter(this.config.retryAfterSeconds);
      return {
        decision: 'REJECT_CAPACITY',
        rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
        reason: 'QUEUE_FULL',
        retryAfterSeconds: retryAfter,
        userMessage: 'AIRA Private Beta is currently experiencing high demand. Please retry shortly.'
      };
    }

    // 10. Enter Bounded FIFO Queue (Suspends until capacity opens or timeout expires)
    this.metrics.queued++;
    const queuePosition = this.queue.length + 1;
    const estimatedWaitMs = queuePosition * 1500;

    if (onQueued) {
      onQueued({
        status: 'QUEUED',
        queuePosition,
        estimatedWaitMs,
        message: 'High demand — your request is queued.'
      });
    }

    return new Promise<AdmissionResult>((resolve, reject) => {
      const queueId = `q_${crypto.randomUUID().slice(0, 8)}`;
      const enqueuedAt = Date.now();

      const timeoutTimer = setTimeout(() => {
        this.removeFromQueue(queueId);
        this.metrics.rejected++;
        const retryAfter = this.calculateJitteredRetryAfter(this.config.retryAfterSeconds);
        resolve({
          decision: 'REJECT_CAPACITY',
          rejectionCode: 'AIRA_PRIVATE_BETA_CAPACITY',
          reason: 'QUEUE_TIMEOUT',
          retryAfterSeconds: retryAfter,
          userMessage: 'Queue wait time exceeded private beta capacity limit. Please retry shortly.'
        });
      }, this.config.queueMaxWaitMs);

      if (options.abortSignal) {
        options.abortSignal.addEventListener('abort', () => {
          this.removeFromQueue(queueId);
          clearTimeout(timeoutTimer);
          reject(options.abortSignal?.reason || new Error('CLIENT_CLOSED_REQUEST'));
        }, { once: true });
      }

      this.queue.push({
        id: queueId,
        principalId,
        options,
        enqueuedAt,
        resolve: (res) => {
          clearTimeout(timeoutTimer);
          const waitMs = Date.now() - enqueuedAt;
          this.metrics.totalWaitMs += waitMs;
          this.metrics.lastWaitMs = waitMs;
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timeoutTimer);
          reject(err);
        },
        timer: timeoutTimer
      });
      this.startQueuePoll();
    });
  }

  private removeFromQueue(id: string): void {
    const idx = this.queue.findIndex(q => q.id === id);
    if (idx !== -1) {
      const [item] = this.queue.splice(idx, 1);
      clearTimeout(item.timer);
    }
    if (this.queue.length === 0) {
      this.stopQueuePoll();
    }
  }

  // NOTE (P1.6.5): GLOBAL FIFO QUEUE: NOT GUARANTEED across independent Vercel serverless instances.
  // Each serverless instance maintains its own local bounded queue, and all instances coordinate
  // synchronously via PostgreSQL advisory locks and distributed capacity tables.
  public async processNextQueued(): Promise<void> {
    if (this.queue.length === 0) return;

    // Evaluate circuit breaker constraints for dequeue
    let effectiveGlobalMaxConcurrent = this.config.globalMaxConcurrent;
    if (this.healthTracker) {
      const groqState = this.healthTracker.getCircuitState('groq', 'openai/gpt-oss-120b');
      const geminiState = this.healthTracker.getCircuitState('gemini', 'gemini-3.5-flash-lite');
      if (groqState === 'OPEN' || geminiState === 'OPEN') {
        effectiveGlobalMaxConcurrent = 1;
      }
    }

    const candidate = this.queue[0];
    if (!candidate) return;

    if (typeof this.store.atomicAdmit === 'function') {
      const atomicRes = await this.store.atomicAdmit({
        principalId: candidate.principalId,
        userMaxConcurrent: this.config.perUserMaxConcurrent,
        userRpmLimit: this.config.perUserRpm,
        globalMaxConcurrent: effectiveGlobalMaxConcurrent,
        globalRpmLimit: this.config.globalRpm,
        userWindowMs: 60000,
        globalWindowMs: 60000,
        permitTtlSeconds: 45
      });

      if (atomicRes.decision !== 'ADMIT' || !atomicRes.globalPermitId) {
        return; // Still no capacity
      }

      // Capacity acquired for queued item -> dequeue and resolve
      this.queue.shift();
      clearTimeout(candidate.timer);

      const permitId = atomicRes.globalPermitId;
      const userPermitId = atomicRes.userPermitId;
      this.metrics.admitted++;

      let released = false;
      const releaseHandle = async () => {
        if (released) return;
        released = true;
        if (typeof this.store.releasePermits === 'function') {
          await this.store.releasePermits([permitId, userPermitId].filter(Boolean) as string[]);
        } else {
          await Promise.all([
            this.store.releasePermit(permitId),
            userPermitId ? this.store.releasePermit(userPermitId) : Promise.resolve()
          ]);
        }
        this.processNextQueued();
      };

      candidate.resolve({
        decision: 'ADMIT_NOW',
        permit: {
          permitId,
          scope: 'global',
          principalId: candidate.principalId,
          acquiredAt: Date.now(),
          release: releaseHandle
        },
        telemetry: atomicRes.telemetry
      });
      return;
    }

    const globalPermit = await this.store.acquirePermit('global', candidate.principalId, effectiveGlobalMaxConcurrent, 45);
    if (!globalPermit.acquired || !globalPermit.permitId) {
      return; // Still no capacity
    }

    // Capacity acquired for queued item -> dequeue and resolve
    this.queue.shift();
    clearTimeout(candidate.timer);

    const userPermit = await this.store.acquirePermit('user', candidate.principalId, this.config.perUserMaxConcurrent, 45);
    const permitId = globalPermit.permitId;
    const userPermitId = userPermit.permitId;

    this.metrics.admitted++;

    let released = false;
    const releaseHandle = async () => {
      if (released) return;
      released = true;
      await this.store.releasePermit(permitId);
      if (userPermitId) {
        await this.store.releasePermit(userPermitId);
      }
      this.processNextQueued();
    };

    candidate.resolve({
      decision: 'ADMIT_NOW',
      permit: {
        permitId,
        scope: 'global',
        principalId: candidate.principalId,
        acquiredAt: Date.now(),
        release: releaseHandle
      }
    });
  }

  public getQueueDepth(): number {
    return this.queue.length;
  }

  public async getDiagnostics(): Promise<Record<string, any>> {
    const globalActive = await this.store.getActiveConcurrency('global');
    const globalRpm = await this.store.getCurrentRpm('global', 'system', 60000);
    const groqCircuit = this.healthTracker ? this.healthTracker.getCircuitState('groq', 'openai/gpt-oss-120b') : 'CLOSED';
    const geminiCircuit = this.healthTracker ? this.healthTracker.getCircuitState('gemini', 'gemini-3.5-flash-lite') : 'CLOSED';

    const saturationPercentage = this.config.globalMaxConcurrent > 0
      ? Math.round((globalActive / this.config.globalMaxConcurrent) * 100)
      : 0;

    return {
      guardEnabled: this.config.enabled,
      globalMaxConcurrent: this.config.globalMaxConcurrent,
      perUserMaxConcurrent: this.config.perUserMaxConcurrent,
      globalRpm: this.config.globalRpm,
      perUserRpm: this.config.perUserRpm,
      queueMaxDepth: this.config.queueMaxDepth,
      queueMaxWaitMs: this.config.queueMaxWaitMs,
      currentActiveRequests: globalActive,
      currentQueueDepth: this.queue.length,
      recentGlobalRpm: globalRpm,
      saturationPercentage,
      metrics: {
        admitted: this.metrics.admitted,
        queued: this.metrics.queued,
        rejected: this.metrics.rejected,
        lastWaitMs: this.metrics.lastWaitMs
      },
      providerCircuits: {
        groq: groqCircuit,
        gemini: geminiCircuit
      }
    };
  }

  public async reset(): Promise<void> {
    this.stopQueuePoll();
    for (const item of this.queue) {
      clearTimeout(item.timer);
    }
    this.queue = [];
    this.metrics = { admitted: 0, queued: 0, rejected: 0, totalWaitMs: 0, lastWaitMs: 0 };
    await this.store.reset();
  }
}
