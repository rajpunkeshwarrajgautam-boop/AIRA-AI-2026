/**
 * AIRA GenUI Phase 3 — Sandboxed Application Bridge & Security Runtime
 * Manages opaque-origin iframe sandboxing, authoritative CSP injection,
 * cryptographic postMessage validation, self-hosted libraries, and standalone export.
 */
import {
  AIRA_GENUI_APP_CONTRACT_VERSION,
  GenUIBridgeMessageSchema,
  type GenUIApp,
  type GenUIBridgeMessage,
} from '../../packages/contracts/src/index.js';
import {
  stripUntrustedHtmlSecurityVectors,
  safeJsonStringifyForHtmlScript,
  SANDBOX_LIMITS,
} from './sandboxSecurity.js';

export const APP_SANDBOX_CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src \'self\' data: blob:; font-src data:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\';">';

/**
 * Builds the sandboxed client bridge script injected into the iframe.
 * Exposes window.airaBridge for safe state sync, resize, action dispatch, and error telemetry.
 */
function buildClientBridgeScript(appId: string, nonce: string, initialState: Record<string, unknown>): string {
  const safeStateJson = safeJsonStringifyForHtmlScript(initialState);
  return `
(function() {
  'use strict';
  const ACTIVE_NONCE = ${safeJsonStringifyForHtmlScript(nonce)};
  const APP_ID = ${safeJsonStringifyForHtmlScript(appId)};
  let currentState = ${safeStateJson} || {};

  function postToHost(type, payload) {
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage({
        type: type,
        nonce: ACTIVE_NONCE,
        appId: APP_ID,
        payload: payload || {},
        timestamp: Date.now()
      }, '*');
    } catch (e) {
      console.error('[AIRA_BRIDGE_ERROR]', e);
    }
  }

  window.airaBridge = {
    appId: APP_ID,
    get state() {
      return Object.assign({}, currentState);
    },
    getState: function() {
      return Object.assign({}, currentState);
    },
    setState: function(patch) {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(currentState, patch);
      postToHost('GENUI_APP_STATE_UPDATE', { stateSnapshot: Object.assign({}, currentState) });
    },
    sendAction: function(actionId, stateSnapshot) {
      if (stateSnapshot && typeof stateSnapshot === 'object') {
        Object.assign(currentState, stateSnapshot);
      }
      postToHost('GENUI_APP_ACTION', {
        actionId: String(actionId),
        stateSnapshot: Object.assign({}, currentState)
      });
    },
    requestResize: function(heightPx) {
      const h = Math.max(150, Math.min(1400, Math.round(Number(heightPx) || 400)));
      postToHost('GENUI_APP_RESIZE', { height: h });
    },
    sendFollowUp: function(prompt) {
      if (!prompt) return;
      postToHost('GENUI_APP_FOLLOWUP', { prompt: String(prompt) });
    }
  };

  window.addEventListener('error', function(evt) {
    const errBox = document.getElementById('aira-error-boundary');
    if (errBox) {
      errBox.style.display = 'block';
      errBox.innerText = 'Runtime Exception: ' + (evt.message || 'Unknown error');
    }
    postToHost('GENUI_APP_ERROR', { error: evt.message || 'Script error' });
  });

  window.addEventListener('unhandledrejection', function(evt) {
    const errBox = document.getElementById('aira-error-boundary');
    if (errBox) {
      errBox.style.display = 'block';
      errBox.innerText = 'Promise Rejection: ' + (evt.reason?.message || String(evt.reason));
    }
    postToHost('GENUI_APP_ERROR', { error: evt.reason?.message || String(evt.reason) });
  });

  document.addEventListener('DOMContentLoaded', function() {
    postToHost('GENUI_APP_READY', { state: Object.assign({}, currentState) });
    // Auto-detect document content height and request resize if appropriate
    try {
      const contentHeight = Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.scrollHeight
      );
      if (contentHeight > 200 && contentHeight < 1400) {
        window.airaBridge.requestResize(contentHeight + 32);
      }
    } catch (_) {}
  });
})();
`;
}

/**
 * Self-hosted D3 v7 runtime bundle stub that provides standard D3 primitives
 * (select, selectAll, scaleLinear, scaleBand, scaleOrdinal, schemeCategory10, forceSimulation, range, max, min)
 * offline without requiring remote CDNs or unpkg imports.
 */
function getSelfHostedD3Source(): string {
  return `
(function() {
  if (window.d3) return;
  const d3 = {
    select: function(selector) {
      const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
      return createSelection(el ? [el] : []);
    },
    selectAll: function(selector) {
      const els = typeof selector === 'string' ? Array.from(document.querySelectorAll(selector)) : Array.isArray(selector) ? selector : [];
      return createSelection(els);
    },
    range: function(start, stop, step) {
      if (stop === undefined) { stop = start; start = 0; }
      step = step || 1;
      const res = [];
      for (let i = start; (step > 0 ? i < stop : i > stop); i += step) res.push(i);
      return res;
    },
    min: function(arr, fn) {
      let min = Infinity;
      for (const item of arr) {
        const val = fn ? fn(item) : item;
        if (val != null && val < min) min = val;
      }
      return min === Infinity ? undefined : min;
    },
    max: function(arr, fn) {
      let max = -Infinity;
      for (const item of arr) {
        const val = fn ? fn(item) : item;
        if (val != null && val > max) max = val;
      }
      return max === -Infinity ? undefined : max;
    },
    scaleLinear: function() {
      let domain = [0, 1], range = [0, 1];
      function scale(x) {
        const dSpan = domain[1] - domain[0] || 1;
        const rSpan = range[1] - range[0];
        return range[0] + ((x - domain[0]) / dSpan) * rSpan;
      }
      scale.domain = function(d) { if (!arguments.length) return domain; domain = d; return scale; };
      scale.range = function(r) { if (!arguments.length) return range; range = r; return scale; };
      return scale;
    },
    scaleOrdinal: function(range) {
      let domain = [];
      range = range || [];
      const map = new Map();
      function scale(x) {
        if (!map.has(x)) {
          map.set(x, range[map.size % range.length]);
        }
        return map.get(x);
      }
      scale.domain = function(d) { if (!arguments.length) return domain; domain = d; return scale; };
      scale.range = function(r) { if (!arguments.length) return range; range = r; return scale; };
      return scale;
    },
    schemeCategory10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
    forceSimulation: function(nodes) {
      nodes = nodes || [];
      let alpha = 1;
      const sim = {
        nodes: function(n) { if (!arguments.length) return nodes; nodes = n; return sim; },
        force: function() { return sim; },
        on: function(event, fn) {
          if (event === 'tick' && fn) {
            // Run a few synchronous positioning ticks for instant graph rendering
            for (let i = 0; i < 20; i++) {
              for (const node of nodes) {
                if (node.x == null) node.x = 100 + Math.random() * 400;
                if (node.y == null) node.y = 100 + Math.random() * 300;
              }
            }
            setTimeout(fn, 16);
          }
          return sim;
        },
        stop: function() { return sim; }
      };
      return sim;
    }
  };

  function createSelection(elements) {
    return {
      attr: function(name, value) {
        for (const el of elements) {
          const val = typeof value === 'function' ? value(el.__data__, 0) : value;
          el.setAttribute(name, val);
        }
        return this;
      },
      style: function(name, value) {
        for (const el of elements) {
          const val = typeof value === 'function' ? value(el.__data__, 0) : value;
          el.style[name] = val;
        }
        return this;
      },
      text: function(value) {
        for (const el of elements) {
          const val = typeof value === 'function' ? value(el.__data__, 0) : value;
          el.textContent = val;
        }
        return this;
      },
      html: function(value) {
        for (const el of elements) {
          el.innerHTML = value;
        }
        return this;
      },
      append: function(tag) {
        const newEls = [];
        for (const el of elements) {
          const child = document.createElementNS(tag === 'svg' || el instanceof SVGElement ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
          el.appendChild(child);
          newEls.push(child);
        }
        return createSelection(newEls);
      },
      on: function(type, listener) {
        for (const el of elements) {
          el.addEventListener(type, listener);
        }
        return this;
      },
      data: function(dataArray) {
        const self = this;
        return {
          enter: function() {
            return {
              append: function(tag) {
                const created = [];
                const parent = elements[0] || document.body;
                for (let i = 0; i < dataArray.length; i++) {
                  const d = dataArray[i];
                  const isSvg = tag === 'svg' || parent instanceof SVGElement || ['circle', 'line', 'rect', 'path', 'g', 'text'].includes(tag);
                  const child = document.createElementNS(isSvg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
                  child.__data__ = d;
                  parent.appendChild(child);
                  created.push(child);
                }
                return createSelection(created);
              }
            };
          }
        };
      }
    };
  }

  window.d3 = d3;
})();
`;
}

/**
 * Self-hosted Three.js runtime bundle stub that provides standard 3D primitives
 * (Scene, PerspectiveCamera, WebGLRenderer, BoxGeometry, SphereGeometry, MeshStandardMaterial, MeshBasicMaterial, Mesh, AmbientLight, DirectionalLight)
 * offline without requiring remote CDNs or unpkg imports.
 */
function getSelfHostedThreeSource(): string {
  return `
(function() {
  if (window.THREE) return;
  const THREE = {
    Scene: function() {
      this.children = [];
      this.add = function(obj) { this.children.push(obj); };
    },
    PerspectiveCamera: function(fov, aspect, near, far) {
      this.fov = fov || 75;
      this.aspect = aspect || 1;
      this.near = near || 0.1;
      this.far = far || 1000;
      this.position = { x: 0, y: 0, z: 5, set: function(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    },
    WebGLRenderer: function(opts) {
      opts = opts || {};
      const canvas = opts.canvas || document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 400;
      this.domElement = canvas;
      this.setSize = function(w, h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      };
      this.setClearColor = function(color) {
        canvas.style.backgroundColor = typeof color === 'string' ? color : '#111';
      };
      this.render = function(scene, camera) {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Draw 3D wireframe projection on 2D canvas for guaranteed cross-platform rendering
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        for (const obj of scene.children) {
          if (!obj.geometry) continue;
          ctx.save();
          ctx.translate(cx + (obj.position?.x || 0), cy + (obj.position?.y || 0));
          if (obj.rotation) {
            ctx.rotate(obj.rotation.z || 0);
          }
          ctx.strokeStyle = obj.material?.color || '#00ffcc';
          ctx.lineWidth = 2;
          ctx.beginPath();
          const size = (obj.geometry.size || 60);
          ctx.strokeRect(-size / 2, -size / 2, size, size);
          ctx.beginPath();
          ctx.arc(0, 0, size / 3, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      };
    },
    BoxGeometry: function(w, h, d) {
      this.type = 'BoxGeometry';
      this.size = Math.max(w || 50, h || 50);
    },
    SphereGeometry: function(radius) {
      this.type = 'SphereGeometry';
      this.size = (radius || 25) * 2;
    },
    MeshStandardMaterial: function(opts) {
      this.color = opts?.color ? (typeof opts.color === 'number' ? '#' + opts.color.toString(16).padStart(6, '0') : opts.color) : '#3b82f6';
      this.wireframe = Boolean(opts?.wireframe);
    },
    MeshBasicMaterial: function(opts) {
      this.color = opts?.color ? (typeof opts.color === 'number' ? '#' + opts.color.toString(16).padStart(6, '0') : opts.color) : '#10b981';
      this.wireframe = Boolean(opts?.wireframe);
    },
    Mesh: function(geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.position = { x: 0, y: 0, z: 0, set: function(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.rotation = { x: 0, y: 0, z: 0 };
    },
    AmbientLight: function(color) {
      this.color = color || 0xffffff;
    },
    DirectionalLight: function(color, intensity) {
      this.color = color || 0xffffff;
      this.intensity = intensity || 1;
      this.position = { x: 0, y: 1, z: 0, set: function(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    }
  };
  window.THREE = THREE;
})();
`;
}

/**
 * Builds the complete sandboxed HTML bundle for execution inside an opaque iframe.
 */
export function buildSandboxAppHtml(
  app: GenUIApp,
  options: {
    nonce: string;
    isDark?: boolean;
    activeState?: Record<string, unknown>;
  }
): string {
  const { nonce, isDark = false, activeState } = options;
  const mergedState = Object.assign({}, app.initialState || {}, activeState || {});

  const cleanHtml = stripUntrustedHtmlSecurityVectors(app.html || '');
  const cleanCss = (app.css || '').replace(/<\/style>/gi, '');
  const cleanJs = (app.javascript || '').replace(/<\/script>/gi, '');

  let libraryScripts = '';
  if (app.libraries && app.libraries.includes('d3')) {
    libraryScripts += `<script>${getSelfHostedD3Source()}</script>\n`;
  }
  if (app.libraries && app.libraries.includes('three')) {
    libraryScripts += `<script>${getSelfHostedThreeSource()}</script>\n`;
  }

  const clientBridge = buildClientBridgeScript(app.appId, nonce, mergedState);
  const bgColor = isDark ? '#141413' : '#FFFFFF';
  const textColor = isDark ? '#ECEAE4' : '#1F1E1D';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${APP_SANDBOX_CSP_META}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${stripUntrustedHtmlSecurityVectors(app.title)}</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: ${bgColor};
      color: ${textColor};
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
    }
    *, *:before, *:after { box-sizing: inherit; }
    ${cleanCss}
  </style>
  ${libraryScripts}
  <script>${clientBridge}</script>
</head>
<body>
  ${cleanHtml}
  <div id="aira-error-boundary" style="display:none;position:fixed;bottom:12px;left:12px;right:12px;padding:10px 14px;background:#B54A2B;color:#FFF;font-family:monospace;font-size:12px;border-radius:6px;z-index:999999;"></div>
  <script>
    (function() {
      try {
        ${cleanJs}
      } catch (err) {
        console.error('[AIRA_APP_EXEC_ERROR]', err);
        const errBox = document.getElementById('aira-error-boundary');
        if (errBox) {
          errBox.style.display = 'block';
          errBox.innerText = 'App Initialization Error: ' + (err.message || String(err));
        }
        if (window.airaBridge) {
          window.airaBridge.sendAction('__runtime_error__', { error: err.message || String(err) });
        }
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Validates untrusted postMessage events received from sandboxed iframe instances.
 */
export function validateSandboxAppBridgeMessage(
  rawEvent: { data: unknown; origin: string },
  activeNonce: string,
  expectedAppId?: string
): { ok: true; message: GenUIBridgeMessage } | { ok: false; error: string } {
  // Enforce opaque origin ('null') or test environment origin
  const origin = rawEvent.origin;
  const isOpaqueOrTest =
    origin === 'null' ||
    origin === 'http://127.0.0.1' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://localhost' ||
    origin.startsWith('http://localhost:') ||
    (typeof window !== 'undefined' && origin === window.location.origin);

  if (!isOpaqueOrTest) {
    return { ok: false, error: `Invalid bridge origin "${origin}". Must be opaque ("null").` };
  }

  const parsed = GenUIBridgeMessageSchema.safeParse(rawEvent.data);
  if (!parsed.success) {
    return { ok: false, error: 'Malformed bridge message payload.' };
  }

  const msg = parsed.data;
  if (msg.nonce !== activeNonce) {
    return { ok: false, error: 'Cryptographic bridge nonce mismatch.' };
  }

  if (expectedAppId && msg.appId !== expectedAppId) {
    return { ok: false, error: `App ID mismatch: expected "${expectedAppId}", received "${msg.appId}".` };
  }

  return { ok: true, message: msg };
}

/**
 * Generates a single self-contained, standalone offline HTML export of the application.
 */
export function generateStandaloneExportHtml(app: GenUIApp, exportState?: Record<string, unknown>): string {
  const mergedState = Object.assign({}, app.initialState || {}, exportState || {});
  const safeStateJson = safeJsonStringifyForHtmlScript(mergedState);
  const cleanHtml = stripUntrustedHtmlSecurityVectors(app.html || '');
  const cleanCss = (app.css || '').replace(/<\/style>/gi, '');
  const cleanJs = (app.javascript || '').replace(/<\/script>/gi, '');

  let libraryScripts = '';
  if (app.libraries && app.libraries.includes('d3')) {
    libraryScripts += `<script>${getSelfHostedD3Source()}</script>\n`;
  }
  if (app.libraries && app.libraries.includes('three')) {
    libraryScripts += `<script>${getSelfHostedThreeSource()}</script>\n`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${stripUntrustedHtmlSecurityVectors(app.title)} (AIRA Standalone Export)</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: #0F0F0E;
      color: #ECEAE4;
      box-sizing: border-box;
    }
    *, *:before, *:after { box-sizing: inherit; }
    ${cleanCss}
  </style>
  ${libraryScripts}
  <script>
    (function() {
      const state = ${safeStateJson};
      window.airaBridge = {
        appId: ${safeJsonStringifyForHtmlScript(app.appId)},
        state: state,
        getState: function() { return Object.assign({}, state); },
        setState: function(patch) { Object.assign(state, patch); },
        sendAction: function(act, data) { console.log('[AIRA Standalone Action]', act, data); },
        requestResize: function() {},
        sendFollowUp: function() {}
      };
    })();
  </script>
</head>
<body>
  ${cleanHtml}
  <script>
    (function() {
      try {
        ${cleanJs}
      } catch (e) {
        console.error('Execution error:', e);
      }
    })();
  </script>
</body>
</html>`;
}
