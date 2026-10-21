import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeModelIdentifier } from '../../contracts/src/index.js';
import type { ModelAdapter } from './index.js';
import type { AdmissionResult, AdmissionPermit, PrivateBetaCapacityGuard } from './capacity/index.js';

interface InferenceContext {
  principalId: string;
  reservations: ReadonlyMap<PrivateBetaCapacityGuard, AdmissionPermit>;
  signal?: AbortSignal;
}
const context = new AsyncLocalStorage<InferenceContext>();

/** Identity is supplied by verified server middleware/runtime, never request JSON. */
export function withInferencePrincipal<T>(principalId: string, action: () => T): T {
  const current = context.getStore();
  if (current?.principalId === principalId) return action();
  if (!principalId) throw new Error('INFERENCE_PRINCIPAL_REQUIRED');
  return context.run({ principalId, reservations: new Map() }, action);
}

/** Reuse only an actual server-side admission; do not charge chat twice. */
export function withInferenceReservation<T>(guard: PrivateBetaCapacityGuard, admission: AdmissionResult, action: () => T, signal?: AbortSignal): T {
  const current = context.getStore();
  if (!current || !admission.permit) return action();
  if (admission.permit.principalId !== current.principalId) throw new Error('CAPACITY_PRINCIPAL_MISMATCH');
  return context.run({ ...current, reservations: new Map([...current.reservations, [guard, admission.permit]]), signal: signal || current.signal }, action);
}

export class InferenceCapacityError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number;
  constructor(admission: AdmissionResult) {
    super(admission.userMessage || 'Inference capacity is temporarily unavailable.');
    this.code = admission.rejectionCode || 'AIRA_PRIVATE_BETA_CAPACITY';
    this.retryAfterSeconds = admission.retryAfterSeconds || 8;
  }
}

/** Covers chat, direct runs, classifier, workflows and builder calls. */
export function protectInferenceAdapter(adapter: ModelAdapter, guard: PrivateBetaCapacityGuard): ModelAdapter {
  async function execute<T>(policy: Parameters<ModelAdapter['complete']>[1], messages: Parameters<ModelAdapter['complete']>[0], signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const model = normalizeModelIdentifier(policy.model);
    const current = context.getStore();
    const deadline = AbortSignal.timeout(Math.min(policy.timeoutMs || 60000, 60000));
    const boundedSignal = AbortSignal.any([deadline, signal, current?.signal].filter(Boolean) as AbortSignal[]);
    boundedSignal.throwIfAborted();
    if (!current) {
      // Standalone deterministic tests use explicit in-memory dependencies. Hosted
      // inference must always carry a verified server principal.
      if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('INFERENCE_PRINCIPAL_REQUIRED');
      return action(boundedSignal);
    }
    if (!guard.isFastTarget(model) || current.reservations.get(guard)?.isActive?.()) return action(boundedSignal);
    const admission = await guard.admit({
      principalId: current.principalId, model,
      promptText: messages.map(message => message.content).join('\n'),
      abortSignal: boundedSignal
    });
    if (admission.decision !== 'ADMIT_NOW') throw new InferenceCapacityError(admission);
    try {
      return await withInferenceReservation(guard, admission, () => action(boundedSignal));
    } finally {
      await admission.permit?.release();
    }
  }
  const protectedMethods: ModelAdapter = {
    provider: adapter.provider,
    complete: (messages, policy, signal) => execute(policy, messages, signal, bounded => adapter.complete(messages, { ...policy, model: normalizeModelIdentifier(policy.model) }, bounded)),
    stream: (messages, policy, onChunk, options) => execute(policy, messages, options?.signal, bounded => adapter.stream(messages, { ...policy, model: normalizeModelIdentifier(policy.model) }, onChunk, { ...options, signal: bounded }))
  };
  // Preserve adapter identity/prototype and provider metadata for existing callers.
  return new Proxy(adapter, {
    get(target, key, receiver) {
      if (key === 'complete') return protectedMethods.complete;
      if (key === 'stream') return protectedMethods.stream;
      return Reflect.get(target, key, receiver);
    }
  });
}
