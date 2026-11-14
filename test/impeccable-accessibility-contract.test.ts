import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(path, 'utf8');

test('sidebar conversation selection is a native keyboard-accessible button, not a clickable div', () => {
  const sidebar = source('src/components/Sidebar.tsx');
  const item = sidebar.split('const renderChatItem =')[1]?.split('\n  return (\n    <AnimatePresence>')[0];
  assert.ok(item, 'conversation rows must exist');
  assert.match(item, /<button[\s\S]*?aria-current=\{activeChatId/);
  assert.match(item, /aria-label=\{`Open conversation:/);
  assert.doesNotMatch(item, /onClick=\{\(\) => handleSelectChatMobile\(c\.id\)\}[\s\S]*?<div/, 'row must not rely on nested div click targets');
  assert.match(sidebar, /aria-label="Search workspace conversations"/);
});

test('chat composer exposes accessible names while preserving its focus surface', () => {
  const sourceText = source('src/components/ChatInput.tsx');
  assert.match(sourceText, /aria-label="Message Aira"/);
  assert.match(sourceText, /aria-label="Attach documents or images"/);
  assert.match(sourceText, /aria-label=\{isLoading \? 'Aira is responding' : 'Send message'\}/);
  assert.match(sourceText, /className="aira-composer-card/);
});

test('billing and pricing dialogues have headings, roles, and mobile-safe scroll', () => {
  const billing = source('src/components/AccountBillingModal.tsx');
  assert.match(billing, /role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(billing, /aria-labelledby="aira-account-billing-title"/);
  assert.match(billing, /role="tablist" aria-label="Billing sections"/);
  assert.match(billing, /role="tabpanel" aria-label="Billing details"/);
  assert.match(billing, /max-h-\[90dvh\]/);
  const pricing = source('src/components/PricingModal.tsx');
  assert.match(pricing, /role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(pricing, /aria-labelledby="aira-pricing-title"/);
  assert.match(pricing, /max-h-\[92dvh\]/);
});

test('project creation fields and dialogs have reliable accessible names', () => {
  const projects = source('src/components/ProjectsModal.tsx');
  assert.match(projects, /aria-labelledby="aira-projects-title"/);
  for (const label of ['Project name', 'Project description', 'Project instructions', 'Document title', 'Document content']) {
    assert.ok(projects.includes(`aria-label="${label}"`), `missing ${label} label`);
  }
});

test('header actions have descriptive, state-aware labels', () => {
  const app = source('src/App.tsx');
  assert.match(app, /aria-label=\{activeConversation\.isPinned \? "Remove bookmark" : "Bookmark conversation"\}/);
  assert.match(app, /aria-label=\{sharedCopied \? "Conversation link copied" : "Share conversation"\}/);
});
