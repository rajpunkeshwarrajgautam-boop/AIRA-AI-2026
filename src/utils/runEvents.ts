export interface AiraRunEvent {
  id?: number;
  type: string;
  data: Record<string, unknown>;
}

/** Reconnect to durable server run events after an approval was granted. */
export async function followAiraRun(
  runId: string,
  onEvent: (event: AiraRunEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!/^run_[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('INVALID_RUN_ID');
  const response = await fetch('/api/runs/' + encodeURIComponent(runId) + '/events?after=0', {
    credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, signal
  });
  if (!response.ok || !response.body) throw new Error('RUN_EVENTS_UNAVAILABLE_' + response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      if (buffer.length > 1_000_000) throw new Error('RUN_EVENT_BUFFER_EXCEEDED');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const lines = raw.split('\n');
        const type = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const dataLine = lines.find(l => l.startsWith('data:'))?.slice(5).trim();
        const idLine = lines.find(l => l.startsWith('id:'))?.slice(3).trim();
        if (type && dataLine && dataLine !== '[DONE]') {
          const parsed: unknown = JSON.parse(dataLine);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            onEvent({ type, data: parsed as Record<string, unknown>, id: idLine && /^\d+$/.test(idLine) ? Number(idLine) : undefined });
          }
          if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) return;
        }
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
