import type { ArtifactRuntimeError } from './artifactRuntimeError';
import { normalizeArtifactRuntimeError } from './artifactRuntimeError';

export const SANDBOX_LIMITS = {
  maxContentBytes: 512 * 1024,
  maxConcurrentSandboxes: 2,
  maxLogsPerSession: 100,
  maxMessageChars: 4000,
  maxRawPayloadBytes: 16 * 1024,
  maxViewportWidthPx: 1600,
  maxViewportHeightPx: 2400,
} as const;

const activeSandboxSlots = new Set<string>();

export function acquireSandboxSlot(instanceId: string): boolean {
  if (activeSandboxSlots.has(instanceId)) return true;
  if (activeSandboxSlots.size >= SANDBOX_LIMITS.maxConcurrentSandboxes) {
    return false;
  }
  activeSandboxSlots.add(instanceId);
  return true;
}

export function releaseSandboxSlot(instanceId: string): void {
  activeSandboxSlots.delete(instanceId);
}

export function getActiveSandboxCount(): number {
  return activeSandboxSlots.size;
}

export function sandboxAttributesForType(artifactType?: string): string {
  const normalized = (artifactType || '').toLowerCase().trim();
  if (
    normalized === 'image/svg+xml' ||
    normalized === 'text/markdown' ||
    normalized === 'application/vnd.ant.code' ||
    normalized === 'application/vnd.ant.mermaid' ||
    normalized === 'application/vnd.ant.react'
  ) {
    // Fully static / script-disabled sandboxed preview
    return '';
  }
  // HTML apps receive opaque origin (no allow-same-origin, no allow-top-navigation)
  return 'allow-scripts allow-forms';
}

/**
 * Safely serializes arbitrary JSON values for embedding inside HTML <script> tags,
 * escaping characters that could prematurely terminate the script tag or open HTML comments.
 */
export function safeJsonStringifyForHtmlScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Strips untrusted model-supplied CSP meta tags, refresh directives, base tags,
 * and external script src tags so the sandbox enforces authoritative policy only.
 */
export function stripUntrustedHtmlSecurityVectors(html: string): string {
  return html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:Content-Security-Policy|refresh)["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\/[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\/(?:cdn\.tailwindcss\.com|unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)[^>]*>/gi, '');
}

/**
 * Removes executable/active content vectors from untrusted SVG markup.
 */
export function sanitizeSvgMarkup(rawSvg: string): string {
  return rawSvg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<(?:iframe|object|embed|meta|base)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)>/gi, '')
    .replace(/<(?:iframe|object|embed|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(?:xlink:href|href|src)\s*=\s*["']\s*(?:javascript:|vbscript:|data:text\/html|data:image\/svg\+xml)[^"']*["']/gi, 'href="#"');
}

export const SANDBOX_ERROR_BOUNDARY_HTML = `
  <div id="aira-error-boundary" style="display:none;position:fixed;bottom:12px;left:12px;right:12px;padding:12px 16px;background:#B54A2B;color:#FFFFFF;font-family:monospace;font-size:12px;border-radius:8px;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);white-space:pre-wrap;word-break:break-word;"></div>
`;

export function buildSandboxLogBridgeScript(nonce: string): string {
  const safeNonceJson = safeJsonStringifyForHtmlScript(nonce);
  return `
  <script>
    (function() {
      const originalLog = console.log;
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalInfo = console.info;

      function emit(level, args) {
        try {
          const message = args.map(arg => {
            if (typeof arg === 'object' && arg !== null) {
              try { return JSON.stringify(arg); } catch(e) { return String(arg); }
            }
            return String(arg);
          }).join(' ');
          window.parent.postMessage({ type: 'CONSOLE_LOG', level: level, message: message, nonce: ${safeNonceJson} }, '*');
        } catch(e) {}
      }

      function emitRuntimeError(message, line, column, stack) {
        try {
          window.parent.postMessage({
            type: 'AIRA_ARTIFACT_RUNTIME_ERROR',
            nonce: ${safeNonceJson},
            error: {
              message: String(message || 'Unknown sandbox error').slice(0, 1000),
              line: typeof line === 'number' ? line : undefined,
              column: typeof column === 'number' ? column : undefined,
              stack: typeof stack === 'string' ? stack.slice(0, 2000) : undefined,
            }
          }, '*');
        } catch (e) {}
      }

      console.log = function(...args) { emit('info', args); originalLog.apply(console, args); };
      console.info = function(...args) { emit('info', args); originalInfo.apply(console, args); };
      console.warn = function(...args) { emit('warn', args); originalWarn.apply(console, args); };
      console.error = function(...args) { emit('error', args); originalError.apply(console, args); };

      window.onerror = function(msg, url, line, col, err) {
        emit('error', [msg + (line ? ' (Line ' + line + ')' : '')]);
        emitRuntimeError(msg, line, col, err && err.stack);
        const errorDisplay = document.getElementById('aira-error-boundary');
        if (errorDisplay) {
          errorDisplay.style.display = 'block';
          errorDisplay.textContent = 'Runtime Error: ' + msg + (line ? ' (Line ' + line + ')' : '');
        }
        return false;
      };

      window.addEventListener('unhandledrejection', function(event) {
        const reason = event.reason;
        const message = reason && reason.message ? reason.message : String(reason || 'Unhandled promise rejection');
        emitRuntimeError(message, undefined, undefined, reason && reason.stack);
      });
    })();
  </script>
  `;
}

/**
 * Pure TypeScript Markdown-to-HTML serializer that HTML-escapes all untrusted raw markup first
 * and permits only safe http(s)/hash/relative link targets. Zero external CDN dependencies.
 */
export function renderSafeMarkdownHtml(rawMarkdown: string): string {
  const lines = (rawMarkdown || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCodeFence = false;
  let listType: 'ul' | 'ol' | null = null;
  let inBlockquote = false;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      out.push('</blockquote>');
      inBlockquote = false;
    }
  };

  const formatInline = (text: string): string => {
    let escaped = escapeHtmlText(text);
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
      const trimmed = url.trim();
      const safeUrl = /^(?:https?:\/\/|#|\/)/i.test(trimmed) ? trimmed : '#blocked-unsafe-uri';
      return `<a href="${safeUrl}" rel="noopener noreferrer">${label}</a>`;
    });
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return escaped;
  };

  const parseTableCells = (line: string): string[] | null => {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) return null;
    const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    const cells = stripped.split('|').map(c => c.trim());
    return cells.length > 0 ? cells : null;
  };

  const isTableSeparator = (line: string): boolean => {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const parts = trimmed.split('|').map(c => c.trim());
    return parts.length > 0 && parts.every(p => /^:?-{3,}:?$/.test(p));
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (/^```/.test(line.trim())) {
      closeList();
      closeBlockquote();
      if (!inCodeFence) {
        out.push('<pre><code>');
        inCodeFence = true;
      } else {
        out.push('</code></pre>');
        inCodeFence = false;
      }
      continue;
    }

    if (inCodeFence) {
      out.push(escapeHtmlText(line));
      continue;
    }

    // GFM Markdown tables (header + separator + rows)
    const headerCells = parseTableCells(line);
    if (headerCells && idx + 1 < lines.length && isTableSeparator(lines[idx + 1])) {
      closeList();
      closeBlockquote();
      out.push('<table><thead><tr>');
      for (const cell of headerCells) {
        out.push(`<th>${formatInline(cell)}</th>`);
      }
      out.push('</tr></thead><tbody>');
      idx += 2;
      while (idx < lines.length) {
        const rowCells = parseTableCells(lines[idx]);
        if (!rowCells || !lines[idx].trim()) {
          idx -= 1;
          break;
        }
        out.push('<tr>');
        for (let c = 0; c < headerCells.length; c += 1) {
          out.push(`<td>${formatInline(rowCells[c] ?? '')}</td>`);
        }
        out.push('</tr>');
        idx += 1;
      }
      out.push('</tbody></table>');
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      closeList();
      closeBlockquote();
      out.push('<hr>');
      continue;
    }

    const bq = /^>\s?(.*)$/.exec(line.trim());
    if (bq) {
      closeList();
      if (!inBlockquote) {
        out.push('<blockquote>');
        inBlockquote = true;
      }
      out.push(`<p>${formatInline(bq[1])}</p>`);
      continue;
    }
    closeBlockquote();

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      continue;
    }

    const ulItem = /^[-*]\s+(.*)$/.exec(line.trim());
    if (ulItem) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${formatInline(ulItem[1])}</li>`);
      continue;
    }

    const olItem = /^\d+\.\s+(.*)$/.exec(line.trim());
    if (olItem) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${formatInline(olItem[1])}</li>`);
      continue;
    }

    closeList();

    if (!line.trim()) {
      out.push('');
    } else {
      out.push(`<p>${formatInline(line)}</p>`);
    }
  }

  closeList();
  closeBlockquote();
  if (inCodeFence) out.push('</code></pre>');
  return out.filter(Boolean).join('\n');
}

export type ValidatedSandboxMessage =
  | { accepted: true; kind: 'CONSOLE_LOG'; level: 'info' | 'warn' | 'error' | 'log'; message: string }
  | { accepted: true; kind: 'RUNTIME_ERROR'; error: ArtifactRuntimeError }
  | { accepted: false; reason: string };

export function validateSandboxBridgeMessage(
  event: { source: unknown; origin?: string; data: unknown },
  expectedSource: unknown,
  activeNonce: string
): ValidatedSandboxMessage {
  if (!expectedSource || event.source !== expectedSource) {
    return { accepted: false, reason: 'FRAME_SOURCE_MISMATCH' };
  }
  if (event.origin !== 'null') {
    return { accepted: false, reason: 'INVALID_ORIGIN' };
  }
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    return { accepted: false, reason: 'INVALID_PAYLOAD' };
  }
  try {
    if (JSON.stringify(event.data).length > SANDBOX_LIMITS.maxRawPayloadBytes) {
      return { accepted: false, reason: 'PAYLOAD_TOO_LARGE' };
    }
  } catch {
    return { accepted: false, reason: 'UNSERIALIZABLE_PAYLOAD' };
  }

  const payload = event.data as Record<string, unknown>;
  if (!activeNonce || typeof payload.nonce !== 'string' || payload.nonce !== activeNonce) {
    return { accepted: false, reason: 'NONCE_VERIFICATION_FAILED' };
  }

  if (payload.type === 'CONSOLE_LOG') {
    const allowedLevels = new Set(['info', 'warn', 'error', 'log']);
    const rawLevel = typeof payload.level === 'string' ? payload.level : 'info';
    const level = (allowedLevels.has(rawLevel) ? rawLevel : 'info') as 'info' | 'warn' | 'error' | 'log';
    const rawMessage = typeof payload.message === 'string' ? payload.message : String(payload.message || '');
    return {
      accepted: true,
      kind: 'CONSOLE_LOG',
      level,
      message: rawMessage.slice(0, SANDBOX_LIMITS.maxMessageChars),
    };
  }

  if (payload.type === 'AIRA_ARTIFACT_RUNTIME_ERROR') {
    const normalized = normalizeArtifactRuntimeError(payload.error || 'Execution failed');
    if (!normalized) {
      return { accepted: false, reason: 'INVALID_ERROR_SHAPE' };
    }
    return { accepted: true, kind: 'RUNTIME_ERROR', error: normalized };
  }

  return { accepted: false, reason: 'UNAUTHORIZED_MESSAGE_TYPE' };
}
