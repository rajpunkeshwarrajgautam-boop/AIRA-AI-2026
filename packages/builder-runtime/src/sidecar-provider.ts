import { randomUUID } from 'node:crypto';
import type {
  SandboxProvider,
  SandboxWorkspace,
  SandboxCreateOptions,
  SandboxReconnectOptions,
  SandboxCommandOptions,
  SandboxCommandResult,
  SandboxFile,
  SandboxPreview
} from './provider-types.js';

interface SidecarWorkspaceState {
  files: Map<string, string>;
  createdAt: number;
  timeoutMs: number;
}

/**
 * AIRA AI 2026 — Isolated Container Sidecar Sandbox Provider
 * 
 * Secure container isolation for untrusted Python and shell workloads
 * without mounting the host Docker socket (/var/run/docker.sock) to the worker.
 * 
 * Communicates with a dedicated sandboxed sidecar runner (e.g. aira-sandbox-sidecar)
 * over an internal Docker bridge network via AIRA_SANDBOX_RUNNER_URL.
 */
export class SidecarSandboxProvider implements SandboxProvider {
  public readonly name = 'sidecar';
  private workspaces = new Map<string, SidecarWorkspaceState>();

  isConfigured(): boolean {
    const url = process.env.AIRA_SANDBOX_RUNNER_URL?.trim();
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private getRunnerUrl(): string {
    const url = process.env.AIRA_SANDBOX_RUNNER_URL?.trim();
    if (!url) {
      throw new Error('CONTAINER_ISOLATION_UNAVAILABLE: AIRA_SANDBOX_RUNNER_URL is not configured.');
    }
    return url.replace(/\/+$/, '');
  }

  async createWorkspace(options: SandboxCreateOptions): Promise<SandboxWorkspace> {
    if (!this.isConfigured()) {
      throw new Error('CONTAINER_ISOLATION_UNAVAILABLE: Sidecar sandbox runner is not configured.');
    }

    const id = `ws_sidecar_${randomUUID().replace(/-/g, '')}`;
    const state: SidecarWorkspaceState = {
      files: new Map(),
      createdAt: Date.now(),
      timeoutMs: options.timeoutMs || 60000
    };
    this.workspaces.set(id, state);

    // Optional handshake with sidecar runner if reachable
    try {
      const runnerUrl = this.getRunnerUrl();
      const res = await fetch(`${runnerUrl}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: id, timeoutMs: state.timeoutMs }),
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok && res.status !== 404) {
        // Status 404 is allowed if runner is a stateless /run endpoint
        const text = await res.text().catch(() => '');
        console.warn(`[SidecarSandboxProvider] Runner handshake returned ${res.status}: ${text}`);
      }
    } catch {
      // Stateless runners execute per command, handshake is advisory
    }

    return {
      id,
      provider: this.name,
      createdAt: state.createdAt,
      expiresAt: state.createdAt + state.timeoutMs
    };
  }

  async reconnectWorkspace(workspaceId: string, _options?: SandboxReconnectOptions): Promise<SandboxWorkspace> {
    let state = this.workspaces.get(workspaceId);
    if (!state) {
      state = {
        files: new Map(),
        createdAt: Date.now(),
        timeoutMs: 60000
      };
      this.workspaces.set(workspaceId, state);
    }
    return {
      id: workspaceId,
      provider: this.name,
      createdAt: state.createdAt,
      expiresAt: state.createdAt + state.timeoutMs
    };
  }

  async writeFile(workspace: SandboxWorkspace, filePath: string, contents: Uint8Array | string): Promise<{ path: string; bytesWritten: number }> {
    const state = this.workspaces.get(workspace.id);
    if (!state) throw new Error(`Sidecar workspace "${workspace.id}" not found.`);

    const contentStr = typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8');
    const bytes = typeof contents === 'string' ? Buffer.byteLength(contents, 'utf8') : contents.byteLength;

    state.files.set(filePath, contentStr);
    return { path: filePath, bytesWritten: bytes };
  }

  async readFile(workspace: SandboxWorkspace, filePath: string): Promise<Uint8Array> {
    const state = this.workspaces.get(workspace.id);
    if (!state) throw new Error(`Sidecar workspace "${workspace.id}" not found.`);

    const fileContent = state.files.get(filePath);
    if (fileContent === undefined) {
      throw new Error(`File "${filePath}" not found in sidecar workspace.`);
    }
    return Buffer.from(fileContent, 'utf8');
  }

  async listFiles(workspace: SandboxWorkspace, _path?: string): Promise<SandboxFile[]> {
    const state = this.workspaces.get(workspace.id);
    if (!state) throw new Error(`Sidecar workspace "${workspace.id}" not found.`);

    const result: SandboxFile[] = [];
    for (const [name, content] of state.files.entries()) {
      result.push({
        name,
        type: 'file',
        size: Buffer.byteLength(content, 'utf8')
      });
    }
    return result;
  }

  async runCommand(workspace: SandboxWorkspace, command: string, options?: SandboxCommandOptions): Promise<SandboxCommandResult> {
    const state = this.workspaces.get(workspace.id);
    if (!state) throw new Error(`Sidecar workspace "${workspace.id}" not found.`);

    const runnerUrl = this.getRunnerUrl();
    const timeoutMs = options?.timeoutMs || state.timeoutMs || 30000;
    const startTime = Date.now();

    // Prepare files payload
    const filesPayload: Record<string, string> = {};
    for (const [name, content] of state.files.entries()) {
      filesPayload[name] = content;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 2000);

      const res = await fetch(`${runnerUrl}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspace.id,
          command,
          files: filesPayload,
          timeoutMs
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Sidecar sandbox execution failed (HTTP ${res.status}): ${errText}`);
      }

      const data = await res.json() as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        durationMs?: number;
        files?: Record<string, string>;
      };

      // Sync back any updated files from execution
      if (data.files && typeof data.files === 'object') {
        for (const [name, content] of Object.entries(data.files)) {
          state.files.set(name, String(content));
        }
      }

      return {
        exitCode: data.exitCode ?? 0,
        stdout: data.stdout || '',
        stderr: data.stderr || '',
        durationMs: data.durationMs || (Date.now() - startTime),
        provider: this.name,
        isolationTier: 'container-sidecar'
      };
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        return {
          exitCode: 124, // Standard timeout exit code
          stdout: '',
          stderr: `Execution timed out after ${timeoutMs}ms.`,
          durationMs: Date.now() - startTime,
          provider: this.name,
          isolationTier: 'container-sidecar'
        };
      }
      throw err;
    }
  }

  async startPreview(_workspace: SandboxWorkspace, _port: number, _command?: string): Promise<SandboxPreview> {
    throw new Error('Preview is not supported in isolated sidecar runner.');
  }

  async terminateWorkspace(workspace: SandboxWorkspace): Promise<void> {
    this.workspaces.delete(workspace.id);
    try {
      const runnerUrl = this.getRunnerUrl();
      await fetch(`${runnerUrl}/workspaces/${workspace.id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2000)
      }).catch(() => {});
    } catch {
      // Teardown is best effort
    }
  }
}
