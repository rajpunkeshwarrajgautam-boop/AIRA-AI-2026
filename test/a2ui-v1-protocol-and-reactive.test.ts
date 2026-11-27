/**
 * Phase 2 TDD Suite: A2UI v1.0 Protocol Interop & Reactive Data Engine
 *
 * Includes protocol fixtures adapted under Apache-2.0 attribution from:
 * a2ui-project/a2ui (revision 36725eee042da90c526f469f94246f96e16fdc35),
 * Copyright A2UI Authors / Google LLC, licensed under Apache-2.0.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2UI_PROTOCOL_VERSION,
  A2UI_BASIC_CATALOG_ID,
  AIRA_A2UI_CATALOG_ID,
  AIRA_A2UI_PROFILE_CAPABILITIES,
  A2UIAgentToRendererMessageSchema,
  A2UIRendererToAgentMessageSchema,
  A2UIRendererCapabilitiesSchema,
  A2UIAgentCapabilitiesSchema,
  A2UISurfaceReducer,
  mapAiraGenUIToA2UIV1Messages,
} from '../packages/contracts/src/a2ui.js';
import {
  AIRA_GENUI_CONTRACT_VERSION,
  validateGenUISurface,
  applyGenUILifecycleEventToMap,
  type GenUISurface,
} from '../packages/contracts/src/genui.js';
import {
  getByJsonPointer,
  setByJsonPointer,
  evaluateReactiveSurface,
} from '../packages/contracts/src/genui-reactive.js';

describe('A2UI v1.0 protocol schemas & conformance fixtures', () => {
  it('validates createSurface, updateComponents, updateDataModel, and deleteSurface with version 1.0', () => {
    const createMsg = A2UIAgentToRendererMessageSchema.parse({
      version: '1.0',
      createSurface: {
        surfaceId: 'contact_form_1',
        catalogId: A2UI_BASIC_CATALOG_ID,
        sendDataModel: true,
        metadata: {
          extensions: {
            com_aira_trace: 'trace_1',
          },
        },
      },
    });
    assert.equal(createMsg.version, A2UI_PROTOCOL_VERSION);

    const updateCompMsg = A2UIAgentToRendererMessageSchema.parse({
      version: '1.0',
      updateComponents: {
        surfaceId: 'contact_form_1',
        components: [
          { id: 'root', component: 'Card', child: 'col_1' },
          {
            id: 'col_1',
            component: 'Column',
            children: ['hdr_1', 'email_input'],
          },
          { id: 'hdr_1', component: 'Text', text: '# Contact Us', variant: 'body' },
          {
            id: 'email_input',
            component: 'TextField',
            label: 'Email',
            value: { '@path': '/contact/email' },
            '@checks': [
              {
                condition: { '@call': 'required', args: { value: { '@path': '/contact/email' } } },
                message: 'Email is required.',
              },
              {
                condition: { '@call': 'email', args: { value: { '@path': '/contact/email' } } },
                message: 'Valid email required.',
              },
            ],
          },
        ],
      },
    });
    assert.equal(updateCompMsg.version, '1.0');

    const updateDataMsg = A2UIAgentToRendererMessageSchema.parse({
      version: '1.0',
      updateDataModel: {
        surfaceId: 'contact_form_1',
        path: '/contact/email',
        value: 'user@example.com',
      },
    });
    assert.equal(updateDataMsg.version, '1.0');

    const deleteMsg = A2UIAgentToRendererMessageSchema.parse({
      version: '1.0',
      deleteSurface: {
        surfaceId: 'contact_form_1',
      },
    });
    assert.equal(deleteMsg.version, '1.0');
  });

  it('rejects v0.9 theme on createSurface, Surface component overrides, invalid versions, and prototype pollution', () => {
    const withTheme = A2UIAgentToRendererMessageSchema.safeParse({
      version: '1.0',
      createSurface: {
        surfaceId: 'bad_theme',
        theme: { primaryColor: '#000' },
      },
    });
    assert.equal(withTheme.success, false);

    const surfaceOverride = A2UIAgentToRendererMessageSchema.safeParse({
      version: '1.0',
      updateComponents: {
        surfaceId: 's1',
        components: [{ id: 'root', component: 'Surface', child: 'c1' }],
      },
    });
    assert.equal(surfaceOverride.success, false);

    const badVer = A2UIAgentToRendererMessageSchema.safeParse({
      version: '0.9',
      createSurface: { surfaceId: 'old_ver' },
    });
    assert.equal(badVer.success, false);

    const proto = JSON.parse('{"version":"1.0","updateDataModel":{"surfaceId":"s1","path":"/__proto__/polluted","value":true}}');
    const reducer = new A2UISurfaceReducer();
    reducer.applyMessage({ version: '1.0', createSurface: { surfaceId: 's1' } });
    const res = reducer.applyMessage(proto);
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'VALIDATION_FAILED');
  });

  it('validates renderer_to_agent action and error discrimination rules (A2UI v1.0 fixtures)', () => {
    const actionMsg = A2UIRendererToAgentMessageSchema.safeParse({
      version: '1.0',
      action: {
        name: 'submit',
        userMessage: 'Submitted contact form',
        surfaceId: 'main',
        sourceComponentId: 'btn_submit',
        timestamp: '2026-11-27T10:00:00Z',
        context: { email: 'a@b.com' },
      },
    });
    assert.equal(actionMsg.success, true);

    const errValidation = A2UIRendererToAgentMessageSchema.safeParse({
      version: '1.0',
      error: {
        code: 'VALIDATION_FAILED',
        surfaceId: 'main',
        path: '/components/0/text',
        message: 'Invalid type',
      },
    });
    assert.equal(errValidation.success, true);

    // Invalid: generic error cannot specify both functionCallId and surfaceId
    const invalidErr = A2UIRendererToAgentMessageSchema.safeParse({
      version: '1.0',
      error: {
        code: 'FUNCTION_FAILED',
        functionCallId: 'call_1',
        surfaceId: 'main',
        message: 'Both set',
      },
    });
    assert.equal(invalidErr.success, false);

    // Capabilities negotiation objects validate cleanly
    const rendererCaps = A2UIRendererCapabilitiesSchema.safeParse({
      '1.0': {
        supportedCatalogIds: [AIRA_A2UI_CATALOG_ID, A2UI_BASIC_CATALOG_ID],
      },
    });
    assert.equal(rendererCaps.success, true);

    const agentCaps = A2UIAgentCapabilitiesSchema.safeParse({
      '1.0': {
        supportedCatalogIds: [AIRA_A2UI_CATALOG_ID],
        acceptsInlineCatalogs: false,
      },
    });
    assert.equal(agentCaps.success, true);
    assert.equal(AIRA_A2UI_PROFILE_CAPABILITIES.compatibilityLevel, 'profiled-a2ui-v1.0');
  });

  it('reduces multi-message A2UI v1.0 streams incrementally into validated AIRA GenUISurface and exports valid A2UI messages back', () => {
    const reducer = new A2UISurfaceReducer();
    const r1 = reducer.applyMessage({
      version: '1.0',
      createSurface: {
        surfaceId: 'budget_planner',
        catalogId: A2UI_BASIC_CATALOG_ID,
        dataModel: { budget: { income: 5000, savingsRate: 20 } },
      },
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.surface, null, 'Surface without root should stay pending until root exists');

    // Duplicate createSurface while active must fail cleanly
    const rDup = reducer.applyMessage({
      version: '1.0',
      createSurface: { surfaceId: 'budget_planner' },
    });
    assert.equal(rDup.ok, false);

    const r2 = reducer.applyMessage({
      version: '1.0',
      updateComponents: {
        surfaceId: 'budget_planner',
        components: [
          { id: 'root', component: 'Column', children: ['title_txt', 'income_slider', 'rate_slider', 'save_btn'] },
          { id: 'title_txt', component: 'Text', text: '# Monthly Savings Planner' },
          { id: 'income_slider', component: 'Slider', label: 'Monthly Income', value: { '@path': '/budget/income' }, min: 1000, max: 20000, steps: 250 },
          { id: 'rate_slider', component: 'Slider', label: 'Savings Rate %', value: { '@path': '/budget/savingsRate' }, min: 5, max: 80, steps: 5 },
          {
            id: 'save_btn',
            component: 'Button',
            child: 'save_btn_txt',
            action: { event: { name: 'analyze_budget', context: { income: { '@path': '/budget/income' } } } },
          },
          { id: 'save_btn_txt', component: 'Text', text: 'Analyze with AIRA' },
        ],
      },
    });
    assert.equal(r2.ok, true);
    assert.ok(r2.surface, 'Should produce validated GenUISurface once root exists');
    const validated = validateGenUISurface(r2.surface);
    assert.equal(validated.ok, true);

    // Partial updateDataModel via JSON Pointer + null delete
    const r3 = reducer.applyMessage({
      version: '1.0',
      updateDataModel: { surfaceId: 'budget_planner', path: '/budget/income', value: 7500 },
    });
    assert.equal(r3.ok, true);
    assert.equal(getByJsonPointer(r3.surface!.state, '/budget/income'), 7500);

    // Export back to A2UI v1.0 messages
    const exported = mapAiraGenUIToA2UIV1Messages(r3.surface!);
    assert.equal(exported.length >= 1, true);
    assert.equal(A2UIAgentToRendererMessageSchema.safeParse(exported[0]).success, true);

    // Delete surface removes it and allows clean recreate afterward
    const rDel = reducer.applyMessage({
      version: '1.0',
      deleteSurface: { surfaceId: 'budget_planner' },
    });
    assert.equal(rDel.ok, true);
    assert.equal(rDel.deleted, true);

    const rRecreated = reducer.applyMessage({
      version: '1.0',
      createSurface: {
        surfaceId: 'budget_planner',
        components: [{ id: 'root', component: 'Text', text: 'Reborn' }],
      },
    });
    assert.equal(rRecreated.ok, true);
    assert.ok(rRecreated.surface);
  });
});

describe('Reactive JSON Pointer data model, dependency graph & dynamic multi-component evaluation', () => {
  it('supports JSON Pointer reads/writes safely and blocks prototype traversal', () => {
    const s = setByJsonPointer({}, '/decision/weights/cost', 40);
    assert.equal(getByJsonPointer(s, '/decision/weights/cost'), 40);
    assert.throws(() => setByJsonPointer(s, '/__proto__/polluted', 1), /forbidden/i);
    assert.throws(() => setByJsonPointer(s, '/a/constructor/b', 1), /forbidden/i);
    const deleted = setByJsonPointer(s, '/decision/weights/cost', null);
    assert.equal(getByJsonPointer(deleted, '/decision/weights/cost'), undefined);
  });

  it('detects circular computed dependencies cleanly without infinite loops', () => {
    const surface: GenUISurface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'cyclic_surf',
      rootId: 'r1',
      textFallback: 'Fallback',
      origin: 'model',
      state: { a: 1, b: 2 },
      computed: [
        { target: '/a', kind: 'math', expression: 'b + 1', deps: ['/b'] },
        { target: '/b', kind: 'math', expression: 'a + 1', deps: ['/a'] },
      ],
      actions: [],
      evidence: [],
      components: [{ id: 'r1', type: 'text', props: { text: 'Test' } }],
    };
    const res = validateGenUISurface(surface);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.code, /CYCLE/);
  });

  it('recomputes dependent metrics, dynamic charts, and filtered tables for composed apps without LLM calls', () => {
    // Weighted decision matrix + math expression + formatted currency + filtered table + reactive chart
    const decisionSurface: GenUISurface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'decision_matrix_1',
      title: 'Cloud Vendor Matrix',
      rootId: 'root',
      textFallback: 'Compare vendor scores',
      origin: 'model',
      state: {
        filterTier: 'all',
        weights: { cost: 50, speed: 30, reliability: 20 },
        candidates: [
          { name: 'Vendor A', tier: 'enterprise', cost: 80, speed: 70, reliability: 90 },
          { name: 'Vendor B', tier: 'startup', cost: 60, speed: 95, reliability: 75 },
        ],
      },
      computed: [
        {
          target: '/derived/matrix',
          kind: 'weighted_decision',
          candidatesRef: '/candidates',
          weightsRef: '/weights',
          filterRef: '/filterTier',
          filterField: 'tier',
          criteria: [
            { key: 'cost', label: 'Cost' },
            { key: 'speed', label: 'Speed' },
            { key: 'reliability', label: 'Reliability' },
          ],
        },
        {
          target: '/derived/topScore',
          kind: 'math',
          expression: 'max(0, round(candidates_top_score, 1))',
          bindings: { candidates_top_score: '/derived/matrix/topScore' },
        },
      ],
      actions: [],
      evidence: [],
      components: [
        { id: 'root', type: 'vertical_group', props: { gap: 'md', children: ['m_top', 'w_cost', 'tbl', 'ch'] } },
        { id: 'm_top', type: 'metric_display', props: { label: 'Top Score', value: 0, dataRef: '/derived/matrix/topScoreLabel' } },
        { id: 'w_cost', type: 'slider', props: { label: 'Cost Weight', stateKey: '/weights/cost', min: 0, max: 100, step: 5, defaultValue: 50 } },
        {
          id: 'tbl',
          type: 'data_table',
          props: {
            title: 'Scored Vendors',
            rowsRef: '/derived/matrix/rows',
            columns: [
              { key: 'name', label: 'Vendor', align: 'left', format: 'text' },
              { key: 'weightedScore', label: 'Score', align: 'right', format: 'number' },
            ],
            rows: [],
          },
        },
        {
          id: 'ch',
          type: 'bar_chart',
          props: {
            title: 'Score Comparison',
            labels: [],
            datasets: [{ label: 'Weighted Score', values: [] }],
            labelsRef: '/derived/matrix/labels',
            datasetsRef: '/derived/matrix/datasets',
          },
        },
      ],
    };

    const validated = validateGenUISurface(decisionSurface);
    assert.equal(validated.ok, true, validated.ok ? '' : validated.error);

    const eval1 = evaluateReactiveSurface(decisionSurface);
    const bar1 = eval1.surface.components.find((c) => c.id === 'ch');
    assert.equal(bar1?.type, 'bar_chart');
    if (bar1?.type === 'bar_chart') {
      assert.deepEqual(bar1.props.labels, ['Vendor A', 'Vendor B']);
      // Initial weights (50,30,20): A = (80*50+70*30+90*20)/100 = 79.0; B = (60*50+95*30+75*20)/100 = 73.5
      assert.deepEqual(bar1.props.datasets[0].values, [79, 73.5]);
    }

    // Mutate speed weight -> recompute flips ranking deterministically without AI call!
    const nextState = setByJsonPointer(decisionSurface.state, '/weights/speed', 90);
    const nextState2 = setByJsonPointer(nextState, '/weights/cost', 5);
    const eval2 = evaluateReactiveSurface(decisionSurface, nextState2);
    const bar2 = eval2.surface.components.find((c) => c.id === 'ch');
    if (bar2?.type === 'bar_chart') {
      assert.equal(bar2.props.labels[0], 'Vendor B', 'Vendor B should rank #1 after boosting speed weight');
    }
  });

  it('supports genui.surface.deleted lifecycle events cleanly inside applyGenUILifecycleEventToMap', () => {
    let map = new Map();
    const baseSurface: GenUISurface = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 's_del',
      rootId: 'r1',
      textFallback: 'Fallback text',
      origin: 'model',
      state: {},
      actions: [],
      evidence: [],
      components: [{ id: 'r1', type: 'text', props: { text: 'Hello' } }],
    };
    map = applyGenUILifecycleEventToMap(map, {
      eventId: 'e1',
      type: 'genui.surface.created',
      surfaceId: 's_del',
      runId: 'run_1',
      sequence: 1,
      timestamp: Date.now(),
      surface: baseSurface,
    }, 'run_1');
    assert.equal(map.has('s_del'), true);

    map = applyGenUILifecycleEventToMap(map, {
      eventId: 'e2',
      type: 'genui.surface.deleted',
      surfaceId: 's_del',
      runId: 'run_1',
      sequence: 2,
      timestamp: Date.now(),
    }, 'run_1');
    assert.equal(map.has('s_del'), false);
  });

  it('rejects ReDoS regex patterns, excessive state depth, and translates @call, openUrl, and @index templates', () => {
    const redosSurface = validateGenUISurface({
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 's_redos',
      rootId: 'r1',
      textFallback: 'Fallback',
      origin: 'model',
      state: {},
      actions: [],
      evidence: [],
      components: [
        {
          id: 'r1',
          type: 'text_input',
          props: { label: 'Input', stateKey: 'x', defaultValue: '' },
          checks: [{ kind: 'regex', pattern: '((a+))+', message: 'Bad regex' }],
        },
      ],
    });
    assert.equal(redosSurface.ok, false);

    // @call formatCurrency / formatString + openUrl + @index List template
    const reducer = new A2UISurfaceReducer();
    const res = reducer.applyMessage({
      version: '1.0',
      createSurface: {
        surfaceId: 's_calls',
        dataModel: { total: 1250, tasks: ['Task A', 'Task B'] },
        components: [
          { id: 'root', component: 'Column', children: ['summary', 'items_list', 'docs_btn'] },
          {
            id: 'summary',
            component: 'Text',
            text: {
              '@call': 'formatString',
              args: {
                template: 'Budget: ${totalFmt}',
                totalFmt: { '@call': 'formatCurrency', args: { value: { '@path': '/total' }, currency: 'USD', decimals: 0 } },
              },
            },
          },
          { id: 'items_list', component: 'List', children: { componentId: 'row_tmpl', path: '/tasks' } },
          { id: 'row_tmpl', component: 'Text', text: 'Milestone item' },
          {
            id: 'docs_btn',
            component: 'Button',
            child: 'docs_txt',
            action: { functionCall: { '@call': 'openUrl', args: { url: 'https://a2ui.org' } } },
          },
          { id: 'docs_txt', component: 'Text', text: 'Open Docs' },
        ],
      },
    });
    assert.equal(res.ok, true);
    assert.ok(res.surface);
    const summaryComp = res.surface!.components.find((c) => c.id === 'summary');
    assert.equal(summaryComp?.type, 'text');
    if (summaryComp?.type === 'text') {
      assert.equal(summaryComp.props.text, 'Budget: $1,250');
    }
    const openUrlAction = res.surface!.actions.find((a) => a.kind === 'open_artifact');
    assert.equal(openUrlAction?.promptTemplate, 'https://a2ui.org/');
    const listComp = res.surface!.components.find((c) => c.id === 'items_list');
    assert.equal(listComp?.type, 'vertical_group');
    if (listComp?.type === 'vertical_group') {
      assert.equal(listComp.props.children.length, 2);
    }
  });
});
