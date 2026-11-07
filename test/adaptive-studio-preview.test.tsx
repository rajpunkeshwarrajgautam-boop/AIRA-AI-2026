import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdaptiveStudioEmptyState } from '../src/components/AdaptiveStudioEmptyState';

test('Adaptive Studio opens on-demand and remains closed by default on initial visit', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /import\.meta\.env\.VITE_ADAPTIVE_STUDIO_PREVIEW === 'true'/);

  // Default state: studio closed
  assert.match(appSource, /const \[isStudioOpen, setIsStudioOpen\] = useState\(false\);/);

  // Unified Contextual Workspace only mounts when studio is explicitly open
  assert.match(appSource, /isStudioOpen && \(\s*<UnifiedWorkspace/);

  // Launcher button present with accessibility and testid
  assert.match(appSource, /data-testid="artifact-studio-launcher"/);
  assert.match(appSource, /title=\{isStudioOpen \? 'Close Artifact Studio' : 'Open Artifact Studio'\}/);

  // Escape key support
  assert.match(appSource, /e\.key === 'Escape'/);

  const artifactSource = readFileSync(new URL('../src/components/ArtifactStudio.tsx', import.meta.url), 'utf8');
  assert.match(artifactSource, /adaptiveDock = false/);
  assert.match(artifactSource, /adaptiveDock && !isExpanded/);
  assert.match(artifactSource, /generateArtifactSandboxHtml\(artifact, currentContent, isDark, activeNonce\)/);
});

test('Adaptive Studio empty state supports clean dismissal and safe preview hints', () => {
  let closed = false;
  const html = renderToStaticMarkup(
    React.createElement(AdaptiveStudioEmptyState, {
      onClose: () => {
        closed = true;
      },
    })
  );

  assert.match(html, /aria-label="Artifact Studio"/);
  assert.match(html, /data-testid="adaptive-studio-close"/);
  assert.match(html, /Your next creation starts here/);
  assert.match(html, /real preview will appear/);
  assert.match(html, /existing isolated preview runtime/);
  assert.doesNotMatch(html, /<iframe|<canvas|Create an interactive solar system/);
});
