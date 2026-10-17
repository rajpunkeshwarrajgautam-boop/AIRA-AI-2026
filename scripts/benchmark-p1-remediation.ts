import * as fs from 'fs';
import * as path from 'path';

interface RunMetrics {
  prompt: string;
  totalDurationMs: number;
  ttfbMs: number;
  apiPreProcessingMs: number; // time to routing_decision
  modelRouterMs: number;     // time from routing_decision to model_provenance
  providerConnectionMs: number; // time from provenance to first delta
  providerTTFTMs: number;       // time to first content delta
  firstThinkingMs: number | null;
  downstreamRelayDelayMs: number;
  clientRenderDelayMs: number;
  deltaCount: number;
  thinkingCount: number;
  tokenCountEstimate: number;
  modelActuallyUsed: string;
  providerActuallyUsed: string;
  fallbackOccurred: boolean;
  retryCount: number;
  upstreamStatus: number;
  responseText: string;
  routingReason: string;
}

const PROMPTS = [
  "What is HTTP in one sentence?",
  "Say hello in one sentence.",
  "Explain REST briefly.",
  "What is 2 + 2?",
  "Define latency.",
  "What is DNS in simple terms?",
  "How does a compiler work in one sentence?",
  "Name three primary colors.",
  "What is JSON?",
  "Tell me a short one-line joke."
];

async function runRemediationBenchmark() {
  const origin = process.env.BENCHMARK_ORIGIN || 'https://aira-ai-2026-git-f-a6b62b-rajpunkeshwarrajgautam-boops-projects.vercel.app';
  console.log('=== AIRA AI 2026 — P1 INFERENCE LATENCY POST-REMEDIATION BENCHMARK ===');
  console.log(`Target: ${origin}`);
  console.log(`Executing ${PROMPTS.length} controlled conversational prompts...\n`);

  const results: RunMetrics[] = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log(`[Prompt ${i + 1}/${PROMPTS.length}] "${prompt}"`);

    // 1. Session init
    const sessionRes = await fetch(`${origin}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Origin': origin,
        'x-aira-csrf-protection': '1',
        'Content-Type': 'application/json'
      }
    });

    if (!sessionRes.ok) {
      throw new Error(`Failed to initialize session: ${sessionRes.status}`);
    }

    const sessionCookie = sessionRes.headers.get('set-cookie') || '';

    // 2. Chat stream request
    const t0 = performance.now();
    let ttfb = 0;
    let routingTime: number | null = null;
    let provenanceTime: number | null = null;
    let firstThinkingTime: number | null = null;
    let firstContentTime: number | null = null;
    let contentDeltaCount = 0;
    let thinkingDeltaCount = 0;
    let responseText = '';
    let routingDecision: any = null;
    let modelProvenance: any = null;
    let upstreamStatus = 0;

    try {
      const chatRes = await fetch(`${origin}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Origin': origin,
          'Content-Type': 'application/json',
          'Cookie': sessionCookie,
          'x-aira-csrf-protection': '1'
        },
        body: JSON.stringify({
          prompt,
          model: 'aira-auto'
        })
      });

      upstreamStatus = chatRes.status;
      ttfb = performance.now() - t0;

      if (!chatRes.ok) {
        console.error(`  Error HTTP ${chatRes.status}: ${await chatRes.text()}`);
        continue;
      }

      const reader = chatRes.body?.getReader();
      if (!reader) {
        console.error('  No readable body');
        continue;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let streamEnded = false;

      while (!streamEnded) {
        const { done, value } = await reader.read();
        if (done) break;
        const now = performance.now();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (currentEvent === 'done' || dataStr === '[DONE]') {
              streamEnded = true;
              break;
            } else if (currentEvent === 'error') {
              console.error(`  Stream error event: ${dataStr}`);
              streamEnded = true;
              break;
            } else if (currentEvent === 'routing_decision' && routingTime === null) {
              routingTime = now - t0;
              try { routingDecision = JSON.parse(dataStr); } catch {}
            } else if (currentEvent === 'model_provenance' && provenanceTime === null) {
              provenanceTime = now - t0;
              try { modelProvenance = JSON.parse(dataStr); } catch {}
            } else if (currentEvent === 'thinking_delta') {
              if (firstThinkingTime === null) firstThinkingTime = now - t0;
              thinkingDeltaCount++;
            } else if (currentEvent === 'content_delta') {
              if (firstContentTime === null) firstContentTime = now - t0;
              contentDeltaCount++;
              try {
                const parsed = JSON.parse(dataStr);
                responseText += parsed.text || '';
              } catch {}
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`  Fetch error: ${err.message}`);
    }

    const tEnd = performance.now();
    const totalDuration = tEnd - t0;

    const metric: RunMetrics = {
      prompt,
      totalDurationMs: Math.round(totalDuration),
      ttfbMs: Math.round(ttfb),
      apiPreProcessingMs: Math.round(routingTime || 0),
      modelRouterMs: Math.round((provenanceTime && routingTime) ? (provenanceTime - routingTime) : 0),
      providerConnectionMs: Math.round((firstThinkingTime && provenanceTime) ? (firstThinkingTime - provenanceTime) : ((firstContentTime && provenanceTime) ? (firstContentTime - provenanceTime) : 0)),
      providerTTFTMs: Math.round(firstContentTime || totalDuration),
      firstThinkingMs: firstThinkingTime ? Math.round(firstThinkingTime) : null,
      downstreamRelayDelayMs: Math.round(Math.max(0, (firstContentTime || 0) - (firstThinkingTime || 0))),
      clientRenderDelayMs: 4, // local benchmark render budget
      deltaCount: contentDeltaCount,
      thinkingCount: thinkingDeltaCount,
      tokenCountEstimate: Math.round(responseText.length / 4),
      modelActuallyUsed: modelProvenance?.executedModel || 'unknown',
      providerActuallyUsed: modelProvenance?.provider || 'unknown',
      fallbackOccurred: Boolean(modelProvenance?.fallbackOccurred),
      retryCount: 0,
      upstreamStatus,
      responseText: responseText.trim(),
      routingReason: routingDecision?.reason || 'unknown'
    };

    results.push(metric);
    console.log(`  ✓ TTFB: ${metric.ttfbMs}ms | Routing: ${metric.apiPreProcessingMs}ms | First Thinking: ${metric.firstThinkingMs ?? 'N/A'}ms | TTFT (Visible Text): ${metric.providerTTFTMs}ms | Total: ${metric.totalDurationMs}ms`);
    console.log(`  Model: ${metric.modelActuallyUsed} (${metric.providerActuallyUsed})`);
    console.log(`  Response: "${metric.responseText.slice(0, 80)}..."\n`);
  }

  // Calculate percentiles
  const ttfts = results.map(r => r.providerTTFTMs).sort((a, b) => a - b);
  const totals = results.map(r => r.totalDurationMs).sort((a, b) => a - b);
  const ttfbs = results.map(r => r.ttfbMs).sort((a, b) => a - b);

  const getPercentile = (arr: number[], p: number) => {
    const idx = Math.floor((p / 100) * (arr.length - 1));
    return arr[idx];
  };

  const summary = {
    sampleCount: results.length,
    ttft: {
      min: Math.min(...ttfts),
      max: Math.max(...ttfts),
      p50: getPercentile(ttfts, 50),
      p75: getPercentile(ttfts, 75),
      p95: getPercentile(ttfts, 95),
      mean: Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length)
    },
    totalDuration: {
      min: Math.min(...totals),
      max: Math.max(...totals),
      p50: getPercentile(totals, 50),
      p75: getPercentile(totals, 75),
      p95: getPercentile(totals, 95),
      mean: Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)
    },
    ttfb: {
      min: Math.min(...ttfbs),
      max: Math.max(...ttfbs),
      p50: getPercentile(ttfbs, 50),
      p75: getPercentile(ttfbs, 75),
      p95: getPercentile(ttfbs, 95),
      mean: Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length)
    },
    apiPreProcessing: {
      mean: Math.round(results.map(r => r.apiPreProcessingMs).reduce((a, b) => a + b, 0) / results.length)
    },
    modelRouter: {
      mean: Math.round(results.map(r => r.modelRouterMs).reduce((a, b) => a + b, 0) / results.length)
    },
    providerConnection: {
      mean: Math.round(results.map(r => r.providerConnectionMs).reduce((a, b) => a + b, 0) / results.length)
    }
  };

  const outputPayload = {
    benchmarkTimestamp: new Date().toISOString(),
    environment: 'preview',
    targetOrigin: origin,
    runs: results,
    summary
  };

  const jsonPath = path.resolve('P1_INFERENCE_REMEDIATION.json');
  fs.writeFileSync(jsonPath, JSON.stringify(outputPayload, null, 2), 'utf8');
  console.log(`Saved JSON benchmark results to ${jsonPath}`);

  console.log('\n=== REMEDIATION BENCHMARK SUMMARY ===');
  console.log(`Sample Count: ${summary.sampleCount}`);
  console.log(`TTFB: p50 = ${summary.ttfb.p50}ms, p95 = ${summary.ttfb.p95}ms, mean = ${summary.ttfb.mean}ms`);
  console.log(`TTFT: p50 = ${summary.ttft.p50}ms, p95 = ${summary.ttft.p95}ms, mean = ${summary.ttft.mean}ms`);
  console.log(`Total: p50 = ${summary.totalDuration.p50}ms, p95 = ${summary.totalDuration.p95}ms, mean = ${summary.totalDuration.mean}ms`);
}

runRemediationBenchmark().catch(console.error);
