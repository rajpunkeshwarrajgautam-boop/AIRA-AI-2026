/**
 * Internal NVIDIA hosted-inference entitlement diagnostic.
 * Run server-side: NVIDIA_API_KEY=<configured server secret> npx tsx scripts/check-nvidia-model-access.ts
 * Never deploy as a public API endpoint; this performs billable/quota-limited requests.
 */
export const MODEL_PROBES = [
  { mode: 'AIRA Fast', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
  { mode: 'AIRA Pro', model: 'nvidia/nemotron-3-super-120b-a12b' },
  { mode: 'AIRA Deep', model: 'nvidia/nemotron-3-ultra-550b-a55b' },
  { mode: 'AIRA Vision', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' }
] as const;

export type ProbeResult = {
  mode: string;
  model: string;
  httpStatus: number | null;
  status: 'ACCESS_CONFIRMED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'MODEL_NOT_FOUND' | 'UPSTREAM_FAILURE' | 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE';
  returnedModel: string | null;
  modelIdentityVerified: boolean;
  responsePreview: string | null;
  latencyMs: number;
};

const BASE = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MAX_MS = 25000;
function classify(code: number): ProbeResult['status'] {
  if (code === 401) return 'UNAUTHORIZED';
  if (code === 403) return 'FORBIDDEN';
  if (code === 404) return 'MODEL_NOT_FOUND';
  if (code === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_FAILURE';
}
export async function probeModel(key: string, mode: string, model: string, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  const started = performance.now();
  const base: ProbeResult = { mode, model, httpStatus: null, status: 'NETWORK_ERROR', returnedModel: null, modelIdentityVerified: false, responsePreview: null, latencyMs: 0 };
  try {
    const res = await fetcher(BASE, {
      method: 'POST',
      signal: AbortSignal.timeout(MAX_MS),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 24, temperature: 0.2, stream: false })
    });
    base.httpStatus = res.status;
    if (!res.ok) {
      base.status = classify(res.status);
      await res.body?.cancel().catch(() => undefined);
      return base;
    }
    // Do not include raw provider error bodies; successful output is limited to a fixed,
    // harmless prompt and truncated to protect CLI / logs.
    const data = await res.json() as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    const response = data.choices?.[0]?.message?.content;
    if (typeof response !== 'string' || !response.trim()) {
      base.status = 'INVALID_RESPONSE';
      return base;
    }
    base.status = 'ACCESS_CONFIRMED';
    base.returnedModel = typeof data.model === 'string' ? data.model : null;
    base.modelIdentityVerified = Boolean(base.returnedModel && base.returnedModel.toLowerCase().split('/').pop() === model.toLowerCase().split('/').pop());
    base.responsePreview = response.slice(0, 80).replace(/[\r\n\t]/g, ' ');
    return base;
  } catch (err) {
    base.status = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK_ERROR';
    return base;
  } finally {
    base.latencyMs = Math.round(performance.now() - started);
  }
}

export async function runDiagnostic(key: string, fetcher: typeof fetch = fetch): Promise<ProbeResult[]> {
  if (!key.trim()) throw new Error('NVIDIA_API_KEY is not configured on this server');
  const results: ProbeResult[] = [];
  for (const target of MODEL_PROBES) {
    // Sequential probing prevents accidental burst rate limiting.
    results.push(await probeModel(key, target.mode, target.model, fetcher));
  }
  return results;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/check-nvidia-model-access.ts')) {
  runDiagnostic(process.env.NVIDIA_API_KEY || '').then(results => {
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2) + '\n');
    if (results.some(r => r.status !== 'ACCESS_CONFIRMED')) process.exitCode = 1;
  }).catch(() => {
    process.stderr.write('NVIDIA diagnostic could not start: server credential unavailable or configuration invalid.\n');
    process.exitCode = 2;
  });
}
