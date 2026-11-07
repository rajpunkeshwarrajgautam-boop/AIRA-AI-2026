import React, { useState, useRef, useEffect, useMemo } from 'react';
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
  ExternalLink,
  Monitor,
  Tablet,
  Smartphone,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  FolderTree,
  Network
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Artifact } from '../types';
import type { AgentExecutionGraph } from '../types/executionGraph';
import type { MultiFileArtifactBundle } from '../types/multiFileArtifact';
import { AgentExecutionGraphView } from './AgentExecutionGraph';
import { WorkspaceFileExplorer } from './WorkspaceFileExplorer';
import { MultiModalAssetViewer } from './MultiModalAssetViewer';
import { generateMultiFileArtifactSandboxHtml } from '../utils/multiFileSandbox';
import { adaptSingleFileArtifactToBundle } from '../utils/artifactBundleEngine';
import { generateProjectZipArchive } from '../utils/artifactZipExporter';
import { syncBundleToWorkspace } from '../utils/artifactWorkspaceSync';
import { generateArtifactSandboxHtml } from '../utils/artifactSandbox';
import { normalizeArtifactRuntimeError, type ArtifactRuntimeError } from '../utils/artifactRuntimeError';
import { createRollbackRevision, diffArtifactLines } from '../utils/artifactRevisions';

function newSandboxNonce(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  // No weak random fallback. An empty nonce fails every inbound message check.
  return '';
}

interface ArtifactStudioProps {
  artifact: Artifact | null;
  onClose: () => void;
  onUpdateArtifact?: (updated: Artifact) => void;
  /** Opt-in layout alignment only; the existing sandbox and artifact actions are unchanged. */
  adaptiveDock?: boolean;
  onRepairArtifact?: (error: ArtifactRuntimeError, title: string) => void;
  allArtifacts?: Artifact[];
  onSelectArtifact?: (artifact: Artifact) => void;
  activeProjectName?: string;
  onSaveToProject?: (artifact: Artifact) => void;
  executionGraph?: AgentExecutionGraph | null;
  bundle?: MultiFileArtifactBundle | null;
  onSelectFile?: (filePath: string) => void;
  onApproveTask?: (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
}

export const ArtifactStudio: React.FC<ArtifactStudioProps> = ({
  artifact,
  onClose,
  onUpdateArtifact,
  adaptiveDock = false,
  onRepairArtifact,
  allArtifacts,
  onSelectArtifact,
  activeProjectName,
  onSaveToProject,
  executionGraph,
  bundle: explicitBundle,
  onSelectFile,
  onApproveTask,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'diff' | 'graph'>('preview');
  const [selectedVersion, setSelectedVersion] = useState<number>(1);
  const [isCopied, setIsCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<Array<{ type: string; message: string }>>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [devicePreset, setDevicePreset] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [isSavedToProject, setIsSavedToProject] = useState(false);
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [isSyncingWorkspace, setIsSyncingWorkspace] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);
  const [screenReaderAnnouncement, setScreenReaderAnnouncement] = useState<string>('');

  const prefersReducedMotion = useMemo(() => {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const activeBundle = useMemo<MultiFileArtifactBundle | null>(() => {
    if (explicitBundle) return explicitBundle;
    if (!artifact) return null;
    if (artifact.bundle) return artifact.bundle;
    return adaptSingleFileArtifactToBundle(artifact);
  }, [explicitBundle, artifact]);

  const defaultEntryPath = activeBundle ? (activeBundle.entryPoint || Object.keys(activeBundle.files)[0] || '') : '';
  const [userSelectedFilePath, setUserSelectedFilePath] = useState<string | null>(null);
  const selectedFilePath = (userSelectedFilePath && activeBundle?.files[userSelectedFilePath])
    ? userSelectedFilePath
    : defaultEntryPath;

  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<ArtifactRuntimeError | null>(null);
  const activeNonceRef = useRef<string>(newSandboxNonce());

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [prevArtifactKey, setPrevArtifactKey] = useState<string | null>(null);
  const artifactKey = artifact ? `${artifact.id}-${artifact.version}` : null;

  // Universal Keyboard Navigation (Phase 1)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // Alt+1: Preview
      if (e.altKey && e.key === '1') {
        e.preventDefault();
        setActiveTab('preview');
        setScreenReaderAnnouncement('Switched to Preview tab');
        return;
      }
      // Alt+2: Code
      if (e.altKey && e.key === '2') {
        e.preventDefault();
        setActiveTab('code');
        setScreenReaderAnnouncement('Switched to Code tab');
        return;
      }
      // Alt+3: Diff
      if (e.altKey && e.key === '3') {
        if (adaptiveDock && artifact?.versions && artifact.versions.length > 1) {
          e.preventDefault();
          setActiveTab('diff');
          setScreenReaderAnnouncement('Switched to Diff tab');
        }
        return;
      }
      // Alt+4: Graph
      if (e.altKey && e.key === '4') {
        if (adaptiveDock && executionGraph) {
          e.preventDefault();
          setActiveTab('graph');
          setScreenReaderAnnouncement('Switched to Graph tab');
        }
        return;
      }

      // Cmd+P or Ctrl+P: quick workspace file jump
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        if (adaptiveDock && activeBundle) {
          e.preventDefault();
          setShowFileExplorer(true);
          setScreenReaderAnnouncement('Opened project files search');
          window.setTimeout(() => {
            const input = document.querySelector<HTMLInputElement>('[data-testid="file-search-input"]');
            if (input) {
              input.focus();
              input.select();
            }
          }, 50);
        }
        return;
      }

      // Escape: dismiss drawer, search, or collapse
      if (e.key === 'Escape') {
        if (showConsole) {
          e.preventDefault();
          setShowConsole(false);
          setScreenReaderAnnouncement('Console closed');
          return;
        }
        if (showFileExplorer && isInput) {
          e.preventDefault();
          target?.blur();
          return;
        }
        if (isExpanded) {
          e.preventDefault();
          setIsExpanded(false);
          setScreenReaderAnnouncement('Studio collapsed to dock');
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [adaptiveDock, artifact, executionGraph, activeBundle, showConsole, showFileExplorer, isExpanded]);

  if (artifact && artifactKey !== prevArtifactKey) {
    setPrevArtifactKey(artifactKey);
    setSelectedVersion(artifact.version);
    activeNonceRef.current = newSandboxNonce();
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
    setRuntimeError(null);
    setDevicePreset('desktop');
    setZoomScale(1);
    setIsSavedToProject(false);
    setUserSelectedFilePath(null);
  }

  // Cross-frame console log receiver with strict verification (CRITICAL FIX B)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // 1. Verify message source matches active iframe window
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      // srcdoc without allow-same-origin has an opaque origin.
      if (event.origin !== 'null') return;
      // 2. Validate payload structure
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type !== 'CONSOLE_LOG' && event.data.type !== 'AIRA_ARTIFACT_RUNTIME_ERROR') return;

      // 3. Validate per-session secret nonce to prevent spoofed/injected cross-frame messages
      if (!event.data.nonce || event.data.nonce !== activeNonceRef.current) {
        return;
      }

      if (event.data.type === 'AIRA_ARTIFACT_RUNTIME_ERROR') {
        if (!adaptiveDock) return;
        const normalized = normalizeArtifactRuntimeError(event.data.error);
        if (normalized) setRuntimeError(normalized);
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
  }, [adaptiveDock]);

  if (!artifact) return null;

  const currentContent = artifact.versions?.find(v => v.version === selectedVersion)?.content || artifact.content;
  const isGenerating = adaptiveDock && !artifact.versions.some(v => v.version === artifact.version);
  const selectedIndex = artifact.versions?.findIndex(v => v.version === selectedVersion) ?? -1;
  const earlierVersion = selectedIndex > 0 ? artifact.versions[selectedIndex - 1] : null;
  const diffRows = adaptiveDock && activeTab === 'diff' && earlierVersion
    ? diffArtifactLines(earlierVersion.content, currentContent)
    : [];

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

  const handleExportZip = () => {
    if (!activeBundle || !artifact) return;
    try {
      const zipBytes = generateProjectZipArchive(activeBundle);
      const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${artifact.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}-project.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err || 'Failed to export ZIP');
      setSecurityNotice(`ZIP export error: ${msg}`);
    }
  };

  const handleSyncWorkspace = async () => {
    if (!activeBundle) return;
    setIsSyncingWorkspace(true);
    try {
      const result = await syncBundleToWorkspace(activeBundle, activeProjectName ? `proj_${activeProjectName}` : undefined);
      if (result.success) {
        setSyncSuccess(true);
        setTimeout(() => setSyncSuccess(false), 2500);
      } else {
        setSecurityNotice(`Workspace sync error: ${result.error || 'Failed to sync'}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err || 'Failed to sync workspace');
      setSecurityNotice(`Workspace sync error: ${msg}`);
    } finally {
      setIsSyncingWorkspace(false);
    }
  };

  const getIframeSrcDoc = () => {
    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    if (adaptiveDock && activeBundle && Object.keys(activeBundle.files).length > 1) {
      return generateMultiFileArtifactSandboxHtml(activeBundle, isDark, activeNonceRef.current);
    }
    return generateArtifactSandboxHtml(artifact, currentContent, isDark, activeNonceRef.current);
  };

  const handleZoomIn = () => setZoomScale(z => Math.min(1.5, Math.round((z + 0.25) * 100) / 100));
  const handleZoomOut = () => setZoomScale(z => Math.max(0.5, Math.round((z - 0.25) * 100) / 100));
  const handleZoomReset = () => setZoomScale(1);
  const currentArtifactIndex = (allArtifacts && artifact) ? allArtifacts.findIndex(a => a.id === artifact.id) : -1;

  const selectedFile = (activeBundle && selectedFilePath)
    ? activeBundle.files[selectedFilePath]
    : null;

  const isMultiModal = Boolean(
    selectedFile && (
      selectedFile.kind === 'image' ||
      selectedFile.kind === 'svg' ||
      selectedFile.kind === 'audio' ||
      selectedFile.kind === 'video' ||
      selectedFile.kind === 'pdf'
    )
  );

  const displayedContent = selectedFile ? selectedFile.content : currentContent;
  const displayedFilePath = selectedFile ? selectedFile.path : '';
  const displayedLanguage = selectedFile ? selectedFile.kind : (artifact.language || 'text');
  const lineCount = displayedContent.split('\n').length;

  return (
    <AnimatePresence>
      {artifact && (
        <motion.aside 
          initial={{ x: '100%', opacity: 0.5, boxShadow: '0 0 0 rgba(0,0,0,0)' }}
          animate={{ x: 0, opacity: 1, boxShadow: '-20px 0 40px -15px rgba(0,0,0,0.2)' }}
          exit={{ x: '100%', opacity: 0.5, boxShadow: '0 0 0 rgba(0,0,0,0)' }}
          transition={prefersReducedMotion ? { duration: 0 } : { type: "spring", stiffness: 250, damping: 25, mass: 0.8 }}
          data-testid="artifact-studio"
          className={`${isExpanded ? 'fixed inset-y-0 right-0 z-[60] w-full' : 'fixed inset-y-0 right-0 z-50 w-full xl:relative xl:inset-auto xl:z-40 xl:w-[48vw]'} ${adaptiveDock && !isExpanded ? 'aira-adaptive-real-studio' : ''} h-[100dvh] min-w-0 flex flex-col bg-claude-surface-light dark:bg-[#141413] border-l border-claude-border-light dark:border-claude-border-dark shadow-2xl xl:shadow-none flex-shrink-0 transition-colors`}
        >
          {/* Top Navigation Bar */}
          <div className="min-h-[56px] px-3 sm:px-4 py-2 flex flex-wrap items-center justify-between gap-2 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light/95 dark:bg-[#1F1E1D]/95 backdrop-blur-md select-none">
            <div className="flex flex-1 items-center space-x-2 sm:space-x-3 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-claude-terracotta/10 text-claude-terracotta flex items-center justify-center border border-claude-terracotta/20 shrink-0">
                <Layers className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <h2 className="text-[13px] font-semibold text-claude-text-light dark:text-claude-text-dark truncate tracking-tight">
                    {artifact.title}
                  </h2>
                  {adaptiveDock && allArtifacts && allArtifacts.length > 1 && (
                    <div className="flex items-center gap-1 rounded-md border border-claude-border-light bg-claude-surface2-light p-0.5 text-xs dark:border-claude-border-dark dark:bg-claude-surface2-dark" data-testid="artifact-carousel">
                      <button
                        type="button"
                        onClick={() => {
                          const prev = (currentArtifactIndex - 1 + allArtifacts.length) % allArtifacts.length;
                          onSelectArtifact?.(allArtifacts[prev]);
                        }}
                        aria-label="Previous artifact"
                        data-testid="artifact-prev"
                        className="rounded p-0.5 text-claude-muted-light hover:text-claude-terracotta dark:text-claude-muted-dark"
                      >
                        <ChevronLeft className="h-3 w-3" />
                      </button>
                      <span className="px-1 font-mono text-[10px] text-claude-text-light dark:text-claude-text-dark" data-testid="artifact-carousel-indicator">
                        {currentArtifactIndex + 1} of {allArtifacts.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const next = (currentArtifactIndex + 1) % allArtifacts.length;
                          onSelectArtifact?.(allArtifacts[next]);
                        }}
                        aria-label="Next artifact"
                        data-testid="artifact-next"
                        className="rounded p-0.5 text-claude-muted-light hover:text-claude-terracotta dark:text-claude-muted-dark"
                      >
                        <ChevronRight className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
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
                        aria-label="Artifact revision"
                        value={selectedVersion} 
                        onChange={(e) => {
                          activeNonceRef.current = newSandboxNonce();
                          setRuntimeError(null);
                          setSelectedVersion(Number(e.target.value));
                        }}
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
              <div
                role="tablist"
                aria-label="Artifact Studio views"
                className="relative mr-1 flex items-center rounded-lg border border-claude-border-light bg-claude-surface2-light p-0.5 dark:border-claude-border-dark dark:bg-claude-surface2-dark"
              >
                {([
                  { id: 'preview' as const, label: 'Preview', icon: Play, shortcut: 'Alt+1' },
                  { id: 'code' as const, label: 'Code', icon: Code, shortcut: 'Alt+2' },
                  ...(adaptiveDock && artifact.versions?.length > 1 ? [{ id: 'diff' as const, label: 'Diff', icon: Layers, shortcut: 'Alt+3' }] : []),
                  ...(adaptiveDock && executionGraph ? [{ id: 'graph' as const, label: 'Graph', icon: Network, shortcut: 'Alt+4' }] : []),
                ]).map(tab => {
                  const Icon = tab.icon;
                  const selected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      id={`tab-${tab.id}`}
                      role="tab"
                      aria-selected={selected}
                      aria-controls={`tabpanel-${tab.id}`}
                      type="button"
                      onClick={() => {
                        setActiveTab(tab.id);
                        setScreenReaderAnnouncement(`Switched to ${tab.label} tab`);
                      }}
                      title={`${tab.label} (${tab.shortcut})`}
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
                          transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
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
                {adaptiveDock && (
                  <button
                    type="button"
                    onClick={() => setShowFileExplorer(!showFileExplorer)}
                    data-testid="toggle-file-explorer"
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors ${
                      showFileExplorer
                        ? 'bg-claude-terracotta/20 text-claude-terracotta border border-claude-terracotta/30'
                        : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                    }`}
                    title={showFileExplorer ? 'Hide project file tree' : 'Show project file tree'}
                  >
                    <FolderTree className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Files</span>
                    {activeBundle && (
                      <span className="font-mono text-[10px] text-stone-400">
                        ({Object.keys(activeBundle.files).length})
                      </span>
                    )}
                  </button>
                )}
                {adaptiveDock && onSaveToProject && (
                  <button
                    type="button"
                    onClick={() => {
                      onSaveToProject(artifact);
                      setIsSavedToProject(true);
                      setTimeout(() => setIsSavedToProject(false), 2000);
                    }}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-aira-blue hover:bg-aira-blue/10 dark:text-blue-400"
                    data-testid="save-to-project-btn"
                    title={activeProjectName ? `Save to ${activeProjectName}` : 'Save to Project'}
                  >
                    {isSavedToProject ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <FolderGit2 className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">{isSavedToProject ? 'Saved' : 'Project'}</span>
                  </button>
                )}
                {adaptiveDock && onUpdateArtifact && selectedVersion !== artifact.version && (
                  <button
                    type="button"
                    disabled={isGenerating}
                    onClick={() => {
                      const restored = createRollbackRevision(artifact, selectedVersion);
                      if (restored) onUpdateArtifact(restored);
                    }}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-claude-terracotta hover:bg-claude-terracotta/10 disabled:opacity-50"
                    title="Restore selected version as a new revision"
                  >Restore</button>
                )}
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

          {adaptiveDock && runtimeError && (
            <div role="alert" data-testid="artifact-runtime-error" className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs text-rose-700 dark:text-rose-300">
              <span className="min-w-0 flex-1 break-words">Sandbox reported: {runtimeError.message}</span>
              {onRepairArtifact && (
                <button
                  type="button"
                  onClick={() => onRepairArtifact(runtimeError, artifact.title)}
                  className="shrink-0 rounded-md border border-rose-500/30 px-2 py-1 font-medium hover:bg-rose-500/10"
                >
                  Repair with Aira Agent
                </button>
              )}
            </div>
          )}

          {/* Main Studio Body */}
          <div className="flex-1 relative overflow-hidden bg-claude-surface-light dark:bg-[#141413] flex">
            {adaptiveDock && showFileExplorer && activeBundle && (
              <WorkspaceFileExplorer
                bundle={activeBundle}
                activeFilePath={selectedFilePath}
                onSelectFile={(path) => {
                  setUserSelectedFilePath(path);
                  onSelectFile?.(path);
                }}
                onExportZip={handleExportZip}
                onSyncWorkspace={handleSyncWorkspace}
                isSyncing={isSyncingWorkspace}
                syncSuccess={syncSuccess}
              />
            )}
            <div className="flex-1 relative overflow-hidden flex flex-col">
              <AnimatePresence mode="wait">
              {activeTab === 'preview' ? (
                <motion.div 
                  key="preview" 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  exit={{ opacity: 0 }} 
                  transition={{ duration: 0.15 }} 
                  role="tabpanel"
                  id="tabpanel-preview"
                  aria-labelledby="tab-preview"
                  className="w-full h-full relative flex flex-col"
                >
                  {/* Sandbox Status Bar */}
                  <div className="h-8 px-4 flex items-center justify-between bg-claude-surface-light dark:bg-[#1F1E1D] border-b border-claude-border-light dark:border-claude-border-dark text-xs text-claude-muted-light dark:text-claude-muted-dark select-none">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="font-medium tracking-tight text-claude-text-light dark:text-claude-text-dark text-[11px]">
                        {isGenerating ? 'Preparing sandbox preview' : isMultiModal ? 'Multi-Modal Asset Sandbox' : 'Live Execution Sandbox'}
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
                        onClick={() => {
                          activeNonceRef.current = newSandboxNonce();
                          setRuntimeError(null);
                          setRefreshKey(k => k + 1);
                        }}
                        className="p-1 hover:text-claude-text-light dark:hover:text-white transition-colors"
                        title="Reload sandbox"
                      >
                        <RotateCw className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Adaptive Canvas Controls Bar (Phase 4 - hidden for multi-modal assets) */}
                  {adaptiveDock && !isMultiModal && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-claude-border-light bg-claude-surface2-light/60 px-3 py-1.5 text-xs dark:border-claude-border-dark dark:bg-[#181816]" data-testid="artifact-canvas-controls">
                      {/* Device Presets */}
                      <div className="flex items-center gap-1 rounded-md border border-claude-border-light bg-claude-surface-light p-0.5 dark:border-claude-border-dark dark:bg-claude-surface-dark" role="radiogroup" aria-label="Device viewport preview">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={devicePreset === 'desktop'}
                          data-testid="device-preset-desktop"
                          onClick={() => setDevicePreset('desktop')}
                          className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${devicePreset === 'desktop' ? 'bg-aira-blue text-white' : 'text-claude-muted-light hover:text-claude-text-light dark:text-claude-muted-dark dark:hover:text-white'}`}
                          title="Fluid desktop view"
                        >
                          <Monitor className="h-3 w-3" />
                          <span className="hidden sm:inline">Desktop</span>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={devicePreset === 'tablet'}
                          data-testid="device-preset-tablet"
                          onClick={() => setDevicePreset('tablet')}
                          className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${devicePreset === 'tablet' ? 'bg-aira-blue text-white' : 'text-claude-muted-light hover:text-claude-text-light dark:text-claude-muted-dark dark:hover:text-white'}`}
                          title="Tablet frame (768px)"
                        >
                          <Tablet className="h-3 w-3" />
                          <span className="hidden sm:inline">Tablet</span>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={devicePreset === 'mobile'}
                          data-testid="device-preset-mobile"
                          onClick={() => setDevicePreset('mobile')}
                          className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${devicePreset === 'mobile' ? 'bg-aira-blue text-white' : 'text-claude-muted-light hover:text-claude-text-light dark:text-claude-muted-dark dark:hover:text-white'}`}
                          title="Mobile frame (375px)"
                        >
                          <Smartphone className="h-3 w-3" />
                          <span className="hidden sm:inline">Mobile</span>
                        </button>
                      </div>

                      {/* Zoom Controls */}
                      <div className="flex items-center gap-1" role="group" aria-label="Canvas zoom controls">
                        <button
                          type="button"
                          onClick={handleZoomOut}
                          disabled={zoomScale <= 0.5}
                          data-testid="zoom-out"
                          className="rounded p-1 text-claude-muted-light hover:bg-claude-surface2-light hover:text-claude-text-light disabled:opacity-40 dark:text-claude-muted-dark dark:hover:bg-claude-surface2-dark"
                          title="Zoom out (min 50%)"
                          aria-label="Zoom out"
                        >
                          <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={handleZoomReset}
                          data-testid="zoom-reset"
                          className="min-w-[42px] px-1 font-mono text-[11px] font-medium text-claude-text-light hover:underline dark:text-claude-text-dark"
                          title="Reset zoom to 100%"
                          aria-label="Reset zoom"
                        >
                          {Math.round(zoomScale * 100)}%
                        </button>
                        <button
                          type="button"
                          onClick={handleZoomIn}
                          disabled={zoomScale >= 1.5}
                          data-testid="zoom-in"
                          className="rounded p-1 text-claude-muted-light hover:bg-claude-surface2-light hover:text-claude-text-light disabled:opacity-40 dark:text-claude-muted-dark dark:hover:bg-claude-surface2-dark"
                          title="Zoom in (max 150%)"
                          aria-label="Zoom in"
                        >
                          <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Never rebuild the live iframe against incomplete streaming source. */}
                  {isGenerating ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center text-claude-muted-light dark:text-claude-muted-dark" aria-live="polite">
                      <span className="h-2.5 w-2.5 rounded-full bg-aira-blue animate-pulse" aria-hidden="true" />
                      <p className="text-sm font-medium">Generating artifact...</p>
                      <p className="max-w-xs text-xs leading-relaxed">{currentContent.length.toLocaleString()} characters received. The sandbox preview starts when generation completes; select Code to inspect the stream.</p>
                    </div>
                  ) : isMultiModal && selectedFile ? (
                    <div className="flex-1 w-full h-full overflow-hidden flex flex-col" data-testid="multimodal-preview-container">
                      <MultiModalAssetViewer
                        file={selectedFile}
                        isDark={typeof document !== 'undefined' && document.documentElement.classList.contains('dark')}
                      />
                    </div>
                  ) : (
                    <div className="flex-1 w-full h-full overflow-auto bg-stone-900/30 dark:bg-black/30 flex flex-col items-center justify-start p-1 sm:p-2" data-testid="artifact-viewport-container">
                      <div
                        style={{
                          width: devicePreset === 'mobile' ? '375px' : devicePreset === 'tablet' ? '768px' : '100%',
                          maxWidth: '100%',
                          height: '100%',
                          transform: zoomScale !== 1 ? `scale(${zoomScale})` : undefined,
                          transformOrigin: 'top center',
                          transition: 'width 0.2s ease, transform 0.2s ease',
                        }}
                        className={`flex flex-col flex-1 h-full bg-transparent ${devicePreset !== 'desktop' ? 'border border-claude-border-dark/60 rounded-xl shadow-2xl overflow-hidden' : ''}`}
                        data-testid="artifact-device-frame"
                      >
                        <iframe
                          key={refreshKey}
                          ref={iframeRef}
                          srcDoc={getIframeSrcDoc()}
                          sandbox="allow-scripts allow-modals allow-forms"
                          className="w-full flex-1 border-0 bg-transparent"
                          title={artifact.title}
                        />
                      </div>
                    </div>
                  )}

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
              ) : activeTab === 'diff' ? (
                <motion.div key="diff" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="tabpanel" id="tabpanel-diff" aria-labelledby="tab-diff" className="flex h-full w-full flex-col bg-[#141413] text-xs text-stone-200">
                  <div className="border-b border-stone-800 px-4 py-2 text-stone-400">
                    {earlierVersion ? `Changes from v${earlierVersion.version} to v${selectedVersion}` : 'No earlier revision available'}
                  </div>
                  <div className="flex-1 overflow-auto font-mono" data-testid="artifact-code-diff" role="region" aria-label="Artifact code diff">
                    {diffRows === null ? (
                      <p className="p-4 text-stone-400">The artifact is too large for inline comparison. Select Code or download both revisions.</p>
                    ) : diffRows.length ? diffRows.map((line, index) => (
                      <div key={index} className={`flex min-w-max whitespace-pre-wrap break-all px-4 py-0.5 ${
                        line.kind === 'added' ? 'bg-emerald-500/15 text-emerald-300'
                          : line.kind === 'removed' ? 'bg-rose-500/15 text-rose-300' : ''
                      }`}>
                        <span aria-label={line.kind} className="mr-3 w-3 shrink-0 select-none">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
                        <span>{line.text || ' '}</span>
                      </div>
                    )) : <p className="p-4 text-stone-400">No differences from the earlier revision.</p>}
                  </div>
                </motion.div>
              ) : activeTab === 'graph' && executionGraph ? (
                <motion.div key="graph" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="tabpanel" id="tabpanel-graph" aria-labelledby="tab-graph" className="flex h-full w-full flex-col">
                  <AgentExecutionGraphView
                    graph={executionGraph}
                    selectedArtifactId={artifact?.id}
                    onSelectArtifact={(artId) => {
                      const found = allArtifacts?.find(a => a.id === artId);
                      if (found) {
                        onSelectArtifact?.(found);
                        setActiveTab('preview');
                      }
                    }}
                    onApproveTask={onApproveTask}
                  />
                </motion.div>
              ) : (
                /* Code View */
                <motion.div 
                  key="code" 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  exit={{ opacity: 0 }} 
                  transition={{ duration: 0.15 }} 
                  role="tabpanel"
                  id="tabpanel-code"
                  aria-labelledby="tab-code"
                  className="w-full h-full flex flex-col bg-[#141413] text-[#D4D4D4] font-mono text-[13px] leading-[1.6]"
                >
                  <div className="h-8 px-4 flex items-center justify-between border-b border-stone-800 text-[11px] text-stone-500 select-none">
                    <span data-testid="code-file-indicator">{displayedFilePath ? `${displayedFilePath} • ` : ''}{lineCount} lines • {displayedLanguage}</span>
                    <span>Read-only</span>
                  </div>
                  {isMultiModal && selectedFile && selectedFile.kind !== 'svg' ? (
                    <div className="flex-1 p-6 flex flex-col items-center justify-center text-center font-mono text-xs text-stone-400">
                      <div className="p-5 rounded-xl bg-stone-900/80 border border-stone-800 max-w-md w-full flex flex-col gap-2.5">
                        <div className="text-stone-200 font-semibold text-sm">{selectedFile.name}</div>
                        <div className="text-stone-400 text-xs font-mono">{selectedFile.path} • {selectedFile.kind.toUpperCase()}</div>
                        <div className="text-stone-500 text-[11px]">Binary multi-modal asset ({selectedFile.sizeBytes || selectedFile.content.length} bytes)</div>
                        <div className="mt-3 p-3 bg-stone-950 rounded text-[11px] text-stone-400 break-all text-left max-h-36 overflow-auto border border-stone-800/60">
                          {selectedFile.content.slice(0, 300)}...
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 overflow-y-auto p-4 flex">
                      <div className="select-none text-stone-600 text-right pr-4 font-mono text-xs border-r border-stone-800/60 mr-4">
                        {Array.from({ length: lineCount }).map((_, i) => (
                          <div key={i}>{i + 1}</div>
                        ))}
                      </div>
                      <pre className="whitespace-pre overflow-x-auto flex-1 font-mono text-xs text-stone-200">
                        <code>{displayedContent}</code>
                      </pre>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
            </div>
          </div>

          {/* Screen Reader Announcement Status */}
          <div className="sr-only" aria-live="polite" role="status">
            {screenReaderAnnouncement}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
};
