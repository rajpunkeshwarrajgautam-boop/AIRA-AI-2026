import type { ArtifactType } from '../types';

/**
 * Derive an explicit language label strictly from validated artifact metadata.
 * Never defaults generic or unknown code types to executable HTML.
 */
export function inferArtifactLanguageFromType(
  type?: ArtifactType | string,
  explicitLanguage?: string
): string {
  if (typeof explicitLanguage === 'string' && explicitLanguage.trim().length > 0) {
    return explicitLanguage.trim().toLowerCase();
  }
  switch ((type || '').toLowerCase().trim()) {
    case 'text/html':
      return 'html';
    case 'image/svg+xml':
      return 'svg';
    case 'application/vnd.ant.react':
      return 'tsx';
    case 'application/vnd.ant.mermaid':
      return 'mermaid';
    case 'text/markdown':
      return 'markdown';
    case 'application/vnd.ant.code':
    default:
      return 'text';
  }
}

/**
 * Only explicitly renderable visual/document artifact types expose the Preview sandbox tab.
 * Generic source code (application/vnd.ant.code) stays on the Code tab.
 */
export function isArtifactTypePreviewable(type?: ArtifactType | string): boolean {
  return (
    type === 'text/html' ||
    type === 'image/svg+xml' ||
    type === 'application/vnd.ant.react' ||
    type === 'application/vnd.ant.mermaid' ||
    type === 'text/markdown'
  );
}
