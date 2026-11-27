export const ARTIFACT_CSP_META_TAG = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';\">";

export const ARTIFACT_STRICT_STATIC_CSP_META_TAG = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';\">";

export const ARTIFACT_REACT_CSP_META_TAG = ARTIFACT_STRICT_STATIC_CSP_META_TAG;

import type { Artifact } from '../types';
import {
  SANDBOX_LIMITS,
  SANDBOX_ERROR_BOUNDARY_HTML,
  buildSandboxLogBridgeScript,
  safeJsonStringifyForHtmlScript,
  escapeHtmlText,
  stripUntrustedHtmlSecurityVectors,
  sanitizeSvgMarkup,
  renderSafeMarkdownHtml,
} from './sandboxSecurity';
import { validateGenUIApp } from '../../packages/contracts/src/genui';
import { buildSandboxAppHtml } from './genuiAppBridge';

export { safeJsonStringifyForHtmlScript, sanitizeSvgMarkup, renderSafeMarkdownHtml };

export function generateArtifactSandboxHtml(
  artifact: Artifact,
  content: string,
  isDark = false,
  nonce = ''
): string {
  const safeContent = typeof content === 'string' ? content : '';
  const byteLength = new TextEncoder().encode(safeContent).length;
  if (byteLength > SANDBOX_LIMITS.maxContentBytes) {
    return `<!DOCTYPE html><html lang="en"><head>${ARTIFACT_STRICT_STATIC_CSP_META_TAG}<meta charset="UTF-8"><style>body{margin:0;padding:24px;font-family:monospace;background:${isDark ? '#1F1E1D' : '#FAF9F5'};color:${isDark ? '#ECEAE4' : '#1F1E1D'};}</style></head><body><div id="aira-limit-error"><strong>SANDBOX_CONTENT_LIMIT_EXCEEDED</strong>: Artifact exceeds maximum sandbox size (${SANDBOX_LIMITS.maxContentBytes} bytes). View or download from the Code tab instead.</div></body></html>`;
  }

  // Open Generative UI Application (aira-app/v1)
  if (artifact.type === 'application/vnd.aira.app') {
    try {
      const parsed = typeof safeContent === 'string' ? JSON.parse(safeContent) : safeContent;
      const val = validateGenUIApp(parsed);
      if (val.ok) {
        return buildSandboxAppHtml(val.app, {
          nonce,
          isDark,
        });
      }
    } catch {
      // Fall through to error/fallback
    }
  }

  const logBridgeScript = buildSandboxLogBridgeScript(nonce);
  const errorBoundaryHtml = SANDBOX_ERROR_BOUNDARY_HTML;

  // 1. SVG Graphics (Script-disabled static containment + vector sanitization)
  if (artifact.type === 'image/svg+xml') {
    const bgColor = isDark ? '#1F1E1D' : '#FAF9F5';
    const gridPattern = isDark
      ? 'radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)'
      : 'radial-gradient(circle, rgba(45,40,30,0.08) 1px, transparent 1px)';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${ARTIFACT_STRICT_STATIC_CSP_META_TAG}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
      background-color: ${bgColor};
      background-image: ${gridPattern};
      background-size: 20px 20px;
    }
    svg {
      max-width: 92vw;
      max-height: 92vh;
      height: auto;
      filter: drop-shadow(0 4px 12px rgba(0,0,0,0.1));
    }
  </style>
</head>
<body>
  ${sanitizeSvgMarkup(safeContent)}
</body>
</html>`;
  }

  // 2. React Components (Dynamic CDN Babel + unsafe-eval removed per Section 8; static safe view until self-hosted compiler is bundled)
  if (artifact.type === 'application/vnd.ant.react' || artifact.language === 'tsx' || artifact.language === 'jsx') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${ARTIFACT_REACT_CSP_META_TAG}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 24px;
      min-height: 100vh;
      background: ${isDark ? '#1F1E1D' : '#FAF9F5'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
      box-sizing: border-box;
    }
    .notice {
      border: 1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(31,30,29,0.15)'};
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 16px;
      background: ${isDark ? '#272624' : '#F5F3ED'};
      font-size: 13px;
      line-height: 1.5;
    }
    pre {
      margin: 0;
      padding: 16px;
      border-radius: 10px;
      background: ${isDark ? '#141413' : '#EFECE3'};
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body class="${isDark ? 'dark' : ''}">
  <div id="root">
    <div class="notice">
      <strong>Static Containment Preview</strong>: In-browser JSX compilation requires a pinned self-hosted compiler without dynamic runtime evaluation or external CDN scripts. View or download the source from the Code tab.
    </div>
    <pre>${escapeHtmlText(safeContent)}</pre>
  </div>
</body>
</html>`;
  }

  // 3. Mermaid Diagrams (Static containment without external CDN execution)
  if (artifact.type === 'application/vnd.ant.mermaid' || artifact.language === 'mermaid') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${ARTIFACT_STRICT_STATIC_CSP_META_TAG}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 24px;
      min-height: 100vh;
      background: ${isDark ? '#1F1E1D' : '#FAF9F5'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-sizing: border-box;
    }
    .notice {
      border: 1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(31,30,29,0.15)'};
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 14px;
      background: ${isDark ? '#272624' : '#F5F3ED'};
      font-size: 13px;
    }
    #mermaid-container pre {
      margin: 0;
      padding: 16px;
      border-radius: 10px;
      background: ${isDark ? '#141413' : '#EFECE3'};
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="notice"><strong>Mermaid Source (Static Containment)</strong>: External Mermaid CDN execution is disabled under strict CSP; source displayed safely below.</div>
  <div id="mermaid-container" class="mermaid"><pre>${escapeHtmlText(safeContent)}</pre></div>
</body>
</html>`;
  }

  // 4. HTML Standalone Apps (Authoritative CSP enforced regardless of model HTML content)
  if (artifact.type === 'text/html' || artifact.type.includes('html')) {
    let result = stripUntrustedHtmlSecurityVectors(safeContent);

    if (/<head>/i.test(result)) {
      result = result.replace(/<head>/i, `<head>${ARTIFACT_CSP_META_TAG}${logBridgeScript}`);
    } else {
      result = `${ARTIFACT_CSP_META_TAG}${logBridgeScript}${result}`;
    }

    if (/<\/body>/i.test(result)) {
      result = result.replace(/<\/body>/i, `${errorBoundaryHtml}</body>`);
    } else {
      result = `${result}${errorBoundaryHtml}`;
    }

    return result;
  }

  // 5. Markdown / Rich Documents (Pure static HTML rendering, script-src 'none')
  if (artifact.type === 'text/markdown' || artifact.language === 'markdown' || artifact.language === 'md') {
    const renderedBody = renderSafeMarkdownHtml(safeContent);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${ARTIFACT_STRICT_STATIC_CSP_META_TAG}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 32px 24px;
      background: ${isDark ? '#1F1E1D' : '#FAF9F5'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
      line-height: 1.7;
    }
    .prose-doc {
      max-width: 768px;
      margin: 0 auto;
    }
    .prose-doc pre, .prose-doc code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: ${isDark ? '#272624' : '#EFECE3'};
      padding: 2px 5px;
      border-radius: 4px;
    }
    .prose-doc pre {
      padding: 14px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="prose-doc" id="doc-root">${renderedBody}</div>
</body>
</html>`;
  }

  // 6. Generic Code Fallback (Script-disabled static view)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${ARTIFACT_STRICT_STATIC_CSP_META_TAG}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      margin: 0;
      padding: 24px;
      background: ${isDark ? '#141413' : '#F5F3ED'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
      font-size: 13px;
      line-height: 1.6;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <pre>${escapeHtmlText(safeContent)}</pre>
</body>
</html>`;
}
