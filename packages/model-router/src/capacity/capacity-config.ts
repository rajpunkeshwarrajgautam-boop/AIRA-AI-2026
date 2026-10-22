export interface PrivateBetaCapacityConfig {
  enabled: boolean;
  globalMaxConcurrent: number;
  perUserMaxConcurrent: number;
  globalRpm: number;
  perUserRpm: number;
  queueMaxDepth: number;
  queueMaxWaitMs: number;
  retryAfterSeconds: number;
  maxPromptTokensApprox: number;
  maxContextTokensApprox: number;
  maxContextTurns: number;
}

export function resolveCapacityConfig(env: NodeJS.ProcessEnv = process.env): PrivateBetaCapacityConfig {
  const isFalse = (val?: string) => val?.trim().toLowerCase() === 'false' || val?.trim() === '0';
  const parseNum = (val: string | undefined, defaultVal: number): number => {
    if (!val) return defaultVal;
    const n = parseInt(val, 10);
    return isNaN(n) || n < 0 ? defaultVal : n;
  };

  return {
    enabled: !isFalse(env.AIRA_PRIVATE_BETA_CAPACITY_GUARD_ENABLED),
    globalMaxConcurrent: parseNum(env.AIRA_FAST_GLOBAL_MAX_CONCURRENT, 2),
    perUserMaxConcurrent: parseNum(env.AIRA_FAST_PER_USER_MAX_CONCURRENT, 1),
    globalRpm: parseNum(env.AIRA_FAST_GLOBAL_RPM, 14),
    perUserRpm: parseNum(env.AIRA_FAST_PER_USER_RPM, 5),
    queueMaxDepth: parseNum(env.AIRA_FAST_QUEUE_MAX_DEPTH, 5),
    queueMaxWaitMs: parseNum(env.AIRA_FAST_QUEUE_MAX_WAIT_MS, 6000),
    retryAfterSeconds: parseNum(env.AIRA_FAST_RETRY_AFTER_SECONDS, 8),
    maxPromptTokensApprox: parseNum(env.AIRA_FAST_MAX_PROMPT_TOKENS, 4000), // ~16k chars
    maxContextTokensApprox: parseNum(env.AIRA_FAST_MAX_CONTEXT_TOKENS, 8000), // ~32k chars
    maxContextTurns: parseNum(env.AIRA_FAST_MAX_CONTEXT_TURNS, 10),
  };
}
