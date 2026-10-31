import {
  ModelAdapter,
  ModelCompletionResult,
  ChatMessageInput,
  SupportedProvider,
  resolveNvidiaModel,
  resolveOpenAIModel,
  resolveAnthropicModel
} from './index.js';
import { ModelPolicy } from '../../contracts/src/index.js';
import { ProviderHealthTracker } from './health-tracker.js';

export interface ResilientConfig {
  firstTokenTimeoutMs?: number;
  fallbackFirstTokenTimeoutMs?: number;
  enableHedging?: boolean;
  hedgeDelayMs?: number;
  tertiaryAdapter?: (ModelAdapter & { modelName?: string; outboundModel?: string }) | null;
  onProvenance?: (provenance: {
    requestedProvider: string;
    requestedModel: string;
    executedProvider: string;
    executedModel: string;
    fallbackOccurred: boolean;
    fallbackReason?: string;
    hedgedRequestUsed?: boolean;
    modelIdentityVerified?: boolean;
  }) => void;
}

export class ResilientModelAdapter implements ModelAdapter {
  readonly provider: SupportedProvider;
  private primaryAdapter: ModelAdapter & { modelName?: string; outboundModel?: string };
  private fallbackAdapter: (ModelAdapter & { modelName?: string; outboundModel?: string }) | null;
  private tertiaryAdapter: (ModelAdapter & { modelName?: string; outboundModel?: string }) | null;
  private healthTracker: ProviderHealthTracker;
  private config: ResilientConfig;
  private stickinessLocked = false;

  constructor(
    primary: ModelAdapter & { modelName?: string; outboundModel?: string },
    fallback: (ModelAdapter & { modelName?: string; outboundModel?: string }) | null,
    healthTracker: ProviderHealthTracker,
    config?: ResilientConfig
  ) {
    this.primaryAdapter = primary;
    this.fallbackAdapter = fallback;
    this.tertiaryAdapter = config?.tertiaryAdapter || null;
    this.healthTracker = healthTracker;
    this.config = config || {};
    this.provider = primary.provider;
  }

  public isStickinessLocked(): boolean {
    return this.stickinessLocked;
  }

  private getModelName(adapter: ModelAdapter & { modelName?: string; outboundModel?: string }, policy: ModelPolicy): string {
    let name = adapter.modelName || adapter.outboundModel;
    if (!name || name.startsWith('aira-')) {
      if (adapter.provider === 'nvidia') {
        name = resolveNvidiaModel(policy.model);
      } else if (adapter.provider === 'openai') {
        name = resolveOpenAIModel(policy.model);
      } else if (adapter.provider === 'anthropic') {
        name = resolveAnthropicModel(policy.model);
      } else if (adapter.provider === 'groq') {
        name = (adapter as any).modelName || process.env.AIRA_FAST_MODEL || 'openai/gpt-oss-120b';
      } else if (adapter.provider === 'gemini') {
        name = (adapter as any).modelName || process.env.AIRA_GEMINI_MODEL || 'gemini-3.5-flash-lite';
      } else {
        name = adapter.modelName || policy.model;
      }
    }
    return name || policy.model || 'mock-deterministic';
  }

  async complete(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    signal?: AbortSignal
  ): Promise<ModelCompletionResult> {
    const primaryModel = this.getModelName(this.primaryAdapter, policy);
    const t0 = performance.now();

    // Circuit Breaker check: if primary circuit is OPEN, bypass directly to fallback
    if (!this.healthTracker.isAvailable(this.primaryAdapter.provider, primaryModel) && this.fallbackAdapter && !signal?.aborted) {
      const fallbackModel = this.getModelName(this.fallbackAdapter, policy);
      const fbRes = await this.fallbackAdapter.complete(messages, policy, signal);
      const fbElapsed = Math.round(performance.now() - t0);
      this.healthTracker.recordSuccess(this.fallbackAdapter.provider, fallbackModel, fbElapsed);
      return fbRes;
    }

    try {
      signal?.throwIfAborted();
      const res = await this.primaryAdapter.complete(messages, policy, signal);
      const elapsed = Math.round(performance.now() - t0);
      this.healthTracker.recordSuccess(this.primaryAdapter.provider, primaryModel, elapsed);
      return res;
    } catch (primaryErr: any) {
      const elapsed = Math.round(performance.now() - t0);
      this.healthTracker.recordFailure(this.primaryAdapter.provider, primaryModel, primaryErr);

      if (this.fallbackAdapter && !signal?.aborted) {
        const fallbackModel = this.getModelName(this.fallbackAdapter, policy);
        const fbRes = await this.fallbackAdapter.complete(messages, policy, signal);
        const fbElapsed = Math.round(performance.now() - t0);
        this.healthTracker.recordSuccess(this.fallbackAdapter.provider, fallbackModel, fbElapsed);
        return fbRes;
      }
      throw primaryErr;
    }
  }

  async stream(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    options?: {
      firstTokenTimeoutMs?: number;
      signal?: AbortSignal;
      onProvenance?: (provenance: any) => void;
    }
  ): Promise<ModelCompletionResult> {
    this.stickinessLocked = false;
    const firstTokenTimeoutMs = options?.firstTokenTimeoutMs ?? this.config.firstTokenTimeoutMs ?? 2500;
    const enableHedging = this.config.enableHedging ?? false;
    const hedgeDelayMs = this.config.hedgeDelayMs ?? 1200;
    const emitProvenance = options?.onProvenance || this.config.onProvenance;

    const primaryModel = this.getModelName(this.primaryAdapter, policy);
    const fallbackModel = this.fallbackAdapter ? this.getModelName(this.fallbackAdapter, policy) : null;

    // Report initial planned provenance
    emitProvenance?.({
      requestedProvider: this.primaryAdapter.provider,
      requestedModel: primaryModel,
      executedProvider: this.primaryAdapter.provider,
      executedModel: primaryModel,
      fallbackOccurred: false,
      hedgedRequestUsed: false,
      modelIdentityVerified: true
    });

    if (enableHedging && this.fallbackAdapter) {
      return this.streamWithHedging(
        messages,
        policy,
        onChunk,
        firstTokenTimeoutMs,
        hedgeDelayMs,
        options?.signal,
        emitProvenance
      );
    }

    return this.streamWithDeadlineAndFallback(
      messages,
      policy,
      onChunk,
      firstTokenTimeoutMs,
      options?.signal,
      emitProvenance
    );
  }

  private async streamWithDeadlineAndFallback(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    firstTokenTimeoutMs: number,
    outerSignal?: AbortSignal,
    emitProvenance?: (p: any) => void
  ): Promise<ModelCompletionResult> {
    const primaryModel = this.getModelName(this.primaryAdapter, policy);
    const primaryAbort = new AbortController();

    if (outerSignal) {
      outerSignal.addEventListener('abort', () => primaryAbort.abort(outerSignal.reason), { once: true });
    }

    let firstTokenTimer: NodeJS.Timeout | null = null;
    let receivedFirstContentToken = false;
    const t0 = performance.now();

    if (firstTokenTimeoutMs > 0) {
      firstTokenTimer = setTimeout(() => {
        if (!receivedFirstContentToken) {
          primaryAbort.abort(
            new Error(`FIRST_TOKEN_TIMEOUT: Primary provider ${this.primaryAdapter.provider}:${primaryModel} exceeded deadline (${firstTokenTimeoutMs}ms) without content`)
          );
        }
      }, firstTokenTimeoutMs);
    }

    try {
      if (!this.healthTracker.isAvailable(this.primaryAdapter.provider, primaryModel)) {
        throw new Error(`Primary provider ${this.primaryAdapter.provider}:${primaryModel} circuit breaker is OPEN`);
      }
      const res = await this.primaryAdapter.stream(
        messages,
        policy,
        delta => {
          if (delta.thinking) {
            onChunk({ thinking: delta.thinking });
          }
          if (typeof delta.text === 'string' && delta.text.length > 0) {
            if (!receivedFirstContentToken) {
              if (delta.text.trim().length > 0) {
                receivedFirstContentToken = true;
                this.stickinessLocked = true;
                if (firstTokenTimer) {
                  clearTimeout(firstTokenTimer);
                  firstTokenTimer = null;
                }
                const ttft = Math.round(performance.now() - t0);
                this.healthTracker.recordSuccess(this.primaryAdapter.provider, primaryModel, ttft);
              }
            }
            onChunk({ text: delta.text });
          }
        },
        { firstTokenTimeoutMs, signal: primaryAbort.signal }
      );

      return res;
    } catch (primaryErr: any) {
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }

      const isAbortedByCaller = outerSignal?.aborted;
      if (isAbortedByCaller) {
        throw outerSignal.reason || primaryErr;
      }

      this.healthTracker.recordFailure(this.primaryAdapter.provider, primaryModel, primaryErr);

      // If content has already started streaming, request stickiness prevents mid-answer fallback!
      if (this.stickinessLocked || receivedFirstContentToken) {
        throw primaryErr;
      }

      // Safe fallback before first token
      if (this.fallbackAdapter) {
        const fallbackModel = this.getModelName(this.fallbackAdapter, policy);
        const isTimeout =
          primaryErr.message?.includes('FIRST_TOKEN_TIMEOUT') ||
          (primaryAbort.signal.aborted && String(primaryAbort.signal.reason).includes('FIRST_TOKEN_TIMEOUT'));

        const fallbackReason = isTimeout
          ? `Primary ${this.primaryAdapter.provider}:${primaryModel} first-token deadline (${firstTokenTimeoutMs}ms) exceeded; fell back to ${this.fallbackAdapter.provider}:${fallbackModel}`
          : `Primary ${this.primaryAdapter.provider}:${primaryModel} failed (${primaryErr.message}); fell back to ${this.fallbackAdapter.provider}:${fallbackModel}`;

        emitProvenance?.({
          requestedProvider: this.primaryAdapter.provider,
          requestedModel: primaryModel,
          executedProvider: this.fallbackAdapter.provider,
          executedModel: fallbackModel,
          fallbackOccurred: true,
          fallbackReason,
          hedgedRequestUsed: false,
          modelIdentityVerified: true
        });

        const fallbackAbort = new AbortController();
        if (outerSignal) {
          outerSignal.addEventListener('abort', () => fallbackAbort.abort(outerSignal.reason), { once: true });
        }

        const tFbStart = performance.now();
        let fbReceivedFirst = false;

        const fbTimeoutMs = this.fallbackAdapter.provider === 'gemini'
          ? (this.config.fallbackFirstTokenTimeoutMs ?? 4000)
          : firstTokenTimeoutMs;

        try {
          const fbRes = await this.fallbackAdapter.stream(
            messages,
            policy,
            delta => {
              if (delta.thinking) onChunk({ thinking: delta.thinking });
              if (typeof delta.text === 'string' && delta.text.length > 0) {
                if (!fbReceivedFirst) {
                  if (delta.text.trim().length > 0) {
                    fbReceivedFirst = true;
                    this.stickinessLocked = true;
                    const fbTtft = Math.round(performance.now() - tFbStart);
                    this.healthTracker.recordSuccess(this.fallbackAdapter!.provider, fallbackModel, fbTtft);
                  }
                }
                onChunk({ text: delta.text });
              }
            },
            { signal: fallbackAbort.signal, firstTokenTimeoutMs: fbTimeoutMs }
          );

          return fbRes;
        } catch (fallbackErr: any) {
          this.healthTracker.recordFailure(this.fallbackAdapter.provider, fallbackModel, fallbackErr);

          if (this.stickinessLocked || fbReceivedFirst) {
            throw fallbackErr;
          }

          const isAborted = outerSignal?.aborted;
          if (isAborted) {
            throw outerSignal.reason || fallbackErr;
          }

          // Section 9: Do NOT fall back to same-quota Groq model if Groq failed due to account-level rate limits
          const isGroqAccountLimit =
            primaryErr.status === 429 ||
            primaryErr.message?.includes('429') ||
            primaryErr.message?.includes('rate_limit') ||
            primaryErr.message?.includes('quota') ||
            primaryErr.message?.includes('TPD') ||
            primaryErr.message?.includes('TPM');

          const tertiaryModel = this.tertiaryAdapter ? this.getModelName(this.tertiaryAdapter, policy) : null;
          const isTertiaryAvailable = this.tertiaryAdapter && tertiaryModel
            ? this.healthTracker.isAvailable(this.tertiaryAdapter.provider, tertiaryModel)
            : false;

          if (this.tertiaryAdapter && tertiaryModel && !isGroqAccountLimit && isTertiaryAvailable) {
            const tertiaryReason = `Primary ${this.primaryAdapter.provider}:${primaryModel} failed (${primaryErr.message}), fallback ${this.fallbackAdapter.provider}:${fallbackModel} failed (${fallbackErr.message}); fell back to tertiary ${this.tertiaryAdapter.provider}:${tertiaryModel}`;

            emitProvenance?.({
              requestedProvider: this.primaryAdapter.provider,
              requestedModel: primaryModel,
              executedProvider: this.tertiaryAdapter.provider,
              executedModel: tertiaryModel,
              fallbackOccurred: true,
              fallbackReason: tertiaryReason,
              hedgedRequestUsed: false,
              modelIdentityVerified: true
            });

            const tertiaryAbort = new AbortController();
            if (outerSignal) {
              outerSignal.addEventListener('abort', () => tertiaryAbort.abort(outerSignal.reason), { once: true });
            }

            const tTertiaryStart = performance.now();
            let tertiaryReceivedFirst = false;

            const tertRes = await this.tertiaryAdapter.stream(
              messages,
              policy,
              delta => {
                if (delta.thinking) onChunk({ thinking: delta.thinking });
                if (typeof delta.text === 'string' && delta.text.length > 0) {
                  if (!tertiaryReceivedFirst) {
                    if (delta.text.trim().length > 0) {
                      tertiaryReceivedFirst = true;
                      this.stickinessLocked = true;
                      const ttft = Math.round(performance.now() - tTertiaryStart);
                      this.healthTracker.recordSuccess(this.tertiaryAdapter!.provider, tertiaryModel, ttft);
                    }
                  }
                  onChunk({ text: delta.text });
                }
              },
              { signal: tertiaryAbort.signal, firstTokenTimeoutMs }
            );

            return tertRes;
          }

          throw new Error(
            `FAST_FALLBACK_CASCADE_EXHAUSTED: Primary ${this.primaryAdapter.provider}:${primaryModel} (${primaryErr.message}) and fallback ${this.fallbackAdapter.provider}:${fallbackModel} (${fallbackErr.message}) both failed.`
          );
        }
      }

      throw primaryErr;
    } finally {
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }
    }
  }

  private async streamWithHedging(
    messages: ChatMessageInput[],
    policy: ModelPolicy,
    onChunk: (delta: { text?: string; thinking?: string }) => void,
    firstTokenTimeoutMs: number,
    hedgeDelayMs: number,
    outerSignal?: AbortSignal,
    emitProvenance?: (p: any) => void
  ): Promise<ModelCompletionResult> {
    const primaryModel = this.getModelName(this.primaryAdapter, policy);
    const fallbackModel = this.getModelName(this.fallbackAdapter!, policy);

    const primaryAbort = new AbortController();
    const secondaryAbort = new AbortController();

    if (outerSignal) {
      outerSignal.addEventListener('abort', () => {
        primaryAbort.abort(outerSignal.reason);
        secondaryAbort.abort(outerSignal.reason);
      }, { once: true });
    }

    let winner: 'primary' | 'secondary' | null = null;
    let hedgeTimer: NodeJS.Timeout | null = null;
    const t0 = performance.now();

    const raceDeferred = new Promise<ModelCompletionResult>((resolve, reject) => {
      let primaryResolved = false;
      let secondaryResolved = false;

      // 1. Launch Primary Stream
      const runPrimary = async () => {
        try {
          const res = await this.primaryAdapter.stream(
            messages,
            policy,
            delta => {
              if (winner === 'secondary') return; // Primary lost race; drop chunks
              if (delta.thinking && !winner) {
                onChunk({ thinking: delta.thinking });
              }
              if (typeof delta.text === 'string' && delta.text.length > 0) {
                if (!winner) {
                  if (delta.text.trim().length > 0) {
                    winner = 'primary';
                    this.stickinessLocked = true;
                    if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
                    secondaryAbort.abort('Primary delivered first token; cancelling hedged request');
                    const ttft = Math.round(performance.now() - t0);
                    this.healthTracker.recordSuccess(this.primaryAdapter.provider, primaryModel, ttft);
                    emitProvenance?.({
                      requestedProvider: this.primaryAdapter.provider,
                      requestedModel: primaryModel,
                      executedProvider: this.primaryAdapter.provider,
                      executedModel: primaryModel,
                      fallbackOccurred: false,
                      hedgedRequestUsed: false,
                      modelIdentityVerified: true
                    });
                  }
                }
                if (winner === 'primary') {
                  onChunk({ text: delta.text });
                }
              }
            },
            { firstTokenTimeoutMs, signal: primaryAbort.signal }
          );
          primaryResolved = true;
          if (winner === 'primary' || !winner) {
            winner = 'primary';
            resolve(res);
          }
        } catch (err: any) {
          primaryResolved = true;
          if (winner === 'primary') {
            reject(err);
          } else if (!winner && secondaryResolved) {
            reject(err);
          }
          // If primary errors before winner chosen, secondary will take over
        }
      };

      // 2. Launch Secondary Stream
      const runSecondary = async () => {
        try {
          const tSecStart = performance.now();
          const res = await this.fallbackAdapter!.stream(
            messages,
            policy,
            delta => {
              if (winner === 'primary') return; // Secondary lost race
              if (delta.thinking && !winner) {
                onChunk({ thinking: delta.thinking });
              }
              if (typeof delta.text === 'string' && delta.text.length > 0) {
                if (!winner) {
                  if (delta.text.trim().length > 0) {
                    winner = 'secondary';
                    this.stickinessLocked = true;
                    primaryAbort.abort('Hedged secondary delivered first token; cancelling primary');
                    const fbTtft = Math.round(performance.now() - tSecStart);
                    this.healthTracker.recordSuccess(this.fallbackAdapter!.provider, fallbackModel, fbTtft);
                    emitProvenance?.({
                      requestedProvider: this.primaryAdapter.provider,
                      requestedModel: primaryModel,
                      executedProvider: this.fallbackAdapter!.provider,
                      executedModel: fallbackModel,
                      fallbackOccurred: true,
                      fallbackReason: `Primary exceeded hedge delay (${hedgeDelayMs}ms); hedged request delivered first token`,
                      hedgedRequestUsed: true,
                      modelIdentityVerified: true
                    });
                  }
                }
                if (winner === 'secondary') {
                  onChunk({ text: delta.text });
                }
              }
            },
            { signal: secondaryAbort.signal }
          );
          secondaryResolved = true;
          if (winner === 'secondary') {
            resolve(res);
          }
        } catch (err: any) {
          secondaryResolved = true;
          if (winner === 'secondary') {
            reject(err);
          }
        }
      };

      // Start primary immediately
      runPrimary();

      // Schedule hedge delay for secondary
      hedgeTimer = setTimeout(() => {
        if (!winner && !outerSignal?.aborted) {
          runSecondary();
        }
      }, hedgeDelayMs);
    });

    try {
      return await raceDeferred;
    } finally {
      if (hedgeTimer) {
        clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
    }
  }
}
