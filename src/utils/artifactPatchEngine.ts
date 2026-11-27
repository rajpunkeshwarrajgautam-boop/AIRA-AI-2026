import type { Artifact, ArtifactVersion } from '../types/index.js';
import type { ArtifactPatch } from '../../packages/contracts/src/artifacts.js';

export type { ArtifactPatch };

export interface PatchResult {
  ok: true;
  artifact: Artifact;
}

export interface PatchError {
  ok: false;
  code: 'STALE_BASE_VERSION' | 'TARGET_MISMATCH' | 'INVALID_PATCH_TYPE' | 'SECTION_NOT_FOUND' | 'MALFORMED_PAYLOAD';
  error: string;
}

/**
 * Applies a targeted atomic patch to an existing artifact with optimistic concurrency conflict detection.
 */
export function applyArtifactPatch(
  artifact: Artifact,
  patch: ArtifactPatch
): PatchResult | PatchError {
  if (artifact.id !== patch.targetId) {
    return {
      ok: false,
      code: 'TARGET_MISMATCH',
      error: `Patch targetId "${patch.targetId}" does not match artifact id "${artifact.id}".`,
    };
  }

  // Conflict detection: Reject patches based on stale versions
  if (patch.baseVersion !== artifact.version) {
    return {
      ok: false,
      code: 'STALE_BASE_VERSION',
      error: `Conflict detected: patch baseVersion (${patch.baseVersion}) does not match current artifact version (${artifact.version}).`,
    };
  }

  let nextContent = artifact.content;

  switch (patch.patchType) {
    case 'replace_section': {
      if (!patch.sectionTitle) {
        return {
          ok: false,
          code: 'SECTION_NOT_FOUND',
          error: 'replace_section requires sectionTitle.',
        };
      }
      const titleEscaped = patch.sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sectionRegex = new RegExp(`(^|\\n)(#{1,6}\\s+${titleEscaped}[^\\n]*\\n)([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`, 'i');

      const match = nextContent.match(sectionRegex);
      if (match) {
        const replacement = `${match[1]}${match[2]}${patch.content || ''}\n`;
        nextContent = nextContent.replace(sectionRegex, replacement).trimEnd();
      } else {
        // Append section if not found
        nextContent = `${nextContent.trimEnd()}\n\n## ${patch.sectionTitle}\n${patch.content || ''}\n`;
      }
      break;
    }

    case 'update_cells': {
      try {
        const parsed = JSON.parse(nextContent);
        if (parsed && Array.isArray(parsed.sheets) && patch.payload && typeof patch.payload === 'object') {
          const sheetName = (patch.payload as any).sheetName || parsed.activeSheet || parsed.sheets[0]?.name;
          const targetSheet = parsed.sheets.find((s: any) => s.name === sheetName) || parsed.sheets[0];
          if (targetSheet) {
            targetSheet.cells = {
              ...(targetSheet.cells || {}),
              ...((patch.payload as any).cells || {}),
            };
            nextContent = JSON.stringify(parsed, null, 2);
          }
        }
      } catch {
        return {
          ok: false,
          code: 'MALFORMED_PAYLOAD',
          error: 'Failed to apply update_cells to non-JSON spreadsheet content.',
        };
      }
      break;
    }

    case 'update_slide': {
      try {
        const parsed = JSON.parse(nextContent);
        if (parsed && Array.isArray(parsed.slides) && patch.payload && typeof patch.payload === 'object') {
          const slideId = (patch.payload as any).slideId;
          const updates = (patch.payload as any).updates || {};
          parsed.slides = parsed.slides.map((s: any) => {
            if (s.id === slideId) return { ...s, ...updates };
            return s;
          });
          nextContent = JSON.stringify(parsed, null, 2);
        }
      } catch {
        return {
          ok: false,
          code: 'MALFORMED_PAYLOAD',
          error: 'Failed to apply update_slide to non-JSON presentation content.',
        };
      }
      break;
    }

    case 'insert_slide': {
      try {
        const parsed = JSON.parse(nextContent);
        if (parsed && Array.isArray(parsed.slides) && patch.payload && typeof patch.payload === 'object') {
          const newSlide = (patch.payload as any).slide;
          if (newSlide && typeof newSlide === 'object') {
            parsed.slides.push(newSlide);
            nextContent = JSON.stringify(parsed, null, 2);
          }
        }
      } catch {
        return {
          ok: false,
          code: 'MALFORMED_PAYLOAD',
          error: 'Failed to apply insert_slide to non-JSON presentation content.',
        };
      }
      break;
    }

    case 'replace_all':
    default: {
      nextContent = patch.content !== undefined ? patch.content : nextContent;
      break;
    }
  }

  const nextVersion = artifact.version + 1;
  const historyEntry: ArtifactVersion = {
    version: nextVersion,
    content: nextContent,
    timestamp: Date.now(),
  };

  const nextVersions = [...(artifact.versions || []), historyEntry];

  return {
    ok: true,
    artifact: {
      ...artifact,
      version: nextVersion,
      content: nextContent,
      versions: nextVersions,
    },
  };
}
