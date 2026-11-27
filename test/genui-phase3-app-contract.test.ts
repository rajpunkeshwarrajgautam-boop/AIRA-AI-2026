/**
 * Phase 3 — Open Generative UI Application Contracts (aira-app/v1)
 * Validates canonical aira-app/v1 schemas, sandbox bridge protocol,
 * payload bounds, prototype protection, and lifecycle events.
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRA_GENUI_APP_CONTRACT_VERSION,
  GenUIAppSchema,
  GenUIAppTypeSchema,
  GenUIBridgeMessageSchema,
  validateGenUIApp,
  normalizeGenUIAppPayload,
  type GenUIApp,
  type GenUIBridgeMessage,
} from '../packages/contracts/src/index.js';

function makeValidApp(overrides?: Partial<GenUIApp>): GenUIApp {
  return {
    schemaVersion: AIRA_GENUI_APP_CONTRACT_VERSION,
    appId: 'app_pendulum_sim',
    appType: 'simulation',
    title: 'Double Pendulum Physics Simulation',
    description: 'Chaotic double pendulum simulation with interactive parameter controls.',
    html: '<canvas id="simCanvas" width="600" height="400"></canvas><div class="controls"><input id="len1" type="range" min="50" max="200" value="100"/></div>',
    css: 'body { margin: 0; background: #111; color: #fff; } canvas { display: block; margin: auto; }',
    javascript: 'const c = document.getElementById("simCanvas"); const ctx = c.getContext("2d");',
    libraries: [],
    initialState: { length1: 100, length2: 120, damping: 0.999 },
    actions: [
      { id: 'act_reset_sim', label: 'Reset Parameters', kind: 'local_recompute', permissionLevel: 'NONE', requiresApproval: false },
      { id: 'act_export_data', label: 'Export Phase Trajectory', kind: 'attach_followup', permissionLevel: 'NONE', requiresApproval: false },
    ],
    height: 520,
    allowResize: true,
    textFallback: 'Double pendulum interactive simulation with length and damping controls.',
    origin: 'model',
    presentationMode: 'sandboxed_app',
    generatedAt: Date.now(),
    ...overrides,
  };
}

describe('Phase 3 — Open Generative UI Application Contract (aira-app/v1)', () => {
  it('validates canonical aira-app/v1 application with all required and optional fields', () => {
    const app = makeValidApp();
    const result = validateGenUIApp(app);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.app.schemaVersion, 'aira-app/v1');
      assert.equal(result.app.appId, 'app_pendulum_sim');
      assert.equal(result.app.appType, 'simulation');
      assert.equal(result.app.height, 520);
      assert.equal(result.app.actions.length, 2);
      assert.equal(result.app.initialState.length1, 100);
    }
  });

  it('validates supported app types including d3_visualization and three_scene with libraries', () => {
    const d3App = makeValidApp({
      appId: 'app_net_graph',
      appType: 'd3_visualization',
      libraries: ['d3'],
      html: '<svg id="graphSvg"></svg>',
      javascript: 'const svg = d3.select("#graphSvg");',
    });
    assert.equal(validateGenUIApp(d3App).ok, true);

    const threeApp = makeValidApp({
      appId: 'app_spatial_mesh',
      appType: 'three_scene',
      libraries: ['three'],
      html: '<div id="container"></div>',
      javascript: 'const scene = new THREE.Scene();',
    });
    assert.equal(validateGenUIApp(threeApp).ok, true);
  });

  it('normalizes untrusted payloads with missing defaults and extra properties', () => {
    const raw = {
      appId: 'app_raw',
      title: 'Quick Chart',
      html: '<div id="chart"></div>',
      textFallback: 'Fallback text',
      extraGarbage: 12345,
    };
    const normalized = normalizeGenUIAppPayload(raw) as any;
    assert.equal(normalized.schemaVersion, AIRA_GENUI_APP_CONTRACT_VERSION);
    assert.equal(normalized.appType, 'html_application');
    assert.equal(normalized.height, 500);
    assert.deepEqual(normalized.actions, []);
    assert.deepEqual(normalized.initialState, {});
    assert.deepEqual(normalized.libraries, []);
    assert.equal(normalized.extraGarbage, undefined);

    const validation = validateGenUIApp(raw);
    assert.equal(validation.ok, true);
  });

  it('rejects prototype manipulation keys fail-closed', () => {
    const maliciousPayload = JSON.parse('{"schemaVersion":"aira-app/v1","appId":"app_bad","appType":"html_application","title":"Exploit","html":"<div></div>","textFallback":"t","__proto__":{"polluted":true}}');
    const result = validateGenUIApp(maliciousPayload);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'GENUI_FORBIDDEN_KEY');
    }
  });

  it('enforces payload size bounds on HTML, CSS, JS and total payload', () => {
    const hugeHtml = 'a'.repeat(600 * 1024);
    const hugeApp = makeValidApp({ html: hugeHtml });
    const result = validateGenUIApp(hugeApp);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.code === 'GENUI_PAYLOAD_TOO_LARGE' || result.code === 'GENUI_SCHEMA_INVALID');
    }
  });

  it('validates bidirectional bridge message protocol with cryptographic nonce', () => {
    const validInit: GenUIBridgeMessage = {
      type: 'GENUI_APP_INIT',
      nonce: 'nonce_secret_12345678',
      appId: 'app_pendulum_sim',
      payload: { theme: 'dark', initialState: { len1: 100 } },
      timestamp: Date.now(),
    };
    const parsedInit = GenUIBridgeMessageSchema.safeParse(validInit);
    assert.equal(parsedInit.success, true);

    const validAction: GenUIBridgeMessage = {
      type: 'GENUI_APP_ACTION',
      nonce: 'nonce_secret_12345678',
      appId: 'app_pendulum_sim',
      payload: { actionId: 'act_reset_sim', stateSnapshot: { len1: 100 } },
      timestamp: Date.now(),
    };
    const parsedAction = GenUIBridgeMessageSchema.safeParse(validAction);
    assert.equal(parsedAction.success, true);

    // Invalid message type rejected
    const invalidType = {
      type: 'UNAUTHORIZED_MESSAGE_TYPE',
      nonce: 'nonce_secret_12345678',
      appId: 'app_pendulum_sim',
      payload: {},
    };
    assert.equal(GenUIBridgeMessageSchema.safeParse(invalidType).success, false);

    // Short/missing nonce rejected
    const badNonce = {
      type: 'GENUI_APP_RESIZE',
      nonce: 'short',
      appId: 'app_pendulum_sim',
      payload: { height: 600 },
    };
    assert.equal(GenUIBridgeMessageSchema.safeParse(badNonce).success, false);
  });
});
