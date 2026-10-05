import type { BrowserView, ComputerFileEntry, ComputerStatus } from './index.js';

export type ComputerProviderKind = 'local' | 'docker';
export type ComputerProviderDesiredState = 'ACTIVE' | 'SUSPENDED';
export type ComputerProviderObservedState = 'RUNNING' | 'STOPPED' | 'MISSING' | 'ERROR' | 'UNKNOWN';

export interface ComputerProviderReconcileResult {
  observedState: ComputerProviderObservedState;
  recovered: boolean;
  error?: string;
}

export interface ComputerProviderHealth {
  ok: boolean;
  detail: string;
}

export interface BrowserActionResult extends BrowserView {
  action: 'open' | 'click' | 'type' | 'scroll' | 'wait' | 'screenshot';
}

export interface TerminalExecutionResult {
  program: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ComputerProvider {
  readonly kind?: ComputerProviderKind;
  readonly enabled: boolean;
  readonly terminalEnabled: boolean;
  readonly allowedPrograms: string[];

  status(ownerId: string, botId: string): Promise<ComputerStatus>;
  start(ownerId: string, botId: string): Promise<ComputerStatus>;
  stop(ownerId: string, botId: string): Promise<ComputerStatus>;

  resourceName?(ownerId: string): string;
  reconcile?(ownerId: string, desiredState: ComputerProviderDesiredState): Promise<ComputerProviderReconcileResult>;
  health?(): Promise<ComputerProviderHealth>;

  open(ownerId: string, botId: string, url: string): Promise<BrowserView>;
  click?(ownerId: string, botId: string, selector: string): Promise<BrowserActionResult>;
  type?(ownerId: string, botId: string, selector: string, text: string, submit?: boolean): Promise<BrowserActionResult>;
  scroll?(ownerId: string, botId: string, deltaY: number): Promise<BrowserActionResult>;
  waitFor?(ownerId: string, botId: string, selector: string, timeoutMs?: number): Promise<BrowserActionResult>;
  screenshot?(ownerId: string, botId: string): Promise<BrowserActionResult>;

  listFiles(ownerId: string, botId: string): Promise<ComputerFileEntry[]>;
  readText(ownerId: string, botId: string, relativePath: string): Promise<{ path: string; content: string; sizeBytes: number }>;
  writeText(ownerId: string, botId: string, relativePath: string, content: string): Promise<{ path: string; sizeBytes: number }>;
  terminal(ownerId: string, botId: string, program: string, args?: string[], timeoutMs?: number): Promise<TerminalExecutionResult>;
}
