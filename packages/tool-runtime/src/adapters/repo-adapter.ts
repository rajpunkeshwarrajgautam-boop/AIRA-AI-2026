import { execFile } from 'child_process';
import * as path from 'path';

export class RepositoryAdapter {
  constructor(private workspaceRoot = process.cwd()) {}

  private runGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: path.resolve(this.workspaceRoot),
          timeout: 10000,
          maxBuffer: 256 * 1024
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`Git command failed: ${stderr || err.message}`));
          } else {
            resolve(stdout.trim());
          }
        }
      );
    });
  }

  async getStatus(): Promise<{
    branch: string;
    isClean: boolean;
    modified: string[];
    untracked: string[];
    headSha: string;
  }> {
    const branch = await this.runGit(['branch', '--show-current']).catch(() => 'unknown');
    const statusOutput = await this.runGit(['status', '--porcelain']).catch(() => '');
    const headSha = await this.runGit(['rev-parse', 'HEAD']).catch(() => 'unknown');

    const lines = statusOutput ? statusOutput.split('\n') : [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      if (!line) continue;
      const status = line.slice(0, 2).trim();
      const file = line.slice(3).trim();
      if (status === '??') {
        untracked.push(file);
      } else {
        modified.push(file);
      }
    }

    return {
      branch,
      isClean: lines.length === 0,
      modified,
      untracked,
      headSha
    };
  }

  async getDiff(maxLines = 100): Promise<{ diff: string; truncated: boolean }> {
    const rawDiff = await this.runGit(['diff']).catch(() => '');
    const lines = rawDiff.split('\n');
    const truncated = lines.length > maxLines;
    return {
      diff: lines.slice(0, maxLines).join('\n'),
      truncated
    };
  }

  async getLog(count = 5): Promise<Array<{ sha: string; message: string }>> {
    const logOutput = await this.runGit(['log', `-${Math.min(count, 20)}`, '--oneline']).catch(() => '');
    const entries = logOutput.split('\n').filter(Boolean).map(line => {
      const [sha, ...msgParts] = line.split(' ');
      return {
        sha,
        message: msgParts.join(' ')
      };
    });
    return entries;
  }
}
