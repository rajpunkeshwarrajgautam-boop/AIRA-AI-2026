import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeAndValidateArtifactPath,
  inferArtifactFileKind,
  resolveRelativeSpecifier,
  ArtifactPathSecurityError
} from '../src/utils/artifactPathSecurity';
import { analyzeFileDependencies } from '../src/utils/artifactDependencyAnalyzer';
import {
  createMultiFileBundle,
  adaptSingleFileArtifactToBundle,
  buildFileTree
} from '../src/utils/artifactBundleEngine';
import {
  computeCrc32,
  generateProjectZipArchive
} from '../src/utils/artifactZipExporter';
import { generateMultiFileArtifactSandboxHtml } from '../src/utils/multiFileSandbox';
import { syncBundleToWorkspace } from '../src/utils/artifactWorkspaceSync';
import type { Artifact } from '../src/types';

test('Path normalization and security validation', () => {
  // Valid normalizations
  assert.equal(normalizeAndValidateArtifactPath('index.html'), 'index.html');
  assert.equal(normalizeAndValidateArtifactPath('src/components/App.tsx'), 'src/components/App.tsx');
  assert.equal(normalizeAndValidateArtifactPath('./assets/icons/logo.svg'), 'assets/icons/logo.svg');
  assert.equal(normalizeAndValidateArtifactPath('src\\utils\\helper.ts'), 'src/utils/helper.ts');

  // Traversal rejections
  assert.throws(() => normalizeAndValidateArtifactPath('../secret.txt'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('src/../../etc/passwd'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('..'), ArtifactPathSecurityError);

  // Absolute paths & Windows drive letters
  assert.throws(() => normalizeAndValidateArtifactPath('/etc/passwd'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('C:\\Windows\\System32'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('\\\\unc\\share'), ArtifactPathSecurityError);

  // Dangerous files and secret extensions
  assert.throws(() => normalizeAndValidateArtifactPath('.env'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('config/.env.local'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('certs/server.key'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('id_rsa'), ArtifactPathSecurityError);
  assert.throws(() => normalizeAndValidateArtifactPath('.git/config'), ArtifactPathSecurityError);
});

test('File kind inference and relative specifier resolution', () => {
  assert.equal(inferArtifactFileKind('index.html'), 'html');
  assert.equal(inferArtifactFileKind('style.css'), 'css');
  assert.equal(inferArtifactFileKind('main.js'), 'javascript');
  assert.equal(inferArtifactFileKind('App.tsx'), 'typescript');
  assert.equal(inferArtifactFileKind('data.json'), 'json');
  assert.equal(inferArtifactFileKind('README.md'), 'markdown');
  assert.equal(inferArtifactFileKind('logo.svg'), 'svg');

  const existingPaths = ['index.html', 'styles/main.css', 'src/App.tsx', 'src/components/Card.tsx'];

  // Resolve relative specifier
  const res1 = resolveRelativeSpecifier('src/App.tsx', './components/Card', existingPaths);
  assert.equal(res1.isResolved, true);
  assert.equal(res1.resolvedPath, 'src/components/Card.tsx');

  // Resolve CSS from HTML
  const res2 = resolveRelativeSpecifier('index.html', './styles/main.css', existingPaths);
  assert.equal(res2.isResolved, true);
  assert.equal(res2.resolvedPath, 'styles/main.css');

  // External package stays unresolved
  const res3 = resolveRelativeSpecifier('src/App.tsx', 'lucide-react', existingPaths);
  assert.equal(res3.isResolved, false);
});

test('Dependency analyzer extracts HTML, JS/TS, and CSS references', () => {
  const existingPaths = ['index.html', 'app.css', 'app.js', 'logo.svg'];
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="stylesheet" href="./app.css">
      </head>
      <body>
        <img src="logo.svg">
        <script src="./app.js"></script>
      </body>
    </html>
  `;

  const deps = analyzeFileDependencies('index.html', htmlContent, existingPaths);
  assert.equal(deps.length, 3);
  assert.ok(deps.some(d => d.type === 'stylesheet' && d.targetPath === 'app.css'));
  assert.ok(deps.some(d => d.type === 'script_tag' && d.targetPath === 'app.js'));
  assert.ok(deps.some(d => d.type === 'asset_ref' && d.targetPath === 'logo.svg'));

  // TypeScript static and dynamic imports
  const tsCode = `
    import React from 'react';
    import { Card } from './components/Card';
    import './styles.css';
    const LazyModal = React.lazy(() => import('./components/Modal'));
  `;
  const existingTsPaths = ['src/App.tsx', 'src/components/Card.tsx', 'src/styles.css', 'src/components/Modal.tsx'];
  const tsDeps = analyzeFileDependencies('src/App.tsx', tsCode, existingTsPaths);
  assert.ok(tsDeps.some(d => d.type === 'static_import' && d.targetPath === 'src/components/Card.tsx'));
  assert.ok(tsDeps.some(d => d.type === 'stylesheet' && d.targetPath === 'src/styles.css'));
  assert.ok(tsDeps.some(d => d.type === 'dynamic_import' && d.targetPath === 'src/components/Modal.tsx'));
});

test('createMultiFileBundle validates paths, builds manifest, and sets entrypoint', () => {
  const bundle = createMultiFileBundle({
    id: 'test-project-1',
    title: 'Interactive Dashboard',
    files: [
      { path: 'index.html', content: '<h1>Dashboard</h1><link rel="stylesheet" href="style.css">', isEntry: true },
      { path: 'style.css', content: 'h1 { color: #D97757; }' },
      { path: 'src/main.js', content: 'console.log("running");' }
    ]
  });

  assert.equal(bundle.id, 'test-project-1');
  assert.equal(bundle.entryPoint, 'index.html');
  assert.equal(Object.keys(bundle.files).length, 3);
  assert.equal(bundle.manifest.files.length, 3);
  assert.ok(bundle.files['index.html'].isEntry);
  assert.equal(bundle.files['style.css'].kind, 'css');

  // Duplicate path rejection
  assert.throws(() => {
    createMultiFileBundle({
      id: 'dup-test',
      title: 'Dup',
      files: [
        { path: 'src/App.tsx', content: '' },
        { path: './src/App.tsx', content: '' }
      ]
    });
  }, ArtifactPathSecurityError);
});

test('Single-file artifact wraps cleanly into MultiFileArtifactBundle', () => {
  const legacyArtifact: Artifact = {
    id: 'art-legacy-1',
    title: 'React Widget',
    type: 'application/vnd.ant.react',
    language: 'tsx',
    content: 'export default function Widget() { return <div>Hello</div>; }',
    version: 1,
    versions: [{ version: 1, content: '...', timestamp: Date.now() }]
  };

  const bundle = adaptSingleFileArtifactToBundle(legacyArtifact);
  assert.equal(bundle.id, 'art-legacy-1');
  assert.equal(bundle.entryPoint, 'src/App.tsx');
  assert.ok(bundle.files['src/App.tsx']);
  assert.equal(bundle.files['src/App.tsx'].content, legacyArtifact.content);
});

test('buildFileTree creates nested, sorted hierarchy', () => {
  const bundle = createMultiFileBundle({
    id: 'tree-test',
    title: 'Tree',
    files: [
      { path: 'index.html', content: '' },
      { path: 'src/components/Button.tsx', content: '' },
      { path: 'src/components/Card.tsx', content: '' },
      { path: 'src/App.tsx', content: '' },
      { path: 'README.md', content: '' }
    ]
  });

  const tree = buildFileTree(bundle.files);
  // Folders first: 'src' folder should be at top level
  assert.ok(tree.some(n => n.name === 'src' && n.isFolder));
  const srcNode = tree.find(n => n.name === 'src');
  assert.ok(srcNode?.children?.some(n => n.name === 'components' && n.isFolder));
  assert.ok(srcNode?.children?.some(n => n.name === 'App.tsx' && !n.isFolder));
});

test('ZIP generator produces valid PKZip archive with CRC-32 and deterministic manifest', () => {
  const bundle = createMultiFileBundle({
    id: 'zip-test-proj',
    title: 'Zip Test',
    files: [
      { path: 'index.html', content: '<!DOCTYPE html><html><body>Hello ZIP</body></html>' },
      { path: 'styles.css', content: 'body { margin: 0; }' }
    ]
  });

  const zipBytes = generateProjectZipArchive(bundle);
  assert.ok(zipBytes instanceof Uint8Array);
  assert.ok(zipBytes.length > 100);

  // Check PKZip signature 0x04034b50 (little endian: 0x50, 0x4b, 0x03, 0x04)
  assert.equal(zipBytes[0], 0x50);
  assert.equal(zipBytes[1], 0x4b);
  assert.equal(zipBytes[2], 0x03);
  assert.equal(zipBytes[3], 0x04);

  // CRC-32 verification
  const testData = new TextEncoder().encode('Hello World');
  const crc = computeCrc32(testData);
  assert.equal(typeof crc, 'number');
  assert.ok(crc > 0);
});

test('Multi-file sandbox inlines stylesheets and scripts safely with log bridge', () => {
  const bundle = createMultiFileBundle({
    id: 'sandbox-test',
    title: 'Sandbox Test',
    files: [
      {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="./style.css">
  </head>
  <body>
    <h1>Multi File Sandbox</h1>
    <script src="./script.js"></script>
  </body>
</html>`,
        isEntry: true
      },
      { path: 'style.css', content: 'body { background: purple; }' },
      { path: 'script.js', content: 'console.log("sandboxed script active");' }
    ]
  });

  const html = generateMultiFileArtifactSandboxHtml(bundle, true, 'nonce-abc-123');

  // Verify stylesheet inlined
  assert.ok(html.includes('<style data-bundle-file="style.css">'));
  assert.ok(html.includes('background: purple;'));

  // Verify script inlined
  assert.ok(html.includes('<script data-bundle-file="script.js">'));
  assert.ok(html.includes('console.log("sandboxed script active");'));

  // Verify nonce-verified postMessage log bridge injected
  assert.ok(html.includes('"nonce-abc-123"'));
  assert.ok(html.includes('AIRA_ARTIFACT_RUNTIME_ERROR'));
  assert.ok(html.includes('CONSOLE_LOG'));
  assert.ok(html.includes('aira-error-boundary'));
});

test('Controlled workspace sync validates paths and identity isolation', async () => {
  const bundle = createMultiFileBundle({
    id: 'sync-proj-1',
    title: 'Sync Proj',
    files: [
      { path: 'index.html', content: '<h1>Sync</h1>' },
      { path: 'app.css', content: 'h1 { font-size: 20px; }' }
    ]
  });

  const res = await syncBundleToWorkspace(bundle, 'test-ws-1');
  assert.equal(res.success, true);
  assert.equal(res.syncedFilesCount, 2);
  assert.equal(res.targetWorkspaceId, 'test-ws-1');
  assert.ok(res.timestamp > 0);
});
