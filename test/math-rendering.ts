import assert from 'node:assert/strict';
import { marked } from 'marked';
import '../src/utils/markdown.js';

// Math expressions render, while code and prose remain unchanged.
const display = String.raw`\[n_s = \frac{120f}{P}\]`;
assert.match(String(marked.parse(display)), /katex-display/);
assert.match(String(marked.parse(display)), /class="katex"/);
assert.match(String(marked.parse('$$\nE=mc^2\n$$')), /katex-display/);
assert.match(String(marked.parse('$s = (n_s-n_r)/n_s$')), /class="katex"/);
assert.match(String(marked.parse(String.raw`\(J\frac{d\omega_r}{dt}\)`)), /class="katex"/);

// Some old provider responses emit standalone bracket lines instead of TeX delimiters.
const legacy = String.raw`
[
n_s = \frac{120 f}{P}; \text{[rpm]}
]
`;
assert.match(String(marked.parse(legacy)), /katex-display/);

const fenced = '```text\n$E=mc^2$\n```';
assert.doesNotMatch(String(marked.parse(fenced)), /class="katex"/);
assert.match(String(marked.parse(fenced)), /E=mc/);
assert.doesNotMatch(String(marked.parse('A [label](https://example.com)')), /class="katex"/);
assert.doesNotMatch(String(marked.parse('Plain paragraph [not math]')), /class="katex"/);

// Even a KaTeX HTML macro cannot inject untrusted attributes with trust:false.
const suspicious = String(marked.parse(String.raw`$\htmlId{evil}{x}$`));
assert.doesNotMatch(suspicious, /id="evil"/);
console.log('PASS: inline, display, legacy brackets, code-safe and untrusted math rendering');
