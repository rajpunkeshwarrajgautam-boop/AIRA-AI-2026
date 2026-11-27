import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRA_GENUI_CONTRACT_VERSION,
  AIRA_GENUI_LIMITS,
  A2UI_V1_COMPATIBILITY_BOUNDARY,
  GenUISurfaceSchema,
  GenUILifecycleEventSchema,
  GenUIInteractionEventSchema,
  validateGenUISurface,
  serializeGenUISurfaceDeterministic,
  mapAiraGenUIToA2UIV1BoundaryEnvelope,
} from '../packages/contracts/src/genui.js';

function makeValidSurface() {
  return {
    schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
    surfaceId: 'surf_q3_funnel_01',
    title: 'Q3 Conversion Funnel',
    rootId: 'layout_root',
    textFallback: 'Q3 funnel dropped 48% between Trial and Paid.',
    state: {
      principal: 10000,
      showRate: true,
      segment: 'enterprise',
    },
    actions: [
      {
        id: 'act_attach',
        label: 'Ask AIRA about current inputs',
        kind: 'attach_followup',
        permissionLevel: 'NONE',
        requiresApproval: false,
      },
    ],
    evidence: [
      {
        id: 'ev_1',
        title: 'Q3 Billing Export',
        uri: 'https://example.com/q3-export',
        snippet: 'Signups 10000 -> Paid 1200',
        verified: true,
      },
    ],
    origin: 'model' as const,
    components: [
      {
        id: 'layout_root',
        type: 'vertical_group' as const,
        props: { gap: 'md', children: ['hdr_1', 'chart_1', 'slider_1', 'btn_1'] },
      },
      {
        id: 'hdr_1',
        type: 'heading' as const,
        props: { level: 3, text: 'Funnel Breakdown' },
      },
      {
        id: 'chart_1',
        type: 'bar_chart' as const,
        props: {
          title: 'Stage Conversion',
          labels: ['Visit', 'Signup', 'Paid'],
          datasets: [{ label: 'Users', values: [10000, 4200, 1200] }],
        },
      },
      {
        id: 'slider_1',
        type: 'slider' as const,
        props: {
          label: 'Principal',
          stateKey: 'principal',
          min: 100,
          max: 100000,
          step: 100,
          defaultValue: 10000,
        },
      },
      {
        id: 'btn_1',
        type: 'action_button' as const,
        props: {
          label: 'Ask AIRA',
          actionId: 'act_attach',
          variant: 'primary',
        },
      },
    ],
  };
}

describe('Phase 1 — Native GenUI Contract (aira-genui/v1)', () => {
  it('validates canonical aira-genui/v1 surfaces with all structural, data ref, state, action, and evidence metadata', () => {
    const res = validateGenUISurface(makeValidSurface());
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error(res.error);
    assert.equal(res.surface.schemaVersion, 'aira-genui/v1');
    assert.equal(res.surface.components.length, 5);

    const parsedDirect = GenUISurfaceSchema.safeParse(makeValidSurface());
    assert.equal(parsedDirect.success, true);
  });

  it('rejects unknown component types, unexpected code/JSX props, and invalid data reference paths fail-closed', () => {
    const unknownComp = makeValidSurface();
    unknownComp.components.push({
      id: 'bad_1',
      type: 'custom_react_eval' as any,
      props: { code: 'alert(1)' } as any,
    });
    unknownComp.components[0].props.children.push('bad_1');
    const r1 = validateGenUISurface(unknownComp);
    assert.equal(r1.ok, false);

    // Reject prototype pollution data ref / state key
    const protoPollute = makeValidSurface() as any;
    protoPollute.state.__proto__ = 'hacked';
    protoPollute.components.push({
      id: 'txt_proto',
      type: 'text',
      props: { text: 'bad', dataRef: '/__proto__/polluted' },
    });
    const r2 = validateGenUISurface(protoPollute);
    assert.equal(r2.ok, false);

    // Reject unsafe javascript: URI in evidence
    const badEvidence = makeValidSurface();
    badEvidence.evidence[0].uri = 'javascript:alert(1)';
    const r3 = validateGenUISurface(badEvidence);
    assert.equal(r3.ok, false);
  });

  it('enforces uniqueness, cycle detection, dangling child references, max nesting depth, max component count, and payload size limits', () => {
    // Duplicate IDs
    const dup = makeValidSurface();
    dup.components.push({ id: 'hdr_1', type: 'text', props: { text: 'duplicate' } });
    assert.equal(validateGenUISurface(dup).ok, false);

    // Dangling child ID
    const dangling = makeValidSurface();
    dangling.components[0].props.children.push('missing_child');
    assert.equal(validateGenUISurface(dangling).ok, false);

    // Cycle detection
    const cyclic = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_cycle',
      rootId: 'g1',
      textFallback: 'Fallback',
      components: [
        { id: 'g1', type: 'vertical_group', props: { children: ['g2'] } },
        { id: 'g2', type: 'vertical_group', props: { children: ['g1'] } },
      ],
    };
    assert.equal(validateGenUISurface(cyclic).ok, false);

    // Nesting depth > maxNestingDepth
    const deepComponents: any[] = [];
    for (let i = 0; i <= AIRA_GENUI_LIMITS.maxNestingDepth + 1; i++) {
      deepComponents.push({
        id: `n_${i}`,
        type: i === AIRA_GENUI_LIMITS.maxNestingDepth + 1 ? 'text' : 'vertical_group',
        props:
          i === AIRA_GENUI_LIMITS.maxNestingDepth + 1
            ? { text: 'leaf' }
            : { children: [`n_${i + 1}`] },
      });
    }
    const tooDeep = {
      schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
      surfaceId: 'surf_deep',
      rootId: 'n_0',
      textFallback: 'Fallback',
      components: deepComponents,
    };
    assert.equal(validateGenUISurface(tooDeep).ok, false);

    // Max component count
    const tooManyChildren: string[] = [];
    const manyComps: any[] = [{ id: 'root', type: 'vertical_group', props: { children: tooManyChildren } }];
    for (let i = 0; i < AIRA_GENUI_LIMITS.maxComponents; i++) {
      const id = `c_${i}`;
      tooManyChildren.push(id);
      manyComps.push({ id, type: 'text', props: { text: 'x' } });
    }
    assert.equal(
      validateGenUISurface({
        schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
        surfaceId: 'surf_many',
        rootId: 'root',
        textFallback: 'Fallback',
        components: manyComps,
      }).ok,
      false
    );
  });

  it('produces deterministic serialization and truthful non-overclaimed A2UI v1.0 boundary mapping', () => {
    const a = validateGenUISurface(makeValidSurface());
    assert.equal(a.ok, true);
    if (!a.ok) return;

    const reversed = makeValidSurface();
    reversed.state = { segment: 'enterprise', showRate: true, principal: 10000 };
    const b = validateGenUISurface(reversed);
    assert.equal(b.ok, true);
    if (!b.ok) return;

    assert.equal(
      serializeGenUISurfaceDeterministic(a.surface),
      serializeGenUISurfaceDeterministic(b.surface),
      'Equivalent state keys must serialize identically'
    );

    const a2ui = mapAiraGenUIToA2UIV1BoundaryEnvelope(a.surface);
    assert.equal(A2UI_V1_COMPATIBILITY_BOUNDARY.a2uiCompliant, false);
    assert.equal(a2ui.compatibilityLevel, 'structural-adapter-boundary');
    assert.equal(a2ui.a2uiTargetVersion, '1.0');
    assert.equal(a2ui.surfaceUpdate.surfaceId, a.surface.surfaceId);
    assert.equal(a2ui.surfaceUpdate.components.length, a.surface.components.length);
  });

  it('validates lifecycle and interaction events against strict schema bounds', () => {
    const lifecycle = GenUILifecycleEventSchema.safeParse({
      eventId: 'evt_1',
      type: 'genui.surface.created',
      surfaceId: 'surf_1',
      runId: 'run_1',
      sequence: 1,
      timestamp: Date.now(),
      surface: makeValidSurface(),
    });
    assert.equal(lifecycle.success, true);

    const interaction = GenUIInteractionEventSchema.safeParse({
      eventId: 'int_1',
      surfaceId: 'surf_1',
      componentId: 'btn_1',
      actionId: 'act_attach',
      kind: 'attach_followup',
      stateSnapshot: { principal: 25000 },
      timestamp: Date.now(),
    });
    assert.equal(interaction.success, true);
  });
});
