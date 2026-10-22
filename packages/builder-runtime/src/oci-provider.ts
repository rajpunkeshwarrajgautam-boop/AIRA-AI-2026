import type {
  SandboxCommandOptions,
  SandboxCommandResult,
  SandboxCreateOptions,
  SandboxFile,
  SandboxPreview,
  SandboxProvider,
  SandboxReconnectOptions,
  SandboxWorkspace
} from './provider-types.js';

export class OCISandboxProvider implements SandboxProvider {
  readonly name = 'oci';

  isConfigured(): boolean {
    return false;
  }

  async createWorkspace(_options: SandboxCreateOptions): Promise<SandboxWorkspace> {
    throw new Error('OCI Sandbox Provider is not active. Oracle Cloud Infrastructure execution boundary is planned for a future release.');
  }

  async reconnectWorkspace(_workspaceId: string, _options?: SandboxReconnectOptions): Promise<SandboxWorkspace> {
    throw new Error('OCI Sandbox Provider is not active. Cannot reconnect to OCI workspace.');
  }

  async writeFile(_workspace: SandboxWorkspace, _path: string, _contents: Uint8Array | string): Promise<{ path: string; bytesWritten: number }> {
    throw new Error('OCI Sandbox Provider is not active.');
  }

  async readFile(_workspace: SandboxWorkspace, _path: string): Promise<Uint8Array> {
    throw new Error('OCI Sandbox Provider is not active.');
  }

  async listFiles(_workspace: SandboxWorkspace, _path?: string): Promise<SandboxFile[]> {
    throw new Error('OCI Sandbox Provider is not active.');
  }

  async runCommand(_workspace: SandboxWorkspace, _command: string, _options?: SandboxCommandOptions): Promise<SandboxCommandResult> {
    throw new Error('OCI Sandbox Provider is not active.');
  }

  async startPreview(_workspace: SandboxWorkspace, _port: number, _command?: string): Promise<SandboxPreview> {
    throw new Error('OCI Sandbox Provider is not active.');
  }

  async terminateWorkspace(_workspace: SandboxWorkspace): Promise<void> {
    // No-op for unconfigured provider
  }
}
