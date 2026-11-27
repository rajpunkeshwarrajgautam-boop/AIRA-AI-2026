import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AIRA_GENUI_CONTRACT_VERSION, buildCalculatorSurface } from '../packages/contracts/src/index.js';
import {
  GENUI_COMPONENT_REGISTRY,
  isSupportedGenUIComponentType,
  GenUISurfaceRenderer,
} from '../src/components/genui/index.js';

const ALL_EXPECTED_COMPONENT_TYPES = [
  'text',
  'heading',
  'caption',
  'rich_text',
  'divider',
  'code_block',
  'math_block',
  'data_table',
  'data_summary',
  'vertical_group',
  'horizontal_group',
  'responsive_grid',
  'card',
  'section',
  'adaptive_container',
  'bar_chart',
  'line_chart',
  'scatter_chart',
  'pie_chart',
  'doughnut_chart',
  'progress_indicator',
  'metric_display',
  'comparison_viz',
  'numeric_input',
  'text_input',
  'slider',
  'select_control',
  'checkbox',
  'radio_group',
  'segmented_control',
  'reset_control',
  'action_button',
  'mission_summary',
  'task_status',
  'execution_timeline',
  'tool_execution_summary',
  'artifact_reference',
  'approval_request',
  'error_recovery',
] as const;

describe('Phase 1 — Component Registry & Surface Renderer (SSR + Guard Verification)', () => {
  it('registers all 39 canonical GenUI component types and rejects unknown types', () => {
    for (const compType of ALL_EXPECTED_COMPONENT_TYPES) {
      assert.equal(isSupportedGenUIComponentType(compType), true, `Missing registry entry for ${compType}`);
      assert.equal(typeof GENUI_COMPONENT_REGISTRY[compType], 'function');
    }
    assert.equal(isSupportedGenUIComponentType('eval_script' as any), false);
    assert.equal(isSupportedGenUIComponentType('arbitrary_jsx' as any), false);
  });

  it('renders invalid/malformed surface safely with textFallback without crashing', () => {
    const html = renderToStaticMarkup(
      React.createElement(GenUISurfaceRenderer, {
        surface: {
          schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
          surfaceId: 'surf_bad',
          rootId: 'root',
          textFallback: 'Safe fallback prose summary',
          components: [{ id: 'root', type: 'unknown_widget', props: { danger: '<img src=x onerror=alert(1)>' } }],
        },
      })
    );
    assert.ok(html.includes('Safe fallback prose summary'));
    assert.equal(html.includes('onerror=alert'), false);
  });

  it('renders deterministic calculator, charts, agent execution components, and interactive controls cleanly', () => {
    const calcSurface = buildCalculatorSurface('compound_interest');
    const calcHtml = renderToStaticMarkup(React.createElement(GenUISurfaceRenderer, { surface: calcSurface }));
    assert.ok(calcHtml.includes('Compound Interest Explorer'));
    assert.ok(calcHtml.includes('Projected Balance'));
    assert.ok(calcHtml.includes('Ask AIRA about current inputs'));

    const execSurface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_exec',
      rootId: 'exec_root',
      textFallback: 'Mission running: 2 of 3 steps complete.',
      components: [
        {
          id: 'exec_root',
          type: 'vertical_group',
          props: { gap: 'sm', children: ['ms_1', 'ts_1', 'tl_1', 'tool_1', 'art_1', 'apr_1', 'err_1'] },
        },
        {
          id: 'ms_1',
          type: 'mission_summary',
          props: { title: 'Audit Schema', status: 'WAITING_FOR_APPROVAL', intent: 'AGENT_MISSION', stepCount: 3, completedSteps: 2 },
        },
        { id: 'ts_1', type: 'task_status', props: { taskName: 'Check migrations', status: 'COMPLETED', durationMs: 120 } },
        { id: 'tl_1', type: 'execution_timeline', props: { title: 'Steps', entries: [{ id: 'e1', label: 'Initialized', status: 'done' }] } },
        { id: 'tool_1', type: 'tool_execution_summary', props: { title: 'Tools', calls: [{ toolName: 'repo_read', status: 'COMPLETED', durationMs: 42 }] } },
        { id: 'art_1', type: 'artifact_reference', props: { artifactId: 'art_1', title: 'audit.md', artifactType: 'text/markdown', version: 1 } },
        {
          id: 'apr_1',
          type: 'approval_request',
          props: { approvalId: 'req_1', runId: 'run_1', toolName: 'write_file', risk: 'medium', reason: 'Update schema file', decision: 'PENDING' },
        },
        { id: 'err_1', type: 'error_recovery', props: { title: 'Timeout Warning', message: 'Upstream timed out once', recoverable: true } },
      ],
    };
    const execHtml = renderToStaticMarkup(React.createElement(GenUISurfaceRenderer, { surface: execSurface }));
    assert.ok(execHtml.includes('Audit Schema'));
    assert.ok(execHtml.includes('Check migrations'));
    assert.ok(execHtml.includes('repo_read'));
    assert.ok(execHtml.includes('audit.md'));
    assert.ok(execHtml.includes('Approve Once'));
    assert.ok(execHtml.includes('Timeout Warning'));
  });
});
