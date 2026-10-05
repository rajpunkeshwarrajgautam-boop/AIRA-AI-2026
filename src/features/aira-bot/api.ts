import type { Bot, BotInput } from '../../../packages/aira-bot/src/contracts';
import type { Run, StreamingEvent } from '../../../packages/contracts/src';
export type { Bot, BotInput, Run, StreamingEvent };
export interface Capabilities {
  models: string[];
  tools: string[];
  computer: boolean;
  computerProvider?: { kind: 'local' | 'docker'; isolation: 'host-process' | 'docker-container'; interactive: boolean };
  delegation: boolean;
  scheduling: boolean;
}
export interface TaskRecord { id: string; run_id: string; objective: string; created_at: number; run?: Run }
export interface BotRoutine {
  id: string; ownerId: string; botId: string; name: string; objective: string; cronExpression: string; timezone: string; enabled: boolean;
  lastScheduledFor?: number; lastRunId?: string; createdAt: number; updatedAt: number;
}
export interface BotRoutineRun { id: string; routineId: string; ownerId: string; botId: string; runId?: string; scheduledFor: number; status: 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'; error?: string; createdAt: number; completedAt?: number; run?: Run }
export interface BotDelegation { id: string; ownerId: string; parentBotId: string; targetBotId: string; parentRunId: string; childRunId: string; objective: string; status: 'STARTED' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'; createdAt: number; updatedAt: number; completedAt?: number; childRun?: Run }
export interface BotNotification { id: string; ownerId: string; botId?: string; runId?: string; kind: string; title: string; message: string; readAt?: number; createdAt: number }
export interface ComputerStatus {
  enabled: boolean;
  state: 'DISABLED' | 'STOPPED' | 'RUNNING' | 'ERROR';
  workspaceReady: boolean;
  browser: { state: 'STOPPED' | 'RUNNING'; url?: string; title?: string; lastScreenshotPath?: string };
  terminal: { enabled: boolean; allowedPrograms: string[] };
  provider?: { kind: 'local' | 'docker'; isolation: 'host-process' | 'docker-container' };
  lease?: { botId: string; holderId: string; mode: 'BOT' | 'HUMAN'; acquiredAt: number; expiresAt: number };
  humanControl?: boolean;
  lastError?: string;
}
export interface ComputerFileEntry { path: string; type: 'file' | 'directory'; sizeBytes: number; updatedAt: number }
export interface BrowserView { action?: 'open' | 'click' | 'type' | 'scroll' | 'wait' | 'screenshot'; url: string; title: string; text: string; links: Array<{ text: string; href: string }>; screenshotPath: string }
export interface TerminalResult { program: string; args: string[]; exitCode: number; stdout: string; stderr: string; truncated: boolean }
export interface ComputerEvent { sequence: number; type: string; timestamp: number; ownerId: string; botId: string; data: Record<string, unknown> }
export interface ComputerTakeover { leaseToken: string; expiresAt: number; pausedRunIds: string[]; preemptedRunId?: string; status: ComputerStatus }

export async function botApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (import.meta.env.DEV && import.meta.env.VITE_AIRA_DEV_IDENTITY === 'true' && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    headers.set('x-test-user-id', 'aira-local-user');
    headers.set('x-test-session-id', 'aira-local-session');
  }
  if (!headers.has('x-test-user-id') && import.meta.env.VITE_FIREBASE_PROJECT_ID && import.meta.env.VITE_FIREBASE_API_KEY) { const { botToken } = await import('./auth'); const token = await botToken(); if (token) headers.set('Authorization', `Bearer ${token}`); }
  const response = await fetch(`/api/aira-bot${path}`, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    let message = `Aira Bot request fails (${response.status}).`;
    try { const body = await response.json(); message = body.error || message; } catch { /* The host may serve HTML when the API is not deployed. */ }
    if (response.status === 401) message = 'Sign in to AIRA to access your bots. Local development requires VITE_AIRA_DEV_IDENTITY=true and NODE_ENV=development.';
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The Aira Bot API is not connected to this deployment. Start or connect the AIRA runtime API.');
  return response.json();
}
export const botPath = (id: string) => `/bots/${encodeURIComponent(id)}`;
export const terminal = (run: Run) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state);
export function downloadResult(run: Run) {
  const url = URL.createObjectURL(new Blob([run.content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `aira-bot-${run.id}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
