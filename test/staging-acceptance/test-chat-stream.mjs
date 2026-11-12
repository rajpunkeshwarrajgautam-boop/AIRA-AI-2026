async function testChatStream() {
  const origin = 'https://staging.virexaaiventures.com';
  const cookie = '__Host-aira_auth_session=v2.aira-bff-session.preview.HSEFdS1cYC-KqrRHTe6H1W1I7jZKh4IV_3j4pMgOvKQ.82PuLMbDJCQxyovHj4eOGwBlu5182typa3-L-K2qTtM';
  const csrfToken = 'e46ba3fd25730ef31ef9c5c0447607880e3d38ac08ca68745b02583f45639fa0';

  console.log('Sending chat stream request for aira-fast...');
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
      messages: [{ role: 'user', content: 'Say hello in exactly 3 words' }],
      model: 'aira-fast'
    })
  });

  console.log('Chat stream HTTP status:', res.status, res.headers.get('content-type'));
  if (res.status !== 200) {
    console.log('Error body:', await res.text());
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let fullText = '';
  let events = [];

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (value) {
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      console.log('Chunk received:', chunk.slice(0, 100));
    }
  }

  console.log('\n--- Stream Complete ---');
  console.log('Total characters received:', fullText.length);
}

testChatStream().catch(console.error);
