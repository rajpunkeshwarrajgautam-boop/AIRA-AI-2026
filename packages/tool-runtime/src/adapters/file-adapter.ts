import * as fs from 'fs';
import * as path from 'path';

export class FileSystemAdapter {
  constructor(private workspaceRoot = process.cwd()) {}

  private resolveSafePath(relPath: string): string {
    const root = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(root, relPath);
    if (!resolved.startsWith(root)) {
      throw new Error(`SECURITY_REJECTED: Access denied. Path "${relPath}" is outside workspace sandbox.`);
    }
    return resolved;
  }

  async list(relPath = '.'): Promise<{
    directory: string;
    entries: Array<{ name: string; isDirectory: boolean; sizeBytes: number }>;
  }> {
    const safePath = this.resolveSafePath(relPath);
    if (!fs.existsSync(safePath)) {
      throw new Error(`Directory not found: "${relPath}"`);
    }

    const stat = fs.statSync(safePath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: "${relPath}"`);
    }

    const dirEntries = fs.readdirSync(safePath, { withFileTypes: true });
    const entries = dirEntries.slice(0, 100).map(e => {
      let sizeBytes = 0;
      if (!e.isDirectory()) {
        try { sizeBytes = fs.statSync(path.join(safePath, e.name)).size; } catch {}
      }
      return {
        name: e.name,
        isDirectory: e.isDirectory(),
        sizeBytes
      };
    });

    return {
      directory: relPath,
      entries
    };
  }

  async read(relPath: string): Promise<{
    filePath: string;
    sizeBytes: number;
    content: string;
    truncated: boolean;
  }> {
    const safePath = this.resolveSafePath(relPath);
    if (!fs.existsSync(safePath)) {
      throw new Error(`File not found: "${relPath}"`);
    }

    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      throw new Error(`Target "${relPath}" is a directory. Use file_system_list instead.`);
    }

    const MAX_SIZE = 64000;
    const content = fs.readFileSync(safePath, 'utf8');
    const truncated = content.length > MAX_SIZE;

    return {
      filePath: relPath,
      sizeBytes: stat.size,
      content: content.slice(0, MAX_SIZE),
      truncated
    };
  }

  async write(relPath: string, content: string): Promise<{
    filePath: string;
    bytesWritten: number;
    created: boolean;
  }> {
    const safePath = this.resolveSafePath(relPath);
    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const exists = fs.existsSync(safePath);
    fs.writeFileSync(safePath, content, 'utf8');

    return {
      filePath: relPath,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      created: !exists
    };
  }

  async patch(relPath: string, targetText: string, replacementText: string): Promise<{
    filePath: string;
    replaced: boolean;
  }> {
    const safePath = this.resolveSafePath(relPath);
    if (!fs.existsSync(safePath)) {
      throw new Error(`File not found for patch: "${relPath}"`);
    }

    const original = fs.readFileSync(safePath, 'utf8');
    if (!original.includes(targetText)) {
      throw new Error(`Target text to patch was not found in "${relPath}".`);
    }

    const updated = original.replace(targetText, replacementText);
    fs.writeFileSync(safePath, updated, 'utf8');

    return {
      filePath: relPath,
      replaced: true
    };
  }

  async delete(relPath: string): Promise<{
    filePath: string;
    deleted: boolean;
  }> {
    const safePath = this.resolveSafePath(relPath);
    if (!fs.existsSync(safePath)) {
      throw new Error(`Cannot delete non-existent file: "${relPath}"`);
    }

    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      fs.rmdirSync(safePath);
    } else {
      fs.unlinkSync(safePath);
    }

    return {
      filePath: relPath,
      deleted: true
    };
  }
}
