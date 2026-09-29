import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

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

export function renderMarkdownToHtml(markdown: string): string {
  try {
    return sanitizeHtml(marked.parse(markdown) as string);
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
