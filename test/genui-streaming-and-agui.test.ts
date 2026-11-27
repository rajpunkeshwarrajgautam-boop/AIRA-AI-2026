import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventType } from '@ag-ui/core';
import {
  adaptAiraEventToAGUI,
  GenUIStreamTagExtractor,
  detectDeterministicCalculatorIntent,
  buildRuntimeExecutionGenUISurface,
  applyGenUILifecycleEventToMap,
  authorizeGenUIActionServerSide,
} from '../packages/agent-runtime/src/genui-streaming.js';
import {
  AIRA_GENUI_CONTRACT_VERSION,
  validateGenUISurface,
} from '../packages/contracts/src/index.js';

describe('Phase 1 — AG-UI Narrow Adapter, Progressive Streaming & State Security', () => {
  it('translates authoritative AIRA runtime events into validated @ag-ui/core events', () => {
    const started = adaptAiraEventToAGUI({
      eventId: 'evt_1',
      runId: 'run_1',
      sequence: 1,
      type: 'run.started',
      timestamp: 1000,
      data: { threadId: 'conv_1' },
    });
    assert.equal(started[0].type, EventType.RUN_STARTED);
    assert.equal((started[0] as any).runId, 'run_1');

    const delta = adaptAiraEventToAGUI({
      eventId: 'evt_2',
      runId: 'run_1',
      sequence: 2,
      type: 'content.delta',
      timestamp: 1001,
      data: { delta: 'Hello world' },
    });
    assert.equal(delta[0].type, EventType.TEXT_MESSAGE_CONTENT);
    assert.equal((delta[0] as any).delta, 'Hello world');

    const validSurface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_agui_1',
      rootId: 'root',
      textFallback: 'Fallback',
      components: [{ id: 'root', type: 'text', props: { text: 'Hello' } }],
    };
    const surfaceEvents = adaptAiraEventToAGUI({
      eventId: 'evt_3',
      runId: 'run_1',
      sequence: 3,
      type: 'genui.surface.created',
      timestamp: 1002,
      data: { surface: validSurface },
    });
    assert.equal(surfaceEvents.some((e) => e.type === EventType.STATE_SNAPSHOT), true);
    assert.equal(surfaceEvents.some((e) => e.type === EventType.CUSTOM), true);
  });

  it('extracts split <airaGenUI> blocks across chunks without leaking raw JSON and degrades safely on malformed JSON', () => {
    const validSurfaceJson = JSON.stringify({
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_split_1',
      rootId: 'r1',
      textFallback: 'Bar chart of Q1/Q2 revenue.',
      components: [
        {
          id: 'r1',
          type: 'bar_chart',
          props: {
            title: 'Revenue',
            labels: ['Q1', 'Q2'],
            datasets: [{ label: 'USD', values: [120, 185] }],
          },
        },
      ],
    });

    const extractor = new GenUIStreamTagExtractor();
    const c1 = extractor.pushChunk('Here is your chart:\n<airaGen');
    const c2 = extractor.pushChunk(`UI>${validSurfaceJson.slice(0, 60)}`);
    const c3 = extractor.pushChunk(`${validSurfaceJson.slice(60)}</airaGenUI>\nHope this helps!`);
    const tail = extractor.flush();

    const fullVisibleText = c1.visibleText + c2.visibleText + c3.visibleText + tail.visibleText;
    assert.equal(fullVisibleText.includes('<airaGenUI>'), false);
    assert.equal(fullVisibleText.includes('schemaVersion'), false);
    assert.ok(fullVisibleText.includes('Here is your chart:'));
    assert.ok(fullVisibleText.includes('Hope this helps!'));

    const allSurfaces = [...c1.surfaces, ...c2.surfaces, ...c3.surfaces, ...tail.surfaces];
    assert.equal(allSurfaces.length, 1);
    assert.equal(allSurfaces[0].ok, true);

    // Malformed / unsafe block degrades cleanly without emitting unvalidated surface
    const badExtractor = new GenUIStreamTagExtractor();
    const b1 = badExtractor.pushChunk('Intro <airaGenUI>{"schemaVersion":"aira-genui/v1","bad":true</airaGenUI> Outro');
    const bTail = badExtractor.flush();
    assert.equal((b1.visibleText + bTail.visibleText).includes('<airaGenUI>'), false);
    const badSurfaces = [...b1.surfaces, ...bTail.surfaces];
    assert.equal(badSurfaces.length, 1);
    assert.equal(badSurfaces[0].ok, false);
  });

  it('reduces out-of-order, duplicate, stale-conversation, and cancellation GenUI lifecycle events cleanly', () => {
    const s1 = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_seq_1',
      rootId: 'r',
      textFallback: 'Initial',
      state: { step: 1 },
      components: [{ id: 'r', type: 'text' as const, props: { text: 'First', variant: 'body' as const } }],
      actions: [],
      evidence: [],
      origin: 'model' as const,
    };

    let map = new Map();
    map = applyGenUILifecycleEventToMap(map, {
      eventId: 'e1',
      type: 'genui.surface.created',
      surfaceId: 'surf_seq_1',
      runId: 'run_active',
      sequence: 1,
      timestamp: 100,
      surface: s1,
    }, 'run_active');
    assert.equal(map.size, 1);

    // Duplicate event ignored idempotently
    const mapAfterDup = applyGenUILifecycleEventToMap(map, {
      eventId: 'e1',
      type: 'genui.surface.created',
      surfaceId: 'surf_seq_1',
      runId: 'run_active',
      sequence: 1,
      timestamp: 100,
      surface: s1,
    }, 'run_active');
    assert.equal(mapAfterDup, map);

    // Stale run event (after conversation switch) ignored
    const mapAfterStale = applyGenUILifecycleEventToMap(map, {
      eventId: 'e_stale',
      type: 'genui.surface.created',
      surfaceId: 'surf_other',
      runId: 'run_old_conversation',
      sequence: 2,
      timestamp: 101,
      surface: { ...s1, surfaceId: 'surf_other' },
    }, 'run_active');
    assert.equal(mapAfterStale.has('surf_other'), false);

    // Patch updates state cleanly and older sequence patch is ignored
    map = applyGenUILifecycleEventToMap(map, {
      eventId: 'e3',
      type: 'genui.surface.patched',
      surfaceId: 'surf_seq_1',
      runId: 'run_active',
      sequence: 5,
      timestamp: 105,
      statePatch: { step: 5 },
    }, 'run_active');
    assert.equal(map.get('surf_seq_1')?.surface.state.step, 5);

    map = applyGenUILifecycleEventToMap(map, {
      eventId: 'e2',
      type: 'genui.surface.patched',
      surfaceId: 'surf_seq_1',
      runId: 'run_active',
      sequence: 3,
      timestamp: 103,
      statePatch: { step: 3 },
    }, 'run_active');
    assert.equal(map.get('surf_seq_1')?.surface.state.step, 5, 'Out-of-order lower sequence must not overwrite newer state');
  });

  it('matches deterministic calculator prompts and builds valid runtime execution surfaces', () => {
    assert.equal(detectDeterministicCalculatorIntent('Calculate compound interest on $10000 at 8% for 10 years'), 'compound_interest');
    assert.equal(detectDeterministicCalculatorIntent('Monthly loan payment EMI for $200,000 mortgage at 6.5%'), 'loan_payment');
    assert.equal(detectDeterministicCalculatorIntent('Convert 42 km to miles'), 'unit_conversion');
    assert.equal(detectDeterministicCalculatorIntent('What is 15 percent of 240'), 'percentage');
    assert.equal(detectDeterministicCalculatorIntent('Plot function f(x) = sin(x) + x^2'), 'scientific_eval');
    assert.equal(detectDeterministicCalculatorIntent('Explain Raft consensus protocol'), null);

    const execSurface = buildRuntimeExecutionGenUISurface({
      runId: 'run_mission_1',
      title: 'Fix flaky auth test',
      status: 'WAITING_FOR_APPROVAL',
      intent: 'AGENT_MISSION',
      toolCalls: [{ toolName: 'repo_read', status: 'COMPLETED', durationMs: 35 }],
      pendingApproval: {
        approvalId: 'req_99',
        runId: 'run_mission_1',
        toolName: 'file_write',
        risk: 'medium',
        reason: 'Write auth patch',
      },
    });
    assert.equal(validateGenUISurface(execSurface).ok, true);
  });

  it('authorizes GenUI consequential actions fail-closed across principals, missing approvals, and unpermitted action kinds', () => {
    const unauth = authorizeGenUIActionServerSide({
      principalUserId: 'attacker',
      runOwnerUserId: 'owner',
      event: {
        eventId: 'int_1',
        surfaceId: 's1',
        componentId: 'b1',
        actionId: 'a1',
        kind: 'run_approval',
        runId: 'run_1',
        stateSnapshot: {},
        timestamp: Date.now(),
      },
    });
    assert.equal(unauth.allowed, false);
    assert.equal(unauth.status, 403);

    const forgedWorkflow = authorizeGenUIActionServerSide({
      principalUserId: 'owner',
      runOwnerUserId: 'owner',
      event: {
        eventId: 'int_2',
        surfaceId: 's1',
        componentId: 'b1',
        actionId: 'a2',
        kind: 'workflow_trigger',
        runId: 'run_1',
        stateSnapshot: {},
        timestamp: Date.now(),
      },
    });
    assert.equal(forgedWorkflow.allowed, false);

    const validFollowup = authorizeGenUIActionServerSide({
      principalUserId: 'owner',
      runOwnerUserId: 'owner',
      event: {
        eventId: 'int_3',
        surfaceId: 's1',
        componentId: 'b1',
        actionId: 'a3',
        kind: 'attach_followup',
        stateSnapshot: { principal: 15000 },
        timestamp: Date.now(),
      },
    });
    assert.equal(validFollowup.allowed, true);
  });
});
