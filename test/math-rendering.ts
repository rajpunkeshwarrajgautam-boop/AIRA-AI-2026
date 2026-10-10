import assert from 'node:assert/strict';
import { marked } from 'marked';
import '../src/utils/markdown.js';

// The markdown extension must render only mathematical content, not fenced code.
const display = String.raw'\[n_s = \frac{120f}{P}\]';
assert.match(String(marked.parse(display)), /class="katex-display"/);
assert.match(String(marked.parse(display)), /class="katex"/);
assert.match(String(marked.parse('$$\nE=mc^2\n$$')), /class="katex-display"/);
assert.match(String(marked.parse('$s = (n_s-n_r)/n_s$')), /class="katex"/);
assert.match(String(marked.parse(String.raw'\(J\frac{d\omega_r}{dt}\)')), /class="katex"/);

// Legacy model outputs use bare bracket pairs as display delimiters.
const legacy = String.raw`
[
n_s = \frac{120 f}{P}; \text{[rpm]}
]
`;
assert.match(String(marked.parse(legacy)), /class="katex-display"/);
assert.match(String(marked.parse(legacy)), /120/);

// Markdown/code blocks must not be parsed as executable TeX.
const fenced = '``' + String.raw'$E=mc^2$' + '``';
assert.doesNotMatch(String(marked.parse(fenced)), /class="katex"/);
assert.match(String(marked.parse(fenced)), /E=mc/);
assert.doesNotMatch(String(marked.parse('A [label](https://example.com)')), /class="katex"/);
assert.doesNotMatch(String(marked.parse('Plain paragraph [not math]')), /class="katex"/);

// KaTeX trust:false must not emit attacker-supplied HTML as executable markup.
const suspicious = String(marked.parse(String.raw'$\\htmlId{evil}{x}$'));
assert.doesNotMatch(suspicious, /id="evil"/);
console.log('PASS: inline, display, legacy brackets and code-safe math rendering');
