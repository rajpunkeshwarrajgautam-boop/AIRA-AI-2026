import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ModelRouter,
  OpenAIAdapter,
  ProviderHealthTracker,
  resolveNvidiaModel,
  isRetiredNvidiaModel,
} from '../packages/model-router/src/index.js';
import {
  normalizeModelIdentifier,
  VERIFIED_MODEL_REGISTRY,
  VERIFIED_PLAN_MODEL_ALLOWLIST,
  COMMERCIAL_PLANS,
} from '../packages/contracts/src/index.js';
import { AVAILABLE_MODELS, normalizeCanonicalModelId } from '../src/utils/constants.js';
import { normalizeStoredModelId } from '../src/utils/storage.js';
import { PresentationRouter } from '../packages/agent-runtime/src/presentation-router.js';
import { renderSafeMarkdownHtml } from '../src/utils/sandboxSecurity.js';
import { generateArtifactSandboxHtml, ARTIFACT_STRICT_STATIC_CSP_META_TAG } from '../src/utils/artifactSandbox.js';
import { generateMultiFileArtifactSandboxHtml } from '../src/utils/multiFileSandbox.js';
import type { Artifact } from '../src/types/index.js';
import type { MultiFileArtifactBundle } from '../src/types/multiFileArtifact.js';

describe('Foundation Remediation (Section 3A, 3B, 3C)', () => {
  it('3A: eliminates retired nvidia/llama-3.1-nemotron-70b-instruct from active registry, fallback chains, and env overrides while preserving capability tiers', () => {
    const retired = [
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'meta/llama-3.1-405b-instruct',
      'nvidia/nemotron-3-super-120b-a12b',
    ];

    for (const id of retired) {
      assert.equal(isRetiredNvidiaModel(id), true, `${id} must be marked retired`);
      assert.equal(AVAILABLE_MODELS.some(m => m.id === id), false, `Retired ${id} must not be selectable in UI`);
      assert.equal(Object.hasOwn(VERIFIED_MODEL_REGISTRY, id), false, `Retired ${id} must not be in active registry`);
      for (const tier of ['guest', 'free', 'plus', 'pro'] as const) {
        assert.equal(VERIFIED_PLAN_MODEL_ALLOWLIST[tier].includes(id), false, `Retired ${id} must not be in ${tier} allowlist`);
      }
    }

    // Legacy IDs migrate deterministically to active Nemotron 3.5 Lightning
    assert.equal(normalizeModelIdentifier('nvidia/llama-3.1-nemotron-70b-instruct'), 'nvidia/nemotron-3.5-lightning-30b-a3b');
    assert.equal(normalizeCanonicalModelId('nvidia/llama-3.1-nemotron-70b-instruct'), 'nvidia/nemotron-3.5-lightning-30b-a3b');
    assert.equal(normalizeStoredModelId('nvidia/llama-3.1-nemotron-70b-instruct'), 'nvidia/nemotron-3.5-lightning-30b-a3b');

    const savedEnv = { ...process.env };
    try {
      delete process.env.NVIDIA_DEFAULT_MODEL;
      delete process.env.NVIDIA_FAST_MODEL;
      delete process.env.NVIDIA_DEEP_MODEL;

      // Capability distinctions preserved
      assert.equal(resolveNvidiaModel('aira-fast'), 'nvidia/nemotron-3.5-bolt-e4b');
      assert.equal(resolveNvidiaModel('aira-pro'), 'nvidia/nemotron-3.5-lightning-30b-a3b');
      assert.equal(resolveNvidiaModel('aira-auto'), 'nvidia/nemotron-3.5-lightning-30b-a3b');
      assert.equal(resolveNvidiaModel('aira-deep'), 'nvidia/nemotron-3.5-super-vl-120b-a12b');
      assert.equal(resolveNvidiaModel('nvidia/llama-3.1-nemotron-70b-instruct'), 'nvidia/nemotron-3.5-lightning-30b-a3b');

      // Misconfigured env vars pointing to retired models must NOT enter active fallback chains
      process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';
      process.env.NVIDIA_FAST_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';
      process.env.NVIDIA_DEEP_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

      assert.equal(isRetiredNvidiaModel(resolveNvidiaModel('aira-fast')), false);
      assert.equal(isRetiredNvidiaModel(resolveNvidiaModel('aira-pro')), false);
      assert.equal(isRetiredNvidiaModel(resolveNvidiaModel('aira-deep')), false);
      assert.equal(isRetiredNvidiaModel(resolveNvidiaModel('unknown-fallback')), false);

      // Commercial pricing & entitlement boundaries remain unchanged
      assert.deepEqual(COMMERCIAL_PLANS.plus.pricing, { INR: 399, USD: 7.99 });
      assert.deepEqual(COMMERCIAL_PLANS.pro.pricing, { INR: 999, USD: 19.99 });
      assert.equal(VERIFIED_PLAN_MODEL_ALLOWLIST.guest.includes('nvidia/nemotron-3.5-lightning-30b-a3b'), false);
      assert.equal(VERIFIED_PLAN_MODEL_ALLOWLIST.free.includes('nvidia/nemotron-3.5-lightning-30b-a3b'), false);
      assert.equal(VERIFIED_PLAN_MODEL_ALLOWLIST.plus.includes('nvidia/nemotron-3.5-lightning-30b-a3b'), true);
      assert.equal(VERIFIED_PLAN_MODEL_ALLOWLIST.pro.includes('nvidia/nemotron-3.5-lightning-30b-a3b'), true);
    } finally {
      process.env = savedEnv;
    }
  });

  it('3A: HTTP 410 Gone is classified as non-retryable and immediately trips circuit breaker', async () => {
    const tracker = new ProviderHealthTracker();
    const adapter = new OpenAIAdapter(
      'mock-nv-key',
      'https://integrate.api.nvidia.com/v1',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia'
    );

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      // Include misleading "500" and "429" substrings inside body to verify status-based non-retryable guard
      return new Response(JSON.stringify({ status: 410, detail: 'EOL since 2026-11-15 (ref 429-500)' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      let caught: any;
      try {
        await adapter.complete(
          [{ role: 'user', content: 'Hello' }],
          { model: 'aira-pro', maxTokens: 64, temperature: 0, extendedThinking: false, timeoutMs: 5000 }
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'HTTP 410 must reject');
      assert.equal(fetchCount, 1, 'HTTP 410 must NOT be retried');
      assert.equal(caught.status, 410);
      assert.equal(caught.nonRetryable, true);

      tracker.recordFailure('nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct', caught, 410);
      assert.equal(
        tracker.getCircuitState('nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct'),
        'OPEN',
        'HTTP 410 must immediately trip circuit breaker to OPEN'
      );
      assert.equal(tracker.isAvailable('nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('3B: PresentationRouter uses non-reasoning fast classifier policy with structured JSON responseFormat and disableThinking', async () => {
    const savedEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    const capturedBodies: any[] = [];

    try {
      delete process.env.GROQ_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.NVIDIA_API_KEY = 'nv-mock-key';

      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        capturedBodies.push(body);
        return new Response(JSON.stringify({
          model: body.model,
          choices: [{
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                mode: 'native_visualization',
                confidence: 0.92,
                reason: 'Numbers benefit from a comparison chart.',
              }),
            },
          }],
          usage: { prompt_tokens: 72, completion_tokens: 24, total_tokens: 96 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;

      const modelRouter = new ModelRouter();
      const router = new PresentationRouter(modelRouter);
      const decision = await router.route({
        prompt: 'Look at regional retention: North 72%, South 64%, East 81%, West 59%. Help executives digest this quickly.',
      });

      assert.equal(decision.source, 'model');
      assert.equal(decision.mode, 'native_visualization');
      assert.equal(decision.degradedToFallback, false);
      assert.equal(decision.invalidStructuredOutput, false);
      assert.equal(capturedBodies.length, 1);

      const reqBody = capturedBodies[0];
      assert.equal(reqBody.model, 'nvidia/nemotron-3.5-bolt-e4b');
      assert.ok(reqBody.response_format, 'Classifier request must pass structured response_format');
      assert.equal(reqBody.chat_template_kwargs?.enable_thinking, false, 'NVIDIA classifier must disable thinking tokens');
      assert.ok(reqBody.max_tokens <= 180, 'Classifier max_tokens must stay tightly bounded');
    } finally {
      globalThis.fetch = originalFetch;
      process.env = savedEnv;
    }
  });

  it('3C: Markdown preview supports GFM tables and blockquotes safely while UnifiedWorkspace respects dark theme', () => {
    const mdHtml = renderSafeMarkdownHtml(
      '# Quarterly Report\n\n> Verified summary\n\n| Tier | Price |\n| --- | --- |\n| Plus | ₹399 |\n\n1. First item\n2. Second item\n\n<script>alert(1)</script>'
    );
    assert.ok(mdHtml.includes('<table>'), 'Markdown preview must render tables');
    assert.ok(mdHtml.includes('<th>Tier</th>'), 'Markdown preview must render table headers');
    assert.ok(mdHtml.includes('<td>Plus</td>'), 'Markdown preview must render table cells');
    assert.ok(mdHtml.includes('<blockquote>'), 'Markdown preview must render blockquotes');
    assert.ok(mdHtml.includes('<ol>'), 'Markdown preview must render ordered lists');
    assert.equal(/<script/i.test(mdHtml), false, 'XSS script tags must remain escaped/blocked');

    const uwSource = fs.readFileSync('src/components/UnifiedWorkspace.tsx', 'utf8');
    assert.equal(
      /generateArtifactSandboxHtml\(artifact,\s*currentContent,\s*false,\s*activeNonce\)/.test(uwSource),
      false,
      'UnifiedWorkspace must not hardcode isDark=false for artifact preview'
    );
  });

  it('3C: assesses SVG, Mermaid, React, HTML, Multi-File, and Revision/Reopen artifact behavior under strict containment', () => {
    const nonce = 'nonce_sec_3c_check';

    // SVG preview renders sanitized SVG directly without script-src unsafe-eval
    const svgArt: Artifact = {
      id: 'art_svg',
      title: 'Metric Ring',
      type: 'image/svg+xml',
      content: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" onload="alert(1)"/></svg>',
      version: 2,
      versions: [
        { version: 1, content: '<svg viewBox="0 0 10 10"></svg>', timestamp: 1000 },
        { version: 2, content: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" onload="alert(1)"/></svg>', timestamp: 2000 },
      ],
      createdAt: 1000,
    };
    const svgDoc = generateArtifactSandboxHtml(svgArt, svgArt.versions![1].content, true, nonce);
    assert.ok(svgDoc.includes(ARTIFACT_STRICT_STATIC_CSP_META_TAG));
    assert.ok(svgDoc.includes('<circle'));
    assert.equal(svgDoc.includes('onload='), false);

    // Mermaid & React explicitly surface safe static/source containment without claiming live script execution
    const mermaidArt: Artifact = {
      id: 'art_mmd',
      title: 'Architecture Flow',
      type: 'application/vnd.ant.mermaid',
      content: 'graph TD; A-->B;',
      version: 1,
      versions: [{ version: 1, content: 'graph TD; A-->B;', timestamp: 1000 }],
      createdAt: 1000,
    };
    const mmdDoc = generateArtifactSandboxHtml(mermaidArt, mermaidArt.content, false, nonce);
    assert.ok(mmdDoc.includes("script-src 'none'"));
    assert.ok(mmdDoc.includes('Mermaid Source (Static Containment)'));
    assert.ok(mmdDoc.includes('graph TD; A--&gt;B;') || mmdDoc.includes('graph TD; A-->B;'));

    const reactArt: Artifact = {
      id: 'art_react',
      title: 'Widget Component',
      type: 'application/vnd.ant.react',
      language: 'tsx',
      content: 'export default function Widget() { return <div>OK</div>; }',
      version: 1,
      versions: [{ version: 1, content: 'export default function Widget() { return <div>OK</div>; }', timestamp: 1000 }],
      createdAt: 1000,
    };
    const reactDoc = generateArtifactSandboxHtml(reactArt, reactArt.content, false, nonce);
    assert.ok(reactDoc.includes("script-src 'none'"));
    assert.ok(reactDoc.includes('Static Containment Preview'));
    assert.equal(reactDoc.includes('unsafe-eval'), false);

    // HTML preview still runs sandboxed (allow-scripts without allow-same-origin) with CSP
    const htmlArt: Artifact = {
      id: 'art_html',
      title: 'Dashboard HTML',
      type: 'text/html',
      content: '<html><body><main id="app">Ready</main></body></html>',
      version: 1,
      versions: [{ version: 1, content: '<html><body><main id="app">Ready</main></body></html>', timestamp: 1000 }],
      createdAt: 1000,
    };
    const htmlDoc = generateArtifactSandboxHtml(htmlArt, htmlArt.content, true, nonce);
    assert.ok(htmlDoc.includes('Ready'));
    assert.ok(htmlDoc.includes("connect-src 'none'"));
    assert.ok(htmlDoc.includes(nonce));

    // Multi-file bundle strips external CDNs and injects CSP cleanly
    const bundle: MultiFileArtifactBundle = {
      id: 'bundle_1',
      title: 'Multi-file Test',
      entryPoint: 'index.html',
      files: {
        'index.html': {
          id: 'f_html',
          path: 'index.html',
          name: 'index.html',
          kind: 'html',
          content: '<!doctype html><html><head><script src="https://cdn.evil.test/lib.js"></script></head><body><h1>App</h1></body></html>',
          sizeBytes: 112,
          lastModified: 1000,
          version: 1,
        },
        'app.js': {
          id: 'f_js',
          path: 'app.js',
          name: 'app.js',
          kind: 'javascript',
          content: 'console.log("loaded");',
          sizeBytes: 22,
          lastModified: 1000,
          version: 1,
        },
      },
      manifest: {
        manifestVersion: '1.0.0',
        projectId: 'bundle_1',
        title: 'Multi-file Test',
        entryPoint: 'index.html',
        createdAt: 1000,
        updatedAt: 1000,
        files: [],
      },
      dependencies: [],
    };
    const mfDoc = generateMultiFileArtifactSandboxHtml(bundle, true, nonce);
    assert.ok(mfDoc.includes("connect-src 'none'"));
    assert.equal(mfDoc.includes('cdn.evil.test'), false);
    assert.ok(mfDoc.includes('<h1>App</h1>'));

    // Revision selection: version 1 vs version 2 renders distinct selected content reliably
    const rev1Doc = generateArtifactSandboxHtml(svgArt, svgArt.versions![0].content, false, nonce);
    const rev2Doc = generateArtifactSandboxHtml(svgArt, svgArt.versions![1].content, false, nonce);
    assert.notEqual(rev1Doc, rev2Doc);
    assert.ok(rev2Doc.includes('r="40"'));
  });
});
