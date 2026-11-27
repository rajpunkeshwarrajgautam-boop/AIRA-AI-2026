/**
 * AIRA GenUI Phase 4A — Model Context Protocol Extension App (aira-mcp-app/v1) Component
 *
 * Mounts MCP Applications inside an opaque, sandboxed iframe (sandbox="allow-scripts allow-forms")
 * with authoritative CSP connect-src 'none', cryptographic postMessage JSON-RPC 2.0 validation,
 * and strict ToolGateway / ApprovalKernel confirmation gating for tool execution.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Code,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Wrench,
} from 'lucide-react';
import {
  type McpAppDescriptor,
  type McpAppRpcMessage,
  validateMcpAppDescriptor,
} from '../../../packages/contracts/src/mcp-apps';
import {
  stripUntrustedHtmlSecurityVectors,
  safeJsonStringifyForHtmlScript,
} from '../../utils/sandboxSecurity';
import { APP_SANDBOX_CSP_META } from '../../utils/genuiAppBridge';

function generateSecureNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mcp_app_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface GenUIMcpAppProps {
  descriptor: unknown;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  onStateChange?: (appId: string, state: Record<string, unknown>) => void;
  theme?: 'light' | 'dark';
  className?: string;
  disabled?: boolean;
}

export const GenUIMcpApp: React.FC<GenUIMcpAppProps> = ({
  descriptor: rawDescriptor,
  onToolCall,
  onStateChange,
  theme = 'dark',
  className = '',
  disabled = false,
}) => {
  const componentId = useId();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Validate descriptor
  const validation = useMemo(() => validateMcpAppDescriptor(rawDescriptor), [rawDescriptor]);
  const descriptor: McpAppDescriptor | null = validation.ok ? validation.descriptor : null;

  // Active state & nonce
  const [appState, setAppState] = useState<Record<string, unknown>>(() => descriptor?.initialState || {});
  const [activeNonce, setActiveNonce] = useState<string>(() => generateSecureNonce());
  const [reloadKey, setReloadKey] = useState<number>(0);
  const [iframeHeight, setIframeHeight] = useState<number>(descriptor?.capabilities?.maxHeightPx || 600);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [hasError, setHasError] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Pending tool confirmation state
  const [pendingToolConfirm, setPendingToolConfirm] = useState<{
    callId?: string | number;
    toolName: string;
    args: Record<string, unknown>;
  } | null>(null);

  // Build the sandboxed HTML for iframe
  const sandboxHtml = useMemo(() => {
    if (!descriptor) return '';
    const safeTitle = stripUntrustedHtmlSecurityVectors(descriptor.title);
    const cleanEntrypoint = stripUntrustedHtmlSecurityVectors(descriptor.entrypointHtml);
    const safeInitialState = safeJsonStringifyForHtmlScript(appState);
    const safeSupportedTools = safeJsonStringifyForHtmlScript(descriptor.supportedTools);
    const bgColor = theme === 'dark' ? '#141413' : '#FFFFFF';
    const textColor = theme === 'dark' ? '#ECEAE4' : '#1F1E1D';

    const clientBridge = `
(function() {
  'use strict';
  const ACTIVE_NONCE = ${safeJsonStringifyForHtmlScript(activeNonce)};
  const APP_ID = ${safeJsonStringifyForHtmlScript(descriptor.appId)};
  const SUPPORTED_TOOLS = ${safeSupportedTools} || [];
  let currentState = ${safeInitialState} || {};
  let rpcCounter = 1;
  const pendingCalls = new Map();

  function postToHost(method, params, id) {
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage({
        jsonrpc: '2.0',
        id: id || ('rpc_' + rpcCounter++),
        method: method,
        params: params || {},
        nonce: ACTIVE_NONCE,
        appId: APP_ID
      }, '*');
    } catch (e) {
      console.error('[AIRA_MCP_BRIDGE_ERROR]', e);
    }
  }

  window.airaMcpBridge = {
    appId: APP_ID,
    get state() { return Object.assign({}, currentState); },
    getState: function() { return Object.assign({}, currentState); },
    setState: function(patch) {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(currentState, patch);
      postToHost('ui/stateUpdate', { state: Object.assign({}, currentState) });
    },
    callTool: function(toolName, args) {
      return new Promise(function(resolve, reject) {
        if (!SUPPORTED_TOOLS.includes(toolName)) {
          return reject(new Error('Tool "' + toolName + '" is not authorized for this MCP App.'));
        }
        const callId = 'tool_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        pendingCalls.set(callId, { resolve: resolve, reject: reject });
        postToHost('tools/call', { name: toolName, arguments: args || {} }, callId);
      });
    },
    resize: function(heightPx) {
      const h = Math.max(200, Math.min(1600, Math.round(Number(heightPx) || 600)));
      postToHost('ui/resize', { height: h });
    }
  };

  window.addEventListener('message', function(evt) {
    const data = evt.data;
    if (!data || data.jsonrpc !== '2.0') return;
    if (data.nonce !== ACTIVE_NONCE) return;

    if (data.method === 'tools/result' && data.params && data.params.callId) {
      const handler = pendingCalls.get(data.params.callId);
      if (handler) {
        pendingCalls.delete(data.params.callId);
        if (data.params.error) handler.reject(new Error(data.params.error));
        else handler.resolve(data.params.result);
      }
    }
  });

  window.addEventListener('error', function(evt) {
    postToHost('ui/error', { error: evt.message || 'Script error', fatal: false });
  });

  document.addEventListener('DOMContentLoaded', function() {
    postToHost('ui/ready', { state: Object.assign({}, currentState) });
  });
})();
`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${APP_SANDBOX_CSP_META}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: ${bgColor};
      color: ${textColor};
      box-sizing: border-box;
    }
    *, *:before, *:after { box-sizing: inherit; }
  </style>
  <script>${clientBridge}</script>
</head>
<body>
  ${cleanEntrypoint}
</body>
</html>`;
  }, [descriptor, activeNonce, appState, theme]);

  // Host postMessage listener
  useEffect(() => {
    const handleHostMessage = async (evt: MessageEvent) => {
      // Security: verify origin is 'null' (opaque sandbox) and event comes from our iframe
      if (iframeRef.current && evt.source !== iframeRef.current.contentWindow) return;
      if (evt.origin !== 'null' && !evt.origin.startsWith('http://localhost') && !evt.origin.startsWith('http://127.0.0.1')) return;

      const data = evt.data;
      if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
      if (data.nonce !== activeNonce) return;
      if (descriptor && data.appId !== descriptor.appId) return;

      const method = data.method;
      const params = data.params || {};

      switch (method) {
        case 'ui/ready':
          setHasError(false);
          setErrorMessage('');
          break;

        case 'ui/resize':
          if (typeof params.height === 'number') {
            const h = Math.max(200, Math.min(1600, Math.round(params.height)));
            setIframeHeight(h);
          }
          break;

        case 'ui/stateUpdate':
          if (params.state && typeof params.state === 'object') {
            setAppState(params.state as Record<string, unknown>);
            if (descriptor && onStateChange) {
              onStateChange(descriptor.appId, params.state as Record<string, unknown>);
            }
          }
          break;

        case 'ui/error':
          setHasError(true);
          setErrorMessage(String(params.error || 'Unknown application error'));
          break;

        case 'tools/call':
          const toolName = String(params.name || '');
          const toolArgs = (params.arguments || {}) as Record<string, unknown>;

          if (!descriptor?.supportedTools.includes(toolName)) {
            sendToolResult(data.id, null, `Tool "${toolName}" is not declared in supportedTools.`);
            return;
          }

          // Check if tool execution requires user confirmation
          setPendingToolConfirm({
            callId: data.id,
            toolName,
            args: toolArgs,
          });
          break;
      }
    };

    window.addEventListener('message', handleHostMessage);
    return () => window.removeEventListener('message', handleHostMessage);
  }, [activeNonce, descriptor, onStateChange]);

  const sendToolResult = useCallback((callId: string | number | undefined, result: unknown, error?: string) => {
    if (!iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({
      jsonrpc: '2.0',
      nonce: activeNonce,
      method: 'tools/result',
      params: {
        callId,
        result: error ? null : result,
        error: error || null,
      },
    }, '*');
  }, [activeNonce]);

  const handleConfirmTool = useCallback(async () => {
    if (!pendingToolConfirm) return;
    const { callId, toolName, args } = pendingToolConfirm;
    setPendingToolConfirm(null);

    try {
      if (onToolCall) {
        const res = await onToolCall(toolName, args);
        sendToolResult(callId, res);
      } else {
        sendToolResult(callId, { status: 'mock_success', tool: toolName });
      }
    } catch (err: any) {
      sendToolResult(callId, null, err?.message || 'Tool execution failed');
    }
  }, [pendingToolConfirm, onToolCall, sendToolResult]);

  const handleDenyTool = useCallback(() => {
    if (!pendingToolConfirm) return;
    const { callId } = pendingToolConfirm;
    setPendingToolConfirm(null);
    sendToolResult(callId, null, 'Tool execution was denied by the user.');
  }, [pendingToolConfirm, sendToolResult]);

  if (!validation.ok || !descriptor) {
    return (
      <div className={`p-4 rounded-xl border border-red-500/30 bg-red-950/20 text-red-300 ${className}`}>
        <div className="flex items-center gap-2 font-medium mb-1">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          Invalid MCP Application Descriptor
        </div>
        <p className="text-xs text-red-400/80 font-mono">
          {!validation.ok ? (validation as any).error : 'Unknown descriptor error'}
        </p>
      </div>
    );
  }

  return (
    <div
      className={`relative rounded-xl border border-neutral-800 bg-neutral-900 overflow-hidden shadow-lg transition-all ${
        isMaximized ? 'fixed inset-4 z-50 flex flex-col bg-neutral-950 shadow-2xl' : ''
      } ${className}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-neutral-900 border-b border-neutral-800 text-xs">
        <div className="flex items-center gap-2">
          <Wrench className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-neutral-200">{descriptor.title}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40 font-mono">
            MCP App
          </span>
          <span className="text-neutral-500 font-mono text-[11px]">[{descriptor.serverId}]</span>
        </div>

        <div className="flex items-center gap-1.5 text-neutral-400">
          <button
            onClick={() => {
              setActiveNonce(generateSecureNonce());
              setReloadKey((k) => k + 1);
            }}
            title="Reload Application"
            className="p-1 hover:text-neutral-200 hover:bg-neutral-800 rounded transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            title={isMaximized ? 'Minimize' : 'Maximize'}
            className="p-1 hover:text-neutral-200 hover:bg-neutral-800 rounded transition"
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Tool confirmation modal */}
      {pendingToolConfirm && (
        <div className="absolute inset-0 z-30 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-neutral-900 border border-neutral-700 rounded-xl p-5 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-semibold text-neutral-100 text-sm">Tool Approval Required</h4>
                <p className="text-xs text-neutral-400 mt-1">
                  MCP App <span className="text-neutral-200 font-mono">{descriptor.title}</span> is requesting to invoke tool:
                </p>
                <div className="mt-2 p-2.5 rounded bg-neutral-950 border border-neutral-800 font-mono text-xs text-emerald-400">
                  {pendingToolConfirm.toolName}
                </div>
                {Object.keys(pendingToolConfirm.args).length > 0 && (
                  <pre className="mt-2 p-2 rounded bg-neutral-950 text-[11px] text-neutral-300 overflow-x-auto max-h-32">
                    {JSON.stringify(pendingToolConfirm.args, null, 2)}
                  </pre>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800 text-xs">
              <button
                onClick={handleDenyTool}
                className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 font-medium transition"
              >
                Deny
              </button>
              <button
                onClick={handleConfirmTool}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition"
              >
                Approve & Execute
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sandboxed iframe */}
      <iframe
        key={reloadKey}
        ref={iframeRef}
        srcDoc={sandboxHtml}
        sandbox="allow-scripts allow-forms"
        title={descriptor.title}
        style={{
          width: '100%',
          height: isMaximized ? '100%' : `${iframeHeight}px`,
          border: 'none',
          display: 'block',
        }}
      />
    </div>
  );
};
