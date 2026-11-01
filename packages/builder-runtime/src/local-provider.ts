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

const PYTHON_SECURITY_GUARD = `
# AIRA Local Subprocess Sandbox Containment Harness
import sys, os

# 1. Block Socket / Network
import socket
class BlockedSocket:
    def __init__(self, *args, **kwargs):
        raise PermissionError("AIRA_SANDBOX_POLICY_VIOLATION: Network access is blocked by AIRA Sandbox Policy.")
    def connect(self, *args, **kwargs):
        raise PermissionError("AIRA_SANDBOX_POLICY_VIOLATION: Network access is blocked by AIRA Sandbox Policy.")
socket.socket = BlockedSocket

# 2. Block Subprocesses & Shell Execution
import subprocess
def blocked_exec(*args, **kwargs):
    raise PermissionError("AIRA_SANDBOX_POLICY_VIOLATION: Subprocess execution is blocked by AIRA Sandbox Policy.")
subprocess.Popen = blocked_exec
subprocess.run = blocked_exec
subprocess.call = blocked_exec
subprocess.check_call = blocked_exec
subprocess.check_output = blocked_exec
os.system = blocked_exec
if hasattr(os, 'popen'):
    os.popen = blocked_exec
if hasattr(os, 'spawnl'):
    os.spawnl = blocked_exec

# 3. Block Filesystem Traversal Outside Workspace
_real_open = open
_workspace_dir = os.path.abspath(os.getcwd())

def safe_open(file, *args, **kwargs):
    try:
        abs_path = os.path.abspath(str(file))
        if not abs_path.startswith(_workspace_dir):
            in_lib = any(abs_path.startswith(os.path.abspath(p)) for p in [sys.prefix, getattr(sys, 'base_prefix', sys.prefix)])
            mode = args[0] if len(args) > 0 else kwargs.get('mode', 'r')
            if ('w' in mode or 'a' in mode or '+' in mode or 'x' in mode) and not abs_path.startswith(_workspace_dir):
                raise PermissionError(f"AIRA_SANDBOX_POLICY_VIOLATION: Write operation outside workspace is blocked: {file}")
            if not in_lib and not abs_path.startswith(_workspace_dir):
                raise PermissionError(f"AIRA_SANDBOX_POLICY_VIOLATION: Filesystem traversal outside workspace is blocked: {file}")
    except PermissionError:
        raise
    except Exception:
        pass
    return _real_open(file, *args, **kwargs)

import builtins
builtins.open = safe_open
`;

function parseCommandArgs(cmdStr: string): { binary: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }

  const binary = parts[0] || '';
  const args = parts.slice(1);
  return { binary, args };
}

export class LocalIsolatedSandboxProvider implements SandboxProvider {
  public readonly name = 'local';
  private workspaces = new Map<string, {
    rootDir: string;
    allowInternet: boolean;
    expiresAt: number;
    processes: Set<number>;
  }>();

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
    if (options.requireContainer) {
      throw new Error('CONTAINER_ISOLATION_REQUIRED: OCI container isolation is required for this workload, but LocalIsolatedSandboxProvider is a restricted host provider.');
    }

    const id = `local_ws_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const rootDir = path.join(os.tmpdir(), `aira_sandbox_${id}`);
    await fs.mkdir(rootDir, { recursive: true });

    const allowInternet = options.allowInternet ?? false;
    // Always write sitecustomize.py into workspace for automatic sandbox injection
    await fs.writeFile(path.join(rootDir, 'sitecustomize.py'), PYTHON_SECURITY_GUARD, 'utf-8');

    const timeoutMs = options.timeoutMs || 900000;
    const expiresAt = Date.now() + timeoutMs;
    this.workspaces.set(id, { rootDir, allowInternet, expiresAt, processes: new Set() });

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
      const fallbackDir = path.join(os.tmpdir(), `aira_sandbox_${workspaceId}`);
      if (fsSync.existsSync(fallbackDir)) {
        this.workspaces.set(workspaceId, {
          rootDir: fallbackDir,
          allowInternet: false,
          expiresAt: Date.now() + 900000,
          processes: new Set()
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
        if (ent.name === 'sitecustomize.py') continue; // Internal harness files
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
    if (options?.requireContainer) {
      throw new Error('CONTAINER_ISOLATION_REQUIRED: OCI container isolation is required for this workload, but LocalIsolatedSandboxProvider is a restricted host provider.');
    }

    const ws = this.workspaces.get(workspace.id);
    if (!ws) throw new Error(`Workspace "${workspace.id}" not found.`);

    const start = Date.now();
    const cwd = options?.cwd ? this.resolveSafePath(workspace.id, options.cwd) : ws.rootDir;
    const timeoutMs = options?.timeoutMs || 30000;

    // Strict Security Isolation: Strip all sensitive host credentials from subprocess environment
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      SYSTEMROOT: process.env.SYSTEMROOT || '',
      COMSPEC: process.env.COMSPEC || 'cmd.exe',
      PYTHONPATH: ws.rootDir,
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

    // P0 SECURITY CONTROL: Untrusted agent-generated commands CANNOT execute arbitrary host shell binaries
    const isExplicitlyTrusted = Boolean(
      options?.trustedHostExecution === true &&
      process.env.AIRA_TRUSTED_HOST_EXECUTION === 'true'
    );

    const isWin = process.platform === 'win32';
    let executable: string;
    let executableArgs: string[];
    let useShell = false;

    if (isExplicitlyTrusted) {
      executable = isWin ? 'cmd.exe' : '/bin/sh';
      executableArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
      useShell = true;
    } else {
      // Untrusted execution: Fail-closed on shell metacharacters and chaining
      if (/[;&|`$><]/.test(command)) {
        throw new Error(`HOST_EXECUTION_BLOCKED: Shell operators and command chaining are prohibited for untrusted workloads: "${command}". An isolated container is required.`);
      }

      const parsed = parseCommandArgs(command);
      const binaryName = path.basename(parsed.binary).toLowerCase().replace(/\.exe$/, '');

      if (binaryName !== 'python' && binaryName !== 'python3') {
        throw new Error(
          `HOST_EXECUTION_BLOCKED: Arbitrary host shell execution ("${parsed.binary}") is forbidden for untrusted workloads. Only contained Python execution or isolated container sandboxes (Docker/OCI) are permitted.`
        );
      }

      // Contained Python binary execution directly without host shell
      executable = parsed.binary;
      executableArgs = parsed.args;
      useShell = false;

      // Adversarial AST / content check on any referenced script file
      for (let i = 0; i < parsed.args.length; i++) {
        const arg = parsed.args[i];
        if (arg.endsWith('.py')) {
          const resolvedScript = this.resolveSafePath(workspace.id, arg);
          try {
            const content = await fs.readFile(resolvedScript, 'utf-8');
            if (content.includes('..') && (content.includes('/etc/') || content.includes('Windows\\System32') || content.includes('.env'))) {
              throw new Error(`SECURITY_VIOLATION: Filesystem traversal attempt detected in script "${arg}".`);
            }
          } catch (err: any) {
            if (err.message?.includes('SECURITY_VIOLATION')) throw err;
          }
        }
      }
    }

    return new Promise((resolve) => {
      let isSettled = false;

      const child = spawn(executable, executableArgs, {
        cwd,
        env: safeEnv,
        shell: useShell,
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
            if (isWin && child.pid) {
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            } else {
              child.kill('SIGKILL');
            }
          } catch {}
          resolve({
            exitCode: 124,
            stdout,
            stderr: stderr + `\nExecution timed out after ${timeoutMs}ms.`,
            durationMs: Date.now() - start,
            provider: this.name,
            isolationTier: 'LOCAL_RESTRICTED_GUARDED'
          });
        }
      }, timeoutMs);

      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timer);
            try {
              if (isWin && child.pid) {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
              } else {
                child.kill('SIGKILL');
              }
            } catch {}
            resolve({
              exitCode: 130,
              stdout,
              stderr: stderr + '\nExecution cancelled by signal.',
              durationMs: Date.now() - start,
              provider: this.name,
              isolationTier: 'LOCAL_RESTRICTED_GUARDED'
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
            provider: this.name,
            isolationTier: 'LOCAL_RESTRICTED_GUARDED'
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
            provider: this.name,
            isolationTier: 'LOCAL_RESTRICTED_GUARDED'
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
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
          } else {
            process.kill(pid, 'SIGKILL');
          }
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
