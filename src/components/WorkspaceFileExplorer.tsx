import React, { useState, useMemo } from 'react';
import {
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  Volume2,
  Video,
  Search,
  Download,
  UploadCloud,
  ChevronRight,
  ChevronDown,
  Layers,
  Sparkles,
  AlertCircle,
  FileCheck
} from 'lucide-react';
import type {
  ArtifactProjectFile,
  FileTreeNode,
  MultiFileArtifactBundle,
  FileDependencyReference
} from '../types/multiFileArtifact';
import { buildFileTree } from '../utils/artifactBundleEngine';

interface WorkspaceFileExplorerProps {
  bundle: MultiFileArtifactBundle;
  activeFilePath: string;
  onSelectFile: (filePath: string) => void;
  onExportZip?: () => void;
  onSyncWorkspace?: () => void;
  isSyncing?: boolean;
  syncSuccess?: boolean;
}

function getFileIcon(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx') || lower.endsWith('.ts') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return <FileCode className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
  }
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.less')) {
    return <FileCode className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
  }
  if (lower.endsWith('.json')) {
    return <FileSpreadsheet className="w-3.5 h-3.5 text-yellow-400 shrink-0" />;
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt')) {
    return <FileText className="w-3.5 h-3.5 text-stone-400 shrink-0" />;
  }
  if (lower.endsWith('.svg')) {
    return <ImageIcon className="w-3.5 h-3.5 text-teal-400 shrink-0" />;
  }
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp') || lower.endsWith('.gif')) {
    return <ImageIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  }
  if (lower.endsWith('.mp3') || lower.endsWith('.wav') || lower.endsWith('.ogg') || lower.endsWith('.aac') || lower.endsWith('.m4a')) {
    return <Volume2 className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
  }
  if (lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.ogv')) {
    return <Video className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
  }
  if (lower.endsWith('.pdf')) {
    return <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
  }
  return <FileText className="w-3.5 h-3.5 text-stone-400 shrink-0" />;
}

export const WorkspaceFileExplorer: React.FC<WorkspaceFileExplorerProps> = ({
  bundle,
  activeFilePath,
  onSelectFile,
  onExportZip,
  onSyncWorkspace,
  isSyncing = false,
  syncSuccess = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [showDependencyPanel, setShowDependencyPanel] = useState(false);

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders(prev => ({ ...prev, [folderPath]: !prev[folderPath] }));
  };

  const fileTree = useMemo(() => {
    return buildFileTree(bundle.files);
  }, [bundle.files]);

  // Filtered files when searching
  const matchingFiles = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const query = searchQuery.toLowerCase().trim();
    return Object.values(bundle.files).filter(f =>
      f.path.toLowerCase().includes(query) || f.name.toLowerCase().includes(query)
    );
  }, [bundle.files, searchQuery]);

  // Dependency summary for the currently active file
  const activeFileDependencies = useMemo(() => {
    return bundle.dependencies.filter(d => d.sourcePath === activeFilePath);
  }, [bundle.dependencies, activeFilePath]);

  const activeFileInboundReferences = useMemo(() => {
    return bundle.dependencies.filter(d => d.targetPath === activeFilePath);
  }, [bundle.dependencies, activeFilePath]);

  const renderTreeNodes = (nodes: FileTreeNode[], depth = 0) => {
    return (
      <div role="group" className="flex flex-col">
        {nodes.map(node => {
          if (node.isFolder) {
            const isCollapsed = Boolean(collapsedFolders[node.path]);
            return (
              <div key={node.id} className="flex flex-col">
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleFolder(node.path)}
                  style={{ paddingLeft: `${depth * 12 + 8}px` }}
                  className="flex items-center gap-1.5 py-1 text-xs text-stone-400 hover:text-stone-200 hover:bg-stone-800/40 rounded transition-colors text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 shrink-0 text-stone-500" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 shrink-0 text-stone-500" />
                  )}
                  {isCollapsed ? (
                    <Folder className="w-3.5 h-3.5 text-amber-500/80 shrink-0" />
                  ) : (
                    <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  )}
                  <span className="truncate font-mono text-[12px]">{node.name}</span>
                </button>
                {!isCollapsed && node.children && (
                  <div className="flex flex-col">
                    {renderTreeNodes(node.children, depth + 1)}
                  </div>
                )}
              </div>
            );
          }

          const isSelected = node.path === activeFilePath;
          const isEntry = node.file?.isEntry || node.path === bundle.entryPoint;
          const hasUnsaved = Boolean(node.file?.hasUnsavedChanges);

          return (
            <button
              key={node.id}
              type="button"
              role="treeitem"
              aria-selected={isSelected}
              data-testid={`file-item-${node.path.replace(/\//g, '-')}`}
              onClick={() => onSelectFile(node.path)}
              style={{ paddingLeft: `${depth * 12 + 20}px` }}
              className={`flex items-center justify-between gap-1.5 py-1 pr-2 text-xs rounded transition-colors text-left group ${
                isSelected
                  ? 'bg-claude-terracotta/20 text-claude-terracotta font-medium border-l-2 border-claude-terracotta'
                  : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/40'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {getFileIcon(node.name)}
                <span className="truncate font-mono text-[11px]">{node.name}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isEntry && (
                  <span
                    title="Designated entrypoint"
                    className="px-1 py-0.2 bg-amber-500/20 text-amber-400 font-mono text-[9px] rounded uppercase"
                  >
                    Entry
                  </span>
                )}
                {hasUnsaved && (
                  <span
                    title="Modified file"
                    className="w-1.5 h-1.5 rounded-full bg-blue-400"
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  const totalFiles = Object.keys(bundle.files).length;

  return (
    <aside
      data-testid="workspace-file-explorer"
      aria-label="Workspace Project Explorer"
      className="w-full sm:w-64 border-r border-stone-800 bg-[#161618] flex flex-col h-full shrink-0 select-none overflow-hidden"
    >
      {/* Explorer Header */}
      <div className="p-2.5 border-b border-stone-800/80 flex items-center justify-between gap-2 bg-[#19191B]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Layers className="w-3.5 h-3.5 text-claude-terracotta shrink-0" />
          <span className="text-xs font-semibold text-stone-200 truncate tracking-tight">
            Workspace Files
          </span>
          <span className="font-mono text-[10px] text-stone-500 px-1 py-0.2 rounded bg-stone-800">
            {totalFiles}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onExportZip && (
            <button
              type="button"
              data-testid="export-zip-btn"
              onClick={onExportZip}
              title="Export project bundle as ZIP"
              className="p-1 rounded text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
          {onSyncWorkspace && (
            <button
              type="button"
              data-testid="sync-workspace-btn"
              onClick={onSyncWorkspace}
              disabled={isSyncing}
              title="Sync bundle to AIRA workspace"
              className="p-1 rounded text-stone-400 hover:text-stone-200 hover:bg-stone-800 disabled:opacity-50 transition-colors"
            >
              {syncSuccess ? (
                <FileCheck className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <UploadCloud className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Search Bar */}
      <div className="p-2 border-b border-stone-800/60 bg-[#141416]">
        <div className="relative flex items-center">
          <Search className="w-3 h-3 text-stone-500 absolute left-2 pointer-events-none" />
          <input
            type="text"
            data-testid="file-search-input"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            className="w-full pl-6 pr-2 py-1 bg-stone-900 border border-stone-800 rounded text-[11px] font-mono text-stone-200 placeholder-stone-600 focus:outline-none focus:border-stone-700"
          />
        </div>
      </div>

      {/* File Tree View */}
      <div
        role="tree"
        aria-label="File tree"
        className="flex-1 overflow-y-auto p-1.5 text-xs font-mono"
      >
        {matchingFiles ? (
          matchingFiles.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <div className="px-2 py-1 text-[10px] text-stone-500 uppercase tracking-wider font-semibold">
                Search Results ({matchingFiles.length})
              </div>
              {matchingFiles.map(file => {
                const isSelected = file.path === activeFilePath;
                return (
                  <button
                    key={file.id}
                    type="button"
                    data-testid={`search-result-${file.path.replace(/\//g, '-')}`}
                    onClick={() => onSelectFile(file.path)}
                    className={`flex items-center justify-between gap-1.5 px-2 py-1 text-xs rounded transition-colors text-left ${
                      isSelected
                        ? 'bg-claude-terracotta/20 text-claude-terracotta font-medium'
                        : 'text-stone-300 hover:bg-stone-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {getFileIcon(file.name)}
                      <span className="truncate text-[11px]">{file.path}</span>
                    </div>
                    {file.isEntry && (
                      <span className="px-1 py-0.2 bg-amber-500/20 text-amber-400 text-[9px] rounded uppercase">
                        Entry
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="p-4 text-center text-stone-500 text-xs italic">
              No matching files found.
            </div>
          )
        ) : (
          renderTreeNodes(fileTree)
        )}
      </div>

      {/* Dependency Graph Summary Toggle */}
      <div className="border-t border-stone-800 bg-[#141416] p-2">
        <button
          type="button"
          data-testid="toggle-dependency-panel"
          onClick={() => setShowDependencyPanel(!showDependencyPanel)}
          className="w-full flex items-center justify-between px-2 py-1 text-[11px] text-stone-400 hover:text-stone-200 hover:bg-stone-800/50 rounded transition-colors"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Sparkles className="w-3 h-3 text-cyan-400" />
            File Dependencies
          </span>
          <span className="font-mono text-[10px] text-stone-500">
            {activeFileDependencies.length} out / {activeFileInboundReferences.length} in
          </span>
        </button>

        {showDependencyPanel && (
          <div
            data-testid="file-dependency-panel"
            className="mt-1.5 p-2 bg-[#111113] border border-stone-800/80 rounded text-[10px] font-mono flex flex-col gap-1.5 max-h-36 overflow-y-auto"
          >
            <div className="text-stone-400 font-semibold truncate border-b border-stone-800 pb-1">
              {activeFilePath}
            </div>

            {activeFileDependencies.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-stone-500 text-[9px] uppercase font-semibold">Imports:</span>
                {activeFileDependencies.map((dep, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between text-stone-300 gap-1 pl-1"
                  >
                    <span className="truncate">{dep.rawSpecifier}</span>
                    <span
                      className={`text-[8px] px-1 rounded uppercase ${
                        dep.isResolved ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                      }`}
                    >
                      {dep.type}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-stone-600 italic">No outgoing module imports.</div>
            )}

            {activeFileInboundReferences.length > 0 && (
              <div className="flex flex-col gap-0.5 mt-1">
                <span className="text-stone-500 text-[9px] uppercase font-semibold">Imported By:</span>
                {activeFileInboundReferences.map((ref, idx) => (
                  <div key={idx} className="text-stone-400 truncate pl-1">
                    ← {ref.sourcePath}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
