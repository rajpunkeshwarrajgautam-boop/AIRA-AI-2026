import type { Artifact } from '../types';

export function generateArtifactSandboxHtml(
  artifact: Artifact,
  content: string,
  isDark = false
): string {
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
            window.parent.postMessage({ type: 'CONSOLE_LOG', level: level, message: message }, '*');
          } catch(e) {}
        }

        console.log = function(...args) { emit('info', args); originalLog.apply(console, args); };
        console.info = function(...args) { emit('info', args); originalInfo.apply(console, args); };
        console.warn = function(...args) { emit('warn', args); originalWarn.apply(console, args); };
        console.error = function(...args) { emit('error', args); originalError.apply(console, args); };

        window.onerror = function(msg, url, line, col, err) {
          emit('error', [msg + (line ? ' (Line ' + line + ')' : '')]);
          const errorDisplay = document.getElementById('aira-error-boundary');
          if (errorDisplay) {
            errorDisplay.style.display = 'block';
            errorDisplay.textContent = 'Runtime Error: ' + msg + (line ? ' (Line ' + line + ')' : '');
          }
          return false;
        };
      })();
    </script>
  `;

  const errorBoundaryHtml = `
    <div id="aira-error-boundary" style="display:none;position:fixed;bottom:12px;left:12px;right:12px;padding:12px 16px;background:#B54A2B;color:#FFFFFF;font-family:monospace;font-size:12px;border-radius:8px;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);white-space:pre-wrap;word-break:break-word;"></div>
  `;

  // 1. SVG Graphics
  if (artifact.type === 'image/svg+xml') {
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
  ${content}
</body>
</html>`;
  }

  // 2. React Components (JSX/TSX via Babel Standalone)
  if (artifact.type === 'application/vnd.ant.react' || artifact.language === 'tsx' || artifact.language === 'jsx') {
    const escapedCode = JSON.stringify(content);

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

      // Environment globals
      window.LucideIcons = IconProxy;
      window.lucideReact = IconProxy;
      window.framerMotion = { motion: motionShim, AnimatePresence: ({ children }) => children };

      const userCode = ${escapedCode};

      // Strip import statements and replace with local bindings
      let transformedCode = userCode
        .replace(/import\\s+React\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*['"][^'"]+['"];?/g, '')
        .replace(/import\\s+\\{([^}]+)\\}\\s*from\\s*['"]react['"];?/g, 'const { $1 } = React;')
        .replace(/import\\s+\\{([^}]+)\\}\\s*from\\s*['"]lucide-react['"];?/g, 'const { $1 } = window.LucideIcons;')
        .replace(/import\\s+\\{([^}]+)\\}\\s*from\\s*['"]framer-motion['"];?/g, 'const { $1 } = window.framerMotion;')
        .replace(/import\\s+.*\\s+from\\s*['"][^'"]+['"];?/g, '');

      // Handle export default
      let componentName = 'App';
      const defaultExportMatch = transformedCode.match(/export\\s+default\\s+(?:function\\s+)?([A-Za-z0-9_]+)/);
      if (defaultExportMatch) {
        componentName = defaultExportMatch[1];
        transformedCode = transformedCode.replace(/export\\s+default\\s+(?:function\\s+)?([A-Za-z0-9_]+);?/g, '');
      } else {
        transformedCode = transformedCode.replace(/export\\s+default\\s+/g, 'const App = ');
      }

      // Remove remaining named exports
      transformedCode = transformedCode.replace(/export\\s+(?:const|function|class|let)\\s+/g, '');

      const wrappedCode = \`
        const { useState, useEffect, useRef, useMemo, useCallback } = React;
        \${transformedCode}

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
        const transpiled = Babel.transform(wrappedCode, {
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

  // 3. Mermaid Diagrams
  if (artifact.type === 'application/vnd.ant.mermaid' || artifact.language === 'mermaid') {
    const mermaidTheme = isDark ? 'dark' : 'neutral';
    const escapedMermaid = JSON.stringify(content);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 32px 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: ${isDark ? '#1F1E1D' : '#FAF9F5'};
      color: ${isDark ? '#ECEAE4' : '#1F1E1D'};
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-sizing: border-box;
    }
    #mermaid-container {
      max-width: 100%;
      overflow: auto;
      display: flex;
      justify-content: center;
    }
    svg {
      max-width: 100% !important;
      height: auto !important;
    }
  </style>
  ${logBridgeScript}
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
  <div id="mermaid-container" class="mermaid"></div>
  ${errorBoundaryHtml}

  <script>
    (function() {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: '${mermaidTheme}',
          fontFamily: 'Outfit, sans-serif',
          themeVariables: {
            primaryColor: '#D97757',
            primaryTextColor: '#FFFFFF',
            primaryBorderColor: '#B54A2B',
            lineColor: '${isDark ? '#9E9D96' : '#6E6D69'}',
            secondaryColor: '${isDark ? '#272624' : '#F5F3ED'}',
            tertiaryColor: '${isDark ? '#1F1E1D' : '#FAF9F5'}'
          }
        });

        const rawDiagram = ${escapedMermaid};
        const container = document.getElementById('mermaid-container');

        mermaid.render('aira-mermaid-svg', rawDiagram)
          .then(result => {
            container.innerHTML = result.svg;
          })
          .catch(err => {
            console.error('Mermaid render error:', err);
            const errorDisplay = document.getElementById('aira-error-boundary');
            if (errorDisplay) {
              errorDisplay.style.display = 'block';
              errorDisplay.textContent = 'Diagram Syntax Error: ' + err.message;
            }
          });
      } catch (err) {
        console.error('Mermaid initialization failed:', err);
      }
    })();
  </script>
</body>
</html>`;
  }

  // 4. HTML Standalone Apps
  if (artifact.type === 'text/html' || artifact.type.includes('html')) {
    let result = content;

    if (!result.includes('cdn.tailwindcss.com')) {
      const tailwindTag = '<script src="https://cdn.tailwindcss.com"></script>';
      if (result.includes('<head>')) {
        result = result.replace('<head>', `<head>${tailwindTag}`);
      } else {
        result = `${tailwindTag}${result}`;
      }
    }

    if (result.includes('<head>')) {
      result = result.replace('<head>', `<head>${logBridgeScript}`);
    } else {
      result = `${logBridgeScript}${result}`;
    }

    if (result.includes('</body>')) {
      result = result.replace('</body>', `${errorBoundaryHtml}</body>`);
    } else {
      result = `${result}${errorBoundaryHtml}`;
    }

    return result;
  }

  // 5. Markdown / Rich Documents
  if (artifact.type === 'text/markdown' || artifact.language === 'markdown' || artifact.language === 'md') {
    const escapedMd = JSON.stringify(content);

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
    .prose-doc h1, .prose-doc h2, .prose-doc h3 {
      font-family: 'Newsreader', serif;
      letter-spacing: -0.02em;
    }
    .prose-doc pre, .prose-doc code {
      font-family: 'JetBrains Mono', monospace;
    }
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

  // 6. Generic Code Fallback
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
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
    pre {
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
  ${logBridgeScript}
</head>
<body>
  <pre>${escapeHtml(content)}</pre>
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
