import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Code,
  Download,
  Eye,
  FileCode,
  Maximize2,
  Minimize2,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import {
  type GenUIApp,
  type GenUIBridgeMessage,
  type GenUIStateRecord,
  validateGenUIApp,
} from '../../../packages/contracts/src/genui';
import {
  buildSandboxAppHtml,
  generateStandaloneExportHtml,
  validateSandboxAppBridgeMessage,
} from '../../utils/genuiAppBridge';

function generateSecureNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `aira_nonce_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface GenUISandboxAppProps {
  app: unknown;
  initialStateOverride?: GenUIStateRecord;
  onStateChange?: (appId: string, nextState: GenUIStateRecord) => void;
  onAction?: (actionId: string, payload: unknown, app: GenUIApp) => void | Promise<void>;
  onFollowUp?: (prompt: string, app: GenUIApp) => void;
  onExportHtml?: (app: GenUIApp) => void;
  theme?: 'light' | 'dark';
  disabled?: boolean;
  className?: string;
}

export const GenUISandboxApp: React.FC<GenUISandboxAppProps> = ({
  app: rawApp,
  initialStateOverride,
  onStateChange,
  onAction,
  onFollowUp,
  onExportHtml,
  theme = 'dark',
  disabled = false,
  className = '',
}) => {
  const componentInstanceId = useId();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Validate the input app definition
  const validation = useMemo(() => validateGenUIApp(rawApp), [rawApp]);
  const validatedApp: GenUIApp | null = validation.ok ? validation.app : null;

  // Track app state: initialize from props or app.initialState
  const [appState, setAppState] = useState<GenUIStateRecord>(() => {
    return initialStateOverride || validatedApp?.initialState || {};
  });

  // State update sync when prop override changes
  useEffect(() => {
    if (initialStateOverride) {
      setAppState(initialStateOverride);
    }
  }, [initialStateOverride]);

  // Nonce generation per sandbox mount / reload cycle
  const [activeNonce, setActiveNonce] = useState<string>(() => generateSecureNonce());
  const [reloadKey, setReloadKey] = useState<number>(0);

  // Dynamic iframe height
  const defaultHeight = validatedApp?.height ? Math.min(Math.max(validatedApp.height, 220), 1200) : 420;
  const [iframeHeight, setIframeHeight] = useState<number>(defaultHeight);

  // Inspector modal & tabs
  const [isInspectorOpen, setIsInspectorOpen] = useState<boolean>(false);
  const [activeInspectorTab, setActiveInspectorTab] = useState<'preview' | 'html' | 'css' | 'js' | 'state' | 'console'>('preview');
  const [consoleLogs, setConsoleLogs] = useState<Array<{ type: string; message: string; timestamp: number }>>([]);
  const [hasRuntimeError, setHasRuntimeError] = useState<boolean>(false);
  const [lastErrorMessage, setLastErrorMessage] = useState<string>('');

  // Handle iframe reload
  const handleReload = useCallback(() => {
    setActiveNonce(generateSecureNonce());
    setReloadKey((k) => k + 1);
    setHasRuntimeError(false);
    setLastErrorMessage('');
    setConsoleLogs((prev) => [
      ...prev,
      { type: 'info', message: 'Sandbox reloaded with fresh cryptographic nonce.', timestamp: Date.now() },
    ]);
  }, []);

  // PostMessage Bridge listener
  useEffect(() => {
    const handleWindowMessage = (event: MessageEvent) => {
      // Validate that message came from our iframe (or opaque sandbox origin null)
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) {
        return;
      }

      const bridgeResult = validateSandboxAppBridgeMessage(event, activeNonce, validatedApp?.appId);
      if (!bridgeResult.ok) {
        return;
      }

      const msg: GenUIBridgeMessage = bridgeResult.message;

      switch (msg.type) {
        case 'GENUI_APP_READY': {
          setConsoleLogs((prev) => [
            ...prev,
            { type: 'info', message: 'Bridge ready. App initialized successfully.', timestamp: Date.now() },
          ]);
          break;
        }

        case 'GENUI_APP_RESIZE': {
          const requestedHeight = msg.payload?.height;
          if (typeof requestedHeight === 'number' && Number.isFinite(requestedHeight)) {
            const clamped = Math.min(Math.max(requestedHeight, 180), 1200);
            setIframeHeight(clamped);
          }
          break;
        }

        case 'GENUI_APP_STATE_UPDATE': {
          const nextState = (msg.payload?.stateSnapshot || msg.payload?.state) as GenUIStateRecord | undefined;
          if (nextState && typeof nextState === 'object' && !Array.isArray(nextState)) {
            setAppState((prev) => {
              const merged = { ...prev, ...nextState };
              if (validatedApp) {
                onStateChange?.(validatedApp.appId, merged);
              }
              return merged;
            });
            setConsoleLogs((prev) => [
              ...prev,
              {
                type: 'state',
                message: `State updated: ${JSON.stringify(nextState).slice(0, 140)}`,
                timestamp: Date.now(),
              },
            ]);
          }
          break;
        }

        case 'GENUI_APP_ACTION': {
          const actionId = String(msg.payload?.actionId || '');
          const actionPayload = msg.payload?.stateSnapshot || msg.payload?.payload;
          setConsoleLogs((prev) => [
            ...prev,
            {
              type: 'action',
              message: `Action dispatched: ${actionId}`,
              timestamp: Date.now(),
            },
          ]);
          if (validatedApp && !disabled) {
            void onAction?.(actionId, actionPayload, validatedApp);
          }
          break;
        }

        case 'GENUI_APP_FOLLOWUP': {
          const prompt = String(msg.payload?.prompt || '').trim();
          if (prompt && validatedApp && !disabled) {
            setConsoleLogs((prev) => [
              ...prev,
              { type: 'followup', message: `Follow-up suggested: "${prompt}"`, timestamp: Date.now() },
            ]);
            onFollowUp?.(prompt, validatedApp);
          }
          break;
        }

        case 'GENUI_APP_ERROR': {
          const errMsg = String(msg.payload?.error || msg.payload?.message || 'Unknown sandbox error');
          setHasRuntimeError(true);
          setLastErrorMessage(errMsg);
          setConsoleLogs((prev) => [
            ...prev,
            { type: 'error', message: `Runtime error: ${errMsg}`, timestamp: Date.now() },
          ]);
          break;
        }
      }
    };

    window.addEventListener('message', handleWindowMessage);
    return () => {
      window.removeEventListener('message', handleWindowMessage);
    };
  }, [activeNonce, disabled, onAction, onFollowUp, onStateChange, validatedApp]);

  // Handle export to standalone HTML file
  const handleExportDownload = useCallback(() => {
    if (!validatedApp) return;
    if (onExportHtml) {
      onExportHtml(validatedApp);
      return;
    }
    const htmlContent = generateStandaloneExportHtml(validatedApp);
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `aira-app-${validatedApp.appId}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [onExportHtml, validatedApp]);

  // Initial mount state snapshot preserved across internal sandbox interactions
  const initialMountState = useMemo(() => {
    return initialStateOverride || validatedApp?.initialState || {};
  }, [reloadKey, validatedApp]);

  // Construct sandbox HTML document (rebuilt only on explicit reload or theme toggle)
  const sandboxHtmlDoc = useMemo(() => {
    if (!validatedApp) return '';
    return buildSandboxAppHtml(validatedApp, {
      nonce: activeNonce,
      isDark: theme === 'dark',
      activeState: initialMountState,
    });
  }, [validatedApp, activeNonce, theme, reloadKey, initialMountState]);

  // Render validation failure
  if (!validation.ok || !validatedApp) {
    const errorMsg = !validation.ok ? validation.error : 'Validation failed.';
    return (
      <div
        className={`rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400 ${className}`}
        data-testid="genui-app-validation-error"
      >
        <div className="font-semibold text-red-300">Invalid Application Definition</div>
        <p className="mt-1 text-xs opacity-90">{errorMsg}</p>
        <div className="mt-2 text-xs text-gray-400">
          Fallback: {String((rawApp as any)?.textFallback || (rawApp as any)?.title || 'Application rendering error.')}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-claude-border-light/80 bg-white shadow-sm transition-all dark:border-claude-border-dark/80 dark:bg-slate-900/95 ${className}`}
      data-testid={`genui-app-${validatedApp.appId}`}
      data-app-type={validatedApp.appType}
    >
      {/* App Toolbar / Header */}
      <div className="flex items-center justify-between border-b border-claude-border-light/60 bg-claude-surface-light/70 px-4 py-2.5 backdrop-blur-sm dark:border-claude-border-dark/60 dark:bg-slate-800/70">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-aira-blue/15 text-aira-blue dark:bg-aira-blue/25">
            <Eye className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-xs font-semibold text-claude-text-light dark:text-claude-text-dark">
              {validatedApp.title}
            </h3>
            {validatedApp.description && (
              <p className="truncate text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                {validatedApp.description}
              </p>
            )}
          </div>
          <span className="shrink-0 rounded-full border border-claude-border-light/80 bg-claude-surface-light px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-claude-muted-light dark:border-claude-border-dark/80 dark:bg-slate-800 dark:text-claude-muted-dark">
            {validatedApp.appType.replace('_', ' ')}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Security Indicator */}
          <span
            className="hidden sm:inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
            title="Opaque origin sandbox with connect-src 'none'. Zero external network exfiltration."
          >
            <ShieldCheck className="h-3 w-3" />
            <span>Sandboxed</span>
          </span>

          {/* Inspect Source Button */}
          <button
            type="button"
            onClick={() => setIsInspectorOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-claude-border-light/80 bg-white px-2 py-1 text-[11px] font-medium text-claude-text-light hover:bg-gray-50 transition-colors dark:border-claude-border-dark/80 dark:bg-slate-850 dark:text-claude-text-dark dark:hover:bg-slate-800"
            title="Inspect Application Source Code and State"
            data-testid="genui-app-inspect-btn"
          >
            <Code className="h-3 w-3" />
            <span className="hidden md:inline">Inspect</span>
          </button>

          {/* Export HTML Button */}
          <button
            type="button"
            onClick={handleExportDownload}
            className="inline-flex items-center gap-1 rounded-lg border border-claude-border-light/80 bg-white px-2 py-1 text-[11px] font-medium text-claude-text-light hover:bg-gray-50 transition-colors dark:border-claude-border-dark/80 dark:bg-slate-850 dark:text-claude-text-dark dark:hover:bg-slate-800"
            title="Export Standalone Self-Contained HTML"
            data-testid="genui-app-export-btn"
          >
            <Download className="h-3 w-3" />
            <span className="hidden md:inline">Export</span>
          </button>

          {/* Reload Sandbox */}
          <button
            type="button"
            onClick={handleReload}
            className="inline-flex h-6 w-6 items-center justify-center rounded-lg border border-claude-border-light/80 bg-white text-claude-muted-light hover:bg-gray-50 hover:text-claude-text-light transition-colors dark:border-claude-border-dark/80 dark:bg-slate-850 dark:text-claude-muted-dark dark:hover:bg-slate-800 dark:hover:text-claude-text-dark"
            title="Reload Sandbox"
            data-testid="genui-app-reload-btn"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Error Banner if sandbox crashed */}
      {hasRuntimeError && (
        <div className="flex items-center justify-between bg-amber-500/10 px-4 py-2 border-b border-amber-500/20 text-xs text-amber-500 dark:text-amber-400">
          <div className="truncate">
            <span className="font-semibold">App Warning:</span> {lastErrorMessage}
          </div>
          <button
            type="button"
            onClick={handleReload}
            className="shrink-0 ml-2 underline text-[11px] font-medium hover:text-amber-600 dark:hover:text-amber-300"
          >
            Retry
          </button>
        </div>
      )}

      {/* Sandboxed Opaque Iframe Container */}
      <div className="relative w-full bg-slate-950/20 transition-[height] duration-150">
        <iframe
          key={`${validatedApp.appId}-${reloadKey}`}
          ref={iframeRef}
          srcDoc={sandboxHtmlDoc}
          title={validatedApp.title}
          sandbox="allow-scripts allow-forms"
          allow=""
          style={{ height: `${iframeHeight}px`, minHeight: '180px', maxHeight: '1200px' }}
          className="w-full border-none transition-all block"
          data-testid="genui-sandbox-iframe"
        />
      </div>

      {/* Inspector Modal / Overlay Drawer */}
      {isInspectorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          data-testid="genui-app-inspector-modal"
        >
          <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-claude-border-light bg-white shadow-2xl dark:border-claude-border-dark dark:bg-slate-900">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-claude-border-light px-5 py-3.5 dark:border-claude-border-dark">
              <div className="flex items-center gap-2">
                <FileCode className="h-4 w-4 text-aira-blue" />
                <h3 className="text-sm font-semibold text-claude-text-light dark:text-claude-text-dark">
                  Source Inspector — {validatedApp.title}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleExportDownload}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border-light bg-white px-2.5 py-1 text-xs font-medium text-claude-text-light hover:bg-gray-50 dark:border-claude-border-dark dark:bg-slate-800 dark:text-claude-text-dark dark:hover:bg-slate-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download Offline HTML</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsInspectorOpen(false)}
                  className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-slate-800 dark:hover:text-gray-200"
                  data-testid="genui-app-inspector-close"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-claude-border-light bg-gray-50 px-4 text-xs dark:border-claude-border-dark dark:bg-slate-850">
              {(['preview', 'html', 'css', 'js', 'state', 'console'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveInspectorTab(tab)}
                  className={`border-b-2 px-3.5 py-2 font-medium capitalize transition-colors ${
                    activeInspectorTab === tab
                      ? 'border-aira-blue text-aira-blue dark:border-aira-blue dark:text-aira-blue'
                      : 'border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
                  }`}
                  data-testid={`genui-inspector-tab-${tab}`}
                >
                  {tab === 'js' ? 'JavaScript' : tab === 'html' ? 'HTML' : tab === 'css' ? 'CSS' : tab}
                </button>
              ))}
            </div>

            {/* Modal Tab Content */}
            <div className="flex-1 overflow-auto p-4 bg-slate-950 font-mono text-xs text-slate-200">
              {activeInspectorTab === 'preview' && (
                <div className="h-full w-full rounded-lg bg-slate-900 p-2 overflow-hidden flex flex-col">
                  <div className="text-[11px] text-gray-400 mb-2">Live Sandboxed View:</div>
                  <iframe
                    srcDoc={sandboxHtmlDoc}
                    title="Inspector Live Preview"
                    sandbox="allow-scripts allow-forms"
                    className="w-full flex-1 border border-slate-700 rounded-md"
                  />
                </div>
              )}

              {activeInspectorTab === 'html' && (
                <pre className="whitespace-pre-wrap selection:bg-aira-blue/30 p-2">
                  {validatedApp.html || '<!-- No HTML content defined -->'}
                </pre>
              )}

              {activeInspectorTab === 'css' && (
                <pre className="whitespace-pre-wrap selection:bg-aira-blue/30 p-2">
                  {validatedApp.css || '/* No CSS styles defined */'}
                </pre>
              )}

              {activeInspectorTab === 'js' && (
                <pre className="whitespace-pre-wrap selection:bg-aira-blue/30 p-2">
                  {validatedApp.javascript || '// No JavaScript defined'}
                </pre>
              )}

              {activeInspectorTab === 'state' && (
                <pre className="whitespace-pre-wrap selection:bg-aira-blue/30 p-2">
                  {JSON.stringify(appState, null, 2)}
                </pre>
              )}

              {activeInspectorTab === 'console' && (
                <div className="space-y-1 p-2">
                  {consoleLogs.length === 0 ? (
                    <div className="text-gray-500 italic">No console logs recorded yet.</div>
                  ) : (
                    consoleLogs.map((log, i) => (
                      <div
                        key={i}
                        className={`text-[11px] leading-relaxed ${
                          log.type === 'error'
                            ? 'text-red-400'
                            : log.type === 'action'
                            ? 'text-cyan-400'
                            : log.type === 'state'
                            ? 'text-amber-400'
                            : 'text-gray-300'
                        }`}
                      >
                        <span className="text-gray-600">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                        <span className="font-semibold uppercase text-[10px]">[{log.type}]</span> {log.message}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
