import type { Artifact, ArtifactVersion } from '../types';

function completed(artifact: Artifact): boolean {
  return artifact.versions?.some(version => version.version === artifact.version) || false;
}

// Preserve previous revisions when the agent emits the same artifact identifier
// on a later turn. A new version is finalized only when the stream is complete.
export function reconcileArtifactRevision(existing: Artifact | undefined, incoming: Artifact): Artifact {
  if (!existing || existing.id !== incoming.id) return incoming;
  const history = existing.versions?.length
    ? existing.versions
    : [{ version: existing.version, content: existing.content, timestamp: Date.now() }];
  const latestVersion = Math.max(existing.version, ...history.map(entry => entry.version));
  const currentIsComplete = completed(existing);
  const newIsComplete = completed(incoming);

  if (newIsComplete && currentIsComplete && incoming.content === existing.content) return existing;

  const version = currentIsComplete ? latestVersion + 1 : existing.version;
  const nextHistory = newIsComplete
    ? [...history.filter(entry => entry.version !== version), { version, content: incoming.content, timestamp: Date.now() }]
    : history.filter(entry => entry.version !== version);

  return { ...incoming, version, versions: nextHistory };
}

export function createRollbackRevision(artifact: Artifact, selectedVersion: number): Artifact | null {
  const snapshot = artifact.versions?.find(version => version.version === selectedVersion);
  if (!snapshot || !completed(artifact) || snapshot.content === artifact.content) return null;
  const version = Math.max(artifact.version, ...artifact.versions.map(v => v.version)) + 1;
  const newSnapshot: ArtifactVersion = { version, content: snapshot.content, timestamp: Date.now() };
  return { ...artifact, version, content: snapshot.content, versions: [...artifact.versions, newSnapshot] };
}

export type ArtifactDiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

export function diffArtifactLines(before: string, after: string): ArtifactDiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  // Avoid quadratic allocation and unbounded rendering on large generated files.
  if (a.length * b.length > 160_000 || a.length + b.length > 2000) return null;
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const lines: ArtifactDiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i++] });
      j++;
    } else if (j < b.length && (i >= a.length || lengths[i][j + 1] > lengths[i + 1][j])) {
      lines.push({ kind: 'added', text: b[j++] });
    } else {
      lines.push({ kind: 'removed', text: a[i++] });
    }
  }
  return lines;
}
