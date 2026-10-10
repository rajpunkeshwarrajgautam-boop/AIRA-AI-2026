/**
 * Rich clipboard payloads use the same sanitized DOM as Aira's chat renderer.
 * Inline the KaTeX layout rules so paste targets don't need Aira's stylesheet.
 * Keep MathML/TeX annotations for accessible, math-aware target editors.
 *
 * Rich HTML portability varies with editors. Plain-text Markdown is always
 * offered as the second clipboard MIME type and remains the legacy Copy mode.
 */
export type RichCopyResult = 'rich' | 'markdown-fallback';

const MATH_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'vertical-align', 'white-space',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-bottom', 'border-top', 'border-left', 'border-right',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'box-sizing', 'overflow', 'overflow-x', 'overflow-y',
  'transform', 'transform-origin', 'opacity', 'flex', 'align-items',
  'justify-content'
] as const;

const ELEMENT_STYLES: Record<string, string> = {
  h1: 'font-size:26px;font-weight:700;margin:18px 0 10px;',
  h2: 'font-size:23px;font-weight:700;margin:16px 0 8px;',
  h3: 'font-size:19px;font-weight:700;margin:14px 0 6px;',
  h4: 'font-size:17px;font-weight:700;margin:12px 0 6px;',
  p: 'margin:0 0 12px;line-height:1.65;',
  strong: 'font-weight:700;',
  b: 'font-weight:700;',
  em: 'font-style:italic;',
  ul: 'margin:8px 0 14px;padding-left:26px;list-style-type:disc;',
  ol: 'margin:8px 0 14px;padding-left:26px;list-style-type:decimal;',
  li: 'margin:3px 0;',
  table: 'border-collapse:collapse;width:100%;margin:12px 0;',
  th: 'border:1px solid #bfc5cb;padding:7px 10px;background-color:#f2f4f7;font-weight:700;text-align:left;',
  td: 'border:1px solid #bfc5cb;padding:7px 10px;text-align:left;',
  blockquote: 'margin:12px 0;padding:4px 12px;border-left:3px solid #ae735d;color:#4b5563;',
  pre: 'white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 12px;background:#f2f4f7;border-radius:6px;',
  code: 'font-family:Consolas,Monaco,monospace;font-size:0.92em;',
  a: 'color:#0755b5;text-decoration:underline;'
};

function inlinePortableStyles(source: Element, clone: Element, inMath = false): void {
  const isMath = inMath || source.classList.contains('katex') ||
    source.classList.contains('aira-math-block') ||
    source.classList.contains('aira-math-embedded');
  const tag = source.tagName.toLowerCase();
  const styles = ELEMENT_STYLES[tag] || '';
  // Source Markdown is sanitized by renderMarkdownToHtml. Discard any
  // user-supplied style attributes and serialize only known-safe CSS.
  clone.removeAttribute('style');
  if (isMath) {
    const computed = window.getComputedStyle(source);
    const declarations = MATH_PROPERTIES.map(property => {
      const value = computed.getPropertyValue(property).trim();
      // Never transfer computed CSS URLs, custom properties or script-like values.
      if (!value || /url\s*\(|expression\s*\(/i.test(value)) return '';
      if (property === 'font-family' && /KaTeX_/.test(value)) {
        return property + ':' + value + ',"Cambria Math","STIX Two Math",serif;';
      }
      return property + ':' + value + ';';
    }).join('');
    clone.setAttribute('style', declarations +
      'color:#202124;' +
      (source.classList.contains('aira-math-block') || source.classList.contains('aira-math-embedded')
        ? 'display:block;margin:14px 0;' : ''));
  } else if (styles) {
    clone.setAttribute('style', styles);
  }

  const sourceChildren = Array.from(source.children);
  const cloneChildren = Array.from(clone.children);
  for (let i = 0; i < sourceChildren.length; i++) {
    inlinePortableStyles(sourceChildren[i], cloneChildren[i], isMath);
  }
}

export function buildPortableRichHtml(renderedMessage: HTMLElement): string {
  const clone = renderedMessage.cloneNode(true) as HTMLElement;
  inlinePortableStyles(renderedMessage, clone);
  clone.removeAttribute('class');
  clone.setAttribute('style',
    'color:#202124;background:#ffffff;font-family:Arial,Helvetica,sans-serif;' +
    'font-size:16px;line-height:1.65;max-width:100%;overflow-wrap:anywhere;');
  // Defensive export boundary. Sanitized chat markup is the only supported source.
  clone.querySelectorAll('script,style,iframe,object,embed,form,meta,link,base')
    .forEach(element => element.remove());
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    '<!--StartFragment-->' + clone.outerHTML + '<!--EndFragment-->' +
    '</body></html>';
}

type WritableClipboard = {
  write?: (items: ClipboardItem[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
};

export async function copyMessageAsRichText(
  markdown: string,
  renderedMessage: HTMLElement,
  clipboard: WritableClipboard | undefined = navigator.clipboard
): Promise<RichCopyResult> {
  if (typeof clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined') {
    const richHtml = buildPortableRichHtml(renderedMessage);
    try {
      await clipboard.write([new ClipboardItem({
        'text/html': new Blob([richHtml], { type: 'text/html' }),
        'text/plain': new Blob([markdown], { type: 'text/plain' })
      })]);
      return 'rich';
    } catch {
      // Some browser/privacy configurations allow writeText but not HTML.
    }
  }

  if (typeof clipboard?.writeText === 'function') {
    await clipboard.writeText(markdown);
    return 'markdown-fallback';
  }

  throw new Error('CLIPBOARD_NOT_AVAILABLE');
}
