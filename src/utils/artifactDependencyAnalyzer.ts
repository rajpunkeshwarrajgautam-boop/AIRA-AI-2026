import type { FileDependencyReference } from '../types/multiFileArtifact';
import { resolveRelativeSpecifier } from './artifactPathSecurity';

/**
 * Analyzes source code across files to extract module dependencies and asset references.
 */
export function analyzeFileDependencies(
  filePath: string,
  content: string,
  existingProjectPaths: string[]
): FileDependencyReference[] {
  const references: FileDependencyReference[] = [];
  const lines = content.split('\n');

  // 1. HTML Analysis
  if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
    // Stylesheet links: <link rel="stylesheet" href="...">
    const linkRegex = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(content)) !== null) {
      const tag = match[0];
      const href = match[1];
      if (/rel=["']stylesheet["']/i.test(tag) || href.endsWith('.css')) {
        const { resolvedPath, isResolved } = resolveRelativeSpecifier(filePath, href, existingProjectPaths);
        references.push({
          sourcePath: filePath,
          targetPath: resolvedPath,
          rawSpecifier: href,
          type: 'stylesheet',
          isResolved
        });
      }
    }

    // Scripts: <script src="...">
    const scriptRegex = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    while ((match = scriptRegex.exec(content)) !== null) {
      const src = match[1];
      const { resolvedPath, isResolved } = resolveRelativeSpecifier(filePath, src, existingProjectPaths);
      references.push({
        sourcePath: filePath,
        targetPath: resolvedPath,
        rawSpecifier: src,
        type: 'script_tag',
        isResolved
      });
    }

    // Images: <img src="...">
    const imgRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    while ((match = imgRegex.exec(content)) !== null) {
      const src = match[1];
      if (!src.startsWith('data:')) {
        const { resolvedPath, isResolved } = resolveRelativeSpecifier(filePath, src, existingProjectPaths);
        references.push({
          sourcePath: filePath,
          targetPath: resolvedPath,
          rawSpecifier: src,
          type: 'asset_ref',
          isResolved
        });
      }
    }
  }

  // 2. JavaScript / TypeScript / TSX Analysis
  if (/\.[jt]sx?$/i.test(filePath)) {
    // Static imports: import ... from '...' or import '...'
    const staticImportRegex = /(?:import\s+(?:[\w*\s{},$]+from\s+)?|export\s+(?:[\w*\s{},$]+from\s+))["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = staticImportRegex.exec(content)) !== null) {
      const specifier = match[1];
      const { resolvedPath, isResolved } = resolveRelativeSpecifier(filePath, specifier, existingProjectPaths);
      references.push({
        sourcePath: filePath,
        targetPath: resolvedPath,
        rawSpecifier: specifier,
        type: specifier.endsWith('.css') ? 'stylesheet' : 'static_import',
        isResolved
      });
    }

    // Dynamic imports: import('...')
    const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      const specifier = match[1];
      const { resolvedPath, isResolved } = resolveRelativeSpecifier(filePath, specifier, existingProjectPaths);
      references.push({
        sourcePath: filePath,
        targetPath: resolvedPath,
        rawSpecifier: specifier,
        type: 'dynamic_import',
        isResolved
      });
    }
  }

  // 3. CSS Analysis
  if (filePath.endsWith('.css')) {
    // @import '...' or @import url('...')
    const cssImportRegex = /@import\s+(?:url\(['"]?([^'"()]+)['"]?\)|['"]([^'"]+)['"])/g;
    let match: RegExpExecArray | null;
    while ((match = cssImportRegex.exec(content)) !== null) {
      const specifier = match[1] || match[2];
      const { resolvedPath, isResolved } = resolveRelativeSpecifier(filePath, specifier, existingProjectPaths);
      references.push({
        sourcePath: filePath,
        targetPath: resolvedPath,
        rawSpecifier: specifier,
        type: 'stylesheet',
        isResolved
      });
    }
  }

  return references;
}

/**
 * Builds an aggregated module dependency graph for an entire project bundle.
 */
export function buildProjectDependencyGraph(
  files: Record<string, { path: string; content: string }>
): FileDependencyReference[] {
  const existingPaths = Object.keys(files);
  const allReferences: FileDependencyReference[] = [];

  for (const file of Object.values(files)) {
    const refs = analyzeFileDependencies(file.path, file.content, existingPaths);
    allReferences.push(...refs);
  }

  return allReferences;
}
