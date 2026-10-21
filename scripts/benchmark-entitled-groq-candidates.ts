import * as fs from 'fs';
import { performance } from 'perf_hooks';

const origin = 'https://aira-ai-2026-1k4pabhao-rajpunkeshwarrajgautam-boops-projects.vercel.app';

const candidates = [
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
  'openai/gpt-oss-120b'
];

const prompts = [
  'What is HTTP in one sentence?',
  'Say hello in one sentence.',
  'Explain REST briefly.',
  'What is 2 + 2?',
  'Define latency.',
  'What is DNS in simple terms?',
  'How does a compiler work in one sentence?',
  'Name three primary colors.',
  'What is JSON?',
  'Tell me a short one-line joke.'
];

interface BenchmarkRunResult {
  candidate: string;
  promptIndex: number;
  prompt: string;
  runIndex: number;
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
}

interface CandidateSummary {
  candidate: string;
  totalRuns: number;
  successfulRuns: number;
  errorCount: number;
  minTtftMs: number;
  p50TtftMs: number;
  p75TtftMs: number;
  p90TtftMs: number;
  p95TtftMs: number;
  maxTtftMs: number;
  meanTtftMs: number;
  minTotalMs: number;
  p50TotalMs: number;
  p95TotalMs: number;
  maxTotalMs: number;
  meanTotalMs: number;
  avgContentDeltas: number;
  avgThinkingDeltas: number;
  sampleAnswers: Record<string, string>;
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

async function runPrompt(candidate: string, prompt: string, pIdx: number, rIdx: number): Promise<BenchmarkRunResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${origin}/api/ready/benchmark-groq`, {
      method: 'POST',
      headers: {
        'Origin': origin,
        'x-aira-csrf-protection': '1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: candidate,
        prompt,
        max_tokens: 150,
        temperature: 0.7
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        candidate,
        promptIndex: pIdx,
        prompt,
        runIndex: rIdx,
        success: false,
        httpStatus: res.status,
        ttfbMs: Math.round(performance.now() - t0),
        ttftMs: null,
        firstThinkingMs: null,
        totalDurationMs: Math.round(performance.now() - t0),
        contentDeltaCount: 0,
        thinkingDeltaCount: 0,
        outputTokensEst: 0,
        text: '',
        error: errText
      };
    }

    const data: any = await res.json();
    return {
      candidate,
      promptIndex: pIdx,
      prompt,
      runIndex: rIdx,
      success: Boolean(data.success),
      httpStatus: res.status,
      ttfbMs: data.ttfbMs,
      ttftMs: data.ttftMs,
      firstThinkingMs: data.firstThinkingMs,
      totalDurationMs: data.totalDurationMs,
      contentDeltaCount: data.contentDeltaCount,
      thinkingDeltaCount: data.thinkingDeltaCount,
      outputTokensEst: Math.round((data.text || '').length / 4),
      text: data.text || '',
      thinking: data.thinking
    };
  } catch (err: any) {
    return {
      candidate,
      promptIndex: pIdx,
      prompt,
      runIndex: rIdx,
      success: false,
      httpStatus: 0,
      ttfbMs: Math.round(performance.now() - t0),
      ttftMs: null,
      firstThinkingMs: null,
      totalDurationMs: Math.round(performance.now() - t0),
      contentDeltaCount: 0,
      thinkingDeltaCount: 0,
      outputTokensEst: 0,
      text: '',
      error: err.message
    };
  }
}

async function benchmark() {
  console.log(`=== STARTING 10-PROMPT x 3-RUN BENCHMARK FOR ENTITLED GROQ CANDIDATES ===\n`);
  const allRuns: BenchmarkRunResult[] = [];

  for (const candidate of candidates) {
    console.log(`\n======================================================`);
    console.log(`BENCHMARKING CANDIDATE: ${candidate}`);
    console.log(`======================================================`);

    for (let pIdx = 0; pIdx < prompts.length; pIdx++) {
      const prompt = prompts[pIdx];
      process.stdout.write(`[Prompt ${pIdx + 1}/10] "${prompt.slice(0, 35)}..." `);

      for (let rIdx = 1; rIdx <= 3; rIdx++) {
        const result = await runPrompt(candidate, prompt, pIdx + 1, rIdx);
        allRuns.push(result);
        if (result.success) {
          process.stdout.write(`R${rIdx}:${result.ttftMs}ms `);
        } else {
          process.stdout.write(`R${rIdx}:ERR `);
        }
        // Small 150ms delay between runs to avoid rate limits
        await new Promise(r => setTimeout(r, 150));
      }
      console.log();
    }
  }

  // Calculate summaries
  const summaries: CandidateSummary[] = [];

  for (const candidate of candidates) {
    const candidateRuns = allRuns.filter(r => r.candidate === candidate);
    const successRuns = candidateRuns.filter(r => r.success && r.ttftMs !== null);
    const ttftList = successRuns.map(r => r.ttftMs as number);
    const totalList = successRuns.map(r => r.totalDurationMs);

    const minTtft = ttftList.length ? Math.min(...ttftList) : 0;
    const maxTtft = ttftList.length ? Math.max(...ttftList) : 0;
    const meanTtft = ttftList.length ? Math.round(ttftList.reduce((a, b) => a + b, 0) / ttftList.length) : 0;

    const minTotal = totalList.length ? Math.min(...totalList) : 0;
    const maxTotal = totalList.length ? Math.max(...totalList) : 0;
    const meanTotal = totalList.length ? Math.round(totalList.reduce((a, b) => a + b, 0) / totalList.length) : 0;

    const sampleAnswers: Record<string, string> = {};
    for (const r of candidateRuns) {
      if (!sampleAnswers[r.prompt] && r.text) {
        sampleAnswers[r.prompt] = r.text;
      }
    }

    summaries.push({
      candidate,
      totalRuns: candidateRuns.length,
      successfulRuns: successRuns.length,
      errorCount: candidateRuns.length - successRuns.length,
      minTtftMs: minTtft,
      p50TtftMs: quantile(ttftList, 0.5),
      p75TtftMs: quantile(ttftList, 0.75),
      p90TtftMs: quantile(ttftList, 0.9),
      p95TtftMs: quantile(ttftList, 0.95),
      maxTtftMs: maxTtft,
      meanTtftMs: meanTtft,
      minTotalMs: minTotal,
      p50TotalMs: quantile(totalList, 0.5),
      p95TotalMs: quantile(totalList, 0.95),
      maxTotalMs: maxTotal,
      meanTotalMs: meanTotal,
      avgContentDeltas: Math.round(successRuns.reduce((a, b) => a + b.contentDeltaCount, 0) / (successRuns.length || 1)),
      avgThinkingDeltas: Math.round(successRuns.reduce((a, b) => a + b.thinkingDeltaCount, 0) / (successRuns.length || 1)),
      sampleAnswers
    });
  }

  console.log('\n\n======================================================');
  console.log('FINAL LATENCY BENCHMARK RESULTS (10 Prompts x 3 Runs = 30 Runs / Model)');
  console.log('======================================================');
  console.table(summaries.map(s => ({
    Candidate: s.candidate,
    SuccessRate: `${s.successfulRuns}/${s.totalRuns} (${Math.round((s.successfulRuns / s.totalRuns) * 100)}%)`,
    'MIN TTFT': `${s.minTtftMs} ms`,
    'P50 TTFT': `${s.p50TtftMs} ms`,
    'P75 TTFT': `${s.p75TtftMs} ms`,
    'P90 TTFT': `${s.p90TtftMs} ms`,
    'P95 TTFT': `${s.p95TtftMs} ms`,
    'MAX TTFT': `${s.maxTtftMs} ms`,
    'MEAN TTFT': `${s.meanTtftMs} ms`,
    'P50 Total': `${s.p50TotalMs} ms`,
    'P95 Total': `${s.p95TotalMs} ms`,
    'Avg Think': `${s.avgThinkingDeltas}`
  })));

  fs.writeFileSync('P1_ENTITLED_GROQ_BENCHMARK.json', JSON.stringify({ summaries, allRuns }, null, 2));
  console.log('\nResults saved to P1_ENTITLED_GROQ_BENCHMARK.json');
}

benchmark().catch(console.error);
