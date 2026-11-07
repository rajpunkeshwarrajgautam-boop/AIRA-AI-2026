/**
 * Multi-File Artifact Bundling & Workspace File Tree Explorer Types (Phase 2).
 *
 * Implements:
 * - Structured multi-file artifact project format
 * - Normalized paths and deterministic project manifests
 * - Module dependency graph representations
 * - Safe export and workspace synchronization contracts
 */

export type ArtifactFileKind = 
  | 'html' 
  | 'css' 
  | 'javascript' 
  | 'typescript' 
  | 'json' 
  | 'markdown' 
  | 'svg' 
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'asset';

export interface ArtifactFileRevision {
  version: number;
  content: string;
  timestamp: number;
  changeSummary?: string;
}

export interface ArtifactProjectFile {
  id: string; // Stable identifier
  path: string; // Normalized relative path (e.g. "src/App.tsx")
  name: string; // Basename (e.g. "App.tsx")
  content: string;
  kind: ArtifactFileKind;
  sizeBytes: number;
  lastModified: number;
  version: number;
  versions?: ArtifactFileRevision[];
  isEntry?: boolean;
  hasUnsavedChanges?: boolean;
}

export interface FileDependencyReference {
  sourcePath: string; // The file declaring the dependency
  targetPath: string; // Resolved normalized target path
  rawSpecifier: string; // Raw specifier from code (e.g. "./styles.css")
  type: 'static_import' | 'stylesheet' | 'script_tag' | 'asset_ref' | 'dynamic_import' | 'unresolved';
  isResolved: boolean;
  line?: number;
}

export interface ProjectManifestEntry {
  path: string;
  sizeBytes: number;
  kind: ArtifactFileKind;
  checksumSha256?: string;
  lastModified: number;
}

export interface ProjectManifest {
  manifestVersion: '1.0.0';
  projectId: string;
  title: string;
  entryPoint: string;
  createdAt: number;
  updatedAt: number;
  files: ProjectManifestEntry[];
}

export interface MultiFileArtifactBundle {
  id: string;
  title: string;
  description?: string;
  entryPoint: string; // Primary entry path (e.g. "index.html" or "src/App.tsx")
  files: Record<string, ArtifactProjectFile>; // key = normalized path
  manifest: ProjectManifest;
  dependencies: FileDependencyReference[];
}

export interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  children?: FileTreeNode[];
  file?: ArtifactProjectFile;
}

export interface WorkspaceSyncResult {
  success: boolean;
  syncedFilesCount: number;
  targetWorkspaceId: string;
  timestamp: number;
  error?: string;
}
