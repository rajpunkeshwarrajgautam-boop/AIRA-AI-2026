import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { 
  extractArtifactsFromText, 
  createStreamingArtifactDetector, 
  normalizeArtifactType 
} from '../src/utils/artifactParser';
import { generateArtifactSandboxHtml } from '../src/utils/artifactSandbox';
import type { Artifact } from '../src/types';

test('Artifact Parser: normalizeArtifactType handles various type and language inputs', () => {
  assert.equal(normalizeArtifactType('application/vnd.ant.react'), 'application/vnd.ant.react');
  assert.equal(normalizeArtifactType('', 'tsx'), 'application/vnd.ant.react');
  assert.equal(normalizeArtifactType('image/svg+xml'), 'image/svg+xml');
  assert.equal(normalizeArtifactType('', 'svg'), 'image/svg+xml');
  assert.equal(normalizeArtifactType('application/vnd.ant.mermaid'), 'application/vnd.ant.mermaid');
  assert.equal(normalizeArtifactType('', 'mermaid'), 'application/vnd.ant.mermaid');
  assert.equal(normalizeArtifactType('text/html'), 'text/html');
  assert.equal(normalizeArtifactType('', 'html'), 'text/html');
  assert.equal(normalizeArtifactType('text/markdown'), 'text/markdown');
  assert.equal(normalizeArtifactType('', 'md'), 'text/markdown');
  assert.equal(normalizeArtifactType('unknown', 'py'), 'application/vnd.ant.code');
});

test('Artifact Parser: extractArtifactsFromText extracts Claude <antArtifact> tags', () => {
  const rawText = `Here is an interactive financial dashboard:

<antArtifact identifier="financial-dashboard" type="application/vnd.ant.react" title="Financial Dashboard">
import React from 'react';
export default function Dashboard() {
  return <div className="p-4 bg-white">Revenue: $120,000</div>;
}
</antArtifact>

Let me know if you would like any modifications.`;

  const { cleanedText, artifacts } = extractArtifactsFromText(rawText);

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].id, 'financial-dashboard');
  assert.equal(artifacts[0].title, 'Financial Dashboard');
  assert.equal(artifacts[0].type, 'application/vnd.ant.react');
  assert.match(artifacts[0].content, /export default function Dashboard/);
  assert.equal(artifacts[0].version, 1);

  // Cleaned text should not contain the XML tag
  assert.ok(!cleanedText.includes('<antArtifact'));
  assert.ok(!cleanedText.includes('</antArtifact>'));
  assert.ok(cleanedText.includes('Here is an interactive financial dashboard:'));
  assert.ok(cleanedText.includes('Let me know if you would like any modifications.'));
});

test('Artifact Parser: extractArtifactsFromText extracts Aira <airaArtifact> tags', () => {
  const rawText = `System Architecture Diagram:

<airaArtifact identifier="arch-diagram" type="application/vnd.ant.mermaid" title="System Architecture">
graph TD
  A[Client] --> B[API Gateway]
  B --> C[PostgreSQL]
</airaArtifact>`;

  const { cleanedText, artifacts } = extractArtifactsFromText(rawText);

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].id, 'arch-diagram');
  assert.equal(artifacts[0].type, 'application/vnd.ant.mermaid');
  assert.match(artifacts[0].content, /graph TD/);
  assert.ok(!cleanedText.includes('<airaArtifact'));
});

test('Artifact Parser: streaming detector buffers, emits clean text, and extracts artifact live', () => {
  let startedArtifact: Artifact | null = null;
  const detector = createStreamingArtifactDetector(artifact => {
    startedArtifact = artifact;
  });

  const chunk1 = 'I will create a counter component for you.\n\n<antArtifact identifier="counter-app" type="application/vnd.ant.react" title="Counter App">\n';
  const chunk2 = 'import React, { useState } from "react";\n';
  const chunk3 = 'export default function Counter() { return <button>Click</button>; }\n';
  const chunk4 = '</antArtifact>\n\nHope this helps!';

  const res1 = detector.processChunk(chunk1);
  assert.ok(startedArtifact !== null);
  assert.equal((startedArtifact as Artifact).id, 'counter-app');
  assert.equal(res1.textToEmit.trim(), 'I will create a counter component for you.');

  const res2 = detector.processChunk(chunk2);
  assert.equal(res2.textToEmit, '');
  assert.ok(res2.artifactUpdate !== undefined);
  assert.match(res2.artifactUpdate.content, /import React/);

  const res3 = detector.processChunk(chunk3);
  assert.match(res3.artifactUpdate?.content || '', /export default function Counter/);

  const res4 = detector.processChunk(chunk4);
  assert.ok(res4.artifactUpdate !== undefined);
  assert.ok(res4.textToEmit.includes('Hope this helps!'));

  const flushRes = detector.flush();
  assert.equal(flushRes.remainingText, '');
});

test('Artifact Sandbox: generateArtifactSandboxHtml produces correct runtime document for React', () => {
  const artifact: Artifact = {
    id: 'test-react',
    title: 'Test React App',
    type: 'application/vnd.ant.react',
    content: 'export default function App() { return <div>Hello World</div>; }',
    version: 1,
    versions: [],
  };

  const html = generateArtifactSandboxHtml(artifact, artifact.content, false);

  assert.ok(html.includes('react.production.min.js'));
  assert.ok(html.includes('react-dom.production.min.js'));
  assert.ok(html.includes('babel.min.js'));
  assert.ok(html.includes('cdn.tailwindcss.com'));
  assert.ok(html.includes('aira-error-boundary'));
  assert.ok(html.includes('CONSOLE_LOG'));
  assert.ok(html.includes('root.render'));
});

test('Artifact Sandbox: generateArtifactSandboxHtml produces correct runtime document for Mermaid', () => {
  const artifact: Artifact = {
    id: 'test-mermaid',
    title: 'Architecture Chart',
    type: 'application/vnd.ant.mermaid',
    content: 'graph LR; A-->B;',
    version: 1,
    versions: [],
  };

  const html = generateArtifactSandboxHtml(artifact, artifact.content, true);

  assert.ok(html.includes('mermaid.min.js'));
  assert.ok(html.includes("theme: 'dark'"));
  assert.ok(html.includes('aira-mermaid-svg'));
  assert.ok(html.includes('CONSOLE_LOG'));
});

test('Artifact Sandbox: generateArtifactSandboxHtml produces correct runtime document for SVG', () => {
  const artifact: Artifact = {
    id: 'test-svg',
    title: 'App Logo',
    type: 'image/svg+xml',
    content: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#D97757"/></svg>',
    version: 1,
    versions: [],
  };

  const html = generateArtifactSandboxHtml(artifact, artifact.content, false);

  assert.ok(html.includes('<svg viewBox="0 0 100 100">'));
  assert.ok(html.includes('#FAF9F5'));
  assert.ok(html.includes('radial-gradient'));
});

test('Artifact Sandbox: generateArtifactSandboxHtml produces correct runtime document for Markdown', () => {
  const artifact: Artifact = {
    id: 'test-md',
    title: 'Technical Specification',
    type: 'text/markdown',
    content: '# Project Spec\n\n- Feature 1\n- Feature 2',
    version: 1,
    versions: [],
  };

  const html = generateArtifactSandboxHtml(artifact, artifact.content, false);

  assert.ok(html.includes('marked.min.js'));
  assert.ok(html.includes('Newsreader'));
  assert.ok(html.includes('prose-doc'));
});

test('Zero-Emoji Policy: Artifact Studio M1 code and templates contain zero emojis', () => {
  const filesToCheck = [
    'src/utils/artifactParser.ts',
    'src/utils/artifactSandbox.ts',
    'src/components/ArtifactStudio.tsx',
    'src/components/ArtifactCard.tsx'
  ];

  // Regex detecting unicode emojis
  const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;

  for (const relativePath of filesToCheck) {
    const fullPath = path.resolve(process.cwd(), relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const hasEmoji = emojiRegex.test(content);
    assert.equal(hasEmoji, false, `File ${relativePath} violated zero-emoji policy`);
  }
});
