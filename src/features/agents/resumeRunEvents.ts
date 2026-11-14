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
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    return cursor;
  } finally {
    reader.releaseLock();
  }
}

