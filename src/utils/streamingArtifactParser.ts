import type { Artifact, ArtifactType } from '../types';

const SUPPORTED_FENCES: Record<string, { title: string; type: ArtifactType }> = {
  html: { title: 'HTML Preview', type: 'text/html' },
  svg: { title: 'SVG Preview', type: 'image/svg+xml' },
  jsx: { title: 'React Component', type: 'application/vnd.ant.react' },
  tsx: { title: 'React Component', type: 'application/vnd.ant.react' },
  react: { title: 'React Component', type: 'application/vnd.ant.react' },
  mermaid: { title: 'Mermaid Diagram', type: 'application/vnd.ant.mermaid' },
};

export interface StreamingFenceArtifactDetector {
  processChunk: (chunk: string) => Artifact[];
  flush: () => Artifact[];
}

/**
 * Recognize only explicitly previewable fenced code blocks in the already
 * cleaned assistant text. The original markdown remains visible in chat.
 * Never parse code fences inside the tag-envelope payload.
 */
export function createStreamingFenceArtifactDetector(): StreamingFenceArtifactDetector {
  let lineBuffer = '';
  let active: Artifact | null = null;
  let fenceIndex = 0;
  const MAX_CONTENT = 512_000;

  const makeSnapshot = (artifact: Artifact): Artifact => ({
    ...artifact,
    versions: artifact.versions.map(v => ({ ...v })),
  });

  const processLine = (line: string, completeLine: boolean, updates: Artifact[]) => {
    const normalized = line.replace(/\r$/, '');
    if (!active) {
      const opener = /^ {0,3}```(html|svg|jsx|tsx|react|mermaid)\s*$/i.exec(normalized);
      if (opener) {
        const language = opener[1].toLowerCase();
        const descriptor = SUPPORTED_FENCES[language];
        fenceIndex += 1;
        active = {
          id: `fenced-artifact-${fenceIndex}`,
          title: descriptor.title,
          type: descriptor.type,
          language,
          content: '',
          version: 1,
          versions: [],
        };
      }
      return;
    }

    if (/^ {0,3}```\s*$/.test(normalized)) {
      active.content = active.content.replace(/\n$/, '');
      active.versions = [{ version: 1, content: active.content, timestamp: Date.now() }];
      updates.push(makeSnapshot(active));
      active = null;
      return;
    }

    // Cap preview accumulation without disrupting the original message text.
    if (active.content.length + line.length + 1 > MAX_CONTENT) return;
    active.content += line + (completeLine ? '\n' : '');
    updates.push(makeSnapshot(active));
  };

  const consume = (chunk: string, final: boolean): Artifact[] => {
    const updates: Artifact[] = [];
    lineBuffer += chunk;
    let lineEnd = lineBuffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = lineBuffer.slice(0, lineEnd);
      lineBuffer = lineBuffer.slice(lineEnd + 1);
      processLine(line, true, updates);
      lineEnd = lineBuffer.indexOf('\n');
    }
    if (final && lineBuffer) {
      processLine(lineBuffer, false, updates);
      lineBuffer = '';
    }
    if (lineBuffer.length > MAX_CONTENT) {
      lineBuffer = '';
      active = null;
    }
    return updates;
  };

  return {
    processChunk: chunk => consume(chunk, false),
    flush: () => consume('', true),
  };
}

/**
 * Bounded updates for the existing streaming artifact detector and SSE artifact events.
 * This is deliberately a reconciler, not a second parser: artifactParser.ts remains
 * the single authority for <antArtifact>/<airaArtifact> envelopes.
 *
 * A leading update opens the studio promptly. Subsequent updates are coalesced
 * within a 150 ms window, with the latest snapshot delivered at the trailing edge.
 * Final versions bypass the timer. Cancellation drops pending snapshots.
 */
export interface StreamingArtifactReconciler {
  publish: (artifact: Artifact) => void;
  flush: () => void;
  cancel: () => void;
}

export function createStreamingArtifactReconciler(
  onUpdate: (artifact: Artifact) => void,
  windowMs = 150,
): StreamingArtifactReconciler {
  let pending: Artifact | null = null;
  let lastSent: Artifact | null = null;
  let lastSentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const samePayload = (a: Artifact, b: Artifact) =>
    a.id === b.id && a.version === b.version && a.content === b.content &&
    a.versions.length === b.versions.length &&
    a.versions.every((version, index) =>
      version.version === b.versions[index].version && version.content === b.versions[index].content);

  const dispatch = () => {
    clearTimer();
    if (!pending || cancelled) return;
    const next = pending;
    pending = null;
    if (lastSent && samePayload(lastSent, next)) return;
    lastSent = next;
    lastSentAt = Date.now();
    onUpdate(next);
  };

  return {
    publish(artifact) {
      if (cancelled) return;
      const next = {
        ...artifact,
        versions: artifact.versions.map(version => ({ ...version })),
      };

      // Never drop the last update of one artifact when a different ID starts.
      if (pending && pending.id !== next.id) dispatch();
      pending = next;

      const elapsed = Date.now() - lastSentAt;
      const completed = next.versions.some(version => version.version === next.version);
      if (!lastSent || lastSent.id !== next.id || completed || elapsed >= windowMs) {
        dispatch();
        return;
      }

      if (timer === null) {
        timer = setTimeout(dispatch, Math.max(0, windowMs - elapsed));
      }
    },
    flush: dispatch,
    cancel() {
      cancelled = true;
      pending = null;
      clearTimer();
    },
  };
}
