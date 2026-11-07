import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnifiedWorkspace } from '../src/components/UnifiedWorkspace';
import type { Artifact } from '../src/types';
import type { AgentExecutionGraph } from '../src/types/executionGraph';

test('Unified Contextual Workspace: Renders single unified surface with contextual tabs', () => {
  const artifact: Artifact = {
    id: 'art-demo-01',
    title: 'Interactive CRM Dashboard',
    type: 'application/vnd.ant.react',
    language: 'tsx',
    content: 'export default function App() { return <div>CRM Dashboard</div>; }',
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

  // Must have root unified-workspace testid
  assert.match(html, /data-testid="unified-workspace"/);
  // Must carry compatibility markers for existing suites
  assert.match(html, /data-testid="artifact-studio"/);
  assert.match(html, /data-testid="agent-contextual-panel"/);
  // Must render Preview and Code tabs
  assert.match(html, /Preview/);
  assert.match(html, /Code/);
  assert.match(html, /Diagnostics/);
  // Must render close button
  assert.match(html, /data-testid="workspace-close"/);
  assert.match(html, /data-testid="artifact-studio-close"/);
});

test('Unified Contextual Workspace: Renders agent execution telemetry and graph when active', () => {
  const graph: AgentExecutionGraph = {
    graphId: 'graph-01',
    runId: 'run-01',
    title: 'Autonomous Swarm Workflow',
    nodes: {
      task_1: {
        id: 'task_1',
        name: 'Build Container',
        role: 'coder',
        state: 'RUNNING',
        dependsOn: [],
        attempt: 1,
        maxAttempts: 2,
      },
    },
    waves: [['task_1']],
    state: 'RUNNING',
    totalTasks: 1,
    completedTasks: 0,
    failedTasks: 0,
  };

  const steps = [
    {
      id: 'step-1',
      name: 'scaffold_files',
      label: 'Scaffolding React project structure',
      state: 'done' as const,
    },
    {
      id: 'step-2',
      name: 'run_tests',
      label: 'Running container test suite',
      state: 'running' as const,
    },
  ];

  const html = renderToStaticMarkup(
    <UnifiedWorkspace
      isOpen={true}
      onClose={() => {}}
      artifact={null}
      executionGraph={graph}
      builderSteps={steps}
      builderBusy={true}
      workspaceMode="agent"
      initialTab="activity"
    />
  );

  assert.match(html, /data-testid="unified-workspace"/);
  assert.match(html, /Autonomous Execution Telemetry/);
  assert.match(html, /Scaffolding React project structure/);
  assert.match(html, /Running container test suite/);
  assert.match(html, /Agent Working/);
});

test('Unified Contextual Workspace: App.tsx enforces ONE coordinated workspace presentation system', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Verify chat is primary: workspace closed by default
  assert.match(appContent, /const \[isStudioOpen, setIsStudioOpen\] = useState\(false\);/);

  // Switching to Agent mode does NOT automatically pop open a technical panel
  assert.match(appContent, /handleSwitchToAgentAndReview = useCallback\(/);
  assert.doesNotMatch(appContent, /handleSwitchToAgentAndReview = useCallback\([\s\S]*?setIsAgentPanelOpen\(true\)/);

  // Intent detection in Agent mode does NOT automatically pop open a technical panel
  assert.doesNotMatch(appContent, /intent\.capability === 'BUILDER_APP' && workspaceMode === 'agent'[\s\S]*?setIsAgentPanelOpen\(true\)/);

  // In Agent mode, header contains a single toggle button for the unified workspace
  assert.match(appContent, /workspaceMode === 'agent' && \(/);
  assert.match(appContent, /Agent Panel/);

  // No duplicate competing panel rendered side-by-side
  assert.doesNotMatch(appContent, /\{isAgentPanelOpen && \(\s*<AgentContextualPanel/);
});

test('Unified Contextual Workspace: CSS enforces responsive drawer and two-pane desktop docked presentation', () => {
  const cssPath = path.resolve(process.cwd(), 'src/styles/adaptiveStudio.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Desktop (>= 1280px) two-pane docked layout: only visible when has-studio-open is present
  assert.match(cssContent, /\.aira-adaptive-shell\.has-studio-open \.aira-adaptive-empty-studio/);
  assert.match(cssContent, /\.aira-adaptive-shell \.aira-adaptive-real-studio \{ width: 46%; flex-basis: 46%; \}/);

  // Tablet & Mobile (< 1280px) responsive drawer modal
  assert.match(cssContent, /@media \(max-width: 1279px\)/);
  assert.match(cssContent, /max-width: 540px !important;/);
  assert.match(cssContent, /position: fixed !important;/);
});
