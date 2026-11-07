import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { normalizeAgentTimelineEvent, appendAgentTimelineEvent } from '../src/utils/agentTimeline';
import { ChatMessage } from '../src/components/ChatMessage';
import type { AgentTimelineEvent } from '../src/types';

test('agent timeline accepts only verified SSE lifecycle event types', () => {
  assert.equal(normalizeAgentTimelineEvent('agent:thought', { text: 'secret' }), null);
  assert.equal(normalizeAgentTimelineEvent('arbitrary_event', { output: 'private' }), null);
  assert.equal(normalizeAgentTimelineEvent('tool_started', { name: 'read_file', callId: 'abc' }, 10)?.label, 'Tool read_file');
  assert.equal(normalizeAgentTimelineEvent('tool_completed', { name: 'read_file', callId: 'abc' }, 12)?.status, 'completed');
  assert.equal(normalizeAgentTimelineEvent('workflow_step_failed', { stepId: 's1' })?.status, 'failed');
  assert.equal(normalizeAgentTimelineEvent('approval_required', {})?.status, 'waiting');
});

test('durable dotted SSE events preserve the same safe timeline semantics as chat events', () => {
  assert.deepEqual(
    normalizeAgentTimelineEvent('workflow.step.started', { stepId: 'step-a', output: 'never display' }, 1),
    normalizeAgentTimelineEvent('workflow_step_started', { stepId: 'step-a' }, 1),
  );
  assert.equal(normalizeAgentTimelineEvent('tool.started', { toolName: 'browser.read', callId: 'tc-a' })?.status, 'running');
  assert.equal(normalizeAgentTimelineEvent('tool.completed', { toolName: 'browser.read', callId: 'tc-a' })?.status, 'completed');
  assert.equal(normalizeAgentTimelineEvent('tool.approval_required', { args: { apiKey: 'SECRET' } })?.status, 'waiting');
  assert.equal(normalizeAgentTimelineEvent('approval.resolved', { decision: 'APPROVE' })?.status, 'completed');
  assert.equal(normalizeAgentTimelineEvent('run.completed', {})?.status, 'completed');
  assert.equal(normalizeAgentTimelineEvent('workflow.step.failed', { stepId: 'step-a' })?.status, 'failed');
  assert.equal(normalizeAgentTimelineEvent('tool.not_a_contract_event', {}) , null);
});

test('agent timeline sanitizes identifiers and never displays raw outputs or arguments', () => {
  const item = normalizeAgentTimelineEvent('tool_started', {
    name: 'web_search<script>alert(1)</script>',
    callId: 'id-1',
    arguments: { apiKey: 'SECRET_ARGUMENT' },
    output: 'SECRET_OUTPUT',
    thinking: 'HIDDEN_REASONING',
  });
  assert.ok(item);
  assert.match(item.label, /^Tool web_searchscriptalert1/);
  const serialized = JSON.stringify(item);
  assert.doesNotMatch(serialized, /SECRET_ARGUMENT|SECRET_OUTPUT|HIDDEN_REASONING|<script>/);
});

test('agent timeline reconciles matching starts/completions and ignores late progress', () => {
  const start = normalizeAgentTimelineEvent('workflow_step_started', { stepId: 'step-1' }, 10)!;
  const complete = normalizeAgentTimelineEvent('workflow_step_completed', { stepId: 'step-1' }, 20)!;
  const late = normalizeAgentTimelineEvent('workflow_step_progress', { stepId: 'step-1' }, 22)!;
  let events = appendAgentTimelineEvent([], start);
  events = appendAgentTimelineEvent(events, complete);
  events = appendAgentTimelineEvent(events, late);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'completed');
  assert.equal(events[0].occurredAt, 20);
});

test('agent timeline has a hard cap to prevent runaway persistent conversation state', () => {
  let items: AgentTimelineEvent[] = [];
  for (let n = 0; n < 120; n++) {
    const item = normalizeAgentTimelineEvent('workflow_step_started', { stepId: `step-${n}` }, n)!;
    items = appendAgentTimelineEvent(items, item);
  }
  assert.equal(items.length, 80);
  assert.equal(items[0].label, 'Step step-40');
});

test('agent timeline is accessible in adaptive mode and absent in baseline mode', () => {
  const event = normalizeAgentTimelineEvent('tool_completed', { name: 'read_file', callId: 'tool-1' })!;
  const message = { id: 'a', role: 'assistant' as const, content: 'Done.', timestamp: 1, agentEvents: [event] };
  const props = { message, userName: 'Guest', onOpenArtifact: () => {} };
  const adaptive = renderToStaticMarkup(createElement(ChatMessage, { ...props, showAgentTimeline: true }));
  assert.match(adaptive, /data-testid="agent-execution-timeline"/);
  assert.match(adaptive, /Verified agent execution events/);
  assert.match(adaptive, /Tool read_file/);
  const baseline = renderToStaticMarkup(createElement(ChatMessage, { ...props, showAgentTimeline: false }));
  assert.doesNotMatch(baseline, /data-testid="agent-execution-timeline"/);
});
