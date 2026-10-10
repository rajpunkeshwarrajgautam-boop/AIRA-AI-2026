/**
 * Deny-by-default policy for dependency execution inside a network-disconnected
 * sandbox. A trusted, separately provisioned npm cache supplies package bytes.
 * Validation does not replace a supply-chain security review.
 */
type DependencyMap = Record<string, string>;
type PackageManifest = { name?: string; dependencies?: DependencyMap; devDependencies?: DependencyMap };
type LockEntry = {
  name?: string; version?: string; resolved?: string; integrity?: string;
  link?: boolean; hasInstallScript?: boolean; inBundle?: boolean;
  dependencies?: DependencyMap; devDependencies?: DependencyMap;
};
type Lockfile = { name?: string; lockfileVersion?: number; packages?: Record<string, LockEntry> };
function readJson<T>(content: string): T {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('INVALID_DEPENDENCY_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_DEPENDENCY_JSON');
  return value as T;
}
function entries(value: DependencyMap | undefined): [string, string][] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_DEPENDENCIES');
  return Object.entries(value);
}
const registry = 'https://registry.npmjs.org/';
const unsafeProtocol = /^(?:file:|link:|git:|git\+|https?:|workspace:|npm:)/i;

/**
 * Exact approved direct versions are provisioned by the worker operator in
 * an offline cache. Generated projects may not request arbitrary packages.
 */
export function validateApprovedDependencySpecs(packageJson: string, allowed: Record<string, string>): boolean {
  const pkg = readJson<PackageManifest & Record<string, unknown>>(packageJson);
  const deps = [...entries(pkg.dependencies), ...entries(pkg.devDependencies)];
  if (deps.length === 0) return false;
  if (deps.length > 30 || pkg.overrides || pkg.workspaces || pkg.bundledDependencies ||
      pkg.bundleDependencies || pkg.resolutions || pkg.publishConfig) {
    throw new Error('UNSUPPORTED_PACKAGE_FEATURE');
  }
  const names = new Set<string>();
  for (const [name, version] of deps) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
        names.has(name) || allowed[name] !== version) {
      throw new Error('DEPENDENCY_NOT_APPROVED');
    }
    names.add(name);
  }
  return true;
}

/** Validates exact declared dependency-to-lock mappings and remote tarball hashes. */
export function validateOfflineDependencyLock(packageJson: string, lockJson: string): void {
  const pkg = readJson<PackageManifest>(packageJson);
  const lock = readJson<Lockfile>(lockJson);
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) {
    throw new Error('UNSUPPORTED_DEPENDENCY_LOCKFILE');
  }
  const declared = [...entries(pkg.dependencies), ...entries(pkg.devDependencies)];
  if (declared.length === 0) throw new Error('NO_EXTERNAL_DEPENDENCIES');
  if (declared.length > 60) throw new Error('TOO_MANY_DEPENDENCIES');
  const root = lock.packages[''];
  const rootDeps = [...entries(root.dependencies), ...entries(root.devDependencies)];
  if (new Set(declared.map(([name]) => name)).size !== declared.length ||
      new Set(rootDeps.map(([name]) => name)).size !== rootDeps.length) throw new Error('DUPLICATE_DEPENDENCIES');
  for (const [name, version] of declared) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.length > 160 ||
        typeof version !== 'string' || !version || unsafeProtocol.test(version)) {
      throw new Error('UNSAFE_DEPENDENCY_SPEC');
    }
    if (!rootDeps.some(([key, locked]) => key === name && locked === version)) {
      throw new Error('DEPENDENCY_LOCK_MISMATCH');
    }
  }
  if (declared.length !== rootDeps.length) throw new Error('DEPENDENCY_LOCK_MISMATCH');
  const allPackages = Object.entries(lock.packages);
  if (allPackages.length > 700) throw new Error('DEPENDENCY_GRAPH_TOO_LARGE');
  for (const [path, item] of allPackages) {
    if (path === '') continue;
    if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._/-]+$/i.test(path) ||
        path.split('/').includes('..') || path.length > 240) throw new Error('UNSAFE_LOCKFILE_PATH');
    if (item.link || item.inBundle || item.hasInstallScript) throw new Error('UNSAFE_DEPENDENCY_PACKAGE');
    let url: URL;
    try { url = new URL(item.resolved || 'invalid'); }
    catch { throw new Error('UNTRUSTED_DEPENDENCY_ARCHIVE'); }
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password ||
        url.search || url.hash || !item.resolved?.startsWith(registry) ||
        item.resolved.includes('\\') ||
        typeof item.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity)) {
      throw new Error('UNTRUSTED_DEPENDENCY_ARCHIVE');
    }
  }
}
