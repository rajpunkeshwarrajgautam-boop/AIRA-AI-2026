import { performance } from 'node:perf_hooks';

async function testFastPreview() {
  const origin = process.env.PREVIEW_URL || 'https://aira-ai-2026-git-f-8556d1-rajpunkeshwarrajgautam-boops-projects.vercel.app';
  console.log(`=== TESTING AIRA FAST (GROQ) ON PR #84 PREVIEW: ${origin} ===\n`);

  console.log('1. Initializing session on Preview...');
  const sessionRes = await fetch(`${origin}/api/auth/session`, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'x-aira-csrf-protection': '1',
      'Content-Type': 'application/json'
    }
  });

  if (!sessionRes.ok) {
    throw new Error(`Session init failed: ${sessionRes.status} ${await sessionRes.text()}`);
  }

  const sessionCookie = sessionRes.headers.get('set-cookie');
  console.log('Session cookie acquired.');

  const prompt = 'What is the boiling point of water?';
  console.log(`\n2. Sending test prompt: "${prompt}" (model: aira-fast)...`);

  const t0 = performance.now();
  const chatRes = await fetch(`${origin}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'Content-Type': 'application/json',
      'Cookie': sessionCookie || '',
      'x-aira-csrf-protection': '1'
    },
    body: JSON.stringify({
      prompt,
      model: 'aira-fast'
    })
  });

  const t1 = performance.now();
  const ttfb = t1 - t0;
  console.log(`Server TTFB: ${ttfb.toFixed(0)} ms, Status: ${chatRes.status}`);

  if (!chatRes.ok) {
    console.error('Error response:', await chatRes.text());
    return;
  }

  const reader = chatRes.body?.getReader();
  if (!reader) {
    console.error('No reader');
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let firstDeltaTime: number | null = null;
  let firstThinkingTime: number | null = null;
  let deltaCount = 0;
  let text = '';
  let modelProvenance: any = null;
  let latencyMetrics: any = null;
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = performance.now();
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        const timeFromStart = (now - t0).toFixed(0);

        if (currentEvent === 'content_delta') {
          if (firstDeltaTime === null) {
            firstDeltaTime = now - t0;
            console.log(`>>> FIRST VISIBLE CONTENT DELTA (TTFT): ${firstDeltaTime.toFixed(0)} ms <<<`);
          }
          deltaCount++;
          try {
            const parsed = JSON.parse(dataStr);
            text += parsed.text || '';
          } catch {}
        } else if (currentEvent === 'thinking_delta') {
          if (firstThinkingTime === null) firstThinkingTime = now - t0;
        } else if (currentEvent === 'model_provenance') {
          try {
            modelProvenance = JSON.parse(dataStr);
            console.log(`[+${timeFromStart}ms] Event: ${currentEvent} | Provider: ${modelProvenance.provider || modelProvenance.executedProvider} | ExecutedModel: ${modelProvenance.executedModel} | Fallback: ${modelProvenance.fallbackOccurred}`);
          } catch {}
        } else if (currentEvent === 'error') {
          console.error(`[+${timeFromStart}ms] ERROR EVENT: ${dataStr}`);
        } else if (currentEvent === 'latency_metrics') {
          try {
            latencyMetrics = JSON.parse(dataStr);
            console.log(`[+${timeFromStart}ms] Event: ${currentEvent} | ${JSON.stringify(latencyMetrics)}`);
          } catch {}
        }
      }
    }
  }

  const tEnd = performance.now();
  console.log('\n\n--- PREVIEW GROQ EXECUTION SUMMARY ---');
  console.log(`Prompt: "${prompt}"`);
  console.log(`Answer: "${text.trim()}"`);
  console.log(`Client TTFB: ${ttfb.toFixed(0)} ms`);
  console.log(`True Client TTFT (First Content Delta): ${firstDeltaTime ? firstDeltaTime.toFixed(0) : 'N/A'} ms`);
  console.log(`Total Duration: ${(tEnd - t0).toFixed(0)} ms`);
  console.log(`Content Deltas: ${deltaCount}`);
  console.log(`Executed Provider: ${modelProvenance?.executedProvider || modelProvenance?.provider}`);
  console.log(`Executed Model: ${modelProvenance?.executedModel}`);
  console.log(`Fallback Occurred: ${modelProvenance?.fallbackOccurred}`);
  console.log(`Server Reported TTFT: ${latencyMetrics?.ttftMs} ms`);
  console.log(`Server DB Critical Path: ${latencyMetrics?.dbCriticalPathMs} ms`);
  console.log(`Server DB Queries Pre-Provider: ${latencyMetrics?.dbQueryCountBeforeProvider}`);
  console.log(`Server DB Queries Pre-Token: ${latencyMetrics?.dbQueryCountBeforeFirstToken}`);
}

testFastPreview().catch(console.error);
