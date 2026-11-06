import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessage } from '../src/components/ChatMessage';
import type { Message } from '../src/types';

test('HITL Approval card renders when approval agent event is present in adaptive mode', () => {
  const messageWithApproval: Message = {
    id: 'msg-approval',
    role: 'assistant',
    content: 'I need authorization to execute file write.',
    timestamp: Date.now(),
    agentEvents: [
      {
        id: 'event-approval-1',
        kind: 'approval',
        label: 'Approval required for write_file',
        status: 'waiting',
        occurredAt: Date.now(),
      },
    ],
  };

  const html = renderToStaticMarkup(
    <ChatMessage
      message={messageWithApproval}
      userName="Aira User"
      showAgentTimeline={true}
      onOpenArtifact={() => {}}
    />
  );

  assert.match(html, /data-testid="hitl-approval-card"/);
  assert.match(html, /Action Authorization Required/);
  assert.match(html, /data-testid="hitl-approve-btn"/);
  assert.match(html, /data-testid="hitl-reject-btn"/);
  assert.match(html, /aria-label="Pending tool execution approval"/);
});

test('HITL Approval card is suppressed when agent timeline is disabled (baseline legacy mode)', () => {
  const messageWithApproval: Message = {
    id: 'msg-approval-2',
    role: 'assistant',
    content: 'I need authorization.',
    timestamp: Date.now(),
    agentEvents: [
      {
        id: 'event-approval-2',
        kind: 'approval',
        label: 'Approval required for deploy_site',
        status: 'waiting',
        occurredAt: Date.now(),
      },
    ],
  };

  const html = renderToStaticMarkup(
    <ChatMessage
      message={messageWithApproval}
      userName="Aira User"
      showAgentTimeline={false}
      onOpenArtifact={() => {}}
    />
  );

  assert.doesNotMatch(html, /data-testid="hitl-approval-card"/);
});
