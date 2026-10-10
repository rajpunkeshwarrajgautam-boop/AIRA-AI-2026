import { readdir, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

const supported = /\.(?:html|js|mjs|css|json|svg|png|webp|jpe?g|gif|woff2?|ttf|wasm|ico)$/i;
export interface PreviewFile { path: string; sha256: string }
export async function collectCompiledPreview(workspace: string): Promise<PreviewFile[] | undefined> {
  const dist = resolve(workspace, 'dist');
  const meta = await lstat(dist).catch(() => null);
  if (!meta) return undefined;
  if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error('COMPILED_PREVIEW_INVALID_DIRECTORY');
  const files: PreviewFile[] = [];
  let total = 0;
  async function walk(folder: string, prefix = ''): Promise<void> {
    if (files.length > 200) throw new Error('COMPILED_PREVIEW_TOO_MANY_FILES');
    for (const ent of await readdir(folder, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) throw new Error('COMPILED_PREVIEW_SYMLINK_REJECTED');
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      if (!/^[a-zA-Z0-9_./-]{1,200}$/.test(rel) || rel.split('/').some(p => p.startsWith('.'))) {
        throw new Error('COMPILED_PREVIEW_UNSAFE_PATH');
      }
      const abs = resolve(dist, rel);
      if (!abs.startsWith(dist + sep)) throw new Error('COMPILED_PREVIEW_PATH_ESCAPE');
      if (ent.isDirectory()) {
        await walk(abs, rel);
      } else if (ent.isFile()) {
        if (!supported.test(rel)) throw new Error('COMPILED_PREVIEW_UNSUPPORTED_ASSET');
        const current = await lstat(abs);
        if (!current.isFile() || current.size > 1_500_000) throw new Error('COMPILED_PREVIEW_ASSET_TOO_LARGE');
        total += current.size;
        if (total > 8_000_000 || files.length >= 200) throw new Error('COMPILED_PREVIEW_SIZE_LIMIT');
        const bytes = await readFile(abs);
        files.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex') });
      } else {
        throw new Error('COMPILED_PREVIEW_SPECIAL_FILE');
      }
    }
  }
  await walk(dist);
  if (!files.some(x => x.path === 'index.html')) throw new Error('COMPILED_PREVIEW_INDEX_MISSING');
  return files;
}
