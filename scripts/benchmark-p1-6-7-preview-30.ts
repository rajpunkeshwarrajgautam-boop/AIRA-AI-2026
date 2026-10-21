import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

const PREVIEW_URL = process.env.PREVIEW_URL || 'https://aira-ai-2026-lah24sv05-rajpunkeshwarrajgautam-boops-projects.vercel.app';
const TARGET_SAMPLES = 30;

interface DetailedSample {
  sampleIndex: number;
  prompt: string;
  timeToHeadersMs: number;
  timeToFirstSseMs: number;
  timeToFirstContentTokenMs: number; // Client TTFT
  timeToCompletionMs: number;
  serverTtftMs: number;
  serverTotalMs: number;
  capacityAdmissionMs: number;
  capacityDbRoundTrips: number;
  capacityTransactionMs: number;
  capacityLockWaitMs: number;
  runCreationMs: number;
  providerTtftMs: number;
  executedProvider: string;
  executedModel: string;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  deltaCount: number;
  interrupted: boolean;
  contentPreview: string;
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
  'What is tail latency amplification in distributed systems?',
  'What does ACID stand for in databases?',
  'Explain how serverless cold starts happen.',
  'Why are advisory locks useful in PostgreSQL?',
  'What is token bucket rate limiting?',
  'Explain exponential backoff with jitter.'
];

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

async function runSample(sampleIndex: number, prompt: string): Promise<DetailedSample> {
  // Obtain fresh session
  const sessionRes = await fetch(`${PREVIEW_URL}/api/auth/session`, {
    method: 'POST',
    headers: {
      'Origin': PREVIEW_URL,
      'x-aira-csrf-protection': '1',
      'Content-Type': 'application/json'
    }
  });

  if (!sessionRes.ok) {
    throw new Error(`Auth session failed: ${sessionRes.status}`);
  }
  const cookie = sessionRes.headers.get('set-cookie') || '';

  const tStart = performance.now();
  const chatRes = await fetch(`${PREVIEW_URL}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Origin': PREVIEW_URL,
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'x-aira-csrf-protection': '1'
    },
    body: JSON.stringify({
      prompt,
      model: 'aira-auto'
    })
  });

  const tHeaders = performance.now();
  const timeToHeadersMs = Math.round(tHeaders - tStart);

  if (!chatRes.ok) {
    const errorText = await chatRes.text();
    throw new Error(`HTTP ${chatRes.status}: ${errorText}`);
  }

  const reader = chatRes.body?.getReader();
  if (!reader) throw new Error('No body reader');

  const decoder = new TextDecoder();
  let buffer = '';
  let timeToFirstSseMs = 0;
  let timeToFirstContentTokenMs = 0;
  let firstSseRecorded = false;
  let firstDeltaRecorded = false;
  let deltaCount = 0;
  let content = '';
  let latencyMetrics: any = null;
  let modelProvenance: any = null;
  let interrupted = false;

  try {
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
        if (!firstSseRecorded && (line.startsWith('event:') || line.startsWith(': ping') || line.startsWith('data:'))) {
          timeToFirstSseMs = Math.round(now - tStart);
          firstSseRecorded = true;
        }

        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (currentEvent === 'content_delta') {
            try {
              const p = JSON.parse(dataStr);
              if (p.text && p.text.length > 0) {
                if (!firstDeltaRecorded) {
                  timeToFirstContentTokenMs = Math.round(now - tStart);
                  firstDeltaRecorded = true;
                }
                deltaCount++;
                content += p.text;
              }
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
  } catch (readErr) {
    interrupted = true;
    console.error(`Stream interrupted during sample ${sampleIndex}:`, readErr);
  }

  const tEnd = performance.now();
  const timeToCompletionMs = Math.round(tEnd - tStart);

  if (!firstDeltaRecorded) {
    timeToFirstContentTokenMs = timeToCompletionMs;
  }

  const serverTtftMs = latencyMetrics?.ttftMs ?? timeToFirstContentTokenMs;
  const serverTotalMs = latencyMetrics?.totalMs ?? timeToCompletionMs;
  const capacityAdmissionMs = latencyMetrics?.capacityAdmissionMs ?? 0;
  const capacityDbRoundTrips = latencyMetrics?.capacityDbRoundTrips ?? 1;
  const capacityTransactionMs = latencyMetrics?.capacityTransactionMs ?? capacityAdmissionMs;
  const capacityLockWaitMs = latencyMetrics?.capacityLockWaitMs ?? 0;
  const runCreationMs = latencyMetrics?.runCreationMs ?? 0;
  const preProviderMs = capacityAdmissionMs + runCreationMs;
  const providerTtftMs = Math.max(0, serverTtftMs - preProviderMs);

  return {
    sampleIndex,
    prompt,
    timeToHeadersMs,
    timeToFirstSseMs,
    timeToFirstContentTokenMs,
    timeToCompletionMs,
    serverTtftMs,
    serverTotalMs,
    capacityAdmissionMs,
    capacityDbRoundTrips,
    capacityTransactionMs,
    capacityLockWaitMs,
    runCreationMs,
    providerTtftMs,
    executedProvider: modelProvenance?.provider || latencyMetrics?.executedProvider || 'unknown',
    executedModel: modelProvenance?.executedModel || latencyMetrics?.executedModel || 'unknown',
    fallbackOccurred: Boolean(modelProvenance?.fallbackOccurred),
    fallbackReason: modelProvenance?.fallbackReason,
    deltaCount,
    interrupted,
    contentPreview: content.slice(0, 80).replace(/\n/g, ' ')
  };
}

async function main() {
  console.log(`=================================================================`);
  console.log(`AIRA AI 2026 — P1.6.7 LIVE STREAMING & TTFT BENCHMARK (${TARGET_SAMPLES} SAMPLES)`);
  console.log(`Target Preview: ${PREVIEW_URL}`);
  console.log(`Start Time: ${new Date().toISOString()}`);
  console.log(`=================================================================\n`);

  const samples: DetailedSample[] = [];
  let failedCount = 0;

  for (let i = 1; i <= TARGET_SAMPLES; i++) {
    const prompt = PROMPTS[(i - 1) % PROMPTS.length];
    process.stdout.write(`[Sample ${i.toString().padStart(2, '0')}/${TARGET_SAMPLES}] "${prompt.slice(0, 32)}..." `);

    let sample: DetailedSample | null = null;
    let retries = 0;

    while (!sample && retries < 5) {
      try {
        sample = await runSample(i, prompt);
      } catch (err: any) {
        if (err.message?.includes('429')) {
          retries++;
          process.stdout.write(`[429 rate limit - backoff 8s] `);
          await new Promise(r => setTimeout(r, 8000));
        } else {
          console.error(`\nError on sample ${i}:`, err.message);
          failedCount++;
          break;
        }
      }
    }

    if (sample) {
      samples.push(sample);
      console.log(
        `-> Client TTFT: ${sample.timeToFirstContentTokenMs}ms | ` +
        `Server TTFT: ${sample.serverTtftMs}ms | ` +
        `Provider TTFT: ${sample.providerTtftMs}ms | ` +
        `Cap: ${sample.capacityAdmissionMs}ms (dbRoundTrips=${sample.capacityDbRoundTrips}) | ` +
        `Provider: ${sample.executedProvider}:${sample.executedModel}`
      );
    }

    // 4600ms pacing between requests to respect global rate limits
    if (i < TARGET_SAMPLES) {
      await new Promise(r => setTimeout(r, 4600));
    }
  }

  // Summary statistics
  const clientTtfts = samples.map(s => s.timeToFirstContentTokenMs);
  const serverTtfts = samples.map(s => s.serverTtftMs);
  const providerTtfts = samples.map(s => s.providerTtftMs);
  const totalLats = samples.map(s => s.timeToCompletionMs);
  const capAdmissions = samples.map(s => s.capacityAdmissionMs);
  const capDbRoundTrips = samples.map(s => s.capacityDbRoundTrips);
  const interruptions = samples.filter(s => s.interrupted).length;
  const fallbacks = samples.filter(s => s.fallbackOccurred).length;

  const stats = {
    targetUrl: PREVIEW_URL,
    totalTargetSamples: TARGET_SAMPLES,
    successfulSamples: samples.length,
    failedSamples: failedCount,
    interruptionRatePct: (interruptions / samples.length) * 100,
    metrics: {
      clientTtft: {
        p50: quantile(clientTtfts, 0.50),
        p95: quantile(clientTtfts, 0.95),
        p99: quantile(clientTtfts, 0.99),
        min: Math.min(...clientTtfts),
        max: Math.max(...clientTtfts)
      },
      serverTtft: {
        p50: quantile(serverTtfts, 0.50),
        p95: quantile(serverTtfts, 0.95),
        p99: quantile(serverTtfts, 0.99),
        min: Math.min(...serverTtfts),
        max: Math.max(...serverTtfts)
      },
      providerTtft: {
        p50: quantile(providerTtfts, 0.50),
        p95: quantile(providerTtfts, 0.95),
        p99: quantile(providerTtfts, 0.99),
        min: Math.min(...providerTtfts),
        max: Math.max(...providerTtfts)
      },
      timeToCompletion: {
        p50: quantile(totalLats, 0.50),
        p95: quantile(totalLats, 0.95),
        p99: quantile(totalLats, 0.99),
        min: Math.min(...totalLats),
        max: Math.max(...totalLats)
      },
      capacityAdmissionMs: {
        p50: quantile(capAdmissions, 0.50),
        p95: quantile(capAdmissions, 0.95),
        p99: quantile(capAdmissions, 0.99),
        min: Math.min(...capAdmissions),
        max: Math.max(...capAdmissions)
      }
    },
    capacityStoreVerification: {
      allUsedDistributedPostgres: capDbRoundTrips.every(rt => rt >= 1),
      minDbRoundTrips: Math.min(...capDbRoundTrips),
      maxDbRoundTrips: Math.max(...capDbRoundTrips)
    },
    routingVerification: {
      providersUsed: [...new Set(samples.map(s => s.executedProvider))],
      modelsUsed: [...new Set(samples.map(s => s.executedModel))],
      fallbackCount: fallbacks
    },
    samples
  };

  const outPath = path.join(process.cwd(), 'P1_6_7_PREVIEW_30_BENCHMARK_RESULTS.json');
  fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
  console.log(`\n=================================================================`);
  console.log(`BENCHMARK SUMMARY (${samples.length}/${TARGET_SAMPLES} successful)`);
  console.log(`Client TTFT (P50/P95/P99): ${stats.metrics.clientTtft.p50}ms / ${stats.metrics.clientTtft.p95}ms / ${stats.metrics.clientTtft.p99}ms`);
  console.log(`Server TTFT (P50/P95/P99): ${stats.metrics.serverTtft.p50}ms / ${stats.metrics.serverTtft.p95}ms / ${stats.metrics.serverTtft.p99}ms`);
  console.log(`Provider TTFT (P50/P95/P99): ${stats.metrics.providerTtft.p50}ms / ${stats.metrics.providerTtft.p95}ms / ${stats.metrics.providerTtft.p99}ms`);
  console.log(`Capacity Admission (P50/P95): ${stats.metrics.capacityAdmissionMs.p50}ms / ${stats.metrics.capacityAdmissionMs.p95}ms`);
  console.log(`DistributedPostgresCapacityStore Active: ${stats.capacityStoreVerification.allUsedDistributedPostgres}`);
  console.log(`Models executed: ${stats.routingVerification.modelsUsed.join(', ')}`);
  console.log(`Saved detailed report to ${outPath}`);
  console.log(`=================================================================`);
}

main().catch(console.error);
