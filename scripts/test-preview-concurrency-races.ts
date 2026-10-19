import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import knex from 'knex';

const PREVIEW_URL = process.env.PREVIEW_URL || 'https://aira-ai-2026-lah24sv05-rajpunkeshwarrajgautam-boops-projects.vercel.app';
const NEON_CS = process.env.DATABASE_URL || (function() {
  try {
    const { execSync } = require('child_process');
    return execSync('npx neonctl connection-string pr90-p1-6-7-preview-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
  } catch {
    return 'postgresql://localhost:5432/neondb';
  }
})();

const db = knex({
  client: 'pg',
  connection: {
    connectionString: NEON_CS,
    ssl: { rejectUnauthorized: false }
  },
  pool: { min: 1, max: 4 }
});

interface ConcurrencyResult {
  concurrencyLevel: number;
  totalLaunched: number;
  admittedCount: number;
  rejectedRateLimitCount: number;
  errorCount: number;
  latenciesMs: number[];
  peakGlobalPermits: number;
  peakTotalPermits: number;
  finalGlobalPermits: number;
  oversubscribed: boolean;
  notes: string;
}

async function getActivePermits(): Promise<{ globalPermits: number; totalPermits: number }> {
  const now = Date.now();
  const [globalRow, totalRow] = await Promise.all([
    db('capacity_permits').where('scope', 'global').andWhere('expires_at', '>', now).count<{ count: string }>('id as count').first(),
    db('capacity_permits').count<{ count: string }>('id as count').first()
  ]);
  return {
    globalPermits: parseInt(globalRow?.count || '0', 10),
    totalPermits: parseInt(totalRow?.count || '0', 10)
  };
}

async function executeSingleConcurrentChat(prompt: string, userIndex: number): Promise<{
  status: number;
  latencyMs: number;
  admitted: boolean;
  rejectedCapacity: boolean;
  error?: string;
  dbRoundTrips?: number;
}> {
  const t0 = performance.now();
  try {
    const sRes = await fetch(`${PREVIEW_URL}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Origin': PREVIEW_URL,
        'x-aira-csrf-protection': '1',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!sRes.ok) {
      return {
        status: sRes.status,
        latencyMs: Math.round(performance.now() - t0),
        admitted: false,
        rejectedCapacity: sRes.status === 429,
        error: `Session init HTTP ${sRes.status}`
      };
    }

    const cookie = sRes.headers.get('set-cookie') || '';

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
      }),
      signal: AbortSignal.timeout(20000)
    });

    const latencyMs = Math.round(performance.now() - t0);

    if (chatRes.status === 429) {
      return {
        status: 429,
        latencyMs,
        admitted: false,
        rejectedCapacity: true
      };
    }

    if (!chatRes.ok) {
      return {
        status: chatRes.status,
        latencyMs,
        admitted: false,
        rejectedCapacity: false,
        error: `HTTP ${chatRes.status}`
      };
    }

    // Read full stream to ensure permit release lifecycle finishes
    const reader = chatRes.body?.getReader();
    let dbRoundTrips = 0;
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.slice(5).trim());
              if (data.capacityDbRoundTrips) {
                dbRoundTrips = data.capacityDbRoundTrips;
              }
            } catch {}
          }
        }
      }
    }

    return {
      status: 200,
      latencyMs: Math.round(performance.now() - t0),
      admitted: true,
      rejectedCapacity: false,
      dbRoundTrips
    };
  } catch (err: any) {
    return {
      status: err.name === 'TimeoutError' ? 408 : 500,
      latencyMs: Math.round(performance.now() - t0),
      admitted: false,
      rejectedCapacity: false,
      error: err.message
    };
  }
}

async function runConcurrencyLevel(level: number): Promise<ConcurrencyResult> {
  console.log(`\n>>> Testing Concurrency Level: ${level} Simultaneous Requests <<<`);
  
  const initial = await getActivePermits();
  console.log(`Initial Active Global Permits: ${initial.globalPermits} (Total rows: ${initial.totalPermits})`);

  let peakGlobalPermits = initial.globalPermits;
  let peakTotalPermits = initial.totalPermits;

  // Monitor permits during execution at 250ms cadence
  let monitoring = true;
  const monitorPromise = (async () => {
    while (monitoring) {
      try {
        const current = await getActivePermits();
        if (current.globalPermits > peakGlobalPermits) peakGlobalPermits = current.globalPermits;
        if (current.totalPermits > peakTotalPermits) peakTotalPermits = current.totalPermits;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
  })();

  const promises: Promise<any>[] = [];
  for (let i = 0; i < level; i++) {
    promises.push(executeSingleConcurrentChat(`Concurrency probe #${i + 1} at level ${level}`, i));
  }

  const results = await Promise.all(promises);
  monitoring = false;
  await monitorPromise;

  // Wait 4 seconds for permit release & async cleanup
  await new Promise(r => setTimeout(r, 4000));
  const final = await getActivePermits();

  const admittedCount = results.filter(r => r.admitted).length;
  const rejectedRateLimitCount = results.filter(r => r.rejectedCapacity).length;
  const errorCount = results.filter(r => !r.admitted && !r.rejectedCapacity).length;
  const latenciesMs = results.map(r => r.latencyMs);

  // Global concurrency limit is 2. Global permits must NEVER exceed 2.
  const oversubscribed = peakGlobalPermits > 2;

  console.log(`Results for Level ${level}:`);
  console.log(`  Admitted (HTTP 200): ${admittedCount}`);
  console.log(`  Capacity Blocked (HTTP 429): ${rejectedRateLimitCount}`);
  console.log(`  Other / Timeout Errors: ${errorCount}`);
  console.log(`  Peak Active Global Permits: ${peakGlobalPermits} (Max allowed: 2) -> Oversubscribed: ${oversubscribed}`);
  console.log(`  Peak Total Permit Rows: ${peakTotalPermits}`);
  console.log(`  Final Active Global Permits: ${final.globalPermits} (Leaks: ${final.globalPermits > 0 ? 'YES' : 'NONE'})`);

  return {
    concurrencyLevel: level,
    totalLaunched: level,
    admittedCount,
    rejectedRateLimitCount,
    errorCount,
    latenciesMs,
    peakGlobalPermits,
    peakTotalPermits,
    finalGlobalPermits: final.globalPermits,
    oversubscribed,
    notes: `Admitted: ${admittedCount}, 429s: ${rejectedRateLimitCount}, Errors: ${errorCount}, Peak Global Permits: ${peakGlobalPermits}`
  };
}

async function main() {
  console.log(`=================================================================`);
  console.log(`AIRA AI 2026 — P1.6.7 CONCURRENCY & RACE TEST SUITE`);
  console.log(`Target: ${PREVIEW_URL}`);
  console.log(`Neon Host: ep-steep-tooth-b3y7kgx9.c-4.ap-southeast-1.aws.neon.tech`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`=================================================================`);

  const levels = [1, 5, 10, 25];
  const suiteResults: ConcurrencyResult[] = [];

  for (const level of levels) {
    const res = await runConcurrencyLevel(level);
    suiteResults.push(res);
    // Cool down between levels to clear sliding-window rate logs and allow queue drain
    console.log(`Cooling down 10s before next concurrency level...`);
    await new Promise(r => setTimeout(r, 10000));
  }

  const outPath = path.join(process.cwd(), 'P1_6_7_PREVIEW_CONCURRENCY_TEST_RESULTS.json');
  fs.writeFileSync(outPath, JSON.stringify(suiteResults, null, 2));

  console.log(`\n=================================================================`);
  console.log(`CONCURRENCY SUITE COMPLETED`);
  console.log(`Summary saved to: ${outPath}`);
  console.log(`=================================================================`);

  await db.destroy();
}

main().catch(async (err) => {
  console.error('Fatal concurrency suite error:', err);
  await db.destroy();
  process.exit(1);
});
