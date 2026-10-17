
async function testSingle() {
  const origin = process.env.TEST_ORIGIN || 'https://aira-ai-2026.vercel.app';
  console.log('1. Initializing session on production...');
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

  const prompt = 'Say hello in one sentence.';
  console.log(`2. Sending prompt: "${prompt}"...`);

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
      model: 'aira-auto'
    })
  });

  const t1 = performance.now();
  console.log(`TTFB: ${(t1 - t0).toFixed(0)} ms, Status: ${chatRes.status}`);

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
  let deltaCount = 0;
  let text = '';
  let modelProvenance: any = null;
  let routingDecision: any = null;

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
        const timeFromStart = (now - t0).toFixed(0);
        console.log(`[+${timeFromStart}ms] Event: ${currentEvent} | Data: ${dataStr.slice(0, 100)}`);
        
        if (currentEvent === 'content_delta') {
          if (firstDeltaTime === null) {
            firstDeltaTime = now - t0;
            console.log(`>>> FIRST CONTENT DELTA (TTFT): ${firstDeltaTime.toFixed(0)} ms <<<`);
          }
          deltaCount++;
          try {
            const parsed = JSON.parse(dataStr);
            text += parsed.text || '';
          } catch {}
        } else if (currentEvent === 'model_provenance') {
          try { modelProvenance = JSON.parse(dataStr); } catch {}
        } else if (currentEvent === 'routing_decision') {
          try { routingDecision = JSON.parse(dataStr); } catch {}
        }
      }
    }
  }

  const tEnd = performance.now();
  console.log('\n--- EXECUTION SUMMARY ---');
  console.log(`Total duration: ${(tEnd - t0).toFixed(0)} ms`);
  console.log(`TTFB: ${(t1 - t0).toFixed(0)} ms`);
  console.log(`TTFT (first text): ${firstDeltaTime ? firstDeltaTime.toFixed(0) : 'N/A'} ms`);
  console.log(`Deltas received: ${deltaCount}`);
  console.log(`Model provenance:`, modelProvenance);
  console.log(`Routing decision:`, routingDecision);
  console.log(`Final text: "${text.trim()}"`);
}

testSingle().catch(console.error);
