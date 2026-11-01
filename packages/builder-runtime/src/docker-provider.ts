import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

/**
 * AIRA AI 2026 — Milestone 3: Hardened Docker/OCI Isolated Sandbox Provider
 * 
 * Enforces:
 * 1. Non-root execution (--user 1000:1000)
 * 2. Unprivileged execution (no --privileged)
 * 3. Zero Docker control socket mounts (never mounts /var/run/docker.sock)
 * 4. Read-only root filesystem (--read-only) with restricted tmpfs
 * 5. Network disabled by default (--network none) unless explicitly authorized
 * 6. Strict resource limits (--memory 256m, --cpus 1.0, --pids-limit 64)
 * 7. Bounded execution timeouts and output quotas (500KB cap)
 * 8. Strict tenant isolation (per-workspace isolated directories)
 * 9. Deterministic cleanup (--rm flag and workspace directory removal)
 */
export class DockerIsolatedSandboxProvider implements SandboxProvider {
  public readonly name = 'docker';
  private workspaces = new Map<string, { rootDir: string; allowInternet: boolean; expiresAt: number; containerIds: Set<string> }>();

  isConfigured(): boolean {
    try {
      execSync('docker --version', { stdio: 'ignore', timeout: 3000 });
      // Probe if docker daemon is running
      execSync('docker info', { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private resolveSafePath(workspaceId: string, relPath: string): string {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) throw new Error(`Docker workspace "${workspaceId}" not found or expired.`);

    const safeRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (safeRel.includes('..') || path.isAbsolute(relPath)) {
      throw new Error(`SECURITY_VIOLATION: Path traversal attempt blocked: "${relPath}".`);
    }
    const resolved = path.resolve(ws.rootDir, safeRel);
    if (!resolved.startsWith(path.resolve(ws.rootDir))) {
      throw new Error(`SECURITY_VIOLATION: Target path escapes sandbox boundary: "${relPath}".`);
    }
    return resolved;
  }

  async createWorkspace(options: SandboxCreateOptions): Promise<SandboxWorkspace> {
    if (!this.isConfigured()) {
      throw new Error('DOCKER_RUNTIME_UNAVAILABLE: Docker daemon is not active. Container isolation cannot be established.');
    }

    const id = `docker_ws_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const rootDir = path.join(os.tmpdir(), `aira_docker_${id}`);
    await fs.mkdir(rootDir, { recursive: true });

    const timeoutMs = options.timeoutMs || 900000;
    const expiresAt = Date.now() + timeoutMs;
    this.workspaces.set(id, {
      rootDir,
      allowInternet: options.allowInternet ?? false,
      expiresAt,
      containerIds: new Set()
    });

    return {
      id,
      provider: this.name,
      createdAt: Date.now(),
      expiresAt,
      status: 'READY'
    };
  }

  async reconnectWorkspace(workspaceId: string, _options?: SandboxReconnectOptions): Promise<SandboxWorkspace> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      const fallbackDir = path.join(os.tmpdir(), `aira_docker_${workspaceId}`);
      if (fsSync.existsSync(fallbackDir)) {
        this.workspaces.set(workspaceId, {
          rootDir: fallbackDir,
          allowInternet: false,
          expiresAt: Date.now() + 900000,
          containerIds: new Set()
        });
        return {
          id: workspaceId,
          provider: this.name,
          createdAt: Date.now(),
          expiresAt: Date.now() + 900000,
          status: 'READY'
        };
      }
      throw new Error(`Workspace "${workspaceId}" not found.`);
    }

    return {
      id: workspaceId,
      provider: this.name,
      createdAt: Date.now() - 60000,
      expiresAt: ws.expiresAt,
      status: 'READY'
    };
  }

  async writeFile(workspace: SandboxWorkspace, filePath: string, contents: Uint8Array | string): Promise<{ path: string; bytesWritten: number }> {
    const target = this.resolveSafePath(workspace.id, filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const buffer = typeof contents === 'string' ? Buffer.from(contents, 'utf-8') : Buffer.from(contents);
    await fs.writeFile(target, buffer);
    return { path: filePath, bytesWritten: buffer.byteLength };
  }

  async readFile(workspace: SandboxWorkspace, filePath: string): Promise<Uint8Array> {
    const target = this.resolveSafePath(workspace.id, filePath);
    const data = await fs.readFile(target);
    return new Uint8Array(data);
  }

  async listFiles(workspace: SandboxWorkspace, subPath = '.'): Promise<SandboxFile[]> {
    const target = this.resolveSafePath(workspace.id, subPath);
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const results: SandboxFile[] = [];
      for (const ent of entries) {
        const full = path.join(target, ent.name);
        let size = 0;
        try {
          const st = await fs.stat(full);
          size = st.size;
        } catch {}
        results.push({
          name: ent.name,
          type: ent.isDirectory() ? 'directory' : 'file',
          size
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  async runCommand(workspace: SandboxWorkspace, command: string, options?: SandboxCommandOptions): Promise<SandboxCommandResult> {
    const ws = this.workspaces.get(workspace.id);
    if (!ws) throw new Error(`Workspace "${workspace.id}" not found.`);

    const start = Date.now();
    const timeoutMs = options?.timeoutMs || 30000;
    const containerName = `aira_cnt_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // Build Docker command with strict sandboxing flags
    const networkFlag = ws.allowInternet ? '--network=bridge' : '--network=none';
    const dockerArgs = [
      'run',
      '--rm',
      '--name', containerName,
      networkFlag,
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--memory=256m',
      '--cpus=1.0',
      '--pids-limit=64',
      '--user=1000:1000',
      '--security-opt=no-new-privileges:true',
      '--cap-drop=ALL',
      '-v', `${ws.rootDir}:/workspace:rw`,
      '-w', '/workspace',
      'python:3.11-slim',
      'sh', '-c', command
    ];

    return new Promise((resolve) => {
      let isSettled = false;
      const child = spawn('docker', dockerArgs, {
        windowsHide: true
      });

      ws.containerIds.add(containerName);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > 500000) stdout = stdout.slice(0, 500000) + '\n[TRUNCATED_STDOUT]';
      });

      child.stderr?.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 500000) stderr = stderr.slice(0, 500000) + '\n[TRUNCATED_STDERR]';
      });

      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            execSync(`docker kill ${containerName}`, { stdio: 'ignore' });
          } catch {}
          child.kill('SIGKILL');
          ws.containerIds.delete(containerName);
          resolve({
            stdout,
            stderr: stderr + '\n[TIMEOUT_EXCEEDED] Execution timed out.',
            exitCode: 124,
            durationMs: Date.now() - start,
            provider: this.name,
            isolationTier: 'CONTAINER_OCI'
          } as any);
        }
      }, timeoutMs);

      child.on('close', (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          ws.containerIds.delete(containerName);
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
            durationMs: Date.now() - start,
            provider: this.name,
            isolationTier: 'CONTAINER_OCI'
          } as any);
        }
      });

      child.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          ws.containerIds.delete(containerName);
          resolve({
            stdout,
            stderr: `Container execution error: ${err.message}`,
            exitCode: 1,
            durationMs: Date.now() - start,
            provider: this.name,
            isolationTier: 'CONTAINER_OCI'
          } as any);
        }
      });
    });
  }

  async startPreview(_workspace: SandboxWorkspace, _port: number, _command?: string): Promise<SandboxPreview> {
    throw new Error('Preview is not supported in hardened Docker batch container mode.');
  }

  async terminateWorkspace(workspace: SandboxWorkspace): Promise<void> {
    const ws = this.workspaces.get(workspace.id);
    if (ws) {
      for (const cName of ws.containerIds) {
        try { execSync(`docker kill ${cName}`, { stdio: 'ignore' }); } catch {}
      }
      ws.containerIds.clear();
      try {
        await fs.rm(ws.rootDir, { recursive: true, force: true });
      } catch {}
      this.workspaces.delete(workspace.id);
    }
  }
}
