import type { MultiFileArtifactBundle, ArtifactProjectFile } from '../types/multiFileArtifact';
import { resolveRelativeSpecifier } from './artifactPathSecurity';

/**
 * Generates an isolated, sandboxed HTML document string representing a MultiFileArtifactBundle.
 * Handles inlining of relative stylesheets, scripts, and assets without exposing parent origin.
 */
export function generateMultiFileArtifactSandboxHtml(
  bundle: MultiFileArtifactBundle,
  isDark = false,
  nonce = ''
): string {
  const safeNonceJson = JSON.stringify(nonce);
  const existingPaths = Object.keys(bundle.files);

  const logBridgeScript = `
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

  const errorBoundaryHtml = `
    <div id="aira-error-boundary" style="display:none;position:fixed;bottom:12px;left:12px;right:12px;padding:12px 16px;background:#B54A2B;color:#FFFFFF;font-family:monospace;font-size:12px;border-radius:8px;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);white-space:pre-wrap;word-break:break-word;"></div>
  `;

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
    return `<!DOCTYPE html><html><body><div style="padding:24px;font-family:sans-serif;color:${isDark ? '#ECEAE4' : '#1F1E1D'}">Empty multi-file project bundle.</div>${logBridgeScript}</body></html>`;
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
        const svgContent = bundle.files[resolvedPath].content;
        const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;
        return match.replace(src, dataUri);
      }
      return match;
    });

    // Inject Tailwind CDN if missing
    if (!html.includes('cdn.tailwindcss.com')) {
      const tailwindTag = '<script src="https://cdn.tailwindcss.com"></script>';
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>\n  ${tailwindTag}`);
      } else {
        html = `${tailwindTag}\n${html}`;
      }
    }

    // Inject log bridge in head or top
    if (html.includes('<head>')) {
      html = html.replace('<head>', `<head>\n  ${logBridgeScript}`);
    } else {
      html = `${logBridgeScript}\n${html}`;
    }

    // Inject error boundary before </body> or at end
    if (html.includes('</body>')) {
      html = html.replace('</body>', `  ${errorBoundaryHtml}\n</body>`);
    } else {
      html = `${html}\n${errorBoundaryHtml}`;
    }

    return html;
  }

  // 2. Entry is React TSX/JSX (e.g. src/App.tsx)
  if (entryFile.kind === 'typescript' || entryFile.path.endsWith('.tsx') || entryFile.path.endsWith('.jsx')) {
    // Gather all local stylesheets
    const inlineCssBlocks: string[] = [];
    for (const [path, file] of Object.entries(bundle.files)) {
      if (file.kind === 'css' || path.endsWith('.css')) {
        inlineCssBlocks.push(`/* ${path} */\n${file.content}`);
      }
    }

    // Gather and transpile all non-entry JS/TS components
    const auxiliaryModules: Array<{ path: string; code: string }> = [];
    for (const [path, file] of Object.entries(bundle.files)) {
      if (path !== entryFile.path && (file.kind === 'typescript' || file.kind === 'javascript')) {
        auxiliaryModules.push({ path, code: file.content });
      }
    }

    const escapedEntryCode = JSON.stringify(entryFile.content);
    const escapedAuxiliaryJson = JSON.stringify(auxiliaryModules);
    const combinedStyles = inlineCssBlocks.join('\n\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: {
              terracotta: '#D97757',
              dark: '#1F1E1D',
              surface: '#272624',
              parchment: '#FAF9F5'
            }
          }
        }
      }
    };
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      background: ${isDark ? '#1F1E1D' : '#FAF9F5'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
    }
    #root {
      min-height: 100vh;
    }
    ${combinedStyles}
  </style>
  ${logBridgeScript}
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
</head>
<body class="${isDark ? 'dark' : ''}">
  <div id="root"></div>
  ${errorBoundaryHtml}

  <script>
    (function() {
      // Icon proxy shim for Lucide icons
      const lucideIcons = window.lucide || {};
      const IconProxy = new Proxy({}, {
        get: function(target, prop) {
          return function(props) {
            const iconName = String(prop).toLowerCase().replace(/icon$/, '');
            const svgRef = React.useRef(null);

            React.useEffect(() => {
              if (svgRef.current && window.lucide && window.lucide.createElement) {
                const icon = window.lucide.icons[prop] || window.lucide.icons[iconName];
                if (icon) {
                  const svg = window.lucide.createElement(icon, props || {});
                  svgRef.current.innerHTML = '';
                  svgRef.current.appendChild(svg);
                }
              }
            }, [props]);

            return React.createElement('span', {
              ref: svgRef,
              className: 'inline-flex items-center justify-center ' + (props.className || ''),
              style: { display: 'inline-flex', width: props.size || 20, height: props.size || 20 }
            });
          };
        }
      });

      // Framer Motion mock shim
      const motionShim = new Proxy({}, {
        get: function(target, prop) {
          return function(props) {
            const { initial, animate, exit, transition, whileHover, whileTap, ...rest } = props || {};
            return React.createElement(prop, rest);
          };
        }
      });

      window.LucideIcons = IconProxy;
      window.lucideReact = IconProxy;
      window.framerMotion = { motion: motionShim, AnimatePresence: ({ children }) => children };

      const userEntryCode = ${escapedEntryCode};
      const auxModules = ${escapedAuxiliaryJson};

      // Strip imports from code snippet
      function cleanImports(code) {
        return code
          .replace(/import\\s+React\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*['"][^'"]+['"];?/g, '')
          .replace(/import\\s+\\{([^}]+)\\}\\s*from\\s*['"]react['"];?/g, 'const { $1 } = React;')
          .replace(/import\\s+\\{([^}]+)\\}\\s*from\\s*['"]lucide-react['"];?/g, 'const { $1 } = window.LucideIcons;')
          .replace(/import\\s+\\{([^}]+)\\}\\s*from\\s*['"]framer-motion['"];?/g, 'const { $1 } = window.framerMotion;')
          .replace(/import\\s+.*\\s+from\\s*['"][^'"]+['"];?/g, '')
          .replace(/import\\s+['"][^'"]+['"];?/g, '');
      }

      let combinedCode = 'const { useState, useEffect, useRef, useMemo, useCallback } = React;\\n';

      // Evaluate auxiliary modules first
      for (const mod of auxModules) {
        let modClean = cleanImports(mod.code);
        modClean = modClean.replace(/export\\s+default\\s+(?:function\\s+)?([A-Za-z0-9_]+);?/g, 'const $1 = ');
        modClean = modClean.replace(/export\\s+(?:const|function|class|let)\\s+/g, '');
        combinedCode += \`/* module: \${mod.path} */\\n\${modClean}\\n\`;
      }

      // Transform entry component
      let entryClean = cleanImports(userEntryCode);
      let componentName = 'App';
      const defaultExportMatch = entryClean.match(/export\\s+default\\s+(?:function\\s+)?([A-Za-z0-9_]+)/);
      if (defaultExportMatch) {
        componentName = defaultExportMatch[1];
        entryClean = entryClean.replace(/export\\s+default\\s+(?:function\\s+)?([A-Za-z0-9_]+);?/g, '');
      } else {
        entryClean = entryClean.replace(/export\\s+default\\s+/g, 'const App = ');
      }
      entryClean = entryClean.replace(/export\\s+(?:const|function|class|let)\\s+/g, '');

      combinedCode += \`
        \${entryClean}

        try {
          const RootComponent = typeof \${componentName} !== 'undefined' ? \${componentName} : (typeof App !== 'undefined' ? App : null);
          if (RootComponent) {
            const root = ReactDOM.createRoot(document.getElementById('root'));
            root.render(React.createElement(RootComponent));
          } else {
            console.error('No top-level component found to mount.');
          }
        } catch (renderError) {
          console.error('Render error:', renderError);
          const errorDisplay = document.getElementById('aira-error-boundary');
          if (errorDisplay) {
            errorDisplay.style.display = 'block';
            errorDisplay.textContent = 'Render Error: ' + renderError.message;
          }
        }
      \`;

      try {
        const transpiled = Babel.transform(combinedCode, {
          presets: ['react', ['typescript', { isTSX: true, allExtensions: true }]],
        }).code;

        const executeScript = document.createElement('script');
        executeScript.textContent = transpiled;
        document.body.appendChild(executeScript);
      } catch (compileError) {
        console.error('Compilation Error:', compileError);
        const errorDisplay = document.getElementById('aira-error-boundary');
        if (errorDisplay) {
          errorDisplay.style.display = 'block';
          errorDisplay.textContent = 'Compilation Error: ' + compileError.message;
        }
      }
    })();
  </script>
</body>
</html>`;
  }

  // 3. Entry is SVG
  if (entryFile.kind === 'svg' || entryFile.path.endsWith('.svg')) {
    const bgColor = isDark ? '#1F1E1D' : '#FAF9F5';
    const gridPattern = isDark
      ? 'radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)'
      : 'radial-gradient(circle, rgba(45,40,30,0.08) 1px, transparent 1px)';

    return `<!DOCTYPE html>
<html lang="en">
<head>
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
  ${logBridgeScript}
</head>
<body>
  ${entryFile.content}
</body>
</html>`;
  }

  // 4. Entry is Markdown
  if (entryFile.kind === 'markdown' || entryFile.path.endsWith('.md') || entryFile.path.endsWith('.markdown')) {
    const escapedMd = JSON.stringify(entryFile.content);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Outfit:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Outfit', sans-serif;
      margin: 0;
      padding: 32px 24px;
      background: ${isDark ? '#1F1E1D' : '#FAF9F5'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
      line-height: 1.7;
    }
    .prose-doc h1, .prose-doc h2, .prose-doc h3 { font-family: 'Newsreader', serif; letter-spacing: -0.02em; }
    .prose-doc pre, .prose-doc code { font-family: 'JetBrains Mono', monospace; }
  </style>
  ${logBridgeScript}
</head>
<body>
  <div class="max-w-3xl mx-auto prose-doc" id="doc-root"></div>
  <script>
    (function() {
      const raw = ${escapedMd};
      const root = document.getElementById('doc-root');
      if (window.marked && root) {
        root.innerHTML = marked.parse(raw);
      }
    })();
  </script>
</body>
</html>`;
  }

  // 5. Generic Code Fallback
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'JetBrains Mono', monospace;
      margin: 0;
      padding: 24px;
      background: ${isDark ? '#141413' : '#F5F3ED'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
      font-size: 13px;
      line-height: 1.6;
    }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
  ${logBridgeScript}
</head>
<body>
  <pre>${escapeHtml(entryFile.content)}</pre>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
