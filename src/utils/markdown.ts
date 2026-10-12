import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

import katex from 'katex';

function renderMath(expression: string, displayMode: boolean): string {
  return katex.renderToString(expression.trim(), {
    displayMode,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    output: 'htmlAndMathml'
  });
}

// Math is tokenized by Marked, so fenced/inline code remains literal.
// Supports TeX \[...\], \(...\), $...$, $...$,
// and legacy model output with a lone [ / ] on separate lines.
marked.use({
  extensions: [
    {
      name: 'airaMathBlock',
      level: 'block',
      start(src: string) {
        const match = src.search(/\\\[|\$\$|(?:^|\n)[ \t]*\[[ \t]*(?:\r?\n)/);
        return match < 0 ? undefined : match;
      },
      tokenizer(src: string) {
        const normalBracket = src.match(/^ {0,3}\[\s*\r?\n([\s\S]+?)\r?\n {0,3}\][ \t]*(?:\r?\n|$)/);
        const explicit = src.match(/^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\r?\n|$)/);
        const dollar = src.match(/^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\r?\n|$)/);
        const chosen = explicit || dollar || (
          normalBracket && /\\[a-zA-Z]+|[=^_]/.test(normalBracket[1])
            ? normalBracket : null
        );
        if (!chosen) return undefined;
        return { type: 'airaMathBlock', raw: chosen[0], text: chosen[1] };
      },
      renderer(token) {
        return '<div class="aira-math-block">' + renderMath(token.text, true) + '</div>\n';
      }
    },
    {
      // A TeX display expression may appear inside a normal sentence.
      // The block-level tokenizer cannot see these because Marked treats
      // the surrounding sentence as a paragraph.
      name: 'airaMathEmbeddedDisplay',
      level: 'inline',
      start(src: string) {
        const index = src.indexOf('\u005c[');
        return index < 0 ? undefined : index;
      },
      tokenizer(src: string) {
        const match = src.match(/^\\\[([\s\S]+?)\\\]/);
        if (!match || !match[1].trim()) return undefined;
        return { type: 'airaMathEmbeddedDisplay', raw: match[0], text: match[1] };
      },
      renderer(token) {
        return '<span class="aira-math-embedded">' + renderMath(token.text, true) + '</span>';
      }
    },

    {
      name: 'airaMathInline',
      level: 'inline',
      start(src: string) {
        const match = src.search(/\\\(|\$/);
        return match < 0 ? undefined : match;
      },
      tokenizer(src: string) {
        const explicit = src.match(/^\\\((.+?)\\\)/s);
        const dollar = src.match(/^\$([^\r\n$]+?)\$(?!\$)/);
        const chosen = explicit || dollar;
        if (!chosen || !chosen[1].trim()) return undefined;
        return { type: 'airaMathInline', raw: chosen[0], text: chosen[1] };
      },
      renderer(token) {
        return renderMath(token.text, false);
      }
    }
  ]
});


const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction']);

function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return escapeHtml(html);

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

export function sanitizeCitationMarkers(text: string, validSourceCount?: number): string {
  if (!text) return '';

  const codeBlocks: string[] = [];
  const placeholder = '___CODE_MD_HOLD_' + Math.random().toString(36).substring(2, 8) + '_';

  let protectedText = text.replace(/(```[\s\S]*?```)/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `${placeholder}${idx}___`;
  });

  protectedText = protectedText.replace(/(`[^`\n]+`)/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `${placeholder}${idx}___`;
  });

  const formatSourceRef = (_fullMatch: string, numStr: string): string => {
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num <= 0) return '';
    if (validSourceCount !== undefined) {
      if (num >= 1 && num <= validSourceCount) {
        return `[Source ${num}]`;
      }
      return '';
    }
    return `[Source ${num}]`;
  };

  protectedText = protectedText
    .replace(/\[(?:Source\s*)?(\d+)†[^\]]*\]/gi, formatSourceRef)
    .replace(/【(\d+)(?::\d+)?†[^】]*】/g, formatSourceRef)
    .replace(/\[(?:Source\s*)?-\d+†[^\]]*\]/gi, '')
    .replace(/\[†[^\]]*\]/g, '')
    .replace(/†L\d+(?:-L\d+)?/g, '')
    .replace(/†/g, '');

  if (validSourceCount !== undefined) {
    protectedText = protectedText.replace(/\[Source\s+(\d+)\]/gi, (match, numStr) => {
      const num = parseInt(numStr, 10);
      if (isNaN(num) || num <= 0 || num > validSourceCount) {
        return '';
      }
      return match;
    });
  }

  return protectedText.replace(new RegExp(`${placeholder}(\\d+)___`, 'g'), (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return codeBlocks[idx] ?? '';
  });
}

export function renderMarkdownToHtml(markdown: string, validSourceCount?: number): string {
  try {
    const cleaned = sanitizeCitationMarkers(markdown, validSourceCount);
    return sanitizeHtml(marked.parse(cleaned) as string);
  } catch (e) {
    console.error('Markdown parse error', e);
    return escapeHtml(markdown);
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
