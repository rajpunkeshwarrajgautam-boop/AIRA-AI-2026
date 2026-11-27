import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_CSP_META_TAG,
  ARTIFACT_REACT_CSP_META_TAG,
  ARTIFACT_STRICT_STATIC_CSP_META_TAG,
  generateArtifactSandboxHtml,
  safeJsonStringifyForHtmlScript,
  sanitizeSvgMarkup,
  renderSafeMarkdownHtml,
} from '../src/utils/artifactSandbox.js';
import {
  SANDBOX_LIMITS,
  validateSandboxBridgeMessage,
  acquireSandboxSlot,
  releaseSandboxSlot,
  getActiveSandboxCount,
  sandboxAttributesForType,
} from '../src/utils/sandboxSecurity.js';
import { generateMultiFileArtifactSandboxHtml } from '../src/utils/multiFileSandbox.js';
import type { Artifact } from '../src/types.js';

describe('Section 8 — Artifact Sandbox Security Gate (AppSec TDD)', () => {
  const nonce = 'appsec_nonce_99887766';

  it('A. safeJsonStringifyForHtmlScript blocks </script> breakout and HTML comment injection', () => {
    const evil = 'const x = "</script><script>alert(document.cookie)</script><!--";';
    const serialized = safeJsonStringifyForHtmlScript(evil);
    assert.equal(serialized.includes('</script>'), false);
    assert.equal(serialized.includes('<script>'), false);
    assert.equal(serialized.includes('<!--'), false);
    assert.equal(JSON.parse(serialized), evil);
  });

  it('B & E. authoritative CSP eliminates floating external CDNs, eliminates unsafe-eval, and ignores fake CSP substrings in model HTML', () => {
    for (const csp of [ARTIFACT_CSP_META_TAG, ARTIFACT_STRICT_STATIC_CSP_META_TAG, ARTIFACT_REACT_CSP_META_TAG]) {
      assert.equal(csp.includes('unsafe-eval'), false, `CSP must NEVER include unsafe-eval: ${csp}`);
      assert.equal(csp.includes('cdn.tailwindcss.com'), false);
      assert.equal(csp.includes('unpkg.com'), false);
      assert.equal(csp.includes('cdn.jsdelivr.net'), false);
      assert.equal(csp.includes('cdnjs.cloudflare.com'), false);
      assert.ok(csp.includes("connect-src 'none'"));
      assert.ok(csp.includes("object-src 'none'"));
      assert.ok(csp.includes("base-uri 'none'"));
      assert.ok(csp.includes("form-action 'none'"));
    }
    assert.ok(ARTIFACT_STRICT_STATIC_CSP_META_TAG.includes("script-src 'none'"), 'Static/SVG/Markdown CSP must disable all script execution');

    // Spoofed CSP inside comment + malicious <meta http-equiv="Content-Security-Policy"> + external script
    const spoofedHtml: Artifact = {
      id: 'evil_csp',
      title: 'Bypass Attempt',
      type: 'text/html',
      content: `<!-- Content-Security-Policy -->
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-eval'">
  <base href="https://attacker.invalid/">
  <script src="https://evil.invalid/steal.js"></script>
</head>
<body><p>Hello</p></body>`,
      version: 1,
      versions: [],
    };
    const rendered = generateArtifactSandboxHtml(spoofedHtml, spoofedHtml.content, false, nonce);
    assert.ok(rendered.includes(ARTIFACT_CSP_META_TAG), 'Authoritative CSP must always be injected');
    assert.equal(rendered.includes('attacker.invalid'), false, 'Untrusted <base> tag must be stripped');
    assert.equal(rendered.includes('evil.invalid'), false, 'External script src must be stripped');
    assert.equal(rendered.includes("default-src * 'unsafe-eval'"), false, 'Model-supplied CSP meta tag must be stripped');
  });

  it('C & D. Markdown & SVG render without unsafe-inline scripts and strip XSS vectors (script, onload, javascript: URI)', () => {
    const maliciousSvg: Artifact = {
      id: 'evil_svg',
      title: 'Malicious SVG',
      type: 'image/svg+xml',
      content: '<svg onload="alert(1)" viewBox="0 0 100 100"><script>fetch("https://evil.invalid")</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(2)"><circle cx="50" cy="50" r="10"/></a></svg>',
      version: 1,
      versions: [],
    };
    const cleanSvg = sanitizeSvgMarkup(maliciousSvg.content);
    assert.equal(/onload\s*=/i.test(cleanSvg), false);
    assert.equal(/<script/i.test(cleanSvg), false);
    assert.equal(/<foreignObject/i.test(cleanSvg), false);
    assert.equal(/javascript:/i.test(cleanSvg), false);

    const renderedSvgDoc = generateArtifactSandboxHtml(maliciousSvg, maliciousSvg.content, false, nonce);
    assert.ok(renderedSvgDoc.includes("script-src 'none'"));
    assert.equal(/<script/i.test(renderedSvgDoc), false, 'SVG document must contain zero <script> tags');

    const maliciousMd: Artifact = {
      id: 'evil_md',
      title: 'Malicious Markdown',
      type: 'text/markdown',
      content: '# Safe Heading\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>\n\n[Click](javascript:alert(3)) and [Docs](https://example.com)',
      version: 1,
      versions: [],
    };
    const safeBody = renderSafeMarkdownHtml(maliciousMd.content);
    assert.equal(/<script/i.test(safeBody), false);
    assert.equal(/<img/i.test(safeBody), false);
    assert.equal(/<[^>]*\bonerror\s*=/i.test(safeBody), false);
    assert.equal(/href\s*=\s*["']\s*javascript:/i.test(safeBody), false);
    assert.ok(safeBody.includes('Safe Heading'));
    assert.ok(safeBody.includes('https://example.com'));

    const renderedMdDoc = generateArtifactSandboxHtml(maliciousMd, maliciousMd.content, false, nonce);
    assert.ok(renderedMdDoc.includes("script-src 'none'"));
    assert.equal(/<script/i.test(renderedMdDoc), false);

    // Unsupported/unpinned React JSX runtime is safely disabled rather than loading external Babel + unsafe-eval
    const reactArtifact: Artifact = {
      id: 'react_disabled',
      title: 'React Widget',
      type: 'application/vnd.ant.react',
      language: 'tsx',
      content: 'export default function App() { return <div>Hi</div>; }',
      version: 1,
      versions: [],
    };
    const renderedReact = generateArtifactSandboxHtml(reactArtifact, reactArtifact.content, false, nonce);
    assert.ok(renderedReact.includes("script-src 'none'"));
    assert.equal(renderedReact.includes('unsafe-eval'), false);
    assert.equal(renderedReact.includes('babel.min.js'), false);
  });

  it('D2. multiFileSandbox strips external CDNs, escapes script context, and injects authoritative CSP', () => {
    const rendered = generateMultiFileArtifactSandboxHtml(
      {
        id: 'mf_sec',
        title: 'MultiFile',
        entryPoint: 'index.html',
        files: {
          'index.html': {
            path: 'index.html',
            kind: 'html',
            isEntry: true,
            lastModified: 1,
            content: '<head><base href="https://evil.invalid/"><script src="https://evil.invalid/x.js"></script></head><body>Hi</body>',
          },
        },
      },
      false,
      nonce
    );
    assert.ok(rendered.includes(ARTIFACT_CSP_META_TAG));
    assert.equal(rendered.includes('cdn.tailwindcss.com'), false);
    assert.equal(rendered.includes('evil.invalid'), false);
  });

  it('F. enforces resource limits (oversized truncation / rejection, sandbox attributes, and concurrent sandbox cap)', () => {
    const huge = '<div>' + 'A'.repeat(SANDBOX_LIMITS.maxContentBytes + 5000) + '</div>';
    const htmlArtifact: Artifact = {
      id: 'huge_1',
      title: 'Oversized App',
      type: 'text/html',
      content: huge,
      version: 1,
      versions: [],
    };
    const rendered = generateArtifactSandboxHtml(htmlArtifact, huge, false, nonce);
    assert.ok(rendered.includes('SANDBOX_CONTENT_LIMIT_EXCEEDED'));
    assert.equal(rendered.length < 4096, true);

    assert.equal(sandboxAttributesForType('image/svg+xml'), '');
    assert.equal(sandboxAttributesForType('text/markdown'), '');
    assert.equal(sandboxAttributesForType('text/html'), 'allow-scripts allow-forms');

    const slotA = acquireSandboxSlot('inst_a');
    const slotB = acquireSandboxSlot('inst_b');
    const slotC = acquireSandboxSlot('inst_c');
    assert.equal(slotA, true);
    assert.equal(slotB, true);
    assert.equal(slotC, false, 'Concurrent sandbox slots must be capped');
    releaseSandboxSlot('inst_a');
    releaseSandboxSlot('inst_b');
    assert.equal(getActiveSandboxCount(), 0);
  });

  it('G. host bridge validator strictly enforces source, opaque origin, nonce, allowed action, and payload size limit', () => {
    const fakeSource = {} as Window;
    const valid = validateSandboxBridgeMessage(
      {
        source: fakeSource,
        origin: 'null',
        data: { type: 'CONSOLE_LOG', level: 'info', message: 'ok', nonce },
      },
      fakeSource,
      nonce
    );
    assert.equal(valid.accepted, true);

    const badAction = validateSandboxBridgeMessage(
      {
        source: fakeSource,
        origin: 'null',
        data: { type: 'EXECUTE_HOST_COMMAND', cmd: 'rm -rf /', nonce },
      },
      fakeSource,
      nonce
    );
    assert.equal(badAction.accepted, false);

    const badOrigin = validateSandboxBridgeMessage(
      {
        source: fakeSource,
        origin: 'https://evil.invalid',
        data: { type: 'CONSOLE_LOG', level: 'info', message: 'hi', nonce },
      },
      fakeSource,
      nonce
    );
    assert.equal(badOrigin.accepted, false);

    const oversized = validateSandboxBridgeMessage(
      {
        source: fakeSource,
        origin: 'null',
        data: { type: 'CONSOLE_LOG', level: 'info', message: 'X'.repeat(20000), nonce },
      },
      fakeSource,
      nonce
    );
    assert.equal(oversized.accepted, false);
  });
});
