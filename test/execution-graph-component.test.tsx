import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentExecutionGraphView } from '../src/components/AgentExecutionGraph';
import { AdaptiveStudioEmptyState } from '../src/components/AdaptiveStudioEmptyState';
import type { AgentExecutionGraph } from '../src/types/executionGraph';

test('AgentExecutionGraphView renders DAG canvas with nodes, roles, and tool telemetry', () => {
  const mockGraph: AgentExecutionGraph = {
    graphId: 'test_graph_01',
    runId: 'run_test_01',
    title: 'Multi-Agent Research Pipeline',
    nodes: {
      step_1: {
        id: 'step_1',
        name: 'Literature Reconnaissance',
        role: 'researcher',
        state: 'COMPLETED',
        dependsOn: [],
        durationMs: 1450,
        attempt: 1,
        maxAttempts: 2,
        associatedArtifactId: 'art_lit_01',
        associatedArtifactTitle: 'Literature Review Document'
      },
      step_2: {
        id: 'step_2',
        name: 'Interactive Model Synthesizer',
        role: 'coder',
        state: 'RUNNING',
        dependsOn: ['step_1'],
        startedAt: 1000,
        attempt: 1,
        maxAttempts: 2,
        activeTool: {
          name: 'vite_compiler',
          callId: 'call_123',
          status: 'running'
        }
      }
    },
    waves: [['step_1'], ['step_2']],
    state: 'RUNNING',
    totalTasks: 2,
    completedTasks: 1,
    failedTasks: 0
  };

  const html = renderToStaticMarkup(
    <AgentExecutionGraphView
      graph={mockGraph}
      selectedArtifactId="art_lit_01"
      onSelectArtifact={() => {}}
      onApproveTask={() => {}}
    />
  );

  // Checks toolbar and title
  assert.match(html, /Multi-Agent Research Pipeline/);
  assert.match(html, /1\/2 Tasks/);
  assert.match(html, /data-testid="dag-canvas-container"/);

  // Checks step 1 (Completed with linked artifact)
  assert.match(html, /data-testid="graph-node-step_1"/);
  assert.match(html, /Literature Reconnaissance/);
  assert.match(html, /Literature Review Document/);
  assert.match(html, /data-testid="node-view-artifact-step_1"/);

  // Checks step 2 (Running with active tool)
  assert.match(html, /data-testid="graph-node-step_2"/);
  assert.match(html, /Interactive Model Synthesizer/);
  assert.match(html, /vite_compiler/);
});

test('AgentExecutionGraphView renders pending approval card with approve/reject actions', () => {
  const approvalGraph: AgentExecutionGraph = {
    graphId: 'test_graph_02',
    runId: 'run_test_02',
    title: 'Protected Release',
    nodes: {
      deploy_step: {
        id: 'deploy_step',
        name: 'Deploy Production Cluster',
        role: 'automation',
        state: 'WAITING_FOR_APPROVAL',
        dependsOn: [],
        attempt: 1,
        maxAttempts: 1,
        approvalRequired: true,
        approvalId: 'appr_gate_99',
        approvalReason: 'Requires human sign-off for release'
      }
    },
    waves: [['deploy_step']],
    state: 'WAITING_FOR_APPROVAL',
    totalTasks: 1,
    completedTasks: 0,
    failedTasks: 0
  };

  const html = renderToStaticMarkup(
    <AgentExecutionGraphView
      graph={approvalGraph}
      onApproveTask={() => {}}
    />
  );

  assert.match(html, /Approval Required/);
  assert.match(html, /data-testid="node-approve-btn-deploy_step"/);
  assert.match(html, /data-testid="node-reject-btn-deploy_step"/);
});

test('AgentExecutionGraphView compact mode renders accessible timeline list', () => {
  const mockGraph: AgentExecutionGraph = {
    graphId: 'test_graph_03',
    runId: 'run_test_03',
    title: 'Mobile Workflow View',
    nodes: {
      task_a: {
        id: 'task_a',
        name: 'Analyze Query',
        role: 'analyst',
        state: 'COMPLETED',
        dependsOn: [],
        attempt: 1,
        maxAttempts: 2
      }
    },
    waves: [['task_a']],
    state: 'COMPLETED',
    totalTasks: 1,
    completedTasks: 1,
    failedTasks: 0
  };

  const html = renderToStaticMarkup(
    <AgentExecutionGraphView
      graph={mockGraph}
      compact={true}
    />
  );

  assert.match(html, /data-testid="timeline-view-container"/);
  assert.match(html, /data-testid="timeline-node-task_a"/);
  assert.match(html, /Wave 1/);
});

test('AdaptiveStudioEmptyState renders execution graph when active, and empty prompt when inactive', () => {
  const activeGraph: AgentExecutionGraph = {
    graphId: 'test_graph_04',
    runId: 'run_test_04',
    title: 'Autonomous Swarm Execution',
    nodes: {
      node_1: {
        id: 'node_1',
        name: 'Swarm Task 1',
        role: 'planner',
        state: 'RUNNING',
        dependsOn: [],
        attempt: 1,
        maxAttempts: 1
      }
    },
    waves: [['node_1']],
    state: 'RUNNING',
    totalTasks: 1,
    completedTasks: 0,
    failedTasks: 0
  };

  // 1. With active graph: renders graph workspace
  const htmlWithGraph = renderToStaticMarkup(
    <AdaptiveStudioEmptyState executionGraph={activeGraph} />
  );
  assert.match(htmlWithGraph, /data-testid="adaptive-studio-graph-workspace"/);
  assert.match(htmlWithGraph, /Autonomous Swarm Execution/);

  // 2. Without graph: renders standard empty state
  const htmlEmpty = renderToStaticMarkup(
    <AdaptiveStudioEmptyState executionGraph={null} />
  );
  assert.match(htmlEmpty, /data-testid="adaptive-studio-empty"/);
  assert.match(htmlEmpty, /Your next creation starts here/);
});
