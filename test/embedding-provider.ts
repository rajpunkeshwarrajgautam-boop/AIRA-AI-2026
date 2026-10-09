import assert from 'node:assert/strict';
import { NvidiaEmbeddingProvider } from '../packages/retrieval/src/embeddings.js';

const originalFetch = globalThis.fetch;

async function main() {
  const requests: Array<{ url: string; body: any }> = [];

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push({ url: String(url), body });

    return new Response(JSON.stringify({
      model: body.model,
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  const current = new NvidiaEmbeddingProvider('test-key');
  const batch = await current.embed(['semantic search'], 'query');

  assert.equal(requests[0].url, 'https://integrate.api.nvidia.com/v1/embeddings');
  assert.equal(requests[0].body.model, 'nvidia/nemotron-3-embed-1b');
  assert.equal(requests[0].body.input_type, 'query');
  assert.equal(requests[0].body.encoding_format, 'float');
  assert.equal(requests[0].body.truncate, 'END');
  assert.equal(batch.modelId, 'nvidia/nemotron-3-embed-1b');

  requests.length = 0;
  let call = 0;

  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push({ url: String(_url), body });
    call++;

    if (call === 1) {
      return new Response('', { status: 410 });
    }

    return new Response(JSON.stringify({
      model: body.model,
      data: [{ index: 0, embedding: [0.3, 0.2, 0.1] }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  const retiredOverride = new NvidiaEmbeddingProvider(
    'test-key',
    'nvidia/nv-embedqa-e5-v5'
  );
  const fallback = await retiredOverride.embed(['semantic search'], 'passage');

  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.model, 'nvidia/nv-embedqa-e5-v5');
  assert.equal(requests[1].body.model, 'nvidia/nemotron-3-embed-1b');
  assert.equal(requests[1].body.input_type, 'passage');
  assert.equal(fallback.modelId, 'nvidia/nemotron-3-embed-1b');

  console.log('PASS: current NVIDIA embedding model is the default');
  console.log('PASS: retired NVIDIA embedding model overrides fail over on 404/410');
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
