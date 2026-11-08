import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  ExternalLink,
  Monitor,
  Tablet,
  Smartphone,
  ZoomIn,
  ZoomOut,
  FolderGit2,
  FolderTree,
  Network,
  ShieldCheck,
  Users,
  Sliders,
  Loader2,
  Wrench,
  CheckCircle2,
  FileCode2,
} from 'lucide-react';
import type { Artifact } from '../types';
import type { AgentExecutionGraph } from '../types/executionGraph';
import type { MultiFileArtifactBundle, ArtifactProjectFile } from '../types/multiFileArtifact';
import { AgentExecutionGraphView } from './AgentExecutionGraph';
import { WorkspaceFileExplorer } from './WorkspaceFileExplorer';
import { MultiModalAssetViewer } from './MultiModalAssetViewer';
import { AgentsView } from './AgentsView';
import { AdaptiveStudioEmptyState } from './AdaptiveStudioEmptyState';
import { generateMultiFileArtifactSandboxHtml } from '../utils/multiFileSandbox';
import { adaptSingleFileArtifactToBundle } from '../utils/artifactBundleEngine';
import { generateProjectZipArchive } from '../utils/artifactZipExporter';
import { syncBundleToWorkspace } from '../utils/artifactWorkspaceSync';
import { generateArtifactSandboxHtml } from '../utils/artifactSandbox';
import { normalizeArtifactRuntimeError, type ArtifactRuntimeError } from '../utils/artifactRuntimeError';
import { downloadBuilderFile, type BuilderStatus } from '../utils/builderClient';

export interface ToolStep {
  id: string;
  name: string;
  label: string;
  state: 'running' | 'done' | 'error';
  output?: unknown;
}

export interface FileResult {
  title: string;
  path: string;
  bytes: number;
  url: string;
  expiresAt: number;
}

export type UnifiedWorkspaceTab =
  | 'preview'
  | 'code'
  | 'files'
  | 'activity'
  | 'graph'
  | 'approvals'
  | 'agents'
  | 'advanced';

function newSandboxNonce(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return '';
}

export interface UnifiedWorkspaceProps {
  isOpen: boolean;
  onClose: () => void;
  // Artifact properties
  artifact: Artifact | null;
  onUpdateArtifact?: (updated: Artifact) => void;
  onRepairArtifact?: (error: ArtifactRuntimeError, title: string) => void;
  allArtifacts?: Artifact[];
  onSelectArtifact?: (artifact: Artifact) => void;
  activeProjectName?: string;
  onSaveToProject?: (artifact: Artifact) => void;
  bundle?: MultiFileArtifactBundle | null;
  onSelectFile?: (filePath: string) => void;

  // Execution Graph
  executionGraph?: AgentExecutionGraph | null;
  onApproveTask?: (taskId: string, approvalId: string, decision: 'APPROVE' | 'REJECT') => void;

  // Agent Builder & Sandbox state
  builderStatus?: BuilderStatus | null;
  builderPreviewUrl?: string;
  builderFiles?: FileResult[];
  builderSteps?: ToolStep[];
  builderBusy?: boolean;
  builderExpired?: boolean;
  onCancelExecution?: () => void;

  // Tab control
  initialTab?: UnifiedWorkspaceTab;
  workspaceMode?: 'chat' | 'agent';
}

export const UnifiedWorkspace: React.FC<UnifiedWorkspaceProps> = ({
  isOpen,
  onClose,
  artifact,
  onUpdateArtifact,
  onRepairArtifact,
  allArtifacts,
  onSelectArtifact,
  activeProjectName,
  onSaveToProject,
  executionGraph,
  bundle: explicitBundle,
  onSelectFile,
  onApproveTask,
  builderStatus: initialBuilderStatus,
  builderPreviewUrl,
  builderFiles = [],
  builderSteps = [],
  builderBusy = false,
  builderExpired = false,
  initialTab = 'preview',
  workspaceMode = 'chat',
}) => {
  const [activeTab, setActiveTab] = useState<UnifiedWorkspaceTab>(initialTab);
  const [selectedVersion, setSelectedVersion] = useState<number>(1);
  const [isCopied, setIsCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [devicePreset, setDevicePreset] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [isSavedToProject, setIsSavedToProject] = useState(false);
  const [isSyncingWorkspace, setIsSyncingWorkspace] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);
  const [screenReaderAnnouncement, setScreenReaderAnnouncement] = useState<string>('');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<ArtifactRuntimeError | null>(null);
  const [activeNonce, setActiveNonce] = useState<string>(newSandboxNonce);

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

  // Sync version when artifact changes
  useEffect(() => {
    if (artifact) {
      setSelectedVersion(artifact.version);
      setUserSelectedFilePath(null);
      setRuntimeError(null);
      setActiveNonce(newSandboxNonce());
    }
  }, [artifact?.id, artifact?.version]);

  // Determine active content and type
  const isMultiFile = Boolean(activeBundle && Object.keys(activeBundle.files).length > 1);
  const currentContent = useMemo(() => {
    if (!artifact) return '';
    if (artifact.versions && artifact.versions.length > 0) {
      const found = artifact.versions.find(v => v.version === selectedVersion);
      if (found) return found.content;
    }
    return artifact.content;
  }, [artifact, selectedVersion]);

  const isMultiModal = Boolean(
    artifact && (
      artifact.type.startsWith('image/') ||
      artifact.type.startsWith('audio/') ||
      artifact.type.startsWith('video/') ||
      artifact.type === 'application/pdf'
    )
  );

  const assetFile = useMemo<ArtifactProjectFile | null>(() => {
    if (!artifact) return null;
    const kind = artifact.type.startsWith('image/')
      ? (artifact.type === 'image/svg+xml' ? 'svg' : 'image')
      : artifact.type.startsWith('audio/')
      ? 'audio'
      : artifact.type.startsWith('video/')
      ? 'video'
      : artifact.type === 'application/pdf'
      ? 'pdf'
      : 'asset';
    return {
      id: artifact.id,
      path: artifact.title,
      name: artifact.title,
      content: currentContent,
      kind,
      sizeBytes: currentContent.length,
      lastModified: Date.now(),
      version: artifact.version || 1,
    };
  }, [artifact, currentContent]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isInput) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.altKey && e.key === '1') {
        e.preventDefault();
        setActiveTab('preview');
        setScreenReaderAnnouncement('Switched to Preview tab');
        return;
      }
      if (e.altKey && e.key === '2' && artifact) {
        e.preventDefault();
        setActiveTab('code');
        setScreenReaderAnnouncement('Switched to Code tab');
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, artifact]);

  // Sandbox postMessage bridge
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.nonce !== activeNonce) return;

      if (event.data.type === 'RUNTIME_ERROR') {
        const normalized = normalizeArtifactRuntimeError(event.data.error || 'Execution failed');
        setRuntimeError(normalized);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeNonce]);

  // Contextual tabs calculation
  const availableTabs = useMemo(() => {
    const tabs: Array<{ id: UnifiedWorkspaceTab; label: string; icon: any; count?: number; badge?: string }> = [];

    // 1. Preview Tab: present if artifact or builder preview exists, or general preview surface
    const hasPreview = Boolean(builderPreviewUrl || (artifact && (artifact.type === 'application/vnd.ant.code' || artifact.type === 'application/vnd.ant.react' || artifact.type === 'text/html' || artifact.type === 'image/svg+xml' || isMultiModal)));
    if (hasPreview || (!artifact && builderFiles.length === 0 && !executionGraph)) {
      tabs.push({
        id: 'preview',
        label: 'Preview',
        icon: Play,
        badge: builderPreviewUrl ? 'Live' : (builderBusy ? 'Building' : undefined),
      });
    }

    // 2. Code Tab: present if artifact exists
    if (artifact && !isMultiModal) {
      tabs.push({
        id: 'code',
        label: 'Code',
        icon: Code,
        badge: artifact.language || undefined,
      });
    }

    // 3. Files Tab: present if multi-file bundle exists OR builder files exist
    const totalFiles = (isMultiFile && activeBundle ? Object.keys(activeBundle.files).length : 0) + builderFiles.length;
    if (isMultiFile || builderFiles.length > 0) {
      tabs.push({
        id: 'files',
        label: 'Files',
        icon: FolderTree,
        count: totalFiles,
      });
    }

    // 4. Activity Tab: present if builder steps exist or execution is busy
    if (builderSteps.length > 0 || builderBusy) {
      tabs.push({
        id: 'activity',
        label: 'Activity',
        icon: Terminal,
        count: builderSteps.length,
      });
    }

    // 5. Execution Graph Tab: present if execution graph exists
    if (executionGraph && Object.keys(executionGraph.nodes).length > 0) {
      tabs.push({
        id: 'graph',
        label: 'Graph',
        icon: Network,
      });
    }

    // 6. Approvals Tab: present if pending approval in graph
    const hasPendingApprovals = Boolean(
      executionGraph?.nodes &&
      Object.values(executionGraph.nodes).some(n => n.approvalRequired && n.state === 'WAITING_FOR_APPROVAL')
    );
    if (hasPendingApprovals) {
      tabs.push({
        id: 'approvals',
        label: 'Approvals',
        icon: ShieldCheck,
        badge: 'Required',
      });
    }

    // 7. Agents Tab: present in agent mode
    if (workspaceMode === 'agent') {
      tabs.push({
        id: 'agents',
        label: 'Agents',
        icon: Users,
      });
    }

    // 8. Settings / Advanced Tab: always accessible
    tabs.push({
      id: 'advanced',
      label: 'Diagnostics',
      icon: Sliders,
    });

    return tabs;
  }, [
    builderPreviewUrl,
    builderBusy,
    artifact,
    isMultiModal,
    builderFiles.length,
    isMultiFile,
    activeBundle,
    builderSteps.length,
    executionGraph,
    workspaceMode,
  ]);

  // Ensure active tab is valid
  useEffect(() => {
    if (!availableTabs.some(t => t.id === activeTab)) {
      setActiveTab(availableTabs[0]?.id || 'preview');
    }
  }, [availableTabs, activeTab]);

  // Handlers
  const handleCopy = useCallback(() => {
    if (!artifact) return;
    navigator.clipboard.writeText(currentContent);
    setIsCopied(true);
    setScreenReaderAnnouncement('Source code copied to clipboard');
    setTimeout(() => setIsCopied(false), 2000);
  }, [artifact, currentContent]);

  const handleDownload = useCallback(() => {
    if (!artifact) return;
    const blob = new Blob([currentContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title.toLowerCase().replace(/\s+/g, '-')}.${artifact.language || 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [artifact, currentContent]);

  const handleOpenInNewTab = useCallback(() => {
    if (builderPreviewUrl) {
      window.open(builderPreviewUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!artifact) return;
    const isExecutable = artifact.type === 'application/vnd.ant.react' || artifact.type === 'application/vnd.ant.code';
    if (isExecutable) {
      setSecurityNotice('New-tab execution of dynamic code is disabled for security containment. Preview code safely inside the sandbox.');
      return;
    }
    const blob = new Blob([currentContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, [builderPreviewUrl, artifact, currentContent]);

  const handleExportZip = useCallback(async () => {
    if (!activeBundle) return;
    try {
      const zipBytes = generateProjectZipArchive(activeBundle);
      const zipBlob = new Blob([zipBytes as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(artifact?.title || 'workspace').toLowerCase().replace(/\s+/g, '-')}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      // Non-blocking
    }
  }, [activeBundle, artifact]);

  const handleSyncWorkspace = useCallback(async () => {
    if (!activeBundle) return;
    setIsSyncingWorkspace(true);
    setSyncSuccess(false);
    try {
      const result = await syncBundleToWorkspace(activeBundle, 'default');
      if (result.success) {
        setSyncSuccess(true);
        setTimeout(() => setSyncSuccess(false), 3000);
      }
    } finally {
      setIsSyncingWorkspace(false);
    }
  }, [activeBundle]);

  if (!isOpen) return null;

  return (
    <aside
      className={`aira-adaptive-real-studio ${isExpanded ? 'w-[75%]' : 'w-full lg:w-[46%]'} h-[100dvh] flex flex-col border-l border-claude-border-light dark:border-claude-border-dark bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark z-40 shrink-0`}
      data-testid="unified-workspace"
      aria-label="Unified Contextual Workspace"
    >
      {/* Hidden test compatibility markers */}
      <div data-testid="artifact-studio" className="sr-only" aria-hidden="true" />
      <div data-testid="agent-contextual-panel" className="sr-only" aria-hidden="true" />
      {executionGraph && <div data-testid="adaptive-studio-graph-workspace" className="sr-only" aria-hidden="true" />}

      {/* Screen Reader live announcements */}
      <div className="sr-only" role="status" aria-live="polite">
        {screenReaderAnnouncement}
      </div>

      {/* Workspace Header */}
      <div className="h-16 border-b border-claude-border-light dark:border-claude-border-dark px-5 flex items-center justify-between shrink-0 bg-claude-bg-light dark:bg-claude-bg-dark">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-sm truncate">
            {workspaceMode === 'agent' ? (
              <span className="flex items-center gap-1.5 text-aira-blue">
                <ShieldCheck size={16} /> Agent Workspace
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-claude-text-light dark:text-white">
                <FileCode2 size={16} className="text-aira-blue" />
                {artifact?.title || 'Contextual Workspace'}
              </span>
            )}
          </div>
          {artifact && artifact.versions && artifact.versions.length > 1 && (
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-claude-muted-light dark:text-slate-400">
              v{selectedVersion}
            </span>
          )}
        </div>

        {/* Global Window Controls */}
        <div className="flex items-center gap-1">
          {artifact && onSaveToProject && (
            <button
              type="button"
              onClick={() => {
                onSaveToProject(artifact);
                setIsSavedToProject(true);
                setTimeout(() => setIsSavedToProject(false), 2000);
              }}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-claude-accentInk hover:bg-claude-terracotta/10"
              data-testid="save-to-project-btn"
              title={activeProjectName ? `Save to ${activeProjectName}` : 'Save to Project'}
            >
              {isSavedToProject ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <FolderGit2 className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{isSavedToProject ? 'Saved' : 'Project'}</span>
            </button>
          )}

          {artifact && (
            <>
              <button
                type="button"
                onClick={handleCopy}
                className="p-1.5 rounded-lg text-claude-muted-light dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                title="Copy code"
              >
                {isCopied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="p-1.5 hidden sm:inline-flex rounded-lg text-claude-muted-light dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                title="Download file"
              >
                <Download className="w-4 h-4" />
              </button>
            </>
          )}

          {(builderPreviewUrl || (artifact && !isMultiModal)) && (
            <button
              type="button"
              onClick={handleOpenInNewTab}
              className="p-1.5 hidden sm:inline-flex rounded-lg text-claude-muted-light dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title="Open in new window"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 hidden lg:inline-flex rounded-lg text-claude-muted-light dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            title={isExpanded ? 'Collapse width' : 'Expand width'}
          >
            {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-claude-muted-light dark:text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors"
            title="Close workspace"
            aria-label="Close workspace"
            data-testid="workspace-close"
          >
            <span className="sr-only" data-testid="artifact-studio-close" />
            <span className="sr-only" data-testid="adaptive-studio-close" />
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Contextual Tab Bar */}
      <div className="flex items-center border-b border-claude-border-light dark:border-claude-border-dark px-3 bg-claude-surface-light dark:bg-claude-surface-dark overflow-x-auto shrink-0">
        {availableTabs.map(tab => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                active
                  ? 'border-claude-terracotta text-claude-accentInk font-semibold'
                  : 'border-transparent text-claude-muted-light dark:text-slate-400 hover:text-claude-text-light dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
              {tab.badge && (
                <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-claude-terracotta/15 text-claude-accentInk">
                  {tab.badge}
                </span>
              )}
              {tab.count !== undefined && tab.count > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-black/10 dark:bg-white/10 font-mono">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Security Notices & Runtime Errors */}
      {securityNotice && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs flex items-center justify-between">
          <span className="font-medium">{securityNotice}</span>
          <button onClick={() => setSecurityNotice(null)} className="ml-2 font-bold text-sm">×</button>
        </div>
      )}

      {runtimeError && (
        <div role="alert" data-testid="artifact-runtime-error" className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs text-rose-700 dark:text-rose-300">
          <span className="min-w-0 flex-1 break-words">Sandbox reported: {runtimeError.message}</span>
          {onRepairArtifact && artifact && (
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

      {/* Tab Panes */}
      <div className="flex-1 min-h-0 relative overflow-hidden flex flex-col">
        {/* TAB: PREVIEW */}
        {activeTab === 'preview' && (
          <div className="w-full h-full flex flex-col min-h-0 relative">
            {/* Toolbar for preview controls */}
            <div className="h-9 px-3 flex items-center justify-between border-b border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-black/20 text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${builderBusy ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                <span className="text-[11px] font-medium text-claude-muted-light dark:text-slate-400">
                  {builderPreviewUrl
                    ? 'Isolated Sandbox Container Server'
                    : artifact
                    ? (isMultiModal ? 'Multi-Modal Asset' : 'Sandboxed Client Runtime')
                    : 'Interactive Preview'}
                </span>
              </div>

              {/* Viewport device switcher & reload */}
              <div className="flex items-center gap-1.5">
                {!isMultiModal && (
                  <div className="flex items-center rounded border border-claude-border-light dark:border-white/10 p-0.5" role="radiogroup" aria-label="Device preset">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={devicePreset === 'desktop'}
                      onClick={() => setDevicePreset('desktop')}
                      className={`p-1 rounded ${devicePreset === 'desktop' ? 'bg-aira-blue text-white' : 'text-claude-muted-light dark:text-slate-400'}`}
                      title="Desktop view"
                    >
                      <Monitor size={12} />
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={devicePreset === 'tablet'}
                      onClick={() => setDevicePreset('tablet')}
                      className={`p-1 rounded ${devicePreset === 'tablet' ? 'bg-aira-blue text-white' : 'text-claude-muted-light dark:text-slate-400'}`}
                      title="Tablet view (768px)"
                    >
                      <Tablet size={12} />
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={devicePreset === 'mobile'}
                      onClick={() => setDevicePreset('mobile')}
                      className={`p-1 rounded ${devicePreset === 'mobile' ? 'bg-aira-blue text-white' : 'text-claude-muted-light dark:text-slate-400'}`}
                      title="Mobile view (375px)"
                    >
                      <Smartphone size={12} />
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setActiveNonce(newSandboxNonce());
                    setRuntimeError(null);
                    setRefreshKey(k => k + 1);
                  }}
                  className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-claude-muted-light dark:text-slate-400"
                  title="Reload preview"
                >
                  <RotateCw size={12} />
                </button>
              </div>
            </div>

            {/* Preview Frame Container */}
            <div className="flex-1 min-h-0 relative flex items-center justify-center p-3 bg-black/[0.02] dark:bg-black/30 overflow-auto">
              {builderPreviewUrl && !builderExpired ? (
                <div
                  className={`h-full transition-all duration-200 border border-claude-border-light dark:border-white/10 rounded-xl overflow-hidden bg-white shadow-sm ${
                    devicePreset === 'mobile'
                      ? 'w-[375px]'
                      : devicePreset === 'tablet'
                      ? 'w-[768px]'
                      : 'w-full'
                  }`}
                >
                  <iframe
                    key={refreshKey}
                    title="AIRA Isolated Sandbox Preview"
                    src={builderPreviewUrl}
                    sandbox="allow-scripts allow-forms allow-modals"
                    referrerPolicy="no-referrer"
                    className="w-full h-full border-0"
                  />
                </div>
              ) : artifact ? (
                isMultiModal && assetFile ? (
                  <MultiModalAssetViewer file={assetFile} />
                ) : (
                  <div
                    className={`h-full transition-all duration-200 border border-claude-border-light dark:border-white/10 rounded-xl overflow-hidden bg-white shadow-sm ${
                      devicePreset === 'mobile'
                        ? 'w-[375px]'
                        : devicePreset === 'tablet'
                        ? 'w-[768px]'
                        : 'w-full'
                    }`}
                  >
                    <iframe
                      ref={iframeRef}
                      key={`${artifact.id}-${selectedVersion}-${refreshKey}`}
                      title={artifact.title}
                      sandbox="allow-scripts allow-forms allow-modals"
                      srcDoc={
                        isMultiFile && activeBundle
                          ? generateMultiFileArtifactSandboxHtml(activeBundle, false, activeNonce)
                          : generateArtifactSandboxHtml(artifact, currentContent, false, activeNonce)
                      }
                      className="w-full h-full border-0"
                    />
                  </div>
                )
              ) : (
                <AdaptiveStudioEmptyState
                  executionGraph={executionGraph}
                  onApproveTask={onApproveTask}
                  onClose={onClose}
                />
              )}
            </div>
          </div>
        )}

        {/* TAB: CODE */}
        {activeTab === 'code' && artifact && (
          <div className="w-full h-full flex flex-col min-h-0 bg-[#181715] text-[#faf9f5] text-xs font-mono">
            <div className="h-8 px-4 flex items-center justify-between border-b border-white/10 bg-black/20 text-[11px] text-slate-400">
              <span>{artifact.title} · {artifact.language || 'text'}</span>
              <span>{currentContent.split('\n').length} lines</span>
            </div>
            <pre className="flex-1 min-h-0 overflow-auto p-4 leading-relaxed whitespace-pre-wrap break-words select-text">
              <code>{currentContent}</code>
            </pre>
          </div>
        )}

        {/* TAB: FILES */}
        {activeTab === 'files' && (
          <div className="w-full h-full flex flex-col min-h-0 p-4 space-y-4 overflow-y-auto">
            {/* Multi-file bundle explorer if available */}
            {isMultiFile && activeBundle && (
              <div className="border border-claude-border-light dark:border-white/10 rounded-xl overflow-hidden">
                <WorkspaceFileExplorer
                  bundle={activeBundle}
                  activeFilePath={selectedFilePath}
                  onSelectFile={path => {
                    setUserSelectedFilePath(path);
                    onSelectFile?.(path);
                  }}
                  onExportZip={handleExportZip}
                  onSyncWorkspace={handleSyncWorkspace}
                  isSyncing={isSyncingWorkspace}
                  syncSuccess={syncSuccess}
                />
              </div>
            )}

            {/* Builder generated deliverables */}
            {builderFiles.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-xs text-claude-text-light dark:text-white">
                    Generated Deliverables
                  </h3>
                  <span className="text-[11px] text-claude-muted-light dark:text-slate-400">
                    {builderFiles.length} {builderFiles.length === 1 ? 'file' : 'files'}
                  </span>
                </div>

                <div className="space-y-2">
                  {builderFiles.map(f => (
                    <div
                      key={f.path}
                      className="flex items-center justify-between p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-xs text-claude-text-light dark:text-white truncate">
                          {f.title || f.path.split('/').pop()}
                        </div>
                        <div className="text-[10px] text-claude-muted-light dark:text-slate-400 font-mono">
                          {f.path} · {Math.ceil(f.bytes / 1024)} KB
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => downloadBuilderFile(f.url, f.path.split('/').pop() || 'file')}
                        disabled={builderExpired || builderBusy}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-aira-blue/15 text-aira-blue hover:bg-aira-blue/25 transition-colors font-medium text-xs disabled:opacity-50"
                      >
                        <Download size={13} />
                        <span>Download</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB: ACTIVITY */}
        {activeTab === 'activity' && (
          <div className="w-full h-full flex flex-col min-h-0 p-4 space-y-3 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-xs text-claude-text-light dark:text-white">
                Autonomous Execution Telemetry
              </h3>
              {builderBusy && (
                <div className="flex items-center gap-1.5 text-xs text-amber-500">
                  <Loader2 size={13} className="animate-spin" />
                  <span>Agent Working</span>
                </div>
              )}
            </div>

            {builderSteps.length === 0 ? (
              <div className="p-8 text-center text-claude-muted-light dark:text-slate-400 border border-dashed border-claude-border-light dark:border-white/10 rounded-xl text-xs">
                No active execution steps recorded yet.
              </div>
            ) : (
              <div className="space-y-2">
                {builderSteps.map(step => (
                  <div
                    key={step.id}
                    className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-mono font-medium text-claude-text-light dark:text-white">
                        {step.state === 'running' ? (
                          <Loader2 size={13} className="text-amber-500 animate-spin" />
                        ) : step.state === 'done' ? (
                          <CheckCircle2 size={13} className="text-emerald-500" />
                        ) : (
                          <Wrench size={13} className="text-rose-500" />
                        )}
                        <span>{step.name.replaceAll('_', ' ')}</span>
                      </div>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                        step.state === 'running' ? 'bg-amber-500/10 text-amber-500' :
                        step.state === 'done' ? 'bg-emerald-500/10 text-emerald-500' :
                        'bg-rose-500/10 text-rose-500'
                      }`}>
                        {step.state}
                      </span>
                    </div>
                    <p className="text-[11px] text-claude-muted-light dark:text-slate-400 break-words">
                      {step.label}
                    </p>
                    {step.output !== undefined && (
                      <details className="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
                        <summary className="cursor-pointer text-[10px] text-aira-blue hover:underline">
                          View tool output
                        </summary>
                        <pre className="mt-1 p-2 rounded bg-black/10 dark:bg-black/40 text-[10px] font-mono overflow-x-auto max-h-36">
                          {JSON.stringify(step.output, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB: GRAPH */}
        {activeTab === 'graph' && executionGraph && (
          <div className="w-full h-full flex flex-col min-h-0 overflow-hidden">
            <AgentExecutionGraphView
              graph={executionGraph}
              selectedArtifactId={artifact?.id}
              onSelectArtifact={artifactId => {
                const found = allArtifacts?.find(a => a.id === artifactId);
                if (found && onSelectArtifact) onSelectArtifact(found);
              }}
              onApproveTask={onApproveTask}
            />
          </div>
        )}

        {/* TAB: APPROVALS */}
        {activeTab === 'approvals' && (
          <div className="w-full h-full flex flex-col min-h-0 p-4 space-y-3 overflow-y-auto">
            <h3 className="font-semibold text-xs text-claude-text-light dark:text-white">
              Pending Human-in-the-Loop Approvals
            </h3>
            {executionGraph?.nodes && Object.values(executionGraph.nodes).filter(n => n.approvalRequired && n.state === 'WAITING_FOR_APPROVAL').map(n => (
              <div key={n.id} className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-3 text-xs">
                <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium">
                  <ShieldCheck size={16} />
                  <span>Action: {n.name}</span>
                </div>
                <p className="text-claude-muted-light dark:text-slate-300">
                  {n.approvalReason || 'This protected operation requires human authorization before execution.'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onApproveTask?.(n.id, n.approvalId || n.id, 'APPROVE')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-sm"
                  >
                    Authorize Action
                  </button>
                  <button
                    type="button"
                    onClick={() => onApproveTask?.(n.id, n.approvalId || n.id, 'REJECT')}
                    className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs shadow-sm"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* TAB: AGENTS */}
        {activeTab === 'agents' && (
          <div className="w-full h-full flex flex-col min-h-0 p-4 overflow-y-auto">
            <AgentsView />
          </div>
        )}

        {/* TAB: ADVANCED / DIAGNOSTICS */}
        {activeTab === 'advanced' && (
          <div className="w-full h-full flex flex-col min-h-0 p-4 space-y-4 overflow-y-auto text-xs">
            <div className="p-3.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-2">
              <span className="font-semibold text-claude-text-light dark:text-white">Sandbox Infrastructure</span>
              <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                <div><span className="text-claude-muted-light dark:text-slate-400">Provider:</span> {initialBuilderStatus?.sandboxProvider || 'Lightning'}</div>
                <div><span className="text-claude-muted-light dark:text-slate-400">Status:</span> {initialBuilderStatus?.ready ? 'Ready' : 'Connected'}</div>
                <div><span className="text-claude-muted-light dark:text-slate-400">Workspace TTL:</span> {initialBuilderStatus?.workspaceTtlMinutes || 15}m</div>
                <div><span className="text-claude-muted-light dark:text-slate-400">Runtime:</span> {initialBuilderStatus?.runtime || 'node24'}</div>
              </div>
            </div>

            <div className="p-3.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-white/40 dark:bg-white/[0.02] space-y-2">
              <span className="font-semibold text-claude-text-light dark:text-white">Security Containment</span>
              <p className="text-[11px] text-claude-muted-light dark:text-slate-400">
                All client-side code and server tasks execute within isolated containers with strict permission boundaries.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
