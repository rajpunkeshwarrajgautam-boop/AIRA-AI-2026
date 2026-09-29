import React, { useState, useEffect, useRef } from 'react';
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
import confetti from 'canvas-confetti';
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

  useEffect(() => {
    if (artifact) {
      setSelectedVersion(artifact.version);
      // Auto default to preview for HTML, SVG, React, and code for others
      if (artifact.type.includes('html') || artifact.type.includes('svg') || artifact.type.includes('react')) {
        setActiveTab('preview');
      } else {
        setActiveTab('code');
      }
      setConsoleLogs([]);
    }
  }, [artifact?.id]);

  if (!artifact) return null;

  const currentContent = artifact.versions?.find(v => v.version === selectedVersion)?.content || artifact.content;

  const handleCopy = () => {
    navigator.clipboard.writeText(currentContent);
    setIsCopied(true);
    confetti({
      particleCount: 25,
      spread: 45,
      origin: { y: 0.2, x: 0.8 },
      colors: ['#7C3AED', '#06B6D4', '#6366F1']
    });
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleDownload = () => {
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

  // Prepare iframe HTML with console capture bridge
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

    // Fallback for raw markdown or text
    return `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6 font-sans text-stone-800 bg-stone-50"><pre class="whitespace-pre-wrap">${currentContent}</pre></body></html>`;
  };

  return (
    <aside 
      className={`h-screen flex flex-col bg-claude-surface-light dark:bg-claude-surface-dark border-l border-claude-border-light dark:border-claude-border-dark shadow-2xl transition-all duration-300 z-40 ${
        isExpanded ? 'w-full md:w-[75vw]' : 'w-full md:w-[48vw] lg:w-[44vw]'
      }`}
    >
      {/* Top Navigation Bar */}
      <div className="h-[54px] px-4 flex items-center justify-between border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light/90 dark:bg-claude-surface-dark/90 backdrop-blur-md select-none">
        <div className="flex items-center space-x-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-claude-terracotta/10 text-claude-terracotta flex items-center justify-center ring-1 ring-claude-terracotta/20">
            <Layers className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-claude-text-light dark:text-claude-text-dark truncate tracking-tight">
              {artifact.title}
            </h2>
            <div className="flex items-center space-x-2 text-[10.5px] text-claude-muted-light dark:text-claude-muted-dark">
              <span className="uppercase font-semibold tracking-wider text-claude-terracotta">{artifact.language || 'artifact'}</span>
              <span>•</span>
              {/* Version Selector */}
              {artifact.versions && artifact.versions.length > 1 ? (
                <div className="flex items-center space-x-1">
                  <span>Version</span>
                  <select 
                    value={selectedVersion} 
                    onChange={(e) => setSelectedVersion(Number(e.target.value))}
                    className="bg-transparent text-claude-terracotta font-medium underline focus:outline-none cursor-pointer"
                  >
                    {artifact.versions.map(v => (
                      <option key={v.version} value={v.version} className="bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-claude-text-dark">
                        v{v.version}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <span className="font-mono">v1.0</span>
              )}
            </div>
          </div>
        </div>

        {/* Tab & Controls */}
        <div className="flex items-center space-x-1.5">
          {/* Tab Switcher (Preview vs Code) */}
          <div className="flex items-center bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light/70 dark:border-claude-border-dark/70 p-0.5 rounded-lg text-xs mr-2 shadow-xs">
            <button
              onClick={() => setActiveTab('preview')}
              className={`flex items-center space-x-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                activeTab === 'preview'
                  ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-terracotta shadow-xs'
                  : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-claude-text-dark'
              }`}
            >
              <Play className="w-3 h-3" />
              <span>Preview</span>
            </button>
            <button
              onClick={() => setActiveTab('code')}
              className={`flex items-center space-x-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                activeTab === 'code'
                  ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-terracotta shadow-xs'
                  : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-claude-text-dark'
              }`}
            >
              <Code className="w-3 h-3" />
              <span>Code</span>
            </button>
          </div>

          {/* Copy Button */}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition"
            title="Copy code"
          >
            {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          {/* Download Button */}
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition"
            title="Download file"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Expand Toggle */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 hidden md:block rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition"
            title={isExpanded ? "Collapse width" : "Expand width"}
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          {/* Close Studio */}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition"
            title="Close artifact"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Studio Body */}
      <div className="flex-1 relative overflow-hidden bg-claude-surface-light dark:bg-claude-surface-dark flex flex-col">
        {activeTab === 'preview' ? (
          <div className="w-full h-full relative flex flex-col">
            {/* Sandbox Toolbar */}
            <div className="h-8 px-3.5 flex items-center justify-between bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 border-b border-claude-border-light/60 dark:border-claude-border-dark/60 text-[11px] text-claude-muted-light dark:text-claude-muted-dark select-none">
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></span>
                <span className="font-medium tracking-tight">Sandbox Active</span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setShowConsole(!showConsole)}
                  className={`flex items-center space-x-1 px-1.5 py-0.5 rounded hover:bg-claude-border-light dark:hover:bg-claude-border-dark transition ${
                    showConsole ? 'text-claude-terracotta font-semibold' : ''
                  }`}
                  title="Toggle console logs"
                >
                  <Terminal className="w-3 h-3" />
                  <span>Logs {consoleLogs.length > 0 && `(${consoleLogs.length})`}</span>
                </button>
                <button
                  onClick={() => setRefreshKey(k => k + 1)}
                  className="p-1 hover:text-claude-text-light dark:hover:text-claude-text-dark transition"
                  title="Reload sandbox"
                >
                  <RotateCw className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Live iframe */}
            <iframe
              key={refreshKey}
              ref={iframeRef}
              srcDoc={getIframeSrcDoc()}
              sandbox="allow-scripts allow-modals allow-forms"
              className="w-full flex-1 border-0 bg-white"
              title={artifact.title}
            />

            {/* Bottom Console Drawer */}
            {showConsole && (
              <div className="h-32 bg-stone-900 text-stone-200 border-t border-stone-800 p-2 font-mono text-xs overflow-y-auto">
                <div className="flex items-center justify-between pb-1 border-b border-stone-800 text-[10px] text-stone-400 mb-1">
                  <span>Console Logs</span>
                  <button onClick={() => setConsoleLogs([])} className="hover:text-stone-200">Clear</button>
                </div>
                {consoleLogs.length === 0 ? (
                  <div className="text-stone-500 italic">No output logged.</div>
                ) : (
                  consoleLogs.map((log, i) => (
                    <div key={i} className={`py-0.5 ${log.type === 'error' ? 'text-red-400' : log.type === 'warn' ? 'text-amber-400' : 'text-stone-300'}`}>
                      &gt; {log.message}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ) : (
          /* Code View */
          <div className="w-full h-full overflow-y-auto p-4 font-mono text-xs leading-relaxed bg-[#1e1e1e] text-[#d4d4d4]">
            <pre className="whitespace-pre">
              <code>{currentContent}</code>
            </pre>
          </div>
        )}
      </div>
    </aside>
  );
};
