import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const allowed = /^[A-Za-z0-9_./-]{1,100}$/;
const suffixes = /\.(?:html|js|mjs|css|json|svg|png|webp|jpe?g|gif|woff2?|ttf|wasm|ico)$/i;
export const artifactMime = (path: string): string | undefined => {
  const ext = path.slice(path.lastIndexOf('.'));
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.wasm': 'application/wasm', '.ico': 'image/x-icon'
  } as Record<string, string>)[ext.toLowerCase()];
};
const parseOctal = (bytes: Buffer) => {
  const s = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(s)) throw new Error('INVALID_COMPILED_TAR_NUMBER');
  return parseInt(s, 8);
};
/** Rejects symlinks, PAX overrides, directories, duplicate paths and unsafe tar entries. */
export function parseCompiledArchive(gzip: Buffer): Map<string, Buffer> {
  if (!Buffer.isBuffer(gzip) || gzip.length === 0 || gzip.length > 12_000_000) {
    throw new Error('COMPILED_ARCHIVE_SIZE_EXCEEDED');
  }
  const raw = gunzipSync(gzip, { maxOutputLength: 10_000_000 });
  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  let terminated = false;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) { terminated = true; break; }
    const actualSum = header.reduce((sum, b, idx) => sum + (idx >= 148 && idx < 156 ? 32 : b), 0);
    const expectedSum = parseOctal(header.subarray(148, 156));
    if (actualSum !== expectedSum || header.toString('ascii', 257, 262) !== 'ustar') {
      throw new Error('COMPILED_ARCHIVE_INVALID_HEADER');
    }
    const name = header.toString('utf8', 0, 100).split('\0')[0];
    if (!allowed.test(name) || !suffixes.test(name) || !artifactMime(name) ||
        name.split('/').some(x => !x || x === '..' || x.startsWith('.')) ||
        files.has(name) || ![0, 48].includes(header[156])) {
      throw new Error('COMPILED_ARCHIVE_UNSAFE_ENTRY');
    }
    const size = parseOctal(header.subarray(124, 136));
    if (size > 1_500_000 || size <= 0 || files.size >= 200) {
      throw new Error('COMPILED_ARCHIVE_ASSET_LIMIT');
    }
    const start = offset + 512;
    const end = start + size;
    if (end > raw.length) throw new Error('COMPILED_ARCHIVE_TRUNCATED');
    total += size;
    if (total > 8_000_000) throw new Error('COMPILED_ARCHIVE_TOTAL_LIMIT');
    files.set(name, Buffer.from(raw.subarray(start, end)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!terminated || !files.has('index.html')) throw new Error('COMPILED_ARCHIVE_INDEX_MISSING');
  return files;
}
export const sha256Bytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
