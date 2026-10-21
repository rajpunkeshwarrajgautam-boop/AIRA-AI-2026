export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ProviderTelemetry {
  provider: string;
  model: string;
  successCount: number;
  failureCount: number;
  recentTTFTP50: number;
  recentTTFTP95: number;
  recentTTFTMax: number;
  consecutiveTimeouts: number;
  consecutiveRateLimits: number;
  rateLimitCount: number;
  serverErrorCount: number;
  firstTokenTimeoutCount: number;
  lastHealthyAt: number | null;
  lastFailureAt: number | null;
  circuitState: CircuitBreakerState;
  circuitOpenedAt: number | null;
  cooldownMs: number;
  currentCooldownMs: number;
}

export interface ProviderHealthTrackerOptions {
  slidingWindowSize?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  consecutiveTimeoutThreshold?: number;
  consecutiveRateLimitThreshold?: number;
  errorRateThreshold?: number;
  p95LatencyThresholdMs?: number;
}

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base]));
  }
  return Math.round(sorted[base]);
}

interface InternalRecord {
  latencies: number[];
  outcomes: Array<'success' | 'timeout' | 'rate_limit' | 'server_error' | 'other_error'>;
  successCount: number;
  failureCount: number;
  consecutiveTimeouts: number;
  consecutiveRateLimits: number;
  rateLimitCount: number;
  serverErrorCount: number;
  firstTokenTimeoutCount: number;
  lastHealthyAt: number | null;
  lastFailureAt: number | null;
  circuitState: CircuitBreakerState;
  circuitOpenedAt: number | null;
  currentCooldownMs: number;
  halfOpenProbes: number;
}

export class ProviderHealthTracker {
  private windowSize: number;
  private defaultCooldownMs: number;
  private maxCooldownMs: number;
  private timeoutThreshold: number;
  private rateLimitThreshold: number;
  private errorRateThreshold: number;
  private p95LatencyThresholdMs: number;

  private records: Map<string, InternalRecord> = new Map();

  constructor(options?: ProviderHealthTrackerOptions) {
    this.windowSize = options?.slidingWindowSize ?? 50;
    this.defaultCooldownMs = options?.cooldownMs ?? 15000;
    this.maxCooldownMs = options?.maxCooldownMs ?? 60000;
    this.timeoutThreshold = options?.consecutiveTimeoutThreshold ?? 2;
    this.rateLimitThreshold = options?.consecutiveRateLimitThreshold ?? 3;
    this.errorRateThreshold = options?.errorRateThreshold ?? 0.4;
    this.p95LatencyThresholdMs = options?.p95LatencyThresholdMs ?? 4000;
  }

  private getKey(provider: string, model: string): string {
    return `${provider.toLowerCase().trim()}:${model.toLowerCase().trim()}`;
  }

  private getOrCreateRecord(provider: string, model: string): InternalRecord {
    const key = this.getKey(provider, model);
    let record = this.records.get(key);
    if (!record) {
      record = {
        latencies: [],
        outcomes: [],
        successCount: 0,
        failureCount: 0,
        consecutiveTimeouts: 0,
        consecutiveRateLimits: 0,
        rateLimitCount: 0,
        serverErrorCount: 0,
        firstTokenTimeoutCount: 0,
        lastHealthyAt: null,
        lastFailureAt: null,
        circuitState: 'CLOSED',
        circuitOpenedAt: null,
        currentCooldownMs: this.defaultCooldownMs,
        halfOpenProbes: 0
      };
      this.records.set(key, record);
    }
    return record;
  }

  public getCircuitState(provider: string, model: string): CircuitBreakerState {
    const record = this.getOrCreateRecord(provider, model);
    if (record.circuitState === 'OPEN') {
      const now = Date.now();
      const openedAt = record.circuitOpenedAt || now;
      if (now - openedAt >= record.currentCooldownMs) {
        // Cooldown has elapsed -> transition to HALF_OPEN to allow probe
        record.circuitState = 'HALF_OPEN';
        record.halfOpenProbes = 0;
      }
    }
    return record.circuitState;
  }

  public isAvailable(provider: string, model: string): boolean {
    const state = this.getCircuitState(provider, model);
    if (state === 'CLOSED') return true;
    if (state === 'HALF_OPEN') {
      // Allow probe request
      return true;
    }
    return false; // OPEN
  }

  public recordSuccess(provider: string, model: string, ttftMs: number): void {
    const record = this.getOrCreateRecord(provider, model);
    const now = Date.now();

    record.successCount++;
    record.consecutiveTimeouts = 0;
    record.consecutiveRateLimits = 0;
    record.lastHealthyAt = now;

    // Reset circuit breaker to CLOSED if it was in HALF_OPEN
    if (record.circuitState === 'HALF_OPEN') {
      record.circuitState = 'CLOSED';
      record.currentCooldownMs = this.defaultCooldownMs;
      record.circuitOpenedAt = null;
      record.halfOpenProbes = 0;
    }

    record.latencies.push(ttftMs);
    if (record.latencies.length > this.windowSize) {
      record.latencies.shift();
    }

    record.outcomes.push('success');
    if (record.outcomes.length > this.windowSize) {
      record.outcomes.shift();
    }
  }

  public recordFailure(
    provider: string,
    model: string,
    error: Error | string,
    statusCode?: number
  ): void {
    const record = this.getOrCreateRecord(provider, model);
    const now = Date.now();
    const errMsg = typeof error === 'string' ? error : error.message || '';
    const isTimeout =
      statusCode === 504 ||
      errMsg.includes('FIRST_TOKEN_TIMEOUT') ||
      errMsg.toLowerCase().includes('timeout') ||
      errMsg.includes('deadline');

    const isRateLimit =
      statusCode === 429 ||
      errMsg.toLowerCase().includes('rate_limit') ||
      errMsg.toLowerCase().includes('rate limit') ||
      errMsg.includes('429');

    const isServerError = typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600 && !isTimeout;

    record.failureCount++;
    record.lastFailureAt = now;

    let outcome: 'timeout' | 'rate_limit' | 'server_error' | 'other_error';
    if (isTimeout) {
      outcome = 'timeout';
      record.consecutiveTimeouts++;
      record.firstTokenTimeoutCount++;
      record.consecutiveRateLimits = 0;
    } else if (isRateLimit) {
      outcome = 'rate_limit';
      record.consecutiveRateLimits++;
      record.rateLimitCount++;
      record.consecutiveTimeouts = 0;
    } else if (isServerError) {
      outcome = 'server_error';
      record.serverErrorCount++;
      record.consecutiveTimeouts = 0;
      record.consecutiveRateLimits = 0;
    } else {
      outcome = 'other_error';
      record.consecutiveTimeouts = 0;
      record.consecutiveRateLimits = 0;
    }

    record.outcomes.push(outcome);
    if (record.outcomes.length > this.windowSize) {
      record.outcomes.shift();
    }

    // Evaluate Circuit Breaker Trip Conditions
    const shouldTrip =
      record.circuitState === 'HALF_OPEN' || // Failed probe immediately trips back
      record.consecutiveTimeouts >= this.timeoutThreshold ||
      record.consecutiveRateLimits >= this.rateLimitThreshold ||
      this.evaluateErrorRateTrip(record);

    if (shouldTrip && record.circuitState !== 'OPEN') {
      this.tripCircuit(record, now);
    }
  }

  private evaluateErrorRateTrip(record: InternalRecord): boolean {
    if (record.outcomes.length < 5) return false;
    const errors = record.outcomes.filter(o => o !== 'success').length;
    const rate = errors / record.outcomes.length;
    if (rate >= this.errorRateThreshold) return true;

    // Check P95 latency trip if we have at least 5 latencies
    if (record.latencies.length >= 5) {
      const p95 = quantile(record.latencies, 0.95);
      if (p95 >= this.p95LatencyThresholdMs) return true;
    }
    return false;
  }

  private tripCircuit(record: InternalRecord, now: number): void {
    if (record.circuitState === 'HALF_OPEN') {
      // Exponential backoff up to maxCooldownMs
      record.currentCooldownMs = Math.min(record.currentCooldownMs * 2, this.maxCooldownMs);
    }
    record.circuitState = 'OPEN';
    record.circuitOpenedAt = now;
  }

  public getTelemetry(provider: string, model: string): ProviderTelemetry {
    const record = this.getOrCreateRecord(provider, model);
    const p50 = quantile(record.latencies, 0.50);
    const p95 = quantile(record.latencies, 0.95);
    const max = record.latencies.length > 0 ? Math.max(...record.latencies) : 0;

    return {
      provider,
      model,
      successCount: record.successCount,
      failureCount: record.failureCount,
      recentTTFTP50: p50,
      recentTTFTP95: p95,
      recentTTFTMax: max,
      consecutiveTimeouts: record.consecutiveTimeouts,
      consecutiveRateLimits: record.consecutiveRateLimits,
      rateLimitCount: record.rateLimitCount,
      serverErrorCount: record.serverErrorCount,
      firstTokenTimeoutCount: record.firstTokenTimeoutCount,
      lastHealthyAt: record.lastHealthyAt,
      lastFailureAt: record.lastFailureAt,
      circuitState: this.getCircuitState(provider, model),
      circuitOpenedAt: record.circuitOpenedAt,
      cooldownMs: this.defaultCooldownMs,
      currentCooldownMs: record.currentCooldownMs
    };
  }

  public getAllTelemetry(): ProviderTelemetry[] {
    const list: ProviderTelemetry[] = [];
    for (const key of this.records.keys()) {
      const [prov, ...rest] = key.split(':');
      const mod = rest.join(':');
      list.push(this.getTelemetry(prov, mod));
    }
    return list;
  }

  public reset(): void {
    this.records.clear();
  }
}
