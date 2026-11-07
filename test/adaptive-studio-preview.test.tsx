import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdaptiveStudioEmptyState } from '../src/components/AdaptiveStudioEmptyState';

test('Adaptive Studio is opt-in and legacy mode remains the default', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /import\.meta\.env\.VITE_ADAPTIVE_STUDIO_PREVIEW === 'true'/);
  assert.match(appSource, /ADAPTIVE_STUDIO_PREVIEW && !activeArtifact && \(\s*<AdaptiveStudioEmptyState/);
  assert.match(appSource, /activeArtifact &&\s*\(?\s*<ArtifactStudio\s+artifact=\{activeArtifact\}\s+adaptiveDock=\{ADAPTIVE_STUDIO_PREVIEW\}/);
  const artifactSource = readFileSync(new URL('../src/components/ArtifactStudio.tsx', import.meta.url), 'utf8');
  assert.match(artifactSource, /adaptiveDock = false/);
  assert.match(artifactSource, /adaptiveDock && !isExpanded/);
  assert.match(artifactSource, /generateArtifactSandboxHtml\(artifact, currentContent, isDark, activeNonce\)/);
});

test('Adaptive Studio empty state does not pretend to execute an artifact', () => {
  const html = renderToStaticMarkup(React.createElement(AdaptiveStudioEmptyState));
  assert.match(html, /aria-label="Artifact Studio"/);
  assert.match(html, /Your next creation starts here/);
  assert.match(html, /real preview will appear/);
  assert.match(html, /existing isolated preview runtime/);
  assert.doesNotMatch(html, /<iframe|<canvas|Create an interactive solar system/);
});
