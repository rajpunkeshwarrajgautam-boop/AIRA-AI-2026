import * as fs from 'fs';
import * as path from 'path';

interface RunMetrics {
  prompt: string;
  totalDurationMs: number;
  ttfbMs: number;
  apiPreProcessingMs: number;
  firstThinkingMs: number | null;
  providerTTFTMs: number;
  thinkingCount: number;
  deltaCount: number;
  modelActuallyUsed: string;
  providerActuallyUsed: string;
  fallbackOccurred: boolean;
  responseText: string;
}

const PROMPTS = [
  "Say hello in one sentence.",
  "What is HTTP in one sentence?",
  "Explain REST briefly.",
  "What is 2 + 2?",
  "Define latency.",
  "What is DNS in simple terms?",
  "How does a compiler work in one sentence?",
  "Name three primary colors.",
  "What is JSON?",
  "Tell me a short one-line joke.",
  "Write a haiku about code.",
  "What is an API?",
  "What is the boiling point of water?",
  "Explain the difference between TCP and UDP in one sentence.",
  "What is a boolean?",
  "What is 15 * 4?",
  "Give me two synonyms for quick.",
  "What does HTML stand for?",
  "Explain recursion simply.",
  "Tell me an interesting computer science fact."
];

async function run20PromptBenchmark() {
  const origin = 'https://aira-ai-2026-git-f-a6b62b-rajpunkeshwarrajgautam-boops-projects.vercel.app';
  console.log('=== P1.1 20-PROMPT BALANCED NORMAL CHAT BENCHMARK ===');
  console.log(`Target: ${origin}`);
  console.log(`Sample Size: ${PROMPTS.length} prompts\n`);

  // Session init
  const sessionRes = await fetch(`${origin}/api/auth/session`, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'x-aira-csrf-protection': '1',
      'Content-Type': 'application/json'
    }
  });

  if (!sessionRes.ok) throw new Error('Session init failed');
  const sessionCookie = sessionRes.headers.get('set-cookie') || '';

  const results: RunMetrics[] = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log(`[${i + 1}/${PROMPTS.length}] "${prompt}"`);

    let success = false;
    let attempts = 0;
    while (!success && attempts < 3) {
      attempts++;
      const t0 = performance.now();
      let ttfb = 0;
      let routingTime: number | null = null;
      let firstThinkTime: number | null = null;
      let firstContentTime: number | null = null;
      let thinkDeltas = 0;
      let contentDeltas = 0;
      let text = '';
      let provenance: any = null;

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

        ttfb = performance.now() - t0;
        if (!chatRes.ok) {
          console.error(`  Error HTTP ${chatRes.status}`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        const reader = chatRes.body?.getReader();
        if (!reader) {
          await new Promise(r => setTimeout(r, 3000));
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
              } else if (currentEvent === 'routing_decision' && routingTime === null) {
                routingTime = now - t0;
              } else if (currentEvent === 'model_provenance') {
                try { provenance = JSON.parse(dataStr); } catch {}
              } else if (currentEvent === 'thinking_delta') {
                if (firstThinkTime === null) firstThinkTime = now - t0;
                thinkDeltas++;
              } else if (currentEvent === 'content_delta') {
                if (firstContentTime === null) firstContentTime = now - t0;
                contentDeltas++;
                try { text += JSON.parse(dataStr).text || ''; } catch {}
              } else if (currentEvent === 'error') {
                console.error(`  [SSE ERROR]: ${dataStr}`);
              }
            }
          }
        }

        if (contentDeltas > 0) {
          success = true;
          const totalDuration = performance.now() - t0;
          const metric: RunMetrics = {
            prompt,
            totalDurationMs: Math.round(totalDuration),
            ttfbMs: Math.round(ttfb),
            apiPreProcessingMs: Math.round(routingTime || 0),
            firstThinkingMs: firstThinkTime ? Math.round(firstThinkTime) : null,
            providerTTFTMs: Math.round(firstContentTime || totalDuration),
            thinkingCount: thinkDeltas,
            deltaCount: contentDeltas,
            modelActuallyUsed: provenance?.executedModel || 'unknown',
            providerActuallyUsed: provenance?.provider || 'unknown',
            fallbackOccurred: provenance?.fallbackOccurred || false,
            responseText: text.trim()
          };

          results.push(metric);
          console.log(`  ✓ TTFB: ${metric.ttfbMs}ms | Route: ${metric.apiPreProcessingMs}ms | FirstThink: ${metric.firstThinkingMs}ms (${thinkDeltas} deltas) | TTFT: ${metric.providerTTFTMs}ms | Total: ${metric.totalDurationMs}ms`);
          console.log(`    Response: "${metric.responseText.slice(0, 75)}..."\n`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          console.log(`  [Attempt ${attempts} failed, backing off 3.5s before retry...]`);
          await new Promise(r => setTimeout(r, 3500));
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        await new Promise(r => setTimeout(r, 3500));
      }
    }
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
      p90: getPercentile(ttfts, 90),
      p95: getPercentile(ttfts, 95),
      mean: Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length)
    },
    totalDuration: {
      min: Math.min(...totals),
      max: Math.max(...totals),
      p50: getPercentile(totals, 50),
      p75: getPercentile(totals, 75),
      p90: getPercentile(totals, 90),
      p95: getPercentile(totals, 95),
      mean: Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)
    },
    ttfb: {
      min: Math.min(...ttfbs),
      max: Math.max(...ttfbs),
      p50: getPercentile(ttfbs, 50),
      p75: getPercentile(ttfbs, 75),
      p90: getPercentile(ttfbs, 90),
      p95: getPercentile(ttfbs, 95),
      mean: Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length)
    },
    routing: {
      mean: Math.round(results.map(r => r.apiPreProcessingMs).reduce((a, b) => a + b, 0) / results.length)
    },
    firstThinking: {
      mean: Math.round(results.map(r => r.firstThinkingMs || 0).reduce((a, b) => a + b, 0) / results.length)
    }
  };

  const payload = {
    timestamp: new Date().toISOString(),
    environment: 'preview',
    origin,
    runs: results,
    summary
  };

  fs.writeFileSync('P1_20_PROMPTS_BENCHMARK.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log(`=== 20-PROMPT BENCHMARK SUMMARY ===`);
  console.log(`Sample Count: ${summary.sampleCount}`);
  console.log(`TTFB: p50=${summary.ttfb.p50}ms | p90=${summary.ttfb.p90}ms | p95=${summary.ttfb.p95}ms | mean=${summary.ttfb.mean}ms`);
  console.log(`TTFT: p50=${summary.ttft.p50}ms | p75=${summary.ttft.p75}ms | p90=${summary.ttft.p90}ms | p95=${summary.ttft.p95}ms | mean=${summary.ttft.mean}ms`);
  console.log(`Total: p50=${summary.totalDuration.p50}ms | p75=${summary.totalDuration.p75}ms | p90=${summary.totalDuration.p90}ms | p95=${summary.totalDuration.p95}ms | mean=${summary.totalDuration.mean}ms`);
  console.log(`Pre-Provider Routing (Mean): ${summary.routing.mean}ms`);
  console.log(`First Thinking Token Arrival (Mean): ${summary.firstThinking.mean}ms`);
}

run20PromptBenchmark().catch(console.error);
