import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnifiedWorkspace } from '../src/components/UnifiedWorkspace';
import { AdaptiveStudioEmptyState } from '../src/components/AdaptiveStudioEmptyState';
import type { Artifact } from '../src/types';

test('REGRESSION TEST (Section 2.1): Empty workspace renders unified-workspace-empty and NO fake tabs', () => {
  const html = renderToStaticMarkup(
    <UnifiedWorkspace
      isOpen={true}
      onClose={() => {}}
      artifact={null}
      workspaceMode="chat"
    />
  );

  // 1. Must render data-testid="unified-workspace-empty"
  assert.match(html, /data-testid="unified-workspace-empty"/, 'Must contain unified-workspace-empty testid');

  // 2. Must NOT render fake Preview/Code tabs from old empty state
  assert.doesNotMatch(html, /aira-adaptive-empty-tabs/, 'Must not contain aira-adaptive-empty-tabs');

  // 3. Must NOT render inner redundant h2
  assert.doesNotMatch(html, /<h2>Artifact Studio<\/h2>/, 'Must not contain redundant Artifact Studio h2');

  // 4. Must NOT render duplicate nested aside
  const asides = html.match(/<aside/g) || [];
  assert.equal(asides.length, 1, 'Must have only ONE aside element (UnifiedWorkspace root)');
});

test('REGRESSION TEST (Section 2.2): Empty workspace does NOT show Preview, Code, or Files tabs', () => {
  const html = renderToStaticMarkup(
    <UnifiedWorkspace
      isOpen={true}
      onClose={() => {}}
      artifact={null}
      workspaceMode="chat"
    />
  );

  // Tab bar buttons for Preview, Code, Files must not exist when empty
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Preview<\/span>[\s\S]*?<\/button>/, 'Preview tab button must not exist when empty');
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Code<\/span>[\s\S]*?<\/button>/, 'Code tab button must not exist when empty');
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Files<\/span>[\s\S]*?<\/button>/, 'Files tab button must not exist when empty');
});

test('REGRESSION TEST (Section 2.3): Diagnostics is NOT a top-level tab; it is an expandable footer section', () => {
  const html = renderToStaticMarkup(
    <UnifiedWorkspace
      isOpen={true}
      onClose={() => {}}
      artifact={null}
      workspaceMode="chat"
    />
  );

  // Diagnostics must NOT be a top-level tab button
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Diagnostics<\/span>[\s\S]*?<\/button>/, 'Diagnostics must not be in the top tab strip');

  // Must render expandable footer with "Advanced: Sandbox Diagnostics"
  assert.match(html, /data-testid="unified-workspace-footer"/, 'Must have workspace footer');
  assert.match(html, /Advanced: Sandbox Diagnostics/, 'Footer must contain Advanced: Sandbox Diagnostics label');
  assert.match(html, /<details[^>]*data-testid="sandbox-diagnostics-details"/, 'Must be an expandable details element');
});

test('REGRESSION TEST (Section 2.4): Genuine artifact renders Preview and Code tabs and no empty state', () => {
  const artifact: Artifact = {
    id: 'art-real-01',
    title: 'Customer Analytics Dashboard',
    type: 'application/vnd.ant.react',
    language: 'tsx',
    content: 'export default function Dashboard() { return <div>Analytics</div>; }',
    version: 1,
    versions: [],
  };

  const html = renderToStaticMarkup(
    <UnifiedWorkspace
      isOpen={true}
      onClose={() => {}}
      artifact={artifact}
      workspaceMode="chat"
    />
  );

  // Active tabs must appear
  assert.match(html, /<span>Preview<\/span>/, 'Must show Preview tab when artifact exists');
  assert.match(html, /<span>Code<\/span>/, 'Must show Code tab when artifact exists');

  // Empty state must NOT be rendered
  assert.doesNotMatch(html, /data-testid="unified-workspace-empty"/, 'Must not render empty state when artifact exists');
  assert.match(html, /<iframe/, 'Must render iframe preview for executable artifact');
});

test('REGRESSION TEST (Section 2.5): Empty workspace remains closed by default on initial application load', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // isStudioOpen must initialize to false
  assert.match(appContent, /const \[isStudioOpen, setIsStudioOpen\] = useState\(false\);/, 'Workspace must be closed by default');
});

test('REGRESSION TEST (Section 2.6): AdaptiveStudioEmptyState component unit contract', () => {
  const html = renderToStaticMarkup(<AdaptiveStudioEmptyState />);

  assert.match(html, /data-testid="unified-workspace-empty"/, 'Must have data-testid="unified-workspace-empty"');
  assert.match(html, /aria-label="Artifact Studio"/, 'Must have aria-label="Artifact Studio"');
  assert.doesNotMatch(html, /<aside/, 'Must not be an aside element');
  assert.doesNotMatch(html, /aira-adaptive-empty-tabs/, 'Must not have fake tabs');
  assert.doesNotMatch(html, /<h2>/, 'Must not have redundant h2');
  assert.match(html, /Your next creation starts here\./, 'Must contain expected heading');
});
