import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PROBES, probeModel, runDiagnostic } from '../../scripts/check-nvidia-model-access.js';

describe('NVIDIA entitlement diagnostic', () => {
  it('tests four distinct exact provider IDs', () => {
    assert.equal(MODEL_PROBES.length, 4);
    assert.equal(new Set(MODEL_PROBES.map(x => x.model)).size, 4);
  });
  it('confirms actual inference with matching upstream identity', async () => {
    const result = await probeModel('test-secret', 'AIRA Pro', 'nvidia/nemotron-3-super-120b-a12b', async (_url, options) => {
      assert.equal((options?.headers as any).Authorization, 'Bearer test-secret');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.stream, false);
      assert.equal(body.model, 'nvidia/nemotron-3-super-120b-a12b');
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    });
    assert.equal(result.status, 'ACCESS_CONFIRMED');
    assert.equal(result.modelIdentityVerified, true);
    assert.equal(result.responsePreview, 'OK');
    assert.equal(JSON.stringify(result).includes('test-secret'), false);
  });
  it('preserves unverified identity when model metadata is missing', async () => {
    const result = await probeModel('test-secret', 'AIRA Pro', 'model-x', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }));
    assert.equal(result.status, 'ACCESS_CONFIRMED');
    assert.equal(result.modelIdentityVerified, false);
  });
  it('returns HTTP status without provider secret or raw error response', async () => {
    const result = await probeModel('test-secret', 'AIRA Deep', 'model-x', async () =>
      new Response('test-secret sensitive provider error', { status: 403 }));
    assert.equal(result.httpStatus, 403);
    assert.equal(result.status, 'FORBIDDEN');
    assert.equal(JSON.stringify(result).includes('test-secret'), false);
  });
  it('runs each model sequentially', async () => {
    let count = 0;
    const results = await runDiagnostic('key', async () => {
      count++;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    });
    assert.equal(count, 4);
    assert.equal(results.length, 4);
  });
});
