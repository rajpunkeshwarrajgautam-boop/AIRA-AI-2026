import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventType } from '@ag-ui/core';
import {
  adaptAiraEventToAGUI,
  authorizeGenUIActionServerSide,
  buildGenUISystemInstruction,
  buildRuntimeExecutionGenUISurface,
  GenUIStreamTagExtractor,
} from '../packages/agent-runtime/src/genui-streaming.js';
import { PresentationRouter } from '../packages/agent-runtime/src/presentation-router.js';
import { AIRA_GENUI_CONTRACT_VERSION, type GenUISurface } from '../packages/contracts/src/genui.js';

describe('Slice 2 TDD: Streaming A2UI v1.0 extraction & AG-UI deletion adaptation', () => {
  it('extracts A2UI v1.0 JSONL streams inside <airaGenUI> across chunks without corrupting prose', () => {
    const extractor = new GenUIStreamTagExtractor();
    const a2uiLines = [
      JSON.stringify({
        version: '1.0',
        createSurface: {
          surfaceId: 'study_1',
          dataModel: { study: { hours: 12, taskDone: false } },
        },
      }),
      JSON.stringify({
        version: '1.0',
        updateComponents: {
          surfaceId: 'study_1',
          components: [
            { id: 'root', component: 'Column', children: ['t_hdr', 's_hrs', 'c_task'] },
            { id: 't_hdr', component: 'Text', text: '# Study Planner' },
            { id: 's_hrs', component: 'Slider', label: 'Weekly Hours', value: { '@path': '/study/hours' }, min: 1, max: 40, steps: 1 },
            { id: 'c_task', component: 'CheckBox', label: 'Complete Module 1', value: { '@path': '/study/taskDone' } },
          ],
        },
      }),
    ].join('\n');

    const fullPayload = `Here is your plan.\n<airaGenUI>\n${a2uiLines}\n</airaGenUI>\nLet me know if you want changes.`;
    const mid = Math.floor(fullPayload.length / 2);
    const r1 = extractor.pushChunk(fullPayload.slice(0, mid));
    const r2 = extractor.pushChunk(fullPayload.slice(mid));
    const r3 = extractor.flush();

    const visible = r1.visibleText + r2.visibleText + r3.visibleText;
    assert.match(visible, /Here is your plan\./);
    assert.match(visible, /Let me know if you want changes\./);
    assert.equal(visible.includes('<airaGenUI>'), false);

    const allSurfaces = [...r1.surfaces, ...r2.surfaces, ...r3.surfaces];
    assert.equal(allSurfaces.length, 1);
    assert.equal(allSurfaces[0].ok, true);
    if (allSurfaces[0].ok) {
      assert.equal(allSurfaces[0].surface.surfaceId, 'study_1');
      assert.equal(allSurfaces[0].surface.components.some((c) => c.type === 'slider'), true);
    }
  });

  it('supports sequential A2UI updateDataModel and deleteSurface across tags via lifecycleEvents', () => {
    const extractor = new GenUIStreamTagExtractor();
    const block1 = `<airaGenUI>${JSON.stringify({
      version: '1.0',
      createSurface: {
        surfaceId: 'surf_live',
        components: [
          { id: 'root', component: 'Column', children: ['txt'] },
          { id: 'txt', component: 'Text', text: { '@path': '/msg' } },
        ],
        dataModel: { msg: 'Initial' },
      },
    })}</airaGenUI>`;
    const block2 = `<airaGenUI>${JSON.stringify({
      version: '1.0',
      deleteSurface: { surfaceId: 'surf_live' },
    })}</airaGenUI>`;

    const p1 = extractor.pushChunk(block1);
    assert.equal(p1.surfaces.length, 1);
    assert.equal(p1.surfaces[0].ok, true);

    const p2 = extractor.pushChunk(block2);
    assert.equal(p2.deletedSurfaceIds.includes('surf_live'), true);

    const aguiDeleted = adaptAiraEventToAGUI({
      eventId: 'evt_del',
      runId: 'run_del',
      type: 'genui.surface.deleted',
      timestamp: Date.now(),
      data: { surfaceId: 'surf_live' },
    });
    assert.equal(aguiDeleted.some((e) => e.type === EventType.CUSTOM && e.name === 'aira.genui.surface.deleted'), true);
  });

  it('routes interactive planners, decision matrices, and multi-step forms to declarative_interactive while keeping plain Q&A text-only', async () => {
    const router = new PresentationRouter();

    const matrix = await router.route({
      prompt: 'Build an interactive vendor decision matrix with editable weights for cost and reliability',
    });
    assert.equal(matrix.mode, 'declarative_interactive');

    const study = await router.route({
      prompt: 'Create a study planner with weekly schedule checkboxes and progress tracking',
    });
    assert.equal(study.mode, 'declarative_interactive');

    const wizard = await router.route({
      prompt: 'Create an interactive multi-step onboarding form with validation',
    });
    assert.equal(wizard.mode, 'declarative_interactive');

    const simpleQa = await router.route({ prompt: 'What is HTTP 410?' });
    assert.equal(simpleQa.mode, 'plain_text');

    const guidance = buildGenUISystemInstruction('declarative_interactive');
    assert.match(guidance, /computed/i);
    assert.match(guidance, /weighted_decision|compound_growth|amortization/);
  });

  it('enforces cross-conversation denial and server-side action definition checks', () => {
    const surfaceDef: GenUISurface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 's_sec',
      rootId: 'r1',
      textFallback: 'Fallback',
      origin: 'model',
      state: {},
      actions: [
        {
          id: 'act_danger',
          label: 'Deploy',
          kind: 'attach_followup',
          permissionLevel: 'DESTRUCTIVE',
          requiresApproval: true,
        },
        {
          id: 'act_safe',
          label: 'Analyze',
          kind: 'attach_followup',
          permissionLevel: 'NONE',
          requiresApproval: false,
          allowedKeys: ['x'],
        },
      ],
      evidence: [],
      components: [
        {
          id: 'r1',
          type: 'vertical_group',
          props: { gap: 'sm', children: ['b1', 'b_danger'] },
        },
        {
          id: 'b1',
          type: 'action_button',
          props: { label: 'Analyze', actionId: 'act_safe', variant: 'primary', disabled: false },
        },
        {
          id: 'b_danger',
          type: 'action_button',
          props: { label: 'Deploy', actionId: 'act_danger', variant: 'danger', disabled: false },
        },
      ],
    };

    const crossConv = authorizeGenUIActionServerSide({
      principalUserId: 'user_a',
      conversationOwnerUserId: 'user_b',
      surface: surfaceDef,
      event: {
        eventId: 'e1',
        surfaceId: 's_sec',
        componentId: 'b1',
        actionId: 'act_safe',
        kind: 'attach_followup',
        conversationId: 'conv_1',
        stateSnapshot: {},
        timestamp: Date.now(),
      },
    });
    assert.equal(crossConv.allowed, false);
    assert.equal(crossConv.status, 403);

    const requiresApprovalBypass = authorizeGenUIActionServerSide({
      principalUserId: 'user_a',
      conversationOwnerUserId: 'user_a',
      surface: surfaceDef,
      event: {
        eventId: 'e2',
        surfaceId: 's_sec',
        componentId: 'b_danger',
        actionId: 'act_danger',
        kind: 'attach_followup',
        conversationId: 'conv_1',
        stateSnapshot: {},
        timestamp: Date.now(),
      },
    });
    assert.equal(requiresApprovalBypass.allowed, false);
    assert.equal(requiresApprovalBypass.status, 403);

    const missingContext = authorizeGenUIActionServerSide({
      principalUserId: 'user_a',
      event: {
        eventId: 'e2b',
        surfaceId: 's_sec',
        componentId: 'b1',
        actionId: 'act_safe',
        kind: 'attach_followup',
        stateSnapshot: {},
        timestamp: Date.now(),
      },
    });
    assert.equal(missingContext.allowed, false);
    assert.equal(missingContext.status, 403);

    const missingPersistedSurface = authorizeGenUIActionServerSide({
      principalUserId: 'user_a',
      conversationOwnerUserId: 'user_a',
      requirePersistedSurface: true,
      event: {
        eventId: 'e2c',
        surfaceId: 's_sec',
        componentId: 'b1',
        actionId: 'act_safe',
        kind: 'attach_followup',
        conversationId: 'conv_1',
        stateSnapshot: {},
        timestamp: Date.now(),
      },
    });
    assert.equal(missingPersistedSurface.allowed, false);
    assert.equal(missingPersistedSurface.status, 403);

    const componentMismatch = authorizeGenUIActionServerSide({
      principalUserId: 'user_a',
      conversationOwnerUserId: 'user_a',
      surface: surfaceDef,
      requirePersistedSurface: true,
      event: {
        eventId: 'e2d',
        surfaceId: 's_sec',
        componentId: 'r1',
        actionId: 'act_safe',
        kind: 'attach_followup',
        conversationId: 'conv_1',
        stateSnapshot: {},
        timestamp: Date.now(),
      },
    });
    assert.equal(componentMismatch.allowed, false);
    assert.equal(componentMismatch.status, 403);

    const valid = authorizeGenUIActionServerSide({
      principalUserId: 'user_a',
      conversationOwnerUserId: 'user_a',
      surface: surfaceDef,
      requirePersistedSurface: true,
      event: {
        eventId: 'e3',
        surfaceId: 's_sec',
        componentId: 'b1',
        actionId: 'act_safe',
        kind: 'attach_followup',
        conversationId: 'conv_1',
        stateSnapshot: { x: 1, leakedSecret: 'drop-me' },
        timestamp: Date.now(),
      },
    });
    assert.equal(valid.allowed, true);
    assert.deepEqual(valid.sanitizedStateSnapshot, { x: 1 });

    const execSurf = buildRuntimeExecutionGenUISurface({
      runId: 'run_ws_1',
      title: 'Inspect files',
      status: 'COMPLETED',
      toolCalls: [{ toolName: 'repo_git_status', status: 'COMPLETED', durationMs: 42 }],
    });
    assert.equal(execSurf.surfaceId, 'exec_run_ws_1');
  });
});
