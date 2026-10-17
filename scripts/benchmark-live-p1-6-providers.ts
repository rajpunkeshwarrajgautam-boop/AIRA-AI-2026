import * as fs from 'fs';
import { performance } from 'perf_hooks';

const endpoint = 'https://aira-ai-2026.vercel.app/api/ready/benchmark-groq';
const origin = 'https://aira-ai-2026.vercel.app';

const candidates = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'allam-2-7b'
];

interface TestPrompt {
  category: 'coding' | 'factual' | 'instruction' | 'reasoning' | 'technical' | 'json' | 'concise' | 'security';
  prompt: string;
}

const testPrompts: TestPrompt[] = [
  { category: 'concise', prompt: 'Say hello in one concise sentence.' },
  { category: 'factual', prompt: 'What is the exact difference between TCP and UDP?' },
  { category: 'coding', prompt: 'Write a TypeScript function to debounce a callback with leading/trailing options.' },
  { category: 'instruction', prompt: 'List exactly three advantages of vector search. Output only a numbered list, no introductory or concluding text.' },
  { category: 'reasoning', prompt: 'If a train travels 60 miles in 45 minutes, what is its average speed in miles per hour? Explain your calculation in two sentences.' },
  { category: 'technical', prompt: 'Explain how an inverted index works in search retrieval and why it enables sub-millisecond term lookups.' },
  { category: 'json', prompt: 'Return a JSON object with keys "status" (string "ok") and "code" (number 200). Return only raw JSON.' },
  { category: 'security', prompt: 'What is the recommended cryptographic hashing algorithm for storing passwords in 2026, and why is SHA-256 alone insufficient?' }
];

interface BenchmarkResult {
  candidate: string;
  category: string;
  prompt: string;
  iteration: number;
  success: boolean;
  httpStatus: number;
  ttfbMs: number;
  ttftMs: number | null;
  firstThinkingMs: number | null;
  totalDurationMs: number;
  contentDeltaCount: number;
  thinkingDeltaCount: number;
  outputTokensEst: number;
  text: string;
  thinking?: string;
  error?: string;
  isRateLimited: boolean;
  isEmpty: boolean;
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

async function queryModel(candidate: string, promptItem: TestPrompt, iter: number): Promise<BenchmarkResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Origin': origin,
        'x-aira-csrf-protection': '1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: candidate,
        prompt: promptItem.prompt,
        max_tokens: 300,
        temperature: 0.7
      })
    });

    const elapsed = Math.round(performance.now() - t0);

    if (!res.ok) {
      const errText = await res.text();
      const isRateLimited = res.status === 429 || errText.toLowerCase().includes('rate_limit') || errText.toLowerCase().includes('rate limit');
      return {
        candidate,
        category: promptItem.category,
        prompt: promptItem.prompt,
        iteration: iter,
        success: false,
        httpStatus: res.status,
        ttfbMs: elapsed,
        ttftMs: null,
        firstThinkingMs: null,
        totalDurationMs: elapsed,
        contentDeltaCount: 0,
        thinkingDeltaCount: 0,
        outputTokensEst: 0,
        text: '',
        error: errText.slice(0, 300),
        isRateLimited,
        isEmpty: true
      };
    }

    const data: any = await res.json();
    const isRateLimited = data.status === 429 || (data.error && data.error.toLowerCase().includes('rate_limit'));
    const text = (data.text || '').trim();
    const isEmpty = text.length === 0;

    return {
      candidate,
      category: promptItem.category,
      prompt: promptItem.prompt,
      iteration: iter,
      success: Boolean(data.success && !isEmpty),
      httpStatus: res.status,
      ttfbMs: data.ttfbMs ?? elapsed,
      ttftMs: data.ttftMs,
      firstThinkingMs: data.firstThinkingMs,
      totalDurationMs: data.totalDurationMs ?? elapsed,
      contentDeltaCount: data.contentDeltaCount ?? 0,
      thinkingDeltaCount: data.thinkingDeltaCount ?? 0,
      outputTokensEst: Math.round(text.length / 4),
      text,
      thinking: data.thinking,
      error: data.error,
      isRateLimited,
      isEmpty
    };
  } catch (err: any) {
    const elapsed = Math.round(performance.now() - t0);
    return {
      candidate,
      category: promptItem.category,
      prompt: promptItem.prompt,
      iteration: iter,
      success: false,
      httpStatus: 0,
      ttfbMs: elapsed,
      ttftMs: null,
      firstThinkingMs: null,
      totalDurationMs: elapsed,
      contentDeltaCount: 0,
      thinkingDeltaCount: 0,
      outputTokensEst: 0,
      text: '',
      error: err.message,
      isRateLimited: false,
      isEmpty: true
    };
  }
}

async function main() {
  console.log(`================================================================`);
  console.log(`AIRA AI 2026 - P1.6 FRESH LIVE PROVIDER BENCHMARK (Groq Entitled)`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Candidates: ${candidates.join(', ')}`);
  console.log(`Prompts: ${testPrompts.length} across ${candidates.length} models, 2 iterations each`);
  console.log(`================================================================\n`);

  const results: BenchmarkResult[] = [];

  for (const candidate of candidates) {
    console.log(`--> Benchmarking model: ${candidate}`);
    for (let iter = 1; iter <= 2; iter++) {
      for (const p of testPrompts) {
        process.stdout.write(`    [iter ${iter}] [${p.category.padEnd(11)}] "${p.prompt.slice(0, 30)}..." `);
        const r = await queryModel(candidate, p, iter);
        results.push(r);
        if (r.success) {
          console.log(`OK (TTFT: ${r.ttftMs}ms, TTFB: ${r.ttfbMs}ms, Total: ${r.totalDurationMs}ms, Deltas: ${r.contentDeltaCount})`);
        } else {
          console.log(`FAIL (Status: ${r.httpStatus}, 429: ${r.isRateLimited}, Empty: ${r.isEmpty}, Err: ${r.error || 'none'})`);
        }
        // Small 250ms spacing to prevent aggressive bursting
        await new Promise(res => setTimeout(res, 250));
      }
    }
    console.log('');
  }

  // Summarize per candidate
  const summaries: Record<string, any> = {};

  for (const c of candidates) {
    const cRuns = results.filter(r => r.candidate === c);
    const successful = cRuns.filter(r => r.success && r.ttftMs !== null);
    const ttfts = successful.map(r => r.ttftMs as number);
    const totals = successful.map(r => r.totalDurationMs);
    const rateLimits = cRuns.filter(r => r.isRateLimited).length;
    const empties = cRuns.filter(r => r.isEmpty).length;

    summaries[c] = {
      totalRuns: cRuns.length,
      successCount: successful.length,
      successRatePct: Math.round((successful.length / cRuns.length) * 1000) / 10,
      rateLimitCount: rateLimits,
      rateLimitRatePct: Math.round((rateLimits / cRuns.length) * 1000) / 10,
      emptyCount: empties,
      p50TtftMs: quantile(ttfts, 0.50),
      p75TtftMs: quantile(ttfts, 0.75),
      p90TtftMs: quantile(ttfts, 0.90),
      p95TtftMs: quantile(ttfts, 0.95),
      maxTtftMs: ttfts.length > 0 ? Math.max(...ttfts) : 0,
      minTtftMs: ttfts.length > 0 ? Math.min(...ttfts) : 0,
      meanTtftMs: ttfts.length > 0 ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0,
      p50TotalMs: quantile(totals, 0.50),
      p95TotalMs: quantile(totals, 0.95),
      samples: successful.slice(0, 3).map(s => ({
        category: s.category,
        prompt: s.prompt,
        ttftMs: s.ttftMs,
        previewText: s.text.slice(0, 150)
      }))
    };
  }

  fs.writeFileSync('P1_6_FRESH_GROQ_BENCHMARK_RAW.json', JSON.stringify({ timestamp: new Date().toISOString(), results, summaries }, null, 2));

  console.log(`\n================================================================`);
  console.log(`SUMMARY RESULTS:`);
  console.log(`================================================================`);
  console.table(Object.keys(summaries).map(k => ({
    Model: k,
    SuccessRate: `${summaries[k].successRatePct}%`,
    'TTFT P50': `${summaries[k].p50TtftMs} ms`,
    'TTFT P95': `${summaries[k].p95TtftMs} ms`,
    'TTFT Max': `${summaries[k].maxTtftMs} ms`,
    'Total P50': `${summaries[k].p50TotalMs} ms`,
    'RateLimits(429)': summaries[k].rateLimitCount,
    Empties: summaries[k].emptyCount
  })));

  console.log(`Raw benchmark data saved to P1_6_FRESH_GROQ_BENCHMARK_RAW.json`);
}

main().catch(console.error);
