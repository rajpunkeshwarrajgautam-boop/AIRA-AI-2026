import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Minimal deterministic ustar archive for manifest-validated project files only. */
export async function createSourceArchive(
  root: string, manifest: Array<{ path: string; sha256: string }>
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (const item of manifest) {
    const name = item.path;
    if (!/^[a-zA-Z0-9_.\/-]{1,100}$/.test(name) ||
        name.split('/').some(p => p === '..' || p.startsWith('.'))) {
      throw new Error('INVALID_ARCHIVE_PATH');
    }
    const absolute = join(root, name);
    const meta = await lstat(absolute);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 256_000) {
      throw new Error('INVALID_ARCHIVE_FILE');
    }
    const data = await readFile(absolute);
    total += data.length;
    if (total > 1_000_000) throw new Error('ARCHIVE_TOO_LARGE');
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
