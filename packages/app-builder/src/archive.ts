import { readFile, lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** Minimal deterministic ustar archive for manifest-validated project files only. */
export async function createSourceArchive(
  root: string, manifest: Array<{ path: string; sha256: string }>,
  limits: { maxFileBytes: number; maxTotalBytes: number; maxFiles: number } = {
    maxFileBytes: 256_000, maxTotalBytes: 1_000_000, maxFiles: 50
  }
): Promise<Buffer> {
  if (manifest.length === 0 || manifest.length > limits.maxFiles) throw new Error('ARCHIVE_FILE_COUNT_EXCEEDED');
  const chunks: Buffer[] = [];
  let total = 0;
  for (const item of manifest) {
    const name = item.path;
    if (!/^[a-zA-Z0-9_.\/-]{1,100}$/.test(name) ||
        name.split('/').some(p => p === '..' || p.startsWith('.'))) {
      throw new Error('INVALID_ARCHIVE_PATH');
    }
    const absolute = resolve(root, name);
    if (!absolute.startsWith(resolve(root) + sep)) throw new Error('INVALID_ARCHIVE_PATH');
    let cursor = resolve(root);
    for (const part of name.split('/')) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('ARCHIVE_SYMLINK_REJECTED');
    }
    const meta = await lstat(absolute);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > limits.maxFileBytes) {
      throw new Error('INVALID_ARCHIVE_FILE');
    }
    const data = await readFile(absolute);
    if (createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error('SOURCE_INTEGRITY_MISMATCH');
    total += data.length;
    if (total > limits.maxTotalBytes) throw new Error('ARCHIVE_TOO_LARGE');
    const header = Buffer.alloc(512);
    const stringAt = (s: string, offset: number, max: number) => {
      const bytes = Buffer.from(s);
      if (bytes.length > max) throw new Error('TAR_FIELD_OVERFLOW');
      bytes.copy(header, offset);
    };
    const octal = (value: number, offset: number, length: number) => {
      stringAt(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    };
    stringAt(name, 0, 100);
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = '0'.charCodeAt(0);
    stringAt('ustar\0', 257, 6);
    stringAt('00', 263, 2);
    const checksum = header.reduce((a, b) => a + b, 0);
    stringAt(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}
