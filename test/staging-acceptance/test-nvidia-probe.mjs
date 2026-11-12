async function testNvidiaModels() {
  const origin = 'https://staging.virexaaiventures.com';
  const cookie = '__Host-aira_auth_session=v2.aira-bff-session.preview.HSEFdS1cYC-KqrRHTe6H1W1I7jZKh4IV_3j4pMgOvKQ.82PuLMbDJCQxyovHj4eOGwBlu5182typa3-L-K2qTtM';
  const csrfToken = 'e46ba3fd25730ef31ef9c5c0447607880e3d38ac08ca68745b02583f45639fa0';

  const modelsToTest = [
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'meta/llama-3.1-70b-instruct',
    'meta/llama-3.1-8b-instruct'
  ];

  for (const model of modelsToTest) {
    console.log(`\nTesting explicit model: ${model}...`);
    try {
      const res = await fetch(origin + '/api/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie,
          'X-CSRF-Token': csrfToken,
          'Origin': origin,
          'Sec-Fetch-Site': 'same-origin',
          'X-AIRA-CSRF-Protection': '1'
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Say hello in 2 words' }],
          model
        })
      });
      console.log(`Status for ${model}: ${res.status}`);
      const text = await res.text();
      const lines = text.split('\n').filter(l => l.startsWith('data: {"requestedModel') || l.startsWith('data: {"error') || l.startsWith('event:'));
      console.log('Events for ' + model + ':', lines.slice(0, 5));
    } catch (e) {
      console.log(`Error testing ${model}:`, e.message);
    }
  }
}

testNvidiaModels().catch(console.error);
