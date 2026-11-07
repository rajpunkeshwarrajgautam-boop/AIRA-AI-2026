import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceFileExplorer } from '../src/components/WorkspaceFileExplorer';
import { createMultiFileBundle } from '../src/utils/artifactBundleEngine';

test('WorkspaceFileExplorer renders file tree with entrypoint badge and file counts', () => {
  const bundle = createMultiFileBundle({
    id: 'test-bundle-explorer',
    title: 'Interactive Project',
    files: [
      { path: 'index.html', content: '<h1>Home</h1>', isEntry: true },
      { path: 'src/styles.css', content: 'body { margin: 0; }' },
      { path: 'src/components/Card.tsx', content: 'export const Card = () => <div>Card</div>;' },
      { path: 'README.md', content: '# Project Docs' }
    ]
  });

  const html = renderToStaticMarkup(
    React.createElement(WorkspaceFileExplorer, {
      bundle,
      activeFilePath: 'index.html',
      onSelectFile: () => {},
      onExportZip: () => {},
      onSyncWorkspace: () => {},
    })
  );

  // Verifications
  assert.match(html, /data-testid="workspace-file-explorer"/);
  assert.match(html, /Workspace Files/);
  assert.match(html, />4<\/span>/, 'Should display total file count badge (4)');
  assert.match(html, /data-testid="export-zip-btn"/);
  assert.match(html, /data-testid="sync-workspace-btn"/);
  assert.match(html, /data-testid="file-search-input"/);
  assert.match(html, /data-testid="file-item-index\.html"/);
  assert.match(html, /Entry/, 'Entrypoint file should have Entry badge');
  assert.match(html, /data-testid="toggle-dependency-panel"/);
});

test('WorkspaceFileExplorer dependency summary shows outgoing and inbound counts', () => {
  const bundle = createMultiFileBundle({
    id: 'dep-test-bundle',
    title: 'Dependencies Project',
    files: [
      { path: 'index.html', content: '<link rel="stylesheet" href="styles.css"><script src="app.js"></script>', isEntry: true },
      { path: 'styles.css', content: 'h1 { color: red; }' },
      { path: 'app.js', content: 'console.log("ready");' }
    ]
  });

  const html = renderToStaticMarkup(
    React.createElement(WorkspaceFileExplorer, {
      bundle,
      activeFilePath: 'index.html',
      onSelectFile: () => {},
    })
  );

  // index.html has 2 outgoing dependencies (styles.css and app.js)
  assert.match(html, /2 out \/ 0 in/);
});

test('WorkspaceFileExplorer renders active file indicator properly', () => {
  const bundle = createMultiFileBundle({
    id: 'active-test-bundle',
    title: 'Active Test',
    files: [
      { path: 'index.html', content: '<h1>Home</h1>' },
      { path: 'styles.css', content: 'body {}' }
    ]
  });

  const html = renderToStaticMarkup(
    React.createElement(WorkspaceFileExplorer, {
      bundle,
      activeFilePath: 'styles.css',
      onSelectFile: () => {},
    })
  );

  // styles.css should be aria-selected=true
  assert.match(html, /aria-selected="true"[^>]*data-testid="file-item-styles\.css"/);
  assert.match(html, /aria-selected="false"[^>]*data-testid="file-item-index\.html"/);
});
