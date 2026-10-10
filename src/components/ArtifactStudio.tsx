import React, { useState, useRef } from 'react';
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
  Layers
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Artifact } from '../types';

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

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [prevArtifactKey, setPrevArtifactKey] = useState<string | null>(null);
  const artifactKey = artifact ? `${artifact.id}-${artifact.version}` : null;

  if (artifact && artifactKey !== prevArtifactKey) {
    setPrevArtifactKey(artifactKey);
    setSelectedVersion(artifact.version);
    if (artifact.type.includes('html') || artifact.type.includes('svg') || artifact.type.includes('react') || artifact.type === 'application/vnd.ant.project') {
      setActiveTab('preview');
    } else {
      setActiveTab('code');
    }
    setConsoleLogs([]);
  }

  if (!artifact) return null;

  const currentContent = artifact.versions?.find(v => v.version === selectedVersion)?.content || artifact.content;

  const projectInfo = (() => {
    if (artifact.type !== 'application/vnd.ant.project') return null;
    try {
      const value = JSON.parse(currentContent) as { previewUrl?: string; jobId?: string; queueJobId?: string; archiveSha256?: string; status?: string };
      if (!value.jobId || !/^[a-f0-9-]{36}$/.test(value.jobId) || value.status !== 'BUILD_PASSED') return null;
      return value;
    } catch { return null; }
  })();
  const projectPreviewUrl = (() => {
    try {
      if (!projectInfo?.previewUrl) return null;
      const url = new URL(projectInfo.previewUrl);
      const allowedOrigin = import.meta.env.VITE_AIRA_PREVIEW_ORIGIN as string | undefined;
      if (allowedOrigin && url.origin === new URL(allowedOrigin).origin && url.origin !== window.location.origin && url.protocol === 'https:') return url.href;
      if (import.meta.env.DEV && url.hostname === '127.0.0.1' && url.port === '4102' && url.protocol === 'http:') return url.href;
      return null;
    } catch { return null; }
  })();


  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentContent);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 1800);
    } catch {
      setIsCopied(false);
    }
  };

  const handleDownload = async () => {
    if (artifact.type === 'application/vnd.ant.project') {
      if (!projectInfo?.jobId) return;
      try {
        // Prefer the owner-scoped durable archive for queued builds. Legacy
        // worker-only artifacts retain their existing download behavior.
        const endpoint = projectInfo.queueJobId && /^[a-f0-9-]{36}$/.test(projectInfo.queueJobId)
          ? '/api/app-builder/queue/' + encodeURIComponent(projectInfo.queueJobId) + '/source'
          : '/api/app-builder/jobs/' + encodeURIComponent(projectInfo.jobId) + '/source';
        const response = await fetch(endpoint, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Source archive unavailable');
        const bytes = await response.arrayBuffer();
        if (projectInfo.archiveSha256) {
          if (!/^[a-f0-9]{64}$/.test(projectInfo.archiveSha256)) throw new Error('Invalid archive digest');
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          const actual = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
          if (actual !== projectInfo.archiveSha256) throw new Error('Archive integrity mismatch');
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'aira-project-source.tar.gz';
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) { console.error('Source archive download failed:', err); }
      return;
    }
    const ext = artifact.language === 'python' ? '.py' : 
                artifact.type.includes('html') ? '.html' : 
                artifact.type.includes('svg') ? '.svg' : 
                artifact.language === 'tsx' ? '.tsx' : '.txt';
    const blob = new Blob([currentContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getIframeSrcDoc = () => {
    const logBridge = `
      <script>
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;
        
        window.addEventListener('message', (e) => {});

        console.log = (...args) => {
          window.parent.postMessage({ type: 'CONSOLE_LOG', level: 'info', message: args.join(' ') }, '*');
          originalLog.apply(console, args);
        };
        console.error = (...args) => {
          window.parent.postMessage({ type: 'CONSOLE_LOG', level: 'error', message: args.join(' ') }, '*');
          originalError.apply(console, args);
        };
        console.warn = (...args) => {
          window.parent.postMessage({ type: 'CONSOLE_LOG', level: 'warn', message: args.join(' ') }, '*');
          originalWarn.apply(console, args);
        };
        window.onerror = (msg, url, line) => {
          window.parent.postMessage({ type: 'CONSOLE_LOG', level: 'error', message: msg + ' (Line ' + line + ')' }, '*');
        };
      </script>
    `;

    if (artifact.type === 'image/svg+xml') {
      return `<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#FAF9F5;">${currentContent}</body></html>`;
    }

    if (artifact.type.includes('html')) {
      if (currentContent.includes('<head>')) {
        return currentContent.replace('<head>', `<head>${logBridge}`);
      }
      return `${logBridge}${currentContent}`;
    }

    return `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6 font-sans text-stone-800 bg-stone-50"><pre class="whitespace-pre-wrap">${currentContent}</pre></body></html>`;
  };

  return (
    <AnimatePresence>
      {artifact && (
        <motion.aside 
          initial={{ x: '100%', opacity: 0.5, boxShadow: '0 0 0 rgba(0,0,0,0)' }}
          animate={{ x: 0, opacity: 1, boxShadow: '-20px 0 40px -15px rgba(0,0,0,0.2)' }}
          exit={{ x: '100%', opacity: 0.5, boxShadow: '0 0 0 rgba(0,0,0,0)' }}
          transition={{ type: "spring", stiffness: 250, damping: 25, mass: 0.8 }}
          className={`fixed inset-y-0 right-0 z-50 md:relative md:inset-auto md:z-40 h-[100dvh] flex flex-col bg-claude-surface-light dark:bg-[#121214] border-l border-claude-border-light dark:border-claude-border-dark shadow-2xl md:shadow-none flex-shrink-0 ${
            isExpanded ? 'w-full md:w-[75vw]' : 'w-full md:w-[48vw] lg:w-[44vw]'
          }`}
        >
          {/* Top Navigation Bar with Liquid Glass */}
          <div className="h-[60px] px-4 flex items-center justify-between border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark backdrop-blur-xl shadow-sm select-none">
            <div className="flex items-center space-x-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-claude-terracotta/10 text-claude-terracotta flex items-center justify-center border border-claude-terracotta/20 shadow-[0_2px_10px_-4px_rgba(235,110,75,0.2)]">
                <Layers className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[13px] font-bold text-claude-text-light dark:text-white truncate tracking-tight">
                  {artifact.title}
                </h2>
                <div className="flex items-center space-x-2 mt-0.5">
                  <span className="text-[9px] uppercase font-bold tracking-[0.1em] text-claude-terracotta">{artifact.language || 'artifact'}</span>
                  <span className="text-claude-muted-light dark:text-claude-muted-dark opacity-50 text-[10px]">•</span>
                  {/* Version Selector */}
                  {artifact.versions && artifact.versions.length > 1 ? (
                    <div className="flex items-center space-x-1">
                      <span className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">Version</span>
                      <select 
                        value={selectedVersion} 
                        onChange={(e) => setSelectedVersion(Number(e.target.value))}
                        className="bg-transparent text-[10px] text-claude-text-light dark:text-white font-bold underline focus:outline-none cursor-pointer"
                      >
                        {artifact.versions.map(v => (
                          <option key={v.version} value={v.version} className="bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-white">
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

            {/* Tab & Controls */}
            <div className="flex items-center space-x-2">
              {/* Watermelon-style continuous tabs */}
              <div className="relative mr-2 flex items-center rounded-xl border border-claude-border-light bg-claude-surface2-light p-1 shadow-inner dark:border-claude-border-dark dark:bg-claude-surface2-dark">
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
                      className={`relative isolate flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                        selected
                          ? 'text-claude-terracotta'
                          : 'text-claude-muted-light hover:text-claude-text-light dark:text-claude-muted-dark dark:hover:text-white'
                      }`}
                    >
                      {selected && (
                        <motion.span
                          layoutId="artifact-active-tab"
                          className="absolute inset-0 -z-10 rounded-lg border border-claude-border-light bg-claude-surface-light shadow-sm dark:border-claude-border-dark dark:bg-claude-surface-dark"
                          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                        />
                      )}
                      <Icon className="h-3.5 w-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-1">
                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={handleCopy} className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white transition-colors" title="Copy code">
                  {isCopied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </motion.button>
                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={handleDownload} className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white transition-colors" title="Download file">
                  <Download className="w-4 h-4" />
                </motion.button>
                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setIsExpanded(!isExpanded)} className="p-2 hidden md:block rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white transition-colors" title={isExpanded ? "Collapse width" : "Expand width"}>
                  {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </motion.button>
                <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={onClose} className="p-2 ml-1 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 transition-colors" title="Close artifact">
                  <X className="w-4 h-4" />
                </motion.button>
              </div>
            </div>
          </div>

          {/* Main Studio Body */}
          <div className="flex-1 relative overflow-hidden bg-claude-surface-light dark:bg-[#121214] flex flex-col">
            <AnimatePresence mode="wait">
              {activeTab === 'preview' ? (
                <motion.div key="preview" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="w-full h-full relative flex flex-col">
                  {/* Sandbox Toolbar */}
                  <div className="h-9 px-4 flex items-center justify-between bg-claude-surface-light dark:bg-claude-surface-dark border-b border-claude-border-light dark:border-claude-border-dark text-xs text-claude-muted-light dark:text-claude-muted-dark select-none">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)] animate-pulse"></span>
                      <span className="font-bold tracking-tight text-claude-text-light dark:text-white">{artifact.type === 'application/vnd.ant.project' ? 'Isolated Build Preview (not product certified)' : 'HTML Preview'}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => setShowConsole(!showConsole)}
                        className={`flex items-center space-x-1.5 px-2 py-1 rounded-md hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition-colors ${
                          showConsole ? 'text-claude-terracotta font-bold bg-claude-terracotta/10' : ''
                        }`}
                        title="Toggle console logs"
                      >
                        <Terminal className="w-3.5 h-3.5" />
                        <span>Logs {consoleLogs.length > 0 && <span className="bg-claude-terracotta/20 px-1 rounded ml-1">{consoleLogs.length}</span>}</span>
                      </button>
                      <button
                        onClick={() => setRefreshKey(k => k + 1)}
                        className="p-1 hover:text-claude-text-light dark:hover:text-white transition-colors"
                        title="Reload sandbox"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Live iframe */}
                  {artifact.type === 'application/vnd.ant.project' && !projectPreviewUrl ? (
                    <div className="p-6 text-sm text-amber-500" role="status">
                      Isolated build preview is unavailable or its configured origin is not trusted. This is not a product certification.
                    </div>
                  ) : (
                    <iframe
                      key={refreshKey}
                      ref={iframeRef}
                      src={projectPreviewUrl || undefined}
                      srcDoc={projectPreviewUrl ? undefined : getIframeSrcDoc()}
                      sandbox={projectPreviewUrl ? "allow-scripts allow-same-origin" : "allow-scripts"}
                      referrerPolicy="no-referrer"
                      className="w-full flex-1 border-0 bg-white"
                      title={artifact.title}
                    />
                  )}

                  {/* Bottom Console Drawer */}
                  <AnimatePresence>
                    {showConsole && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 160, opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-[#0D0D0D] text-stone-300 border-t border-[#333] p-3 font-mono text-xs overflow-y-auto shadow-[inset_0_5px_10px_rgba(0,0,0,0.5)]">
                        <div className="flex items-center justify-between pb-2 border-b border-[#333] text-[10px] font-bold tracking-widest uppercase text-stone-500 mb-2">
                          <span>Console</span>
                          <button onClick={() => setConsoleLogs([])} className="hover:text-stone-300 transition-colors">Clear</button>
                        </div>
                        {consoleLogs.length === 0 ? (
                          <div className="text-stone-600 italic">No output logged.</div>
                        ) : (
                          consoleLogs.map((log, i) => (
                            <div key={i} className={`py-0.5 leading-relaxed ${log.type === 'error' ? 'text-red-400' : log.type === 'warn' ? 'text-amber-400' : 'text-[#A3A3A3]'}`}>
                              <span className="text-stone-600 mr-2">›</span>{log.message}
                            </div>
                          ))
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              ) : (
                /* Code View */
                <motion.div key="code" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }} className="w-full h-full overflow-y-auto p-5 font-mono text-[13px] leading-[1.6] bg-[#0D0D0D] text-[#D4D4D4] shadow-[inset_0_2px_10px_rgba(0,0,0,0.2)]">
                  <pre className="whitespace-pre">
                    <code>{currentContent}</code>
                  </pre>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
