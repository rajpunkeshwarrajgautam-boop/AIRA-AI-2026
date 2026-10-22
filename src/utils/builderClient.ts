import { authenticatedApiFetch, neonAuth } from '../lib/neonAuth';

export interface BuilderEvent { type: string; data: Record<string, any> }
export interface BuilderStatus {
  ready: boolean;
  enabled: boolean;
  allowed: boolean;
  configured: boolean;
  providerConfigured: boolean;
  reason: string;
  principalId: string;
  temporaryMinutes: number;
  sandboxProvider?: string;
  sandboxProviderConfigured?: boolean;
  teamspaceConfigured?: boolean;
  runtime?: string;
  instanceType?: string;
  workspaceTtlMinutes?: number;
  previewPort?: number;
  fallbackProvider?: string;
}
async function session() {
  if (!neonAuth.isAuthenticated()) {
    const response = await fetch('/api/auth/session', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not establish a signed Aira session. Refresh and try again.');
  }
}
export async function builderStatus(): Promise<BuilderStatus> {
  await session();
  const r = await authenticatedApiFetch('/api/builder/status', { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Could not load builder configuration.');
  return r.json();
}
export async function streamBuilder(body: Record<string, unknown>, signal: AbortSignal, onEvent: (event: BuilderEvent) => void) {
  await session();
  const r = await authenticatedApiFetch('/api/builder/stream', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error || `Builder request failed (${r.status}).`); }
  if (!r.body) throw new Error('Streaming is unavailable in this browser.');
  const reader = r.body.getReader(), decoder = new TextDecoder();
  let buffer = '', terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n'), type = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const payload = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (type && payload) { const data = JSON.parse(payload); onEvent({ type, data }); if (type === 'builder.completed' || type === 'builder.error') terminal = true; }
      }
      if (done) break;
    }
    if (!terminal) throw new Error('Builder disconnected before completion. The workspace may have been terminated; no successful completion was confirmed.');
  } finally { reader.releaseLock(); }
}
export async function cancelBuilder(ticket: string, keepalive = false) {
  const r = await authenticatedApiFetch('/api/builder/cancel', {
    keepalive,
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket })
  });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not stop the sandbox.'); }
}
export async function downloadBuilderFile(url: string, name: string) {
  if (!url.startsWith('/api/builder/download?ticket=')) throw new Error('Invalid download URL.');
  const r = await authenticatedApiFetch(url, { credentials: 'same-origin' });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Download unavailable. The workspace may have expired.'); }
  const blob = await r.blob(), objectURL = URL.createObjectURL(blob), a = document.createElement('a'); a.href = objectURL; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(objectURL), 10000);
}
