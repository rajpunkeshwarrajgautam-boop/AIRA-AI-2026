import type { Artifact } from '../types';
import type {
  ArtifactProjectFile,
  FileTreeNode,
  MultiFileArtifactBundle,
  ProjectManifest
} from '../types/multiFileArtifact';
import {
  inferArtifactFileKind,
  normalizeAndValidateArtifactPath,
  ArtifactPathSecurityError
} from './artifactPathSecurity';
import { buildProjectDependencyGraph } from './artifactDependencyAnalyzer';

function computeSimpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Creates a validated MultiFileArtifactBundle from a collection of raw file specs.
 */
export function createMultiFileBundle(config: {
  id: string;
  title: string;
  description?: string;
  files: Array<{ path: string; content: string; isEntry?: boolean }>;
}): MultiFileArtifactBundle {
  const fileMap: Record<string, ArtifactProjectFile> = {};
  const seenPaths = new Set<string>();
  let designatedEntry = '';

  for (const f of config.files) {
    const normalized = normalizeAndValidateArtifactPath(f.path);
    if (seenPaths.has(normalized)) {
      throw new ArtifactPathSecurityError(`Duplicate file path detected: "${normalized}"`);
    }
    seenPaths.add(normalized);

    const name = normalized.split('/').pop() || normalized;
    const kind = inferArtifactFileKind(normalized);
    const content = typeof f.content === 'string' ? f.content : String(f.content || '');
    const isEntry = Boolean(f.isEntry) || (!designatedEntry && (normalized === 'index.html' || normalized === 'src/App.tsx'));

    if (isEntry) {
      designatedEntry = normalized;
    }

    fileMap[normalized] = {
      id: `file_${computeSimpleHash(normalized)}`,
      path: normalized,
      name,
      content,
      kind,
      sizeBytes: new TextEncoder().encode(content).length,
      lastModified: Date.now(),
      version: 1,
      isEntry
    };
  }

  // Fallback entry point to first file if none explicitly designated
  if (!designatedEntry && config.files.length > 0) {
    const firstPath = Object.keys(fileMap)[0];
    if (firstPath) {
      fileMap[firstPath].isEntry = true;
      designatedEntry = firstPath;
    }
  }

  const manifestEntries = Object.values(fileMap).map(f => ({
    path: f.path,
    sizeBytes: f.sizeBytes,
    kind: f.kind,
    checksumSha256: computeSimpleHash(f.content),
    lastModified: f.lastModified
  }));

  const manifest: ProjectManifest = {
    manifestVersion: '1.0.0',
    projectId: config.id,
    title: config.title,
    entryPoint: designatedEntry,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    files: manifestEntries
  };

  const dependencies = buildProjectDependencyGraph(fileMap);

  return {
    id: config.id,
    title: config.title,
    description: config.description,
    entryPoint: designatedEntry,
    files: fileMap,
    manifest,
    dependencies
  };
}

/**
 * Converts a legacy single-file Artifact into a MultiFileArtifactBundle for uniform handling.
 */
export function adaptSingleFileArtifactToBundle(artifact: Artifact): MultiFileArtifactBundle {
  let fileName = 'index.html';
  if (artifact.type === 'application/vnd.ant.code') {
    const ext = artifact.language === 'python' ? 'py' : artifact.language === 'json' ? 'json' : 'ts';
    fileName = `main.${ext}`;
  } else if (artifact.type === 'application/vnd.ant.react' || artifact.language === 'tsx') {
    fileName = 'src/App.tsx';
  } else if (artifact.type === 'image/svg+xml') {
    fileName = 'graphic.svg';
  } else if (artifact.type === 'text/markdown') {
    fileName = 'README.md';
  }

  return createMultiFileBundle({
    id: artifact.id,
    title: artifact.title,
    files: [
      {
        path: fileName,
        content: artifact.content,
        isEntry: true
      }
    ]
  });
}

/**
 * Converts a flat path-indexed file record into a nested hierarchical file tree.
 */
export function buildFileTree(files: Record<string, ArtifactProjectFile>): FileTreeNode[] {
  interface MutableFolderNode {
    id: string;
    name: string;
    path: string;
    isFolder: true;
    children: Record<string, MutableFolderNode | FileTreeNode>;
  }

  const rootFolders: Record<string, MutableFolderNode | FileTreeNode> = {};

  for (const [filePath, file] of Object.entries(files)) {
    const parts = filePath.split('/');
    let currentLevel = rootFolders;
    let accumulatedPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      const isFile = i === parts.length - 1;

      if (isFile) {
        currentLevel[part] = {
          id: file.id,
          name: part,
          path: accumulatedPath,
          isFolder: false,
          file
        };
      } else {
        if (!currentLevel[part]) {
          currentLevel[part] = {
            id: `folder_${accumulatedPath}`,
            name: part,
            path: accumulatedPath,
            isFolder: true,
            children: {}
          };
        }
        currentLevel = (currentLevel[part] as MutableFolderNode).children;
      }
    }
  }

  function convertToArray(nodeMap: Record<string, MutableFolderNode | FileTreeNode>): FileTreeNode[] {
    const list: FileTreeNode[] = [];
    for (const item of Object.values(nodeMap)) {
      if (item.isFolder) {
        list.push({
          id: item.id,
          name: item.name,
          path: item.path,
          isFolder: true,
          children: convertToArray((item as MutableFolderNode).children)
        });
      } else {
        list.push(item);
      }
    }

    // Sort folders first, then alphabetical by name
    return list.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  return convertToArray(rootFolders);
}
