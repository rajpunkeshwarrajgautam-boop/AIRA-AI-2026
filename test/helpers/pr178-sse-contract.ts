import assert from 'node:assert/strict';

export function assertCompletedSse(body: string, label: string): string {
  const events = body.replace(/\r\n/g, '\n').split('\n\n')
    .map(block => {
      const fields = block.split('\n');
      return {
        name: fields.find(line => line.startsWith('event: '))?.slice(7) || '',
        data: fields.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      };
    }).filter(evt => evt.name);
  const names = events.map(evt => evt.name);
  assert.ok(names.includes('run_started'), label + ': missing run_started');
  assert.ok(names.includes('content_delta'), label + ': missing content_delta');
  assert.ok(names.includes('routing_decision') || names.includes('model_provenance'), label + ': missing routing metadata');
  assert.ok(!names.some(name => ['run_failed', 'error', 'capability_unready', 'approval_required'].includes(name)), label + ': failure or incomplete run');
  assert.equal(events.at(-1)?.name, 'done', label + ': missing terminal done event');
  assert.equal(events.at(-1)?.data, '[DONE]', label + ': invalid completion marker');
  const answer = events.filter(evt => evt.name === 'content_delta')
    .map(evt => {
      const payload = JSON.parse(evt.data);
      assert.equal(typeof payload.text, 'string', label + ': invalid content delta');
      return payload.text as string;
    }).join('');
  assert.ok(answer.trim().length > 0, label + ': empty answer');
  console.log('PASS:', label, '(events=' + names.join(', ') + ', chars=' + answer.length + ')');
  return answer;
}
