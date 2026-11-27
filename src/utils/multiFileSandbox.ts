import type { MultiFileArtifactBundle, ArtifactProjectFile } from '../types/multiFileArtifact';
import { resolveRelativeSpecifier } from './artifactPathSecurity';
import { ARTIFACT_CSP_META_TAG, ARTIFACT_STRICT_STATIC_CSP_META_TAG } from './artifactSandbox';
import {
  SANDBOX_LIMITS,
  SANDBOX_ERROR_BOUNDARY_HTML,
  buildSandboxLogBridgeScript,
  escapeHtmlText,
  stripUntrustedHtmlSecurityVectors,
  sanitizeSvgMarkup,
  renderSafeMarkdownHtml,
} from './sandboxSecurity';

/**
 * Generates an isolated, sandboxed HTML document string representing a MultiFileArtifactBundle.
 * Handles inlining of relative stylesheets, scripts, and assets without exposing parent origin.
 */
export function generateMultiFileArtifactSandboxHtml(
  bundle: MultiFileArtifactBundle,
  isDark = false,
  nonce = ''
): string {
  let totalBytes = 0;
  for (const file of Object.values(bundle.files)) {
    totalBytes += new TextEncoder().encode(file.content || '').length;
  }
  if (totalBytes > SANDBOX_LIMITS.maxContentBytes) {
    return `<!DOCTYPE html><html lang="en"><head>${ARTIFACT_STRICT_STATIC_CSP_META_TAG}<meta charset="UTF-8"><style>body{margin:0;padding:24px;font-family:monospace;background:${isDark ? '#1F1E1D' : '#FAF9F5'};color:${isDark ? '#ECEAE4' : '#1F1E1D'};}</style></head><body><div id="aira-limit-error"><strong>SANDBOX_CONTENT_LIMIT_EXCEEDED</strong>: Multi-file bundle exceeds maximum sandbox size (${SANDBOX_LIMITS.maxContentBytes} bytes).</div></body></html>`;
  }

  const existingPaths = Object.keys(bundle.files);
  const logBridgeScript = buildSandboxLogBridgeScript(nonce);
  const errorBoundaryHtml = SANDBOX_ERROR_BOUNDARY_HTML;

  // Determine entry point file
  let entryFile: ArtifactProjectFile | undefined = bundle.files[bundle.entryPoint];
  if (!entryFile) {
    // Look for index.html
    entryFile = bundle.files['index.html'] || bundle.files['src/App.tsx'] || bundle.files['App.tsx'];
  }
  if (!entryFile && existingPaths.length > 0) {
    entryFile = bundle.files[existingPaths[0]];
  }

  if (!entryFile) {
    return `<!DOCTYPE html><html><head>${ARTIFACT_STRICT_STATIC_CSP_META_TAG}<meta charset="UTF-8"></head><body><div style="padding:24px;font-family:sans-serif;color:${isDark ? '#ECEAE4' : '#1F1E1D'}">Empty multi-file project bundle.</div></body></html>`;
  }

  // 1. Entry is HTML (e.g. index.html)
  if (entryFile.kind === 'html' || entryFile.path.endsWith('.html') || entryFile.path.endsWith('.htm')) {
    let html = entryFile.content;

    // Inline stylesheets: <link rel="stylesheet" href="...">
    html = html.replace(/<link\b([^>]*\bhref=["']([^"']+)["'][^>]*)>/gi, (match, _attrs, href) => {
      const { resolvedPath, isResolved } = resolveRelativeSpecifier(entryFile!.path, href, existingPaths);
      if (isResolved && bundle.files[resolvedPath]) {
        const cssContent = bundle.files[resolvedPath].content;
        return `<style data-bundle-file="${resolvedPath}">\n${cssContent}\n</style>`;
      }
      return match;
    });

    // Inline local scripts: <script src="...">
    html = html.replace(/<script\b([^>]*\bsrc=["']([^"']+)["'][^>]*)><\/script>/gi, (match, _attrs, src) => {
      const { resolvedPath, isResolved } = resolveRelativeSpecifier(entryFile!.path, src, existingPaths);
      if (isResolved && bundle.files[resolvedPath]) {
        const jsContent = bundle.files[resolvedPath].content;
        return `<script data-bundle-file="${resolvedPath}">\n${jsContent}\n</script>`;
      }
      return match;
    });

    // Inline local image/svg assets if referenced: <img src="...">
    html = html.replace(/<img\b([^>]*\bsrc=["']([^"']+)["'][^>]*)>/gi, (match, _attrs, src) => {
      const { resolvedPath, isResolved } = resolveRelativeSpecifier(entryFile!.path, src, existingPaths);
      if (isResolved && bundle.files[resolvedPath] && resolvedPath.endsWith('.svg')) {
        const svgContent = sanitizeSvgMarkup(bundle.files[resolvedPath].content);
        const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;
        return match.replace(src, dataUri);
      }
      return match;
    });

    // Strip untrusted model-supplied CSP/base/external CDN links before injecting authoritative CSP
    html = stripUntrustedHtmlSecurityVectors(html);

    // Inject authoritative CSP + log bridge in head or top
    if (/<head>/i.test(html)) {
      html = html.replace(/<head>/i, `<head>\n  ${ARTIFACT_CSP_META_TAG}\n  ${logBridgeScript}`);
    } else {
      html = `${ARTIFACT_CSP_META_TAG}\n${logBridgeScript}\n${html}`;
    }

    // Inject error boundary before </body> or at end
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `  ${errorBoundaryHtml}\n</body>`);
    } else {
      html = `${html}\n${errorBoundaryHtml}`;
    }

    return html;
  }

  // 2. Entry is React TSX/JSX (Static safe containment view without external CDN scripts or unsafe-eval)
  if (entryFile.kind === 'typescript' || entryFile.path.endsWith('.tsx') || entryFile.path.endsWith('.jsx')) {
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
    }
    pre {
      margin: 0;
      padding: 16px;
      border-radius: 10px;
      background: ${isDark ? '#141413' : '#EFECE3'};
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body class="${isDark ? 'dark' : ''}">
  <div id="root">
    <div class="notice">
      <strong>Static Containment Preview</strong>: Multi-file JSX compilation requires a pinned self-hosted compiler without dynamic runtime evaluation or external CDN scripts. View or export the project files instead.
    </div>
    <pre>${escapeHtmlText(entryFile.content)}</pre>
  </div>
</body>
</html>`;
  }

  // 3. Entry is SVG (Script-disabled + vector sanitization)
  if (entryFile.kind === 'svg' || entryFile.path.endsWith('.svg')) {
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
  ${sanitizeSvgMarkup(entryFile.content)}
</body>
</html>`;
  }

  // 4. Entry is Markdown (Pure static HTML rendering, script-src 'none')
  if (entryFile.kind === 'markdown' || entryFile.path.endsWith('.md') || entryFile.path.endsWith('.markdown')) {
    const renderedBody = renderSafeMarkdownHtml(entryFile.content);
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
    .prose-doc { max-width: 768px; margin: 0 auto; }
    .prose-doc pre, .prose-doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <div class="prose-doc" id="doc-root">${renderedBody}</div>
</body>
</html>`;
  }

  // 5. Generic Code Fallback (Script-disabled)
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
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <pre>${escapeHtmlText(entryFile.content)}</pre>
</body>
</html>`;
}
