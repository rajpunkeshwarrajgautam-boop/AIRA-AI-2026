async function testLongContextFailover() {
  const origin = 'https://staging.virexaaiventures.com';
  const cookie = '__Host-aira_auth_session=v2.aira-bff-session.preview.HSEFdS1cYC-KqrRHTe6H1W1I7jZKh4IV_3j4pMgOvKQ.82PuLMbDJCQxyovHj4eOGwBlu5182typa3-L-K2qTtM';
  const csrfToken = 'e46ba3fd25730ef31ef9c5c0447607880e3d38ac08ca68745b02583f45639fa0';

  console.log('Generating >28K character context to trigger Gemini failover...');
  const largeDocument = 'Here is line of important project context number ' + Array.from({ length: 1200 }, (_, i) => `Entry ${i}: Alpha Beta Gamma Delta`).join('. ') + '.\n\nQuestion: What Greek letters were mentioned? List them briefly in 4 words.';

  console.log('Total characters in user prompt:', largeDocument.length);

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
      messages: [{ role: 'user', content: largeDocument }],
      model: 'aira-pro'
    })
  });

  console.log('Chat stream HTTP status:', res.status, res.headers.get('content-type'));
  const text = await res.text();
  console.log('--- ALL SSE EVENTS ---');
  console.log(text.slice(0, 1500));
  console.log('\n--- (Middle omitted) ---\n');
  console.log(text.slice(-1500));
}

testLongContextFailover().catch(console.error);
