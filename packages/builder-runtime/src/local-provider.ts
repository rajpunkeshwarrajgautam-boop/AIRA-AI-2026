import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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

export class LocalIsolatedSandboxProvider implements SandboxProvider {
  public readonly name = 'local';
  private workspaces = new Map<string, { rootDir: string; expiresAt: number; processes: Set<number> }>();

  isConfigured(): boolean {
    return true;
  }

  private resolveSafePath(workspaceId: string, relPath: string): string {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) throw new Error(`Local workspace "${workspaceId}" not found or expired.`);
    
    // Normalize and prevent directory traversal
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
    const id = `local_ws_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const rootDir = path.join(os.tmpdir(), `aira_sandbox_${id}`);
    await fs.mkdir(rootDir, { recursive: true });

    const timeoutMs = options.timeoutMs || 900000;
    const expiresAt = Date.now() + timeoutMs;
    this.workspaces.set(id, { rootDir, expiresAt, processes: new Set() });

    return {
      id,
      provider: this.name,
      createdAt: Date.now(),
      expiresAt,
      status: 'READY',
      previewUrl: `http://127.0.0.1:3000?ws=${id}`
    };
  }

  async reconnectWorkspace(workspaceId: string, _options?: SandboxReconnectOptions): Promise<SandboxWorkspace> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      // Re-initialize if directory exists
      const fallbackDir = path.join(os.tmpdir(), `aira_sandbox_${workspaceId}`);
      if (fsSync.existsSync(fallbackDir)) {
        this.workspaces.set(workspaceId, { rootDir: fallbackDir, expiresAt: Date.now() + 900000, processes: new Set() });
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
    const cwd = options?.cwd ? this.resolveSafePath(workspace.id, options.cwd) : ws.rootDir;
    const timeoutMs = options?.timeoutMs || 30000;

    // Strict Security Isolation: Strip all sensitive host credentials from subprocess environment
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      SYSTEMROOT: process.env.SYSTEMROOT || '',
      TEMP: ws.rootDir,
      TMP: ws.rootDir,
      HOME: ws.rootDir,
      USERPROFILE: ws.rootDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
      ...(options?.env || {})
    };

    // Remove any accidental leak of secrets
    for (const key of Object.keys(safeEnv)) {
      const kUpper = key.toUpperCase();
      if (
        kUpper.includes('TOKEN') ||
        kUpper.includes('SECRET') ||
        kUpper.includes('KEY') ||
        kUpper.includes('DATABASE') ||
        kUpper.includes('NEON') ||
        kUpper.includes('AWS') ||
        kUpper.includes('POSTGRES') ||
        kUpper.includes('AUTH') ||
        kUpper.includes('COOKIE') ||
        kUpper.includes('JWT')
      ) {
        delete safeEnv[key];
      }
    }

    return new Promise((resolve) => {
      let isSettled = false;
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

      const child = spawn(shell, shellArgs, {
        cwd,
        env: safeEnv,
        windowsHide: true
      });

      if (child.pid) {
        ws.processes.add(child.pid);
      }

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
            child.kill('SIGKILL');
          } catch {}
          resolve({
            exitCode: 124,
            stdout,
            stderr: stderr + `\nExecution timed out after ${timeoutMs}ms.`,
            durationMs: Date.now() - start,
            provider: this.name
          });
        }
      }, timeoutMs);

      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timer);
            try {
              child.kill('SIGKILL');
            } catch {}
            resolve({
              exitCode: 130,
              stdout,
              stderr: stderr + '\nExecution cancelled by signal.',
              durationMs: Date.now() - start,
              provider: this.name
            });
          }
        }, { once: true });
      }

      child.on('close', (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          if (child.pid) ws.processes.delete(child.pid);
          resolve({
            exitCode: code ?? 0,
            stdout,
            stderr,
            durationMs: Date.now() - start,
            provider: this.name
          });
        }
      });

      child.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          if (child.pid) ws.processes.delete(child.pid);
          resolve({
            exitCode: 1,
            stdout,
            stderr: stderr + `\nProcess error: ${err.message}`,
            durationMs: Date.now() - start,
            provider: this.name
          });
        }
      });
    });
  }

  async startPreview(workspace: SandboxWorkspace, port = 3000, _command?: string): Promise<SandboxPreview> {
    return {
      url: `http://127.0.0.1:${port}?workspace=${workspace.id}`,
      port,
      provider: this.name
    };
  }

  async terminateWorkspace(workspace: SandboxWorkspace): Promise<void> {
    const ws = this.workspaces.get(workspace.id);
    if (ws) {
      for (const pid of ws.processes) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      ws.processes.clear();
      try {
        await fs.rm(ws.rootDir, { recursive: true, force: true });
      } catch {}
      this.workspaces.delete(workspace.id);
    }
  }
}
