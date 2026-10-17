import { performance } from 'node:perf_hooks';

async function testGroqPreview() {
  const origin = process.env.PREVIEW_URL || 'https://aira-ai-2026-git-f-a6b62b-rajpunkeshwarrajgautam-boops-projects.vercel.app';
  console.log(`=== TESTING AIRA FAST (GROQ) ON PREVIEW: ${origin} ===\n`);

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

  const prompt = 'Explain 1+1 briefly.';
  console.log(`\n2. Sending test prompt: "${prompt}" (model: aira-deep)...`);

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
      model: 'aira-deep'
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
  let thinkingCount = 0;
  let text = '';
  let modelProvenance: any = null;
  let routingDecision: any = null;
  let currentEvent = '';
  const chunkTimes: Array<{ timeMs: number; deltaLength: number }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = performance.now();
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      console.log(`RAW LINE: "${line}"`);
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
            chunkTimes.push({ timeMs: Math.round(now - t0), deltaLength: (parsed.text || '').length });
            process.stdout.write(parsed.text || '');
          } catch {}
        } else if (currentEvent === 'thinking_delta') {
          if (firstThinkingTime === null) firstThinkingTime = now - t0;
          thinkingCount++;
        } else if (currentEvent === 'model_provenance') {
          try {
            modelProvenance = JSON.parse(dataStr);
            console.log(`\n[+${timeFromStart}ms] Event: ${currentEvent} | Provider: ${modelProvenance.provider} | ExecutedModel: ${modelProvenance.executedModel} | Fallback: ${modelProvenance.fallbackOccurred}`);
          } catch {}
        } else if (currentEvent === 'routing_decision') {
          try {
            routingDecision = JSON.parse(dataStr);
            console.log(`[+${timeFromStart}ms] Event: ${currentEvent} | Intent: ${routingDecision.intent} | Target: ${routingDecision.target}`);
          } catch {}
        } else {
          console.log(`[+${timeFromStart}ms] Event: ${currentEvent} | Data: ${dataStr}`);
        }
      }
    }
  }

  const tEnd = performance.now();
  console.log('\n\n--- PREVIEW GROQ EXECUTION SUMMARY ---');
  console.log(`Prompt: "${prompt}"`);
  console.log(`Answer: "${text.trim()}"`);
  console.log(`Server TTFB: ${ttfb.toFixed(0)} ms`);
  console.log(`Visible TTFT: ${firstDeltaTime ? firstDeltaTime.toFixed(0) : 'N/A'} ms`);
  console.log(`Total Duration: ${(tEnd - t0).toFixed(0)} ms`);
  console.log(`Content Deltas: ${deltaCount}`);
  console.log(`Thinking Deltas: ${thinkingCount}`);
  console.log(`Executed Provider: ${modelProvenance?.executedProvider || modelProvenance?.provider}`);
  console.log(`Executed Model: ${modelProvenance?.executedModel}`);
  console.log(`Fallback Occurred: ${modelProvenance?.fallbackOccurred}`);
  console.log(`Real Streaming Verified: ${deltaCount > 1 ? 'YES' : 'NO'}`);
}

testGroqPreview().catch(console.error);
