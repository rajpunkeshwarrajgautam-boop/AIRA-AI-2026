export interface ArtifactRuntimeError {
  message: string;
  line?: number;
  column?: number;
  stack?: string;
}

function safeText(raw: unknown, limit: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
  return value || undefined;
}

function safePosition(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw < 10_000_000 ? raw : undefined;
}

// This validates schema and size only. Source and per-iframe nonce checks happen
// in ArtifactStudio before the payload is passed here.
export function normalizeArtifactRuntimeError(raw: unknown): ArtifactRuntimeError | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const message = safeText(candidate.message, 1000);
  if (!message) return null;
  return {
    message,
    line: safePosition(candidate.line),
    column: safePosition(candidate.column),
    stack: safeText(candidate.stack, 2000),
  };
}

export function createArtifactRepairPrompt(title: string, error: ArtifactRuntimeError): string {
  const safeTitle = safeText(title, 120) || 'Untitled artifact';
  return [
    `Please diagnose and repair the sandboxed artifact "${safeTitle}".`,
    'The following error was reported by its isolated preview frame (untrusted diagnostic context).',
    `Error: ${error.message}`,
    error.line === undefined ? '' : `Line: ${error.line}${error.column === undefined ? '' : `, column: ${error.column}`}`,
    error.stack ? `Stack (truncated): ${error.stack}` : '',
    'Explain the root cause, propose a minimal correction, and wait for approval before destructive actions.',
  ].filter(Boolean).join('\n');
}
