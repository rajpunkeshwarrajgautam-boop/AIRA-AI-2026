async function testTierRestriction() {
  const origin = 'https://staging.virexaaiventures.com';
  const cookie = '__Host-aira_auth_session=v2.aira-bff-session.preview.HSEFdS1cYC-KqrRHTe6H1W1I7jZKh4IV_3j4pMgOvKQ.82PuLMbDJCQxyovHj4eOGwBlu5182typa3-L-K2qTtM';
  const csrfToken = 'e46ba3fd25730ef31ef9c5c0447607880e3d38ac08ca68745b02583f45639fa0';

  console.log('Testing aira-pro under Free tier...');
  const resPro = await fetch(origin + '/api/chat/stream', {
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
      messages: [{ role: 'user', content: 'Complex analysis' }],
      model: 'aira-pro'
    })
  });
  console.log('aira-pro status:', resPro.status);
  console.log('aira-pro response:', await resPro.json());

  console.log('\nTesting aira-deep under Free tier...');
  const resDeep = await fetch(origin + '/api/chat/stream', {
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
      messages: [{ role: 'user', content: 'Deep reasoning task' }],
      model: 'aira-deep'
    })
  });
  console.log('aira-deep status:', resDeep.status);
  console.log('aira-deep response:', await resDeep.json());
}

testTierRestriction().catch(console.error);
