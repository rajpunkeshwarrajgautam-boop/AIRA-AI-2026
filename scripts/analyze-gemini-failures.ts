import * as fs from 'node:fs';
import * as path from 'node:path';

const benchmarkPath = path.resolve('P1_6_PROVIDER_BENCHMARK.json');
const data = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));

const allRequests: any[] = [
  ...(data.batchA?.requests || []),
  ...(data.batchB?.requests || []),
  ...(data.batchC?.requests || [])
];

console.log('Total recorded requests:', allRequests.length);

const geminiRequests = allRequests.filter((r: any) => 
  r.executedProvider === 'gemini' || 
  r.requestedProvider === 'gemini' || 
  (r.error && r.error.includes('Gemini'))
);
console.log('Total Gemini requests:', geminiRequests.length);

const allFailures = allRequests.filter((r: any) => !r.success);
console.log('Total failures across all requests:', allFailures.length);

const geminiFailures = allRequests.filter((r: any) => 
  !r.success && (r.executedProvider === 'gemini' || (r.error && r.error.includes('Gemini')))
);
console.log('Total Gemini failures:', geminiFailures.length);

const nonGeminiFailures = allRequests.filter((r: any) => 
  !r.success && !(r.executedProvider === 'gemini' || (r.error && r.error.includes('Gemini')))
);
console.log('Non-Gemini failures:', nonGeminiFailures.length);

console.log('\n--- Non-Gemini Failures ---');
for (const f of nonGeminiFailures) {
  console.log(`[${f.batch} #${f.index}] prov=${f.executedProvider}:${f.executedModel} err='${f.error}' status=${f.status}`);
}

console.log('\n--- Gemini Failures ---');
const breakdown: Record<string, { count: number; models: Record<string, number>; batches: Record<string, number> }> = {};

for (const f of geminiFailures) {
  const err = f.error || 'Unknown';
  if (!breakdown[err]) {
    breakdown[err] = { count: 0, models: {}, batches: {} };
  }
  breakdown[err].count++;
  const m = f.executedModel || 'unknown';
  breakdown[err].models[m] = (breakdown[err].models[m] || 0) + 1;
  const b = f.batch || 'unknown';
  breakdown[err].batches[b] = (breakdown[err].batches[b] || 0) + 1;

  console.log(`[${f.batch} #${f.index}] model=${f.executedModel} TTFT=${f.trueBrowserTTFT}ms provTTFT=${f.providerTTFT}ms err='${f.error}'`);
}

console.log('\nBreakdown:', JSON.stringify(breakdown, null, 2));
