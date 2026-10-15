export interface SandboxWorkspace {
  readonly id: string;
  readonly provider: string;
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly status?: string;
  readonly previewUrl?: string;
  readonly portUrls?: Record<string, string>;
  readonly raw?: unknown;
}

export interface SandboxCreateOptions {
  allowInternet: boolean;
  allowPreview: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  name?: string;
  runtime?: string;
  instanceType?: string;
  teamspace?: string;
}

export interface SandboxReconnectOptions {
  signal?: AbortSignal;
}

export interface SandboxCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  detached?: boolean;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  commandId?: string;
  durationMs?: number;
  provider: string;
}

export interface SandboxFile {
  name: string;
  type: string;
  size?: number;
}

export interface SandboxPreview {
  url: string;
  port: number;
  provider: string;
}

export interface SandboxProvider {
  readonly name: string;
  isConfigured(): boolean;
  createWorkspace(options: SandboxCreateOptions): Promise<SandboxWorkspace>;
  reconnectWorkspace(workspaceId: string, options?: SandboxReconnectOptions): Promise<SandboxWorkspace>;
  writeFile(workspace: SandboxWorkspace, path: string, contents: Uint8Array | string): Promise<{ path: string; bytesWritten: number }>;
  readFile(workspace: SandboxWorkspace, path: string): Promise<Uint8Array>;
  listFiles(workspace: SandboxWorkspace, path?: string): Promise<SandboxFile[]>;
  runCommand(workspace: SandboxWorkspace, command: string, options?: SandboxCommandOptions): Promise<SandboxCommandResult>;
  startPreview(workspace: SandboxWorkspace, port: number, command?: string): Promise<SandboxPreview>;
  stopCommand?(workspace: SandboxWorkspace, commandId: string): Promise<void>;
  terminateWorkspace(workspace: SandboxWorkspace): Promise<void>;
}
