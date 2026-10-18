import * as fs from 'fs';
import * as path from 'path';

interface LatencyBreakdown {
  requestId: string;
  type: 'guest' | 'authenticated';
  isWarm: boolean;
  prompt: string;
  clientTtfbMs: number;
  clientTtftMs: number;
  clientTotalMs: number;
  serverTtftMs: number;
  serverTotalMs: number;
  capacityAdmissionMs: number;
  capacityDbRoundtrips: number;
  capacityTransactionMs: number;
  capacityLockWaitMs: number;
  runCreationMs: number;
  dbCriticalPathMs: number;
  preProviderLatencyMs: number;
  providerTtftMs: number;
  executedProvider: string;
  executedModel: string;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  deltaCount: number;
  textPreview: string;
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

async function runSingleRequest(
  origin: string,
  sessionCookie: string | null,
  prompt: string,
  type: 'guest' | 'authenticated',
  isWarm: boolean
): Promise<LatencyBreakdown> {
  let cookieToUse = sessionCookie;

  // If no cookie provided, initialize fresh session
  if (!cookieToUse) {
    const sRes = await fetch(`${origin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Origin': origin,
        'x-aira-csrf-protection': '1',
        'Content-Type': 'application/json'
      }
    });
    if (!sRes.ok) throw new Error(`Session init failed: ${sRes.status}`);
    cookieToUse = sRes.headers.get('set-cookie') || '';
  }

  const t0 = performance.now();
  const chatRes = await fetch(`${origin}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'Content-Type': 'application/json',
      'Cookie': cookieToUse,
      'x-aira-csrf-protection': '1'
    },
    body: JSON.stringify({
      prompt,
      model: 'aira-auto'
    })
  });

  const t1 = performance.now();
  const clientTtfbMs = Math.round(t1 - t0);

  if (!chatRes.ok) {
    throw new Error(`Chat stream error: ${chatRes.status} ${await chatRes.text()}`);
  }

  const reader = chatRes.body?.getReader();
  if (!reader) throw new Error('No body reader');

  const decoder = new TextDecoder();
  let buffer = '';
  let firstDeltaTime: number | null = null;
  let text = '';
  let deltaCount = 0;
  let latencyMetrics: any = null;
  let modelProvenance: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = performance.now();
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        if (currentEvent === 'content_delta') {
          if (firstDeltaTime === null) {
            firstDeltaTime = now - t0;
          }
          deltaCount++;
          try {
            const p = JSON.parse(dataStr);
            text += p.text || '';
          } catch {}
        } else if (currentEvent === 'latency_metrics') {
          try {
            latencyMetrics = JSON.parse(dataStr);
          } catch {}
        } else if (currentEvent === 'model_provenance') {
          try {
            modelProvenance = JSON.parse(dataStr);
          } catch {}
        }
      }
    }
  }

  const tEnd = performance.now();
  const clientTotalMs = Math.round(tEnd - t0);
  const clientTtftMs = firstDeltaTime !== null ? Math.round(firstDeltaTime) : clientTotalMs;

  const serverTtftMs = latencyMetrics?.ttftMs ?? clientTtftMs;
  const serverTotalMs = latencyMetrics?.totalMs ?? clientTotalMs;
  const capacityAdmissionMs = latencyMetrics?.capacityAdmissionMs ?? 0;
  const capacityDbRoundtrips = latencyMetrics?.capacityDbRoundTrips ?? 1;
  const capacityTransactionMs = latencyMetrics?.capacityTransactionMs ?? capacityAdmissionMs;
  const capacityLockWaitMs = latencyMetrics?.capacityLockWaitMs ?? 0;
  const runCreationMs = latencyMetrics?.runCreationMs ?? 0;
  const dbCriticalPathMs = latencyMetrics?.dbCriticalPathMs ?? 0;

  const preProviderLatencyMs = capacityAdmissionMs + runCreationMs;
  const providerTtftMs = Math.max(0, serverTtftMs - preProviderLatencyMs);

  return {
    requestId: latencyMetrics?.requestId || 'unknown',
    type,
    isWarm,
    prompt,
    clientTtfbMs,
    clientTtftMs,
    clientTotalMs,
    serverTtftMs,
    serverTotalMs,
    capacityAdmissionMs,
    capacityDbRoundtrips,
    capacityTransactionMs,
    capacityLockWaitMs,
    runCreationMs,
    dbCriticalPathMs,
    preProviderLatencyMs,
    providerTtftMs,
    executedProvider: modelProvenance?.provider || latencyMetrics?.executedProvider || 'unknown',
    executedModel: modelProvenance?.executedModel || latencyMetrics?.executedModel || 'unknown',
    fallbackOccurred: Boolean(modelProvenance?.fallbackOccurred),
    fallbackReason: modelProvenance?.fallbackReason,
    deltaCount,
    textPreview: text.slice(0, 60).replace(/\n/g, ' ')
  };
}

const PROMPTS = [
  'What is the speed of light in vacuum?',
  'Why do databases use B-tree indexes?',
  'Explain optimistic concurrency in two sentences.',
  'What is the difference between TCP and UDP?',
  'What is the capital of Australia?',
  'How does HTTP/2 multiplexing work?',
  'Explain the CAP theorem briefly.',
  'Why does connection pooling reduce latency?',
  'What is an SSE stream compared to WebSocket?',
  'What is tail latency amplification?'
];

async function main() {
  const origin = process.env.TEST_ORIGIN || 'https://aira-ai-2026.vercel.app';
  console.log(`=== PRODUCTION TTFT & TIMELINE REPRODUCTION ===`);
  console.log(`Target: ${origin}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  const guestResults: LatencyBreakdown[] = [];
  const authResults: LatencyBreakdown[] = [];

  // 1. 10 Sequential Guest Requests (Each with fresh guest session)
  console.log(`--- RUNNING 10 SEQUENTIAL GUEST REQUESTS ---`);
  for (let i = 0; i < 10; i++) {
    const prompt = PROMPTS[i % PROMPTS.length];
    console.log(`[Guest ${i + 1}/10] Sending: "${prompt}"...`);
    // Fresh guest session per request to isolate guest initialization
    let res: LatencyBreakdown | null = null;
    while (!res) {
      try {
        res = await runSingleRequest(origin, null, prompt, 'guest', i > 0);
      } catch (err: any) {
        if (err.message?.includes('429')) {
          console.log(`  -> 429 capacity wait, waiting 10s...`);
          await new Promise(r => setTimeout(r, 10000));
        } else {
          throw err;
        }
      }
    }
    guestResults.push(res);
    console.log(
      `  -> Client TTFT: ${res.clientTtftMs}ms | Server TTFT: ${res.serverTtftMs}ms | ` +
      `Capacity: ${res.capacityAdmissionMs}ms | RunCreate: ${res.runCreationMs}ms | ` +
      `Provider (${res.executedProvider}:${res.executedModel}): ${res.providerTtftMs}ms`
    );
    // 5000ms pacing between requests to respect global 14 RPM
    await new Promise(r => setTimeout(r, 4800));
  }

  // 2. 10 Sequential Authenticated Requests
  console.log(`\n--- RUNNING 10 SEQUENTIAL AUTHENTICATED REQUESTS ---`);
  console.log(`Pacing with 5000ms delay and session renewal to respect per-user (5 RPM) and global (14 RPM) capacity...`);

  for (let i = 0; i < 10; i++) {
    const prompt = PROMPTS[i % PROMPTS.length];
    console.log(`[Auth ${i + 1}/10] Sending: "${prompt}"...`);

    let res: LatencyBreakdown | null = null;
    while (!res) {
      try {
        const authSessRes = await fetch(`${origin}/api/auth/session`, {
          method: 'POST',
          headers: {
            'Origin': origin,
            'x-aira-csrf-protection': '1',
            'Content-Type': 'application/json'
          }
        });
        const authCookie = authSessRes.headers.get('set-cookie') || '';
        res = await runSingleRequest(origin, authCookie, prompt, 'authenticated', true);
      } catch (err: any) {
        if (err.message?.includes('429')) {
          console.log(`  -> 429 capacity wait, waiting 10s...`);
          await new Promise(r => setTimeout(r, 10000));
        } else {
          throw err;
        }
      }
    }
    authResults.push(res);
    console.log(
      `  -> Client TTFT: ${res.clientTtftMs}ms | Server TTFT: ${res.serverTtftMs}ms | ` +
      `Capacity: ${res.capacityAdmissionMs}ms | RunCreate: ${res.runCreationMs}ms | ` +
      `Provider (${res.executedProvider}:${res.executedModel}): ${res.providerTtftMs}ms`
    );
    await new Promise(r => setTimeout(r, 4800));
  }

  // 3. Compute Percentiles
  const computeSuiteStats = (results: LatencyBreakdown[], name: string) => {
    const clientTtfts = results.map(r => r.clientTtftMs);
    const serverTtfts = results.map(r => r.serverTtftMs);
    const providerTtfts = results.map(r => r.providerTtftMs);
    const preProviderLats = results.map(r => r.preProviderLatencyMs);
    const capacityAdmissions = results.map(r => r.capacityAdmissionMs);
    const runCreations = results.map(r => r.runCreationMs);

    return {
      name,
      count: results.length,
      clientTtftP50: quantile(clientTtfts, 0.50),
      clientTtftP95: quantile(clientTtfts, 0.95),
      clientTtftMax: Math.max(...clientTtfts),
      serverTtftP50: quantile(serverTtfts, 0.50),
      serverTtftP95: quantile(serverTtfts, 0.95),
      serverTtftMax: Math.max(...serverTtfts),
      providerTtftP50: quantile(providerTtfts, 0.50),
      providerTtftP95: quantile(providerTtfts, 0.95),
      preProviderP50: quantile(preProviderLats, 0.50),
      preProviderP95: quantile(preProviderLats, 0.95),
      capacityAdmissionP50: quantile(capacityAdmissions, 0.50),
      capacityAdmissionP95: quantile(capacityAdmissions, 0.95),
      runCreationP50: quantile(runCreations, 0.50),
      runCreationP95: quantile(runCreations, 0.95),
      fallbackCount: results.filter(r => r.fallbackOccurred).length,
      executedModels: [...new Set(results.map(r => `${r.executedProvider}:${r.executedModel}`))]
    };
  };

  const guestStats = computeSuiteStats(guestResults, 'Guest Requests');
  const authStats = computeSuiteStats(authResults, 'Authenticated Requests');
  const combinedStats = computeSuiteStats([...guestResults, ...authResults], 'Combined All Requests');

  console.log(`\n==================================================`);
  console.log(`REPRODUCTION PERCENTILE SUMMARY TABLE`);
  console.log(`==================================================`);
  console.log(`Metric                        | Guest (10) | Auth (10)  | Combined (20)`);
  console.log(`------------------------------+------------+------------+--------------`);
  console.log(`Client TTFT P50 (ms)          | ${String(guestStats.clientTtftP50).padEnd(10)} | ${String(authStats.clientTtftP50).padEnd(10)} | ${String(combinedStats.clientTtftP50).padEnd(12)}`);
  console.log(`Client TTFT P95 (ms)          | ${String(guestStats.clientTtftP95).padEnd(10)} | ${String(authStats.clientTtftP95).padEnd(10)} | ${String(combinedStats.clientTtftP95).padEnd(12)}`);
  console.log(`Client TTFT Max (ms)          | ${String(guestStats.clientTtftMax).padEnd(10)} | ${String(authStats.clientTtftMax).padEnd(10)} | ${String(combinedStats.clientTtftMax).padEnd(12)}`);
  console.log(`Server TTFT P50 (ms)          | ${String(guestStats.serverTtftP50).padEnd(10)} | ${String(authStats.serverTtftP50).padEnd(10)} | ${String(combinedStats.serverTtftP50).padEnd(12)}`);
  console.log(`Server TTFT P95 (ms)          | ${String(guestStats.serverTtftP95).padEnd(10)} | ${String(authStats.serverTtftP95).padEnd(10)} | ${String(combinedStats.serverTtftP95).padEnd(12)}`);
  console.log(`Server TTFT Max (ms)          | ${String(guestStats.serverTtftMax).padEnd(10)} | ${String(authStats.serverTtftMax).padEnd(10)} | ${String(combinedStats.serverTtftMax).padEnd(12)}`);
  console.log(`Provider TTFT P50 (ms)        | ${String(guestStats.providerTtftP50).padEnd(10)} | ${String(authStats.providerTtftP50).padEnd(10)} | ${String(combinedStats.providerTtftP50).padEnd(12)}`);
  console.log(`Provider TTFT P95 (ms)        | ${String(guestStats.providerTtftP95).padEnd(10)} | ${String(authStats.providerTtftP95).padEnd(10)} | ${String(combinedStats.providerTtftP95).padEnd(12)}`);
  console.log(`Pre-Provider Latency P50 (ms) | ${String(guestStats.preProviderP50).padEnd(10)} | ${String(authStats.preProviderP50).padEnd(10)} | ${String(combinedStats.preProviderP50).padEnd(12)}`);
  console.log(`Pre-Provider Latency P95 (ms) | ${String(guestStats.preProviderP95).padEnd(10)} | ${String(authStats.preProviderP95).padEnd(10)} | ${String(combinedStats.preProviderP95).padEnd(12)}`);
  console.log(`  - Capacity Admission P50    | ${String(guestStats.capacityAdmissionP50).padEnd(10)} | ${String(authStats.capacityAdmissionP50).padEnd(10)} | ${String(combinedStats.capacityAdmissionP50).padEnd(12)}`);
  console.log(`  - Capacity Admission P95    | ${String(guestStats.capacityAdmissionP95).padEnd(10)} | ${String(authStats.capacityAdmissionP95).padEnd(10)} | ${String(combinedStats.capacityAdmissionP95).padEnd(12)}`);
  console.log(`  - Run Creation DB Write P50 | ${String(guestStats.runCreationP50).padEnd(10)} | ${String(authStats.runCreationP50).padEnd(10)} | ${String(combinedStats.runCreationP50).padEnd(12)}`);
  console.log(`  - Run Creation DB Write P95 | ${String(guestStats.runCreationP95).padEnd(10)} | ${String(authStats.runCreationP95).padEnd(10)} | ${String(combinedStats.runCreationP95).padEnd(12)}`);
  console.log(`Fallbacks Occurred            | ${String(guestStats.fallbackCount).padEnd(10)} | ${String(authStats.fallbackCount).padEnd(10)} | ${String(combinedStats.fallbackCount).padEnd(12)}`);
  console.log(`Executed Models               | ${guestStats.executedModels.join(', ')}`);

  // Write full raw data to JSON artifact
  const outPath = path.resolve(process.cwd(), 'P1_6_7_PRODUCTION_REPRODUCTION_RESULTS.json');
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    origin,
    guestStats,
    authStats,
    combinedStats,
    guestResults,
    authResults
  }, null, 2));
  console.log(`\nDetailed reproduction data saved to: ${outPath}`);
}

main().catch(err => {
  console.error('Fatal reproduction error:', err);
  process.exit(1);
});
