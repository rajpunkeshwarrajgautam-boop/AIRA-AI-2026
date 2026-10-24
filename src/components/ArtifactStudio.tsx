import React, { useState, useRef, useEffect } from 'react';
import { 
  Code, 
  Play, 
  Copy, 
  Check, 
  Download, 
  Maximize2, 
  Minimize2, 
  X, 
  RotateCw, 
  Terminal, 
  Layers,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Artifact } from '../types';
import { generateArtifactSandboxHtml } from '../utils/artifactSandbox';

interface ArtifactStudioProps {
  artifact: Artifact | null;
  onClose: () => void;
  onUpdateArtifact?: (updated: Artifact) => void;
}

export const ArtifactStudio: React.FC<ArtifactStudioProps> = ({
  artifact,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
  const [selectedVersion, setSelectedVersion] = useState<number>(1);
  const [isCopied, setIsCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<Array<{ type: string; message: string }>>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const activeNonceRef = useRef<string>(
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `nonce_${Math.random().toString(36).slice(2)}_${Date.now()}`
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [prevArtifactKey, setPrevArtifactKey] = useState<string | null>(null);
  const artifactKey = artifact ? `${artifact.id}-${artifact.version}` : null;

  if (artifact && artifactKey !== prevArtifactKey) {
    setPrevArtifactKey(artifactKey);
    setSelectedVersion(artifact.version);
    activeNonceRef.current = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `nonce_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    if (
      artifact.type === 'text/html' ||
      artifact.type === 'image/svg+xml' ||
      artifact.type === 'application/vnd.ant.react' ||
      artifact.type === 'application/vnd.ant.mermaid' ||
      artifact.type === 'text/markdown'
    ) {
      setActiveTab('preview');
    } else {
      setActiveTab('code');
    }
    setConsoleLogs([]);
  }

  // Cross-frame console log receiver with strict verification (CRITICAL FIX B)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // 1. Verify message source matches active iframe window
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) {
        return;
      }
      // 2. Validate payload structure
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type !== 'CONSOLE_LOG') return;

      // 3. Validate per-session secret nonce to prevent spoofed/injected cross-frame messages
      if (!event.data.nonce || event.data.nonce !== activeNonceRef.current) {
        return;
      }

      // 4. Schema validation
      const allowedLevels = ['info', 'warn', 'error', 'log'];
      const level = allowedLevels.includes(event.data.level) ? event.data.level : 'info';
      const rawMessage = typeof event.data.message === 'string' ? event.data.message : String(event.data.message || '');
      const message = rawMessage.slice(0, 4000);
      setConsoleLogs(prev => [...prev.slice(-99), { type: level, message }]);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (!artifact) return null;

  const currentContent = artifact.versions?.find(v => v.version === selectedVersion)?.content || artifact.content;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentContent);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 1800);
    } catch {
      setIsCopied(false);
    }
  };

  const handleDownload = () => {
    const ext = artifact.language === 'python' ? '.py' : 
                artifact.type === 'image/svg+xml' ? '.svg' : 
                artifact.type === 'application/vnd.ant.mermaid' ? '.mmd' :
                artifact.type === 'text/markdown' ? '.md' :
                artifact.type === 'application/vnd.ant.react' || artifact.language === 'tsx' ? '.tsx' :
                artifact.type === 'text/html' ? '.html' : '.txt';
    const blob = new Blob([currentContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // CRITICAL FIX A: Never open untrusted executable generated HTML as an unrestricted same-origin Blob document
  const handleOpenInNewTab = () => {
    const isExecutable = artifact.type === 'text/html' || artifact.type === 'application/vnd.ant.react';
    if (isExecutable) {
      setSecurityNotice('New-tab execution of dynamic code is disabled for origin isolation. Use safe download to run locally, or view safely in this sandboxed preview.');
      setTimeout(() => setSecurityNotice(null), 6000);
      return;
    }
    // Safe text view for non-executable types
    const blob = new Blob([currentContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const getIframeSrcDoc = () => {
    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    return generateArtifactSandboxHtml(artifact, currentContent, isDark, activeNonceRef.current);
  };

  const lineCount = currentContent.split('\n').length;

  return (
    <AnimatePresence>
      {artifact && (
        <motion.aside 
          initial={{ x: '100%', opacity: 0.5, boxShadow: '0 0 0 rgba(0,0,0,0)' }}
          animate={{ x: 0, opacity: 1, boxShadow: '-20px 0 40px -15px rgba(0,0,0,0.2)' }}
          exit={{ x: '100%', opacity: 0.5, boxShadow: '0 0 0 rgba(0,0,0,0)' }}
          transition={{ type: "spring", stiffness: 250, damping: 25, mass: 0.8 }}
          data-testid="artifact-studio"
          className={`${isExpanded ? 'fixed inset-y-0 right-0 z-[60] w-full' : 'fixed inset-y-0 right-0 z-50 w-full xl:relative xl:inset-auto xl:z-40 xl:w-[48vw]'} h-[100dvh] min-w-0 flex flex-col bg-claude-surface-light dark:bg-[#141413] border-l border-claude-border-light dark:border-claude-border-dark shadow-2xl xl:shadow-none flex-shrink-0 transition-colors`}
        >
          {/* Top Navigation Bar */}
          <div className="min-h-[56px] px-3 sm:px-4 py-2 flex flex-wrap items-center justify-between gap-2 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light/95 dark:bg-[#1F1E1D]/95 backdrop-blur-md select-none">
            <div className="flex flex-1 items-center space-x-2 sm:space-x-3 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-claude-terracotta/10 text-claude-terracotta flex items-center justify-center border border-claude-terracotta/20 shrink-0">
                <Layers className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[13px] font-semibold text-claude-text-light dark:text-claude-text-dark truncate tracking-tight">
                  {artifact.title}
                </h2>
                <div className="flex items-center space-x-2 mt-0.5">
                  <span className="text-[10px] uppercase font-mono tracking-wider text-claude-terracotta font-medium">
                    {artifact.language || artifact.type.split('/').pop() || 'artifact'}
                  </span>
                  <span className="text-claude-muted-light dark:text-claude-muted-dark opacity-40 text-[10px]">•</span>
                  {/* Version Selector */}
                  {artifact.versions && artifact.versions.length > 1 ? (
                    <div className="flex items-center space-x-1">
                      <span className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">Version</span>
                      <select 
                        value={selectedVersion} 
                        onChange={(e) => setSelectedVersion(Number(e.target.value))}
                        className="bg-transparent text-[10px] text-claude-text-light dark:text-white font-semibold underline focus:outline-none cursor-pointer"
                      >
                        {artifact.versions.map(v => (
                          <option key={v.version} value={v.version} className="bg-claude-surface-light dark:bg-[#1F1E1D] text-claude-text-light dark:text-white">
                            v{v.version}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <span className="font-mono text-[10px] text-claude-muted-light dark:text-claude-muted-dark font-medium">v1.0</span>
                  )}
                </div>
              </div>
            </div>

            {/* Tab & Action Controls */}
            <div className="flex shrink-0 items-center space-x-1 sm:space-x-1.5">
              {/* Tab Selector */}
              <div className="relative mr-1 flex items-center rounded-lg border border-claude-border-light bg-claude-surface2-light p-0.5 dark:border-claude-border-dark dark:bg-claude-surface2-dark">
                {([
                  { id: 'preview' as const, label: 'Preview', icon: Play },
                  { id: 'code' as const, label: 'Code', icon: Code },
                ]).map(tab => {
                  const Icon = tab.icon;
                  const selected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`relative isolate flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        selected
                          ? 'text-claude-terracotta'
                          : 'text-claude-muted-light hover:text-claude-text-light dark:text-claude-muted-dark dark:hover:text-white'
                      }`}
                    >
                      {selected && (
                        <motion.span
                          layoutId="artifact-active-tab"
                          className="absolute inset-0 -z-10 rounded-md border border-claude-border-light bg-claude-surface-light shadow-sm dark:border-claude-border-dark dark:bg-[#272624]"
                          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                        />
                      )}
                      <Icon className="h-3.5 w-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-0.5">
                <button 
                  onClick={handleCopy} 
                  className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white transition-colors" 
                  title="Copy code"
                >
                  {isCopied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
                <button 
                  onClick={handleDownload} 
                  className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white transition-colors" 
                  title="Download file"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button 
                  onClick={handleOpenInNewTab} 
                  className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white transition-colors" 
                  title="Open in new tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setIsExpanded(!isExpanded)} 
                  className="p-1.5 hidden md:block rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white transition-colors" 
                  title={isExpanded ? "Collapse width" : "Expand width"}
                >
                  {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>
                <button 
                  onClick={onClose} 
                  className="p-1.5 ml-0.5 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:text-red-500 transition-colors" 
                  title="Close artifact"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {securityNotice && (
            <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs flex items-center justify-between">
              <span className="font-medium">{securityNotice}</span>
              <button onClick={() => setSecurityNotice(null)} className="ml-2 text-amber-500 hover:text-amber-700 font-bold text-sm">×</button>
            </div>
          )}

          {/* Main Studio Body */}
          <div className="flex-1 relative overflow-hidden bg-claude-surface-light dark:bg-[#141413] flex flex-col">
            <AnimatePresence mode="wait">
              {activeTab === 'preview' ? (
                <motion.div 
                  key="preview" 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  exit={{ opacity: 0 }} 
                  transition={{ duration: 0.15 }} 
                  className="w-full h-full relative flex flex-col"
                >
                  {/* Sandbox Status Bar */}
                  <div className="h-8 px-4 flex items-center justify-between bg-claude-surface-light dark:bg-[#1F1E1D] border-b border-claude-border-light dark:border-claude-border-dark text-xs text-claude-muted-light dark:text-claude-muted-dark select-none">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="font-medium tracking-tight text-claude-text-light dark:text-claude-text-dark text-[11px]">
                        Live Execution Sandbox
                      </span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => setShowConsole(!showConsole)}
                        className={`flex items-center space-x-1.5 px-2 py-0.5 rounded text-[11px] hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition-colors ${
                          showConsole ? 'text-claude-terracotta font-medium bg-claude-terracotta/10' : ''
                        }`}
                        title="Toggle console logs"
                      >
                        <Terminal className="w-3 h-3" />
                        <span>Logs {consoleLogs.length > 0 && <span className="bg-claude-terracotta/20 px-1 rounded text-[10px] ml-1">{consoleLogs.length}</span>}</span>
                      </button>
                      <button
                        onClick={() => setRefreshKey(k => k + 1)}
                        className="p-1 hover:text-claude-text-light dark:hover:text-white transition-colors"
                        title="Reload sandbox"
                      >
                        <RotateCw className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Sandboxed iframe */}
                  <iframe
                    key={refreshKey}
                    ref={iframeRef}
                    srcDoc={getIframeSrcDoc()}
                    sandbox="allow-scripts allow-modals allow-forms"
                    className="w-full flex-1 border-0 bg-transparent"
                    title={artifact.title}
                  />

                  {/* Console Drawer */}
                  <AnimatePresence>
                    {showConsole && (
                      <motion.div 
                        initial={{ height: 0, opacity: 0 }} 
                        animate={{ height: 160, opacity: 1 }} 
                        exit={{ height: 0, opacity: 0 }} 
                        className="bg-[#121214] text-stone-300 border-t border-claude-border-dark p-3 font-mono text-xs overflow-y-auto"
                      >
                        <div className="flex items-center justify-between pb-1.5 border-b border-stone-800 text-[10px] font-semibold tracking-wider uppercase text-stone-500 mb-2">
                          <span>Sandbox Console</span>
                          <button onClick={() => setConsoleLogs([])} className="hover:text-stone-300 transition-colors">Clear</button>
                        </div>
                        {consoleLogs.length === 0 ? (
                          <div className="text-stone-600 text-xs italic">No output logged.</div>
                        ) : (
                          consoleLogs.map((log, i) => (
                            <div key={i} className={`py-0.5 leading-relaxed font-mono text-xs ${log.type === 'error' ? 'text-red-400' : log.type === 'warn' ? 'text-amber-400' : 'text-stone-300'}`}>
                              <span className="text-stone-600 mr-2">&gt;</span>{log.message}
                            </div>
                          ))
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              ) : (
                /* Code View */
                <motion.div 
                  key="code" 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  exit={{ opacity: 0 }} 
                  transition={{ duration: 0.15 }} 
                  className="w-full h-full flex flex-col bg-[#141413] text-[#D4D4D4] font-mono text-[13px] leading-[1.6]"
                >
                  <div className="h-8 px-4 flex items-center justify-between border-b border-stone-800 text-[11px] text-stone-500 select-none">
                    <span>{lineCount} lines • {artifact.language || 'text'}</span>
                    <span>Read-only</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 flex">
                    <div className="select-none text-stone-600 text-right pr-4 font-mono text-xs border-r border-stone-800/60 mr-4">
                      {Array.from({ length: lineCount }).map((_, i) => (
                        <div key={i}>{i + 1}</div>
                      ))}
                    </div>
                    <pre className="whitespace-pre overflow-x-auto flex-1 font-mono text-xs text-stone-200">
                      <code>{currentContent}</code>
                    </pre>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
