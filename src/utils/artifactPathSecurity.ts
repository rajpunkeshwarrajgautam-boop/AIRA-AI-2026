import type { ArtifactFileKind } from '../types/multiFileArtifact';

export class ArtifactPathSecurityError extends Error {
  constructor(message: string) {
    super(`[Artifact Security] ${message}`);
    this.name = 'ArtifactPathSecurityError';
  }
}

const DANGEROUS_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  'known_hosts',
  'authorized_keys',
  'passwd',
  'shadow',
  'credentials.json',
  '.netrc'
]);

const DANGEROUS_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.pkcs12',
  '.crt',
  '.der',
  '.kdbx'
]);

/**
 * Normalizes an artifact file path and strictly rejects path traversals,
 * absolute paths, control characters, and secret-bearing filenames.
 */
export function normalizeAndValidateArtifactPath(rawPath: string): string {
  if (typeof rawPath !== 'string') {
    throw new ArtifactPathSecurityError('Path must be a non-empty string');
  }

  let cleaned = rawPath.trim();
  if (!cleaned) {
    throw new ArtifactPathSecurityError('Empty path is not permitted');
  }

  // Reject null bytes and control characters
  if (/[\0\x01-\x1f\x7f]/.test(cleaned)) {
    throw new ArtifactPathSecurityError('Path contains null bytes or control characters');
  }

  // Reject Windows drive letters (e.g. C:) and UNC paths (\\)
  if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith('\\\\')) {
    throw new ArtifactPathSecurityError('Absolute paths and drive letters are prohibited');
  }

  // Normalize backslashes to forward slashes
  cleaned = cleaned.replace(/\\/g, '/');

  // Reject leading slashes (absolute paths in POSIX)
  if (cleaned.startsWith('/')) {
    throw new ArtifactPathSecurityError('Absolute paths starting with "/" are prohibited');
  }

  // Split into segments and check for traversal
  const segments = cleaned.split('/');
  const normalizedSegments: string[] = [];

  for (const seg of segments) {
    if (seg === '' || seg === '.') {
      continue; // Skip redundant empty or current-dir segments
    }
    if (seg === '..') {
      throw new ArtifactPathSecurityError('Path traversal sequence ".." is strictly prohibited');
    }

    // Check invalid characters in segment (< > : " | ? *)
    if (/[<>:"|?*]/.test(seg)) {
      throw new ArtifactPathSecurityError(`Invalid filename character in segment "${seg}"`);
    }

    const lowerSeg = seg.toLowerCase();

    // Check dangerous file names
    if (DANGEROUS_FILENAMES.has(lowerSeg)) {
      throw new ArtifactPathSecurityError(`Access to secret or sensitive file "${seg}" is prohibited`);
    }

    // Check dangerous extensions
    for (const ext of DANGEROUS_EXTENSIONS) {
      if (lowerSeg.endsWith(ext)) {
        throw new ArtifactPathSecurityError(`File type "${ext}" is blocked for security`);
      }
    }

    // Disallow hidden control directories (.git, .ssh)
    if (lowerSeg === '.git' || lowerSeg === '.ssh') {
      throw new ArtifactPathSecurityError(`Directory "${seg}" is restricted`);
    }

    normalizedSegments.push(seg);
  }

  if (normalizedSegments.length === 0) {
    throw new ArtifactPathSecurityError('Resolved path has no valid segments');
  }

  return normalizedSegments.join('/');
}

/**
 * Infers artifact file kind from file extension.
 */
export function inferArtifactFileKind(path: string): ArtifactFileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'typescript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.svg')) return 'svg';
  return 'asset';
}

/**
 * Resolves a relative import specifier against a base file path.
 * e.g. base = "src/components/App.tsx", specifier = "./Button" -> "src/components/Button.tsx"
 */
export function resolveRelativeSpecifier(
  baseFilePath: string,
  rawSpecifier: string,
  existingPaths: string[]
): { resolvedPath: string; isResolved: boolean } {
  // If external package or absolute URL (http, https, @...)
  if (/^(?:https?:|\/\/|node:)/i.test(rawSpecifier) || (!rawSpecifier.startsWith('.') && !rawSpecifier.startsWith('/'))) {
    return { resolvedPath: rawSpecifier, isResolved: false };
  }

  const baseDir = baseFilePath.includes('/') ? baseFilePath.slice(0, baseFilePath.lastIndexOf('/')) : '';
  const cleanSpec = rawSpecifier.replace(/\\/g, '/');

  const baseParts = baseDir ? baseDir.split('/') : [];
  const specParts = cleanSpec.split('/');

  for (const part of specParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (baseParts.length > 0) {
        baseParts.pop();
      } else {
        return { resolvedPath: rawSpecifier, isResolved: false }; // escapes root
      }
    } else {
      baseParts.push(part);
    }
  }

  const candidate = baseParts.join('/');

  // Exact match
  if (existingPaths.includes(candidate)) {
    return { resolvedPath: candidate, isResolved: true };
  }

  // Match with common extensions (.tsx, .ts, .jsx, .js, .css, .html)
  const extensions = ['.tsx', '.ts', '.jsx', '.js', '.css', '.html', '.json', '/index.tsx', '/index.ts', '/index.js'];
  for (const ext of extensions) {
    const withExt = candidate + ext;
    if (existingPaths.includes(withExt)) {
      return { resolvedPath: withExt, isResolved: true };
    }
  }

  return { resolvedPath: candidate, isResolved: false };
}
