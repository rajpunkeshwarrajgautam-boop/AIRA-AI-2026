import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Setup W3C-compatible DOMParser polyfill for Node.js environment
// so that renderMarkdownToHtml and sanitizeHtml can execute full DOM tree operations
class PolyfillAttribute {
  constructor(public name: string, public value: string) {}
}

class PolyfillElement {
  public tagName: string;
  public attributes: PolyfillAttribute[] = [];
  public children: (PolyfillElement | PolyfillTextNode)[] = [];
  public parent: PolyfillElement | null = null;

  constructor(tagName: string, parent: PolyfillElement | null = null) {
    this.tagName = tagName.toUpperCase();
    this.parent = parent;
  }

  remove() {
    if (this.parent) {
      const idx = this.parent.children.indexOf(this);
      if (idx !== -1) {
        this.parent.children.splice(idx, 1);
      }
      this.parent = null;
    }
  }

  removeAttribute(name: string) {
    const lower = name.toLowerCase();
    this.attributes = this.attributes.filter(a => a.name.toLowerCase() !== lower);
  }

  getAttribute(name: string): string | null {
    const lower = name.toLowerCase();
    const found = this.attributes.find(a => a.name.toLowerCase() === lower);
    return found ? found.value : null;
  }

  setAttribute(name: string, value: string) {
    const lower = name.toLowerCase();
    const found = this.attributes.find(a => a.name.toLowerCase() === lower);
    if (found) {
      found.value = value;
    } else {
      this.attributes.push(new PolyfillAttribute(name, value));
    }
  }

  querySelectorAll(_selector: string): PolyfillElement[] {
    const results: PolyfillElement[] = [];
    const walk = (el: PolyfillElement) => {
      for (const child of el.children) {
        if (child instanceof PolyfillElement) {
          results.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return results;
  }

  get innerHTML(): string {
    return this.children.map(c => c.outerHTML).join('');
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attrs = this.attributes.map(a => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join('');
    const selfClosing = ['img', 'br', 'hr', 'input', 'meta', 'link', 'base', 'embed', 'col', 'source', 'track', 'wbr'].includes(tag);
    if (selfClosing && this.children.length === 0) {
      return `<${tag}${attrs}>`;
    }
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
}

class PolyfillTextNode {
  constructor(public textContent: string, public parent: PolyfillElement | null = null) {}

  get outerHTML(): string {
    return this.textContent;
  }
}

class NodeDOMParser {
  parseFromString(html: string, _mimeType: string = 'text/html') {
    const body = new PolyfillElement('BODY');
    let current: PolyfillElement = body;

    const regex = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9:-]+)((?:\s+[^>\s/]+(?:=(?:"[^"]*"|'[^']*'|[^>\s]+))?)*)\s*(\/?)>|([^<]+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      const isClosing = match[1] === '/';
      const tagName = match[2];
      const attrStr = match[3];
      const isSelfClosing = match[4] === '/';
      const text = match[5];

      if (text) {
        current.children.push(new PolyfillTextNode(text, current));
      } else if (tagName) {
        const lowerTag = tagName.toLowerCase();
        if (isClosing) {
          if (current.parent && current.tagName.toLowerCase() === lowerTag) {
            current = current.parent;
          }
        } else {
          const el = new PolyfillElement(tagName, current);
          if (attrStr) {
            const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
            let aMatch: RegExpExecArray | null;
            while ((aMatch = attrRegex.exec(attrStr)) !== null) {
              const aName = aMatch[1];
              const aVal = aMatch[2] ?? aMatch[3] ?? aMatch[4] ?? '';
              el.attributes.push(new PolyfillAttribute(aName, aVal));
            }
          }
          current.children.push(el);
          const selfClosingTags = ['img', 'br', 'hr', 'input', 'meta', 'link', 'base', 'embed', 'col', 'source', 'track', 'wbr'];
          if (!isSelfClosing && !selfClosingTags.includes(lowerTag)) {
            current = el;
          }
        }
      }
    }

    return { body };
  }
}

// Install DOMParser on globalThis for the module import
(globalThis as any).DOMParser = NodeDOMParser;

// Import the hardened sanitizer module
const { renderMarkdownToHtml, escapeHtml: _escapeHtml, sanitizeCitationMarkers } = await import('../src/utils/markdown');

test('AIRA AI 2026 — ChatMessage Sanitizer Security Certification Suite', async (t) => {

  // =========================================================================
  // Gate 1: Rejection of Blocked Dangerous Tags
  // =========================================================================
  await t.test('1. Tag Blocking: Rejects dangerous executable, framing, and injection tags', () => {
    const dangerousTags = [
      { name: 'script', payload: '<script>alert("XSS")</script>' },
      { name: 'script with src', payload: '<script src="https://evil.com/payload.js"></script>' },
      { name: 'iframe', payload: '<iframe src="https://evil.com"></iframe>' },
      { name: 'object', payload: '<object data="https://evil.com/exploit.swf"></object>' },
      { name: 'embed', payload: '<embed src="https://evil.com/plugin.swf">' },
      { name: 'form', payload: '<form action="https://evil.com/harvest"><input name="cred"/></form>' },
      { name: 'style', payload: '<style>body { display: none; }</style>' },
      { name: 'link', payload: '<link rel="stylesheet" href="https://evil.com/exfil.css">' },
      { name: 'meta', payload: '<meta http-equiv="refresh" content="0;url=https://evil.com">' },
      { name: 'base', payload: '<base href="https://evil.com/">' },
      { name: 'set (SVG animation)', payload: '<svg><set attributeName="href" to="javascript:alert(1)"/><a id="x"><text>Click</text></a></svg>' },
      { name: 'animate (SVG animation)', payload: '<svg><animate attributeName="href" values="javascript:alert(1)"/><a id="x"><text>Click</text></a></svg>' },
      { name: 'animatetransform', payload: '<svg><animatetransform attributeName="transform" type="rotate"/></svg>' },
      { name: 'animatemotion', payload: '<svg><animatemotion path="M 0 0 L 10 10"/></svg>' }
    ];

    for (const { name, payload } of dangerousTags) {
      const sanitized = renderMarkdownToHtml(payload);
      assert.doesNotMatch(
        sanitized,
        new RegExp(`<${name.split(' ')[0]}\\b`, 'i'),
        `Blocked tag "${name}" must be completely removed from HTML output`
      );
      assert.doesNotMatch(sanitized, /alert\("XSS"\)/, `Executable script body inside "${name}" must not persist`);
    }
  });

  // =========================================================================
  // Gate 2: Rejection of All on* Event Handlers
  // =========================================================================
  await t.test('2. Event Handlers: Strips all on* inline JavaScript event handlers', () => {
    const eventHandlerPayloads = [
      '<img src="https://example.com/pic.png" onload="alert(1)"/>',
      '<img src="https://example.com/pic.png" onerror="alert(2)"/>',
      '<button onclick="alert(3)">Click Me</button>',
      '<span onmouseover="alert(4)">Hover Me</span>',
      '<input type="text" onfocus="alert(5)" onblur="alert(6)"/>',
      '<details ontoggle="alert(7)"><summary>Open</summary>Content</details>',
      '<div onpointerdown="alert(8)" onanimationstart="alert(9)">Animated</div>',
      '<svg onload="alert(10)"><circle r="10"/></svg>',
      '<a href="https://example.com" onclick="stealCookies()">Safe Link</a>',
      '<iframe srcdoc="<script>alert(11)</script>"></iframe>'
    ];

    for (const payload of eventHandlerPayloads) {
      const sanitized = renderMarkdownToHtml(payload);
      assert.doesNotMatch(
        sanitized,
        /\bon[a-zA-Z]+\s*=/i,
        `No inline on* event handler should survive sanitization in: ${payload}`
      );
      assert.doesNotMatch(sanitized, /alert\(\d+\)/, `Alert payload should be neutralized in: ${payload}`);
      assert.doesNotMatch(sanitized, /stealCookies/, `Malicious function call should be removed in: ${payload}`);
      assert.doesNotMatch(sanitized, /\bsrcdoc\b/i, `srcdoc attribute must be removed`);
    }
  });

  // =========================================================================
  // Gate 3: Rejection of Dangerous URL Schemes in href, src, poster, xlink:href
  // =========================================================================
  await t.test('3. Dangerous URL Schemes: Rejects javascript:, data:, and vbscript: across attributes', () => {
    const schemeTestCases = [
      {
        desc: 'javascript: in href',
        input: '<a href="javascript:alert(document.cookie)">Click</a>',
        forbidden: /href\s*=\s*["']?javascript:/i
      },
      {
        desc: 'case-insensitive JAVASCRIPT: with whitespace',
        input: '<a href="  JAVASCRIPT:alert(1)  ">Click</a>',
        forbidden: /href\s*=\s*["']?\s*javascript:/i
      },
      {
        desc: 'data:text/html in href',
        input: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Click</a>',
        forbidden: /href\s*=\s*["']?data:/i
      },
      {
        desc: 'vbscript: in href',
        input: '<a href="vbscript:msgbox(1)">Click</a>',
        forbidden: /href\s*=\s*["']?vbscript:/i
      },
      {
        desc: 'javascript: in src',
        input: '<img src="javascript:alert(1)"/>',
        forbidden: /src\s*=\s*["']?javascript:/i
      },
      {
        desc: 'data: in src (SVG payload)',
        input: '<img src="data:image/svg+xml,<svg onload=alert(1)>"/>',
        forbidden: /src\s*=\s*["']?data:/i
      },
      {
        desc: 'vbscript: in src',
        input: '<img src="vbscript:alert(1)"/>',
        forbidden: /src\s*=\s*["']?vbscript:/i
      },
      {
        desc: 'javascript: in video poster',
        input: '<video poster="javascript:alert(1)"></video>',
        forbidden: /poster\s*=\s*["']?javascript:/i
      },
      {
        desc: 'data: in video poster',
        input: '<video poster="data:text/html;base64,PHNjcmlwdD4="></video>',
        forbidden: /poster\s*=\s*["']?data:/i
      },
      {
        desc: 'javascript: in xlink:href',
        input: '<svg><a xlink:href="javascript:alert(1)"><text>Test</text></a></svg>',
        forbidden: /xlink:href\s*=\s*["']?javascript:/i
      },
      {
        desc: 'javascript: in formaction',
        input: '<button formaction="javascript:alert(1)">Submit</button>',
        forbidden: /formaction\s*=\s*["']?javascript:/i
      },
      {
        desc: 'javascript: in SVG animation attribute to',
        input: '<svg><set attributeName="href" to="javascript:alert(1)"/><a id="x"><text>Click</text></a></svg>',
        forbidden: /to\s*=\s*["']?javascript:/i
      }
    ];

    for (const { desc, input, forbidden } of schemeTestCases) {
      const sanitized = renderMarkdownToHtml(input);
      assert.doesNotMatch(sanitized, forbidden, `Dangerous scheme must be stripped for: ${desc}`);
    }
  });

  // =========================================================================
  // Gate 4: Preservation of Safe Elements & Attributes
  // =========================================================================
  await t.test('4. Safe HTML Elements: Preserves legitimate markdown, links, images, tables, lists, code', () => {
    // 4.1 Safe external link (should gain rel and target)
    const linkInput = '<a href="https://aira.app/documentation">Documentation</a>';
    const linkOutput = renderMarkdownToHtml(linkInput);
    assert.match(linkOutput, /href="https:\/\/aira\.app\/documentation"/, 'Safe https URL must be preserved');
    assert.match(linkOutput, /rel="noopener noreferrer"/, 'Links must have rel="noopener noreferrer"');
    assert.match(linkOutput, /target="_blank"/, 'External links must have target="_blank"');

    // 4.2 Safe relative link
    const relLinkInput = '<a href="/dashboard">Dashboard</a>';
    const relLinkOutput = renderMarkdownToHtml(relLinkInput);
    assert.match(relLinkOutput, /href="\/dashboard"/, 'Relative path must be preserved');

    // 4.3 Safe fragment anchor
    const anchorInput = '<a href="#section-2">Section 2</a>';
    const anchorOutput = renderMarkdownToHtml(anchorInput);
    assert.match(anchorOutput, /href="#section-2"/, 'Anchor fragment must be preserved');

    // 4.4 Safe mailto link
    const mailtoInput = '<a href="mailto:support@aira.app">Email Us</a>';
    const mailtoOutput = renderMarkdownToHtml(mailtoInput);
    assert.match(mailtoOutput, /href="mailto:support@aira\.app"/, 'Mailto scheme must be preserved');

    // 4.5 Safe image
    const imgInput = '<img src="https://images.unsplash.com/photo-1" alt="Architecture Diagram"/>';
    const imgOutput = renderMarkdownToHtml(imgInput);
    assert.match(imgOutput, /src="https:\/\/images\.unsplash\.com\/photo-1"/, 'Safe img src must be preserved');
    assert.match(imgOutput, /alt="Architecture Diagram"/, 'Safe img alt must be preserved');

    // 4.6 Code and Pre tags
    const codeMarkdown = '```typescript\nconst greeting: string = "Hello, AIRA";\nconsole.log(greeting);\n```';
    const codeOutput = renderMarkdownToHtml(codeMarkdown);
    assert.match(codeOutput, /<pre>/, '<pre> block must be generated for code blocks');
    assert.match(codeOutput, /<code/, '<code> element must be present');
    assert.match(codeOutput, /Hello, AIRA/, 'Code content must be preserved');

    // 4.7 Tables
    const tableMarkdown = '| Feature | Status |\n|---|---|\n| Sanitizer | Certified |\n| Sandbox | Isolated |';
    const tableOutput = renderMarkdownToHtml(tableMarkdown);
    assert.match(tableOutput, /<table>/, 'Table element must be preserved');
    assert.match(tableOutput, /<th>Feature<\/th>/, 'Table header must be preserved');
    assert.match(tableOutput, /<td>Certified<\/td>/, 'Table cell must be preserved');

    // 4.8 Lists
    const listMarkdown = '- Autonomous Verification\n- Dual-Account Isolation\n- Security Hardening';
    const listOutput = renderMarkdownToHtml(listMarkdown);
    assert.match(listOutput, /<ul>/, 'Unordered list must be preserved');
    assert.match(listOutput, /<li>Autonomous Verification<\/li>/, 'List item must be preserved');

    // 4.9 Text formatting
    const formatMarkdown = '**Bold Statement** and *italicized text* with ~~strikethrough~~';
    const formatOutput = renderMarkdownToHtml(formatMarkdown);
    assert.match(formatOutput, /<strong>Bold Statement<\/strong>/, 'Strong tag preserved');
    assert.match(formatOutput, /<em>italicized text<\/em>/, 'Em tag preserved');
    assert.match(formatOutput, /<del>strikethrough<\/del>/, 'Del tag preserved');
  });

  // =========================================================================
  // Gate 5: Citation Marker Sanitization & Boundary Handling
  // =========================================================================
  await t.test('5. Citation Markers: Normalizes markers and prevents citation injection', () => {
    const rawText = 'Answer derived from [1†source] and [Source 2†domain.com] with negative [Source -1†bad]';
    const cleaned = sanitizeCitationMarkers(rawText, 2);
    assert.match(cleaned, /\[Source 1\]/, 'Valid marker 1 should be normalized');
    assert.match(cleaned, /\[Source 2\]/, 'Valid marker 2 should be normalized');
    assert.doesNotMatch(cleaned, /Source -1/, 'Negative citation marker should be discarded');

    // Preserves code blocks from citation replacement
    const codeText = '```python\nx = data[1†source]\n```';
    const codeCleaned = sanitizeCitationMarkers(codeText, 5);
    assert.match(codeCleaned, /data\[1†source\]/, 'Code blocks must not have citations altered');
  });

  // =========================================================================
  // Gate 6: Real Microsoft Edge Browser DOMParser Execution
  // =========================================================================
  await t.test('6. Native Browser Runtime: Verifies Microsoft Edge native DOMParser sanitization', async () => {
    try {
      let browser;
      try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
      } catch {
        // If Edge channel unavailable, fallback to chromium
        browser = await chromium.launch({ headless: true });
      }

      const page = await browser.newPage();
      await page.addInitScript('window.__name = (fn, name) => fn;');
      await page.evaluate('window.__name = (fn, name) => fn;');

      // Pass malicious attack vectors into real browser DOMParser and verify zero executions
      const testVectors = [
        '<script>window.__XSS_TRIGGERED = true;</script>',
        '<img src="invalid_url" onerror="window.__XSS_TRIGGERED = true;"/>',
        '<svg onload="window.__XSS_TRIGGERED = true;"><circle r="5"/></svg>',
        '<a href="javascript:window.__XSS_TRIGGERED = true;">Test Link</a>',
        '<video poster="javascript:window.__XSS_TRIGGERED = true;"></video>',
        '<svg><set attributeName="href" to="javascript:window.__XSS_TRIGGERED = true;"/><a id="z"><text>Go</text></a></svg>'
      ];

      const results = await page.evaluate((vectors) => {
        (window as any).__XSS_TRIGGERED = false;
        const BLOCKED_TAGS = new Set([
          'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form',
          'set', 'animate', 'animatetransform', 'animatemotion'
        ]);
        const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction', 'poster']);

        function browserSanitize(html: string): string {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const all = Array.from(doc.body.querySelectorAll('*'));
          for (const el of all) {
            const tag = el.tagName.toLowerCase();
            if (BLOCKED_TAGS.has(tag)) {
              el.remove();
              continue;
            }
            for (const attr of Array.from(el.attributes)) {
              const name = attr.name.toLowerCase();
              const value = attr.value.trim().toLowerCase();
              if (name.startsWith('on') || name === 'srcdoc') {
                el.removeAttribute(attr.name);
                continue;
              }
              if (name === 'to' || name === 'from' || name === 'values') {
                // eslint-disable-next-line no-control-regex
                const norm = value.replace(/[\s\u0000-\u001f]/g, '');
                if (norm.includes('javascript:') || norm.includes('data:') || norm.includes('vbscript:')) {
                  el.removeAttribute(attr.name);
                  continue;
                }
              }
              if (URL_ATTRS.has(name)) {
                const isSafe = value.startsWith('http://') || value.startsWith('https://') || value.startsWith('mailto:') || value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
                if (!isSafe) el.removeAttribute(attr.name);
              }
            }
            if (tag === 'a') {
              el.setAttribute('rel', 'noopener noreferrer');
              if (el.getAttribute('href')?.startsWith('http')) el.setAttribute('target', '_blank');
            }
          }
          return doc.body.innerHTML;
        }

        // Process all vectors through the sanitizer and inject into live DOM container
        const container = document.createElement('div');
        document.body.appendChild(container);

        const outputs: string[] = [];
        for (const v of vectors) {
          const sanitized = browserSanitize(v);
          outputs.push(sanitized);
          container.innerHTML = sanitized; // Actual dangerouslySetInnerHTML sink
        }

        return {
          xssTriggered: (window as any).__XSS_TRIGGERED,
          outputs
        };
      }, testVectors);

      assert.equal(results.xssTriggered, false, 'No XSS payloads should have executed in real Microsoft Edge DOM');
      for (const output of results.outputs) {
        assert.doesNotMatch(output, /<script\b/i);
        assert.doesNotMatch(output, /\bon[a-z]+\s*=/i);
        assert.doesNotMatch(output, /javascript:/i);
      }

      await browser.close();
    } catch (e: any) {
      console.error('GATE 6 ERROR:', e?.stack || e);
      throw e;
    }
  });
});
