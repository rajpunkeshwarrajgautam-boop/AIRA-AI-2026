import type { Artifact, IntentTaxonomy } from '../../contracts/src/index.js';

type ArtifactType = Artifact['type'];

interface FencedBlock {
  language: string;
  content: string;
}

const PREVIEWABLE_TYPES: Record<string, { type: ArtifactType; title: string; language: string }> = {
  html: { type: 'text/html', title: 'Interactive HTML Preview', language: 'html' },
  htm: { type: 'text/html', title: 'Interactive HTML Preview', language: 'html' },
  svg: { type: 'image/svg+xml', title: 'SVG Diagram', language: 'svg' },
  jsx: { type: 'application/vnd.ant.react', title: 'React Component', language: 'jsx' },
  tsx: { type: 'application/vnd.ant.react', title: 'React Component', language: 'tsx' },
  react: { type: 'application/vnd.ant.react', title: 'React Component', language: 'tsx' },
  mermaid: { type: 'application/vnd.ant.mermaid', title: 'Mermaid Diagram', language: 'mermaid' },
};

function normalizeArtifactType(rawType?: string, language?: string): ArtifactType {
  const t = (rawType || '').toLowerCase().trim();
  const lang = (language || '').toLowerCase().trim();
  if (t === 'text/html' || (!t && (lang === 'html' || lang === 'htm'))) return 'text/html';
  if (t === 'image/svg+xml' || (!t && lang === 'svg')) return 'image/svg+xml';
  if (t === 'application/vnd.ant.react' || (!t && (lang === 'tsx' || lang === 'jsx' || lang === 'react'))) {
    return 'application/vnd.ant.react';
  }
  if (t === 'application/vnd.ant.mermaid' || (!t && lang === 'mermaid')) return 'application/vnd.ant.mermaid';
  if (t === 'text/markdown' || (!t && (lang === 'markdown' || lang === 'md'))) return 'text/markdown';
  return 'application/vnd.ant.code';
}

function defaultLanguageFor(type: ArtifactType, explicitLanguage?: string): string {
  if (explicitLanguage && explicitLanguage.trim().length > 0) {
    return explicitLanguage.trim().toLowerCase();
  }
  switch (type) {
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

function parseEnvelopeAttributes(rawAttrs: string): { id: string; title: string; type: ArtifactType; language: string } {
  const readAttr = (name: string) => {
    const match = rawAttrs.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
    return match ? match[1] : '';
  };
  const explicitLanguage = readAttr('language');
  const rawType = readAttr('type');
  const type = normalizeArtifactType(rawType, explicitLanguage);
  return {
    id: readAttr('identifier') || readAttr('id') || `art_${Date.now()}`,
    title: readAttr('title') || 'Generated Deliverable',
    type,
    language: defaultLanguageFor(type, explicitLanguage),
  };
}

function extractFencedCodeBlocks(content: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const regex = /^ {0,3}```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)^ {0,3}```\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      language: (match[1] || '').toLowerCase().trim(),
      content: (match[2] || '').trimEnd(),
    });
  }
  return blocks;
}

function isArtifactDeliveryRequested(promptLower: string): boolean {
  return /\b(editable\s+(?:markdown\s+)?(?:artifact|spec|specification|document|report)|downloadable\s+(?:spec|specification|document|report)|save\s+as\s+(?:an?\s+)?artifact|create\s+(?:an?\s+)?(?:html|svg|react|mermaid|interactive)\b|build\s+(?:an?\s+)?(?:html|svg|react)\b)/i.test(
    promptLower
  );
}

/**
 * Classifies an assistant response into explicit deliverable artifacts without hijacking
 * ordinary fenced code explanations (TypeScript, Python, SQL, JSON, Bash, Markdown) into
 * broken HTML previews.
 */
export function classifyResponseArtifacts(input: {
  content: string;
  prompt?: string;
  intent?: IntentTaxonomy;
  runId?: string;
}): { artifacts: Artifact[] } {
  const content = input.content || '';
  const prompt = (input.prompt || '').trim();
  const promptLower = prompt.toLowerCase();
  const now = Date.now();
  const artifacts: Artifact[] = [];

  // 1. Explicit <airaArtifact> / <antArtifact> envelopes are always authoritative
  const envelopeRegex = /<(?:antArtifact|airaArtifact)\s+([^>]+)>([\s\S]*?)<\/(?:antArtifact|airaArtifact)>/gi;
  let envMatch: RegExpExecArray | null;
  while ((envMatch = envelopeRegex.exec(content)) !== null) {
    const attrs = parseEnvelopeAttributes(envMatch[1]);
    const inner = (envMatch[2] || '').trim();
    artifacts.push({
      id: attrs.id,
      runId: input.runId,
      title: attrs.title,
      type: attrs.type,
      language: attrs.language,
      content: inner,
      version: 1,
      versions: [{ version: 1, content: inner, timestamp: now }],
    });
  }
  if (artifacts.length > 0) {
    return { artifacts };
  }

  // 2. Previewable complete self-contained fenced deliverables (HTML/SVG/React/Mermaid)
  const blocks = extractFencedCodeBlocks(content);
  const explicitRequest = isArtifactDeliveryRequested(promptLower);

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const previewMeta = PREVIEWABLE_TYPES[block.language];
    if (!previewMeta) continue;

    const looksSelfContainedHtml =
      (block.language === 'html' || block.language === 'htm') &&
      (/<!doctype\s+html|<html\b/i.test(block.content) || explicitRequest);
    const looksSelfContainedSvg =
      block.language === 'svg' &&
      /<svg\b[^>]*>[\s\S]*<\/svg>/i.test(block.content) &&
      (explicitRequest || !/\b(explain|what\s+is|example|tutorial)\b/i.test(promptLower));
    const looksExplicitPreviewWidget =
      explicitRequest && (previewMeta.type === 'application/vnd.ant.react' || previewMeta.type === 'application/vnd.ant.mermaid');

    if (looksSelfContainedHtml || looksSelfContainedSvg || looksExplicitPreviewWidget) {
      artifacts.push({
        id: `art_${now}_${i + 1}`,
        runId: input.runId,
        title: previewMeta.title,
        type: previewMeta.type,
        language: previewMeta.language,
        content: block.content,
        version: 1,
        versions: [{ version: 1, content: block.content, timestamp: now }],
      });
    }
  }
  if (artifacts.length > 0) {
    return { artifacts };
  }

  // 3. Explicit editable Markdown specification/report deliverables (not ordinary prose+code)
  if (
    /\b(editable\s+(?:markdown\s+)?(?:artifact|spec|specification|document|report)|downloadable\s+(?:spec|specification|document|report)|refine\s+iteratively)\b/i.test(
      promptLower
    ) &&
    content.trim().length > 0
  ) {
    artifacts.push({
      id: `art_doc_${now}`,
      runId: input.runId,
      title: 'Editable Specification Document',
      type: 'text/markdown',
      language: 'markdown',
      content: content.trim(),
      version: 1,
      versions: [{ version: 1, content: content.trim(), timestamp: now }],
    });
    return { artifacts };
  }

  // 4. Autonomous missions keep their mission summary report artifact
  if (input.intent === 'AGENT_MISSION' && content.trim().length > 0) {
    const report = `# Mission Execution Summary\n\n**Objective**: ${prompt}\n\n**Outcome**: ${content}\n\n**Status**: COMPLETED`;
    artifacts.push({
      id: `art_mission_${now}`,
      runId: input.runId,
      title: `Mission Report: ${prompt.slice(0, 36)}`,
      type: 'text/markdown',
      language: 'markdown',
      content: report,
      version: 1,
      versions: [{ version: 1, content: report, timestamp: now }],
    });
  }

  return { artifacts };
}
