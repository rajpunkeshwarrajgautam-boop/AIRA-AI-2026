import { performance } from 'perf_hooks';

const PREVIEW_URL = 'https://aira-ai-2026-lah24sv05-rajpunkeshwarrajgautam-boops-projects.vercel.app';

async function main() {
  console.log(`Connecting to Preview URL: ${PREVIEW_URL}`);

  // 1. Session initialization
  const sessionRes = await fetch(`${PREVIEW_URL}/api/auth/session`, {
    method: 'POST',
    headers: {
      'Origin': PREVIEW_URL,
      'x-aira-csrf-protection': '1',
      'Content-Type': 'application/json'
    }
  });

  if (!sessionRes.ok) {
    console.error(`Session init failed: ${sessionRes.status} ${await sessionRes.text()}`);
    process.exit(1);
  }

  const cookie = sessionRes.headers.get('set-cookie') || '';
  console.log(`Session initialized successfully. Cookie length: ${cookie.length}`);

  // 2. Chat stream test
  const t0 = performance.now();
  const chatRes = await fetch(`${PREVIEW_URL}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Origin': PREVIEW_URL,
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'x-aira-csrf-protection': '1'
    },
    body: JSON.stringify({
      prompt: 'Hello! Please reply in one short sentence.',
      model: 'aira-auto'
    })
  });

  const t1 = performance.now();
  console.log(`Chat stream response status: ${chatRes.status} (TTFB: ${Math.round(t1 - t0)}ms)`);

  if (!chatRes.ok) {
    console.error(`Chat stream failed: ${chatRes.status} ${await chatRes.text()}`);
    process.exit(1);
  }

  const reader = chatRes.body?.getReader();
  if (!reader) throw new Error('No body reader');

  const decoder = new TextDecoder();
  let buffer = '';
  let latencyMetrics: any = null;
  let modelProvenance: any = null;
  let text = '';
  let firstDeltaMs: number | null = null;

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
          if (firstDeltaMs === null) {
            firstDeltaMs = Math.round(now - t0);
          }
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

  const totalMs = Math.round(performance.now() - t0);

  console.log('\n--- STREAM RESULTS ---');
  console.log(`Model Content: "${text.trim()}"`);
  console.log(`Client TTFT: ${firstDeltaMs}ms`);
  console.log(`Client Total: ${totalMs}ms`);
  console.log('\n--- MODEL PROVENANCE ---');
  console.log(JSON.stringify(modelProvenance, null, 2));
  console.log('\n--- LATENCY METRICS ---');
  console.log(JSON.stringify(latencyMetrics, null, 2));

  console.log('\n--- CAPACITY STORE VERIFICATION ---');
  const dbRoundTrips = latencyMetrics?.capacityDbRoundTrips;
  const capacityAdmissionMs = latencyMetrics?.capacityAdmissionMs;
  console.log(`capacityDbRoundTrips: ${dbRoundTrips}`);
  console.log(`capacityAdmissionMs: ${capacityAdmissionMs}ms`);
  console.log(`capacityTransactionMs: ${latencyMetrics?.capacityTransactionMs}ms`);

  if (dbRoundTrips >= 1) {
    console.log('✅ PASS: DistributedPostgresCapacityStore is ACTIVE in deployed Preview!');
  } else {
    console.log('❌ FAIL: Preview is using InMemoryCapacityStore (capacityDbRoundTrips = 0)!');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
