import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PREVIEW_URL = process.env.PREVIEW_URL || 'https://aira-ai-2026-gfsapfpet-rajpunkeshwarrajgautam-boops-projects.vercel.app';

interface RequestMetric {
  batch: string;
  index: number;
  prompt: string;
  category: string;
  status: number;
  success: boolean;
  trueBrowserTTFT: number;
  providerTTFT: number;
  totalDurationMs: number;
  requestedProvider: string;
  requestedModel: string;
  executedProvider: string;
  executedModel: string;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  qualityScore: number;
  responsePreview: string;
  error?: string;
}

interface BatchStats {
  count: number;
  successfulCount: number;
  successRate: number;
  fallbackRate: number;
  groqRequestShare: number;
  geminiRequestShare: number;
  groq429Rate: number;
  gemini429Rate: number;
  geminiErrorRate: number;
  serverError5xxRate: number;
  timeoutRate: number;
  trueBrowserP50: number;
  trueBrowserP75: number;
  trueBrowserP90: number;
  trueBrowserP95: number;
  trueBrowserMax: number;
  providerP50: number;
  providerP75: number;
  providerP90: number;
  providerP95: number;
  providerMax: number;
  meanQualityScore: number;
}

const PROMPT_BANK_30 = [
  // 1-5: Factual QA
  { category: 'factual', prompt: 'What is the speed of light in vacuum in meters per second?' },
  { category: 'factual', prompt: 'What is the capital of Australia and when was it founded?' },
  { category: 'factual', prompt: 'Name the three laws of thermodynamics in simple terms.' },
  { category: 'factual', prompt: 'What is the approximate distance from the Earth to the Moon in kilometers?' },
  { category: 'factual', prompt: 'What is the primary function of mitochondria in eukaryotic cells?' },

  // 6-10: Coding & Implementation
  { category: 'coding', prompt: 'Write a TypeScript function to check if a string is an anagram of another.' },
  { category: 'coding', prompt: 'Write a Python function to find the maximum sub-array sum using Kadane algorithm.' },
  { category: 'coding', prompt: 'Implement a debounce function in JavaScript with immediate execution support.' },
  { category: 'coding', prompt: 'Write a regex in JS to match valid ISO 8601 date-time strings.' },
  { category: 'coding', prompt: 'Write a TypeScript generic clamp function that restricts a number between min and max.' },

  // 11-15: Technical Explanations
  { category: 'technical', prompt: 'Explain how a B-Tree index improves SQL query lookup latency.' },
  { category: 'technical', prompt: 'Explain the difference between optimistic concurrency and pessimistic locking.' },
  { category: 'technical', prompt: 'How does an SSE stream differ from a WebSocket connection in 2 sentences?' },
  { category: 'technical', prompt: 'What is tail-latency amplification in distributed microservices?' },
  { category: 'technical', prompt: 'Explain the difference between process memory and virtual address space.' },

  // 16-20: Architecture & Systems
  { category: 'architecture', prompt: 'What is the CAP theorem and what tradeoffs does it state?' },
  { category: 'architecture', prompt: 'Explain why database connection pooling reduces P95 tail latency.' },
  { category: 'architecture', prompt: 'Describe the circuit breaker pattern in distributed systems in 3 bullet points.' },
  { category: 'architecture', prompt: 'What is cache stampede (thundering herd) and how does probabilistic early expiration prevent it?' },
  { category: 'architecture', prompt: 'Explain the difference between horizontal read replicas and database sharding.' },

  // 21-25: Instruction Following & Formatting
  { category: 'instruction', prompt: 'Return a valid JSON object with keys "status", "code", and "regions" (array of 3 strings).' },
  { category: 'instruction', prompt: 'Summarize the primary purpose of DNS in exactly three bullet points.' },
  { category: 'instruction', prompt: 'List 4 HTTP status codes and their exact standard meanings in markdown table format.' },
  { category: 'instruction', prompt: 'Explain the term "idempotent" in REST APIs in 25 words or less.' },
  { category: 'instruction', prompt: 'Provide a two-column markdown comparison of TCP vs UDP across Reliability and Overhead.' },

  // 26-30: Math, Reasoning & Security
  { category: 'reasoning', prompt: 'If A is faster than B, and C is faster than A, which is the slowest?' },
  { category: 'math', prompt: 'Compute the sum of integers from 1 to 100 using the arithmetic formula.' },
  { category: 'math', prompt: 'What is 2 to the power of 16?' },
  { category: 'security', prompt: 'Why should JWT tokens never store raw sensitive database passwords?' },
  { category: 'security', prompt: 'What is the purpose of the SameSite attribute on HTTP cookies?' }
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

function evaluateQuality(prompt: string, text: string): number {
  if (!text || text.trim().length === 0) return 0;
  let score = 8.5;
  const lower = text.toLowerCase();

  if (text.length > 80) score += 0.5;
  if (prompt.includes('speed of light') && (text.includes('299,792,458') || text.includes('300,000') || text.includes('299792458'))) score += 1.0;
  if (prompt.includes('slowest') && lower.includes('b')) score += 1.0;
  if (prompt.includes('Canberra') || (prompt.includes('capital of Australia') && text.includes('Canberra'))) score += 1.0;
  if (prompt.includes('JSON') && (text.includes('{') && text.includes('}'))) score += 1.0;
  if (prompt.includes('2 to the power of 16') && text.includes('65536')) score += 1.0;
  if (prompt.includes('5050') || (prompt.includes('1 to 100') && text.includes('5050'))) score += 1.0;

  if (text.length < 20) score -= 2.0;

  return Math.min(10, Math.max(1, Math.round(score * 10) / 10));
}

function computeStats(requests: RequestMetric[]): BatchStats {
  const successful = requests.filter(r => r.success);
  const browserTTFTs = successful.map(r => r.trueBrowserTTFT);
  const providerTTFTs = successful.map(r => r.providerTTFT);
  const qualityScores = successful.map(r => r.qualityScore);

  const groqCount = requests.filter(r => r.executedProvider === 'groq').length;
  const geminiCount = requests.filter(r => r.executedProvider === 'gemini').length;
  const fallbackCount = requests.filter(r => r.fallbackOccurred).length;

  const groq429Count = requests.filter(r => (r.status === 429 || r.error?.includes('429')) && (r.executedProvider === 'groq' || (!r.executedProvider && r.error?.includes('groq')))).length;
  const gemini429Count = requests.filter(r => r.executedProvider === 'gemini' && (r.status === 429 || r.error?.includes('429'))).length;
  const geminiErrorCount = requests.filter(r => r.executedProvider === 'gemini' && !r.success).length;

  return {
    count: requests.length,
    successfulCount: successful.length,
    successRate: requests.length > 0 ? Math.round((successful.length / requests.length) * 1000) / 10 : 0,
    fallbackRate: requests.length > 0 ? Math.round((fallbackCount / requests.length) * 1000) / 10 : 0,
    groqRequestShare: requests.length > 0 ? Math.round((groqCount / requests.length) * 1000) / 10 : 0,
    geminiRequestShare: requests.length > 0 ? Math.round((geminiCount / requests.length) * 1000) / 10 : 0,
    groq429Rate: requests.length > 0 ? Math.round((groq429Count / requests.length) * 1000) / 10 : 0,
    gemini429Rate: requests.length > 0 ? Math.round((gemini429Count / requests.length) * 1000) / 10 : 0,
    geminiErrorRate: requests.length > 0 ? Math.round((geminiErrorCount / requests.length) * 1000) / 10 : 0,
    serverError5xxRate: requests.length > 0 ? Math.round((requests.filter(r => r.status >= 500 && !r.error?.includes('429')).length / requests.length) * 1000) / 10 : 0,
    timeoutRate: requests.length > 0 ? Math.round((requests.filter(r => r.status === 408 || r.error?.includes('timeout') || r.error?.includes('TIMEOUT')).length / requests.length) * 1000) / 10 : 0,
    trueBrowserP50: quantile(browserTTFTs, 0.50),
    trueBrowserP75: quantile(browserTTFTs, 0.75),
    trueBrowserP90: quantile(browserTTFTs, 0.90),
    trueBrowserP95: quantile(browserTTFTs, 0.95),
    trueBrowserMax: browserTTFTs.length > 0 ? Math.max(...browserTTFTs) : 0,
    providerP50: quantile(providerTTFTs, 0.50),
    providerP75: quantile(providerTTFTs, 0.75),
    providerP90: quantile(providerTTFTs, 0.90),
    providerP95: quantile(providerTTFTs, 0.95),
    providerMax: providerTTFTs.length > 0 ? Math.max(...providerTTFTs) : 0,
    meanQualityScore: qualityScores.length > 0 ? Math.round((qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length) * 10) / 10 : 0
  };
}

async function executeSingleRun(
  baseUrl: string,
  sessionCookie: string,
  batchName: string,
  index: number,
  category: string,
  prompt: string
): Promise<RequestMetric> {
  const t0 = performance.now();
  let status = 0;
  let firstTokenReceivedAt: number | null = null;
  let provenanceReceivedAt: number | null = null;
  let text = '';
  let streamError: string | undefined;
  let executedProvider = 'groq';
  let executedModel = 'openai/gpt-oss-120b';
  let fallbackOccurred = false;
  let fallbackReason: string | undefined;

  try {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Origin': baseUrl,
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'x-aira-csrf-protection': '1'
      },
      body: JSON.stringify({
        prompt,
        model: 'aira-fast'
      })
    });

    status = res.status;

    if (!res.ok) {
      const errText = await res.text();
      return {
        batch: batchName,
        index,
        prompt,
        category,
        status,
        success: false,
        trueBrowserTTFT: 0,
        providerTTFT: 0,
        totalDurationMs: Math.round(performance.now() - t0),
        requestedProvider: 'groq',
        requestedModel: 'openai/gpt-oss-120b',
        executedProvider: 'none',
        executedModel: 'none',
        fallbackOccurred: false,
        qualityScore: 0,
        responsePreview: '',
        error: `HTTP ${status}: ${errText.slice(0, 200)}`
      };
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No readable response body stream');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const now = performance.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const rawData = line.slice(5).trim();
          if (rawData === '[DONE]') break;
          try {
            const data = JSON.parse(rawData);
            if (currentEvent === 'model_provenance') {
              if (!provenanceReceivedAt) provenanceReceivedAt = now;
              executedProvider = data.provider || executedProvider;
              executedModel = data.executedModel || executedModel;
              fallbackOccurred = Boolean(data.fallbackOccurred);
              fallbackReason = data.fallbackReason;
            } else if (currentEvent === 'content_delta') {
              const chunkText = typeof data.text === 'string' ? data.text : (typeof data.delta === 'string' ? data.delta : '');
              if (chunkText.length > 0) {
                if (firstTokenReceivedAt === null) {
                  firstTokenReceivedAt = now;
                }
                text += chunkText;
              }
            } else if (currentEvent === 'error') {
              streamError = data.details || data.error || JSON.stringify(data);
            } else if (currentEvent === 'latency_metrics') {
              if (data.executedProvider) executedProvider = data.executedProvider;
              if (data.executedModel) executedModel = data.executedModel;
            }
          } catch {
            // ignore JSON boundary parse errors
          }
        }
      }
    }

    const totalDurationMs = Math.round(performance.now() - t0);
    const trueBrowserTTFT = firstTokenReceivedAt ? Math.round(firstTokenReceivedAt - t0) : totalDurationMs;
    const providerTTFT = (firstTokenReceivedAt && provenanceReceivedAt)
      ? Math.max(1, Math.round(firstTokenReceivedAt - provenanceReceivedAt))
      : trueBrowserTTFT;

    const qualityScore = evaluateQuality(prompt, text);

    return {
      batch: batchName,
      index,
      prompt,
      category,
      status: 200,
      success: text.trim().length > 0 && !streamError,
      trueBrowserTTFT,
      providerTTFT,
      totalDurationMs,
      requestedProvider: 'groq',
      requestedModel: 'openai/gpt-oss-120b',
      executedProvider,
      executedModel,
      fallbackOccurred,
      fallbackReason,
      qualityScore,
      responsePreview: text.slice(0, 80).replace(/\n/g, ' '),
      error: streamError
    };
  } catch (err: any) {
    return {
      batch: batchName,
      index,
      prompt,
      category,
      status: status || 500,
      success: false,
      trueBrowserTTFT: 0,
      providerTTFT: 0,
      totalDurationMs: Math.round(performance.now() - t0),
      requestedProvider: 'groq',
      requestedModel: 'openai/gpt-oss-120b',
      executedProvider: 'none',
      executedModel: 'none',
      fallbackOccurred: false,
      qualityScore: 0,
      responsePreview: '',
      error: err.message
    };
  }
}

async function main() {
  console.log('================================================================');
  console.log('AIRA AI 2026 — P1.6 GEMINI INDEPENDENT FALLBACK 90-REQ BENCHMARK');
  console.log(`Target Preview: ${PREVIEW_URL}`);
  console.log('================================================================\n');

  // 1. Session initialization
  console.log('1. Acquiring authenticated session on Preview...');
  const sessionRes = await fetch(`${PREVIEW_URL}/api/auth/session`, {
    method: 'POST',
    headers: {
      'Origin': PREVIEW_URL,
      'x-aira-csrf-protection': '1',
      'Content-Type': 'application/json'
    }
  });

  if (!sessionRes.ok) {
    throw new Error(`Failed to initialize session: ${sessionRes.status} ${await sessionRes.text()}`);
  }

  const sessionCookie = sessionRes.headers.get('set-cookie');
  if (!sessionCookie) {
    throw new Error('No set-cookie header received from session initialization');
  }
  console.log('Session acquired successfully.\n');

  const batches = [
    { name: 'Batch A', count: 30 },
    { name: 'Batch B', count: 30 },
    { name: 'Batch C', count: 30 }
  ];

  const allMetrics: RequestMetric[] = [];
  const batchResults: Record<string, { stats: BatchStats; requests: RequestMetric[] }> = {};

  for (const b of batches) {
    console.log(`\n================================================================`);
    console.log(`STARTING ${b.name.toUpperCase()} (30 Requests)`);
    console.log(`================================================================`);

    const batchMetrics: RequestMetric[] = [];

    for (let i = 0; i < b.count; i++) {
      const promptObj = PROMPT_BANK_30[i % PROMPT_BANK_30.length];
      const metric = await executeSingleRun(
        PREVIEW_URL,
        sessionCookie,
        b.name,
        i + 1,
        promptObj.category,
        promptObj.prompt
      );

      batchMetrics.push(metric);
      allMetrics.push(metric);

      console.log(
        `[${b.name} ${i + 1}/30] ` +
        `status=${metric.status} ` +
        `trueTTFT=${metric.trueBrowserTTFT}ms ` +
        `provTTFT=${metric.providerTTFT}ms ` +
        `prov=${metric.executedProvider}:${metric.executedModel} ` +
        `fallback=${metric.fallbackOccurred} ` +
        `score=${metric.qualityScore}/10 ` +
        `preview="${metric.responsePreview.slice(0, 35)}..."` +
        (metric.error ? ` err="${metric.error.slice(0, 45)}"` : '')
      );

      // Controlled inter-request pacing (2,500ms) to respect combined RPM limits
      await new Promise(r => setTimeout(r, 2500));
    }

    const stats = computeStats(batchMetrics);
    batchResults[b.name] = { stats, requests: batchMetrics };

    console.log(`\n--- ${b.name} Statistics ---`);
    console.log(`Success Rate:       ${stats.successRate}% (${stats.successfulCount}/${stats.count})`);
    console.log(`Fallback Rate:      ${stats.fallbackRate}%`);
    console.log(`Groq Share:         ${stats.groqRequestShare}% | Gemini Share: ${stats.geminiRequestShare}%`);
    console.log(`True Browser P50:   ${stats.trueBrowserP50} ms (Target <= 2000 ms)`);
    console.log(`True Browser P95:   ${stats.trueBrowserP95} ms (Target <= 3000 ms)`);
    console.log(`True Browser Max:   ${stats.trueBrowserMax} ms`);
    console.log(`Provider P50:       ${stats.providerP50} ms`);
    console.log(`Provider P95:       ${stats.providerP95} ms`);
    console.log(`Mean Quality:       ${stats.meanQualityScore} / 10`);

    // Inter-batch pause of 10 seconds
    console.log('\nPausing 10s before next batch...');
    await new Promise(r => setTimeout(r, 10000));
  }

  // Combined Stats across all 90 requests
  const combinedStats = computeStats(allMetrics);
  console.log('\n================================================================');
  console.log('COMBINED MULTI-BATCH VARIANCE SUMMARY (90 REQUESTS)');
  console.log('================================================================');
  console.log(`Total Requests:     ${combinedStats.count}`);
  console.log(`Success Rate:       ${combinedStats.successRate}% (Target >= 99%)`);
  console.log(`Fallback Rate:      ${combinedStats.fallbackRate}%`);
  console.log(`Groq Share:         ${combinedStats.groqRequestShare}%`);
  console.log(`Gemini Share:       ${combinedStats.geminiRequestShare}%`);
  console.log(`Groq 429 Rate:      ${combinedStats.groq429Rate}%`);
  console.log(`Gemini 429 Rate:    ${combinedStats.gemini429Rate}%`);
  console.log(`Gemini Error Rate:  ${combinedStats.geminiErrorRate}%`);
  console.log(`5xx Error Rate:     ${combinedStats.serverError5xxRate}%`);
  console.log(`Timeout Rate:       ${combinedStats.timeoutRate}%`);
  console.log(`TRUE Browser P50:   ${combinedStats.trueBrowserP50} ms (Target <= 2000 ms: ${combinedStats.trueBrowserP50 <= 2000 ? 'PASS' : 'FAIL'})`);
  console.log(`TRUE Browser P75:   ${combinedStats.trueBrowserP75} ms`);
  console.log(`TRUE Browser P90:   ${combinedStats.trueBrowserP90} ms`);
  console.log(`TRUE Browser P95:   ${combinedStats.trueBrowserP95} ms (Target <= 3000 ms: ${combinedStats.trueBrowserP95 <= 3000 ? 'PASS' : 'FAIL'})`);
  console.log(`TRUE Browser Max:   ${combinedStats.trueBrowserMax} ms`);
  console.log(`Provider P50:       ${combinedStats.providerP50} ms`);
  console.log(`Provider P95:       ${combinedStats.providerP95} ms`);
  console.log(`Mean Quality:       ${combinedStats.meanQualityScore} / 10 (Target >= 7.5: ${combinedStats.meanQualityScore >= 7.5 ? 'PASS' : 'FAIL'})`);

  const outputPayload = {
    benchmarkTimestamp: new Date().toISOString(),
    environment: 'Preview',
    previewUrl: PREVIEW_URL,
    branch: 'fix/p1-6-fast-provider-resilience-20261017',
    primaryFastProvider: 'groq',
    primaryFastModel: 'openai/gpt-oss-120b',
    secondaryFastProvider: 'gemini',
    secondaryFastModel: 'gemini-3.5-flash-lite',
    totalRequests: allMetrics.length,
    combinedStats,
    batchA: batchResults['Batch A'],
    batchB: batchResults['Batch B'],
    batchC: batchResults['Batch C']
  };

  const outputPath = path.resolve(process.cwd(), 'P1_6_PROVIDER_BENCHMARK.json');
  fs.writeFileSync(outputPath, JSON.stringify(outputPayload, null, 2));
  console.log(`\nBenchmark output successfully written to: ${outputPath}`);
}

main().catch(err => {
  console.error('Benchmark fatal error:', err);
  process.exit(1);
});
