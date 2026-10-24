import type { Artifact, ArtifactType, ArtifactVersion } from '../types';

export interface ParsedArtifactAttributes {
  id: string;
  title: string;
  type: ArtifactType;
  language?: string;
}

export function normalizeArtifactType(rawType?: string, language?: string): ArtifactType {
  const t = (rawType || '').toLowerCase().trim();
  const lang = (language || '').toLowerCase().trim();

  if (t === 'application/vnd.ant.react' || t.includes('react') || lang === 'tsx' || lang === 'jsx') {
    return 'application/vnd.ant.react';
  }
  if (t === 'image/svg+xml' || t.includes('svg') || lang === 'svg') {
    return 'image/svg+xml';
  }
  if (t === 'application/vnd.ant.mermaid' || t.includes('mermaid') || lang === 'mermaid') {
    return 'application/vnd.ant.mermaid';
  }
  if (t === 'text/markdown' || t.includes('markdown') || lang === 'markdown' || lang === 'md') {
    return 'text/markdown';
  }
  if (t === 'text/html' || t.includes('html') || lang === 'html') {
    return 'text/html';
  }
  return 'application/vnd.ant.code';
}

export function parseAttributesFromTag(tagContent: string): ParsedArtifactAttributes {
  const getAttr = (name: string): string => {
    const match = tagContent.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
    return match ? match[1] : '';
  };

  const id = getAttr('identifier') || getAttr('id') || `art-${Date.now()}`;
  const title = getAttr('title') || 'Interactive Artifact';
  const rawType = getAttr('type');
  const language = getAttr('language') || (rawType.includes('html') ? 'html' : rawType.includes('react') ? 'tsx' : undefined);
  const type = normalizeArtifactType(rawType, language);

  return { id, title, type, language };
}

export interface ExtractedArtifactsResult {
  cleanedText: string;
  artifacts: Artifact[];
}

export function extractArtifactsFromText(text: string): ExtractedArtifactsResult {
  if (!text) {
    return { cleanedText: '', artifacts: [] };
  }

  const artifacts: Artifact[] = [];
  const tagRegex = /<(?:antArtifact|airaArtifact)\s+([^>]+)>([\s\S]*?)(?:<\/(?:antArtifact|airaArtifact)>|$)/gi;

  let cleanedText = text;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const attributesStr = match[1];
    const content = match[2] || '';

    const { id, title, type, language } = parseAttributesFromTag(attributesStr);

    const artifact: Artifact = {
      id,
      title,
      type,
      language,
      content,
      version: 1,
      versions: [
        {
          version: 1,
          content,
          timestamp: Date.now(),
        },
      ],
    };

    artifacts.push(artifact);
    cleanedText = cleanedText.replace(fullMatch, '').trim();
  }

  return { cleanedText, artifacts };
}

export interface StreamingArtifactDetector {
  processChunk: (chunk: string) => { textToEmit: string; artifactUpdate?: Artifact };
  flush: () => { remainingText: string; finalArtifact?: Artifact };
  getActiveArtifact: () => Artifact | null;
}

export function createStreamingArtifactDetector(
  onArtifactStarted?: (artifact: Artifact) => void
): StreamingArtifactDetector {
  let inArtifact = false;
  let activeArtifact: Artifact | null = null;
  let contentBuffer = '';
  let lookaheadBuffer = '';

  return {
    processChunk(chunk: string) {
      lookaheadBuffer += chunk;
      let textToEmit = '';
      let artifactUpdate: Artifact | undefined;

      while (lookaheadBuffer.length > 0) {
        if (!inArtifact) {
          const openTagIndex = lookaheadBuffer.search(/<(?:antArtifact|airaArtifact)\s+/i);

          if (openTagIndex === -1) {
            // Check if there is a partial opening tag at the tail
            const partialIndex = lookaheadBuffer.lastIndexOf('<');
            if (partialIndex !== -1 && '<antArtifact'.startsWith(lookaheadBuffer.slice(partialIndex))) {
              textToEmit += lookaheadBuffer.slice(0, partialIndex);
              lookaheadBuffer = lookaheadBuffer.slice(partialIndex);
              break;
            }
            textToEmit += lookaheadBuffer;
            lookaheadBuffer = '';
            break;
          }

          // Emit text prior to opening tag
          textToEmit += lookaheadBuffer.slice(0, openTagIndex);
          lookaheadBuffer = lookaheadBuffer.slice(openTagIndex);

          // Find end of opening tag
          const closeBracketIndex = lookaheadBuffer.indexOf('>');
          if (closeBracketIndex === -1) {
            // Incomplete tag header, wait for next chunk
            break;
          }

          const tagHeader = lookaheadBuffer.slice(0, closeBracketIndex + 1);
          lookaheadBuffer = lookaheadBuffer.slice(closeBracketIndex + 1);

          const attributesStr = tagHeader.replace(/^<[^\s]+\s+/, '').replace(/>$/, '');
          const { id, title, type, language } = parseAttributesFromTag(attributesStr);

          activeArtifact = {
            id,
            title,
            type,
            language,
            content: '',
            version: 1,
            versions: [],
          };

          inArtifact = true;
          contentBuffer = '';

          if (onArtifactStarted) {
            onArtifactStarted(activeArtifact);
          }
        } else {
          // Inside artifact, searching for closing tag
          const closeTagMatch = lookaheadBuffer.match(/<\/(?:antArtifact|airaArtifact)>/i);

          if (!closeTagMatch || closeTagMatch.index === undefined) {
            // Check for partial closing tag at the end
            const partialCloseIndex = lookaheadBuffer.lastIndexOf('<');
            if (partialCloseIndex !== -1 && '</antArtifact>'.startsWith(lookaheadBuffer.slice(partialCloseIndex))) {
              contentBuffer += lookaheadBuffer.slice(0, partialCloseIndex);
              lookaheadBuffer = lookaheadBuffer.slice(partialCloseIndex);
            } else {
              contentBuffer += lookaheadBuffer;
              lookaheadBuffer = '';
            }

            if (activeArtifact) {
              activeArtifact.content = contentBuffer;
              artifactUpdate = { ...activeArtifact };
            }
            break;
          }

          const closeIndex = closeTagMatch.index;
          contentBuffer += lookaheadBuffer.slice(0, closeIndex);
          lookaheadBuffer = lookaheadBuffer.slice(closeIndex + closeTagMatch[0].length);

          if (activeArtifact) {
            activeArtifact.content = contentBuffer;
            activeArtifact.versions = [
              {
                version: 1,
                content: contentBuffer,
                timestamp: Date.now(),
              },
            ];
            artifactUpdate = { ...activeArtifact };
          }

          inArtifact = false;
        }
      }

      return { textToEmit, artifactUpdate };
    },

    flush() {
      let remainingText = '';
      let finalArtifact: Artifact | undefined;

      if (inArtifact && activeArtifact) {
        contentBuffer += lookaheadBuffer;
        activeArtifact.content = contentBuffer;
        activeArtifact.versions = [
          {
            version: 1,
            content: contentBuffer,
            timestamp: Date.now(),
          },
        ];
        finalArtifact = { ...activeArtifact };
      } else {
        remainingText = lookaheadBuffer;
      }

      inArtifact = false;
      lookaheadBuffer = '';
      contentBuffer = '';
      activeArtifact = null;

      return { remainingText, finalArtifact };
    },

    getActiveArtifact() {
      return activeArtifact;
    },
  };
}
