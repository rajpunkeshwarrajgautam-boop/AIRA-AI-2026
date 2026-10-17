import * as fs from 'fs';

async function testDeepAndResearchRoutes() {
  const origin = 'https://aira-ai-2026-git-f-a6b62b-rajpunkeshwarrajgautam-boops-projects.vercel.app';
  console.log('=== VERIFYING AIRA DEEP AND RESEARCH ROUTE REGRESSION ===\n');

  // Session
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

  // 1. Explicit aira-deep request
  console.log('Test 1: Explicit aira-deep query (complex architecture reasoning)...');
  const deepRes = await fetch(`${origin}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
      'x-aira-csrf-protection': '1'
    },
    body: JSON.stringify({
      prompt: 'Analyze the architectural trade-offs between eventual consistency and strict serializability in multi-region distributed databases.',
      model: 'aira-deep'
    })
  });

  let deepProvenance: any = null;
  let deepRouting: any = null;
  let deepText = '';
  let deepThinkCount = 0;

  if (deepRes.ok && deepRes.body) {
    const reader = deepRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (currentEvent === 'done' || dataStr === '[DONE]') break;
          if (currentEvent === 'model_provenance') {
            try { deepProvenance = JSON.parse(dataStr); } catch {}
          } else if (currentEvent === 'routing_decision') {
            try { deepRouting = JSON.parse(dataStr); } catch {}
          } else if (currentEvent === 'thinking_delta') {
            deepThinkCount++;
          } else if (currentEvent === 'content_delta') {
            try { deepText += JSON.parse(dataStr).text || ''; } catch {}
          }
        }
      }
    }
  }

  console.log('  Deep Provenance:', JSON.stringify(deepProvenance));
  console.log(`  Thinking deltas observed: ${deepThinkCount}`);
  console.log(`  Deep response length: ${deepText.length} chars`);
  console.log(`  Deep response preview: "${deepText.slice(0, 100)}..."\n`);

  // 2. Research prompt with aira-auto
  console.log('Test 2: Research query with aira-auto (should route to RESEARCH / aira-deep)...');
  const researchRes = await fetch(`${origin}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
      'x-aira-csrf-protection': '1'
    },
    body: JSON.stringify({
      prompt: 'Research the latest developments in solid-state batteries and cite sources.',
      model: 'aira-auto'
    })
  });

  let researchProvenance: any = null;
  let researchRouting: any = null;
  let researchText = '';

  if (researchRes.ok && researchRes.body) {
    const reader = researchRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (currentEvent === 'done' || dataStr === '[DONE]') break;
          if (currentEvent === 'model_provenance') {
            try { researchProvenance = JSON.parse(dataStr); } catch {}
          } else if (currentEvent === 'routing_decision') {
            try { researchRouting = JSON.parse(dataStr); } catch {}
          } else if (currentEvent === 'content_delta') {
            try { researchText += JSON.parse(dataStr).text || ''; } catch {}
          }
        }
      }
    }
  }

  console.log('  Research Routing:', JSON.stringify(researchRouting));
  console.log('  Research Provenance:', JSON.stringify(researchProvenance));
  console.log(`  Research response preview: "${researchText.slice(0, 100)}..."\n`);

  const summary = {
    deepModelPreserved: deepProvenance?.executedModel === 'nvidia/nemotron-3-super-120b-a12b',
    deepThinkingEnabled: deepThinkCount > 0,
    researchRouteIndependent: researchRouting?.intent === 'RESEARCH',
    researchModel: researchProvenance?.executedModel
  };

  console.log('=== ROUTE VERIFICATION SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync('P1_DEEP_RESEARCH_REGRESSION.json', JSON.stringify({ deepProvenance, deepRouting, researchRouting, researchProvenance, summary }, null, 2), 'utf8');
}

testDeepAndResearchRoutes().catch(console.error);
