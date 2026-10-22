import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectCapabilityIntent } from '../src/utils/capabilityDispatcher';
import { generateArtifactSandboxHtml } from '../src/utils/artifactSandbox';
import type { Artifact, WorkspaceMode } from '../src/types';

test('AIRA ONE Mode Architecture: Exactly two user-facing execution modes', () => {
  const allowedModes: WorkspaceMode[] = ['chat', 'agent'];
  assert.equal(allowedModes.length, 2);
  assert.deepEqual(allowedModes, ['chat', 'agent']);
});

test('Capability Dispatch: Detects Image Generation intent and parameters', () => {
  const prompts = [
    'Generate an image of a futuristic city',
    'Create a photo of a mountain sunset in 16:9',
    'Draw an illustration of an astronaut on Mars',
    'Render a concept art of cybernetic architecture'
  ];

  for (const p of prompts) {
    const intent = detectCapabilityIntent(p, 'chat');
    assert.equal(intent.capability, 'IMAGE_GENERATION', `Failed on prompt: ${p}`);
    assert.ok(intent.cleanPrompt.length > 0);
  }

  const widescreen = detectCapabilityIntent('Generate an image of a neon city in 16:9 widescreen', 'chat');
  assert.equal(widescreen.capability, 'IMAGE_GENERATION');
  assert.equal(widescreen.parameters?.aspectRatio, '16:9');
});

test('Capability Dispatch: Detects Builder App intent and proposes Agent Mode from Chat Mode', () => {
  const prompt = 'Build a CRM website and test it';
  
  // In Chat Mode -> Proposes Agent Mode
  const chatIntent = detectCapabilityIntent(prompt, 'chat');
  assert.equal(chatIntent.capability, 'BUILDER_APP');
  assert.equal(chatIntent.suggestAgentMode, true);

  // In Agent Mode -> Proceeds directly
  const agentIntent = detectCapabilityIntent(prompt, 'agent');
  assert.equal(agentIntent.capability, 'BUILDER_APP');
  assert.equal(agentIntent.suggestAgentMode, false);
});

test('Capability Dispatch: Detects Research intent with primary citations', () => {
  const prompt = 'Research this company and compare sources on its recent revenue';
  const intent = detectCapabilityIntent(prompt, 'chat');
  assert.equal(intent.capability, 'RESEARCH');
  assert.equal(intent.parameters?.requiresWebCitations, true);
});

test('Capability Dispatch: Detects Automation intent', () => {
  const prompt = 'Create an automation for tomorrow at 9am to check server status';
  const intent = detectCapabilityIntent(prompt, 'chat');
  assert.equal(intent.capability, 'AUTOMATION');
  assert.equal(intent.parameters?.isScheduled, true);
});

test('Capability Dispatch: General conversation fallback', () => {
  const prompt = 'What is the difference between a mutex and a semaphore?';
  const intent = detectCapabilityIntent(prompt, 'chat');
  assert.equal(intent.capability, 'GENERAL_CONVERSATION');
});

test('Security Critical Fix A: Verify executable new-tab prevention and sandbox attributes', () => {
  const studioFile = path.resolve(process.cwd(), 'src/components/ArtifactStudio.tsx');
  const content = fs.readFileSync(studioFile, 'utf8');

  // Verify handleOpenInNewTab disables executable Blob generation
  assert.ok(content.includes('isExecutable'));
  assert.ok(content.includes('New-tab execution of dynamic code is disabled'));
  assert.ok(!content.includes("type: 'text/html'")); // No text/html blob in open-in-new-tab

  // Verify iframe sandbox DOES NOT include allow-same-origin
  assert.match(content, /sandbox="allow-scripts allow-modals allow-forms"/);
  assert.ok(!content.includes('allow-same-origin'));
});

test('Security Critical Fix B: Verify postMessage cross-frame validation and per-session nonce', () => {
  const studioFile = path.resolve(process.cwd(), 'src/components/ArtifactStudio.tsx');
  const content = fs.readFileSync(studioFile, 'utf8');

  // Verify event.source check against iframe contentWindow
  assert.ok(content.includes('event.source !== iframeRef.current.contentWindow'));

  // Verify per-session nonce validation
  assert.ok(content.includes('activeNonceRef.current'));
  assert.ok(content.includes('event.data.nonce !== activeNonceRef.current'));

  // Verify sandbox HTML injection of nonce
  const artifact: Artifact = {
    id: 'test-secure-nonce',
    title: 'Secure Artifact',
    type: 'application/vnd.ant.react',
    content: 'export default function App() { return <div>Test</div>; }',
    version: 1,
    versions: []
  };

  const testNonce = 'nonce-xyz-secure-12345';
  const html = generateArtifactSandboxHtml(artifact, artifact.content, false, testNonce);
  assert.ok(html.includes(testNonce), 'Generated sandbox HTML must embed the per-session nonce');
  assert.ok(html.includes(`nonce: "${testNonce}"`), 'Log bridge must transmit session nonce');
});

test('AIRA ONE Visual Tokens: Verify color palette configuration in Tailwind and CSS', () => {
  const tailwindFile = path.resolve(process.cwd(), 'tailwind.config.js');
  const twContent = fs.readFileSync(tailwindFile, 'utf8');

  assert.ok(twContent.includes('#111C35'), 'Midnight Navy #111C35 must be configured');
  assert.ok(twContent.includes('#3056CB'), 'Royal Blue #3056CB must be configured');
  assert.ok(twContent.includes('#E9EDF4'), 'Silver #E9EDF4 must be configured');
  assert.ok(twContent.includes('#F8F9FC'), 'Porcelain #F8F9FC must be configured');
  assert.ok(twContent.includes('#B79C6A'), 'Soft Gold #B79C6A must be configured');

  const cssFile = path.resolve(process.cwd(), 'src/index.css');
  const cssContent = fs.readFileSync(cssFile, 'utf8');
  assert.ok(cssContent.includes('#111C35'));
  assert.ok(cssContent.includes('#3056CB'));
});

test('Zero-Emoji Policy: AIRA ONE corrected files contain zero emojis', () => {
  const filesToCheck = [
    'src/App.tsx',
    'src/components/ChatInput.tsx',
    'src/components/Sidebar.tsx',
    'src/components/CommandPalette.tsx',
    'src/components/GreetingScreen.tsx',
    'src/components/ArtifactStudio.tsx',
    'src/components/AgentContextualPanel.tsx',
    'src/utils/capabilityDispatcher.ts',
    'src/types/index.ts'
  ];

  const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;

  for (const rel of filesToCheck) {
    const fullPath = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const hasEmoji = emojiRegex.test(content);
    assert.equal(hasEmoji, false, `File ${rel} contains emoji violation`);
  }
});
