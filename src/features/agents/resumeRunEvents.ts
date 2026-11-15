import { authenticatedApiFetch, neonAuth } from '../../lib/neonAuth';

export interface ResumedRunEvent {
  id: number | null;
  type: string;
  data: unknown;
}
interface ResumeOptions {
  runId: string;
  lastEventId?: number;
  signal?: AbortSignal;
  onEvent: (event: ResumedRunEvent) => void;
}

/**
 * Reads existing /api/runs/:id/events cursor replay. Never POSTs a second run.
 * Callers must use a run ID obtained from the original authenticated stream.
 */
export async function resumeRunEvents({ runId, lastEventId, signal, onEvent }: ResumeOptions) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('Invalid run ID');
  if (lastEventId !== undefined && (!Number.isSafeInteger(lastEventId) || lastEventId < 0)) {
    throw new Error('Invalid event cursor');
  }
  const epoch = neonAuth.getAuthEpoch();
  const owner = neonAuth.getCurrentUser()?.id || null;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
  const response = await authenticatedApiFetch(`/api/runs/${encodeURIComponent(runId)}/events`, {
    method: 'GET', headers, signal,
  });
  if (!response.ok) throw new Error(`Unable to resume run: ${response.status}`);
  if (!response.body) throw new Error('Run event stream has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cursor = lastEventId ?? -1;
  let terminal: 'COMPLETED' | 'FAILED' | 'CANCELLED' | null = null;
  const processBlock = (block: string) => {
    const lines = block.split('\n');
    let id: number | null = null;
    let type = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('id:')) {
        const raw = line.slice(3).trim();
        if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) id = Number(raw);
      } else if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    if (id !== null && id <= cursor) return;
    if (id !== null) cursor = id;
    let data: unknown;
    try { data = JSON.parse(dataLines.join('\n')); }
    catch { data = dataLines.join('\n'); }
    onEvent({ id, type, data });
    if (type === 'run.completed') terminal = 'COMPLETED';
    else if (type === 'run.failed') terminal = 'FAILED';
    else if (type === 'run.cancelled') terminal = 'CANCELLED';
  };

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (neonAuth.getAuthEpoch() !== epoch || (neonAuth.getCurrentUser()?.id || null) !== owner) {
        throw new Error('Authenticated identity changed; replay rejected');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        processBlock(block);
        if (terminal) break;
      }
      if (terminal) { await reader.cancel(); break; }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    return { cursor, terminal };
  } finally {
    reader.releaseLock();
  }
}


/**
 * Never reissues POST /api/chat/stream. The replay event log is used to wait
 * for a terminal state. The final run content comes from the owned GET run
 * resource, not by appending overlapping persisted and live delta batches.
 */
export async function recoverRunResult(
  runId: string,
  options: { signal?: AbortSignal; onEvent?: (event: ResumedRunEvent) => void } = {},
): Promise<{ state: 'COMPLETED' | 'FAILED' | 'CANCELLED'; content: string }> {
  const result = await resumeRunEvents({
    runId,
    signal: options.signal,
    onEvent: options.onEvent || (() => {}),
  });
  const response = await authenticatedApiFetch(`/api/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    signal: options.signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Run recovery failed: HTTP ${response.status}`);
  const run = await response.json() as { state?: string; content?: string; error?: string };
  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state || '')) {
    throw new Error('Run has not reached a terminal state; retry recovering later');
  }
  if (run.state === 'COMPLETED' && (typeof run.content !== 'string' || !run.content.trim())) {
    throw new Error('Run completed but its authoritative response was unavailable');
  }
  // A missing terminal event is acceptable only if the owned durable run has
  // reached a verified terminal state (for example after relay restart).
  void result;
  return {
    state: run.state as 'COMPLETED' | 'FAILED' | 'CANCELLED',
    content: typeof run.content === 'string' && run.content ? run.content : String(run.error || 'The run ended without output.'),
  };
}
