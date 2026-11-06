import type { BrowserView, ComputerFileEntry, ComputerStatus } from './index.js';

export type ComputerProviderKind = 'local' | 'docker';

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
  actionReceipt?(ownerId: string, actionId: string): Promise<{ status: string; result?: unknown; error?: string } | undefined>;
  revokeAction?(ownerId: string, actionId: string): Promise<void>;
}
