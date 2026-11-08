import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/utils/constants';

const read = (name: string) => readFileSync(resolve(process.cwd(), name), 'utf8');
const tokens = read('src/index.css');
const darkPalette = tokens.match(/  \.dark \{([\s\S]*?)\n  \}/)?.[1] || '';
const lightPalette = tokens.match(/  :root \{([\s\S]*?)\n  \}/)?.[1] || '';

test('Claude reference light and dark palettes match DESIGN.md', () => {
  for (const [name, value] of Object.entries({
    '--bg-main': '#FAF9F5',
    '--bg-surface': '#F5F0E8',
    '--bg-surface-secondary': '#EFE9DE',
    '--text-primary': '#141413',
    '--border-color': '#E6DFD8',
    '--accent-terracotta': '#CC785C',
  })) {
    assert.ok(lightPalette.includes(`${name}: ${value};`), `Missing light token ${name}`);
  }
  for (const [name, value] of Object.entries({
    '--bg-main': '#181715',
    '--bg-surface': '#252320',
    '--text-primary': '#FAF9F5',
    '--accent-terracotta': '#CC785C',
  })) {
    assert.ok(darkPalette.includes(`${name}: ${value};`), `Missing dark token ${name}`);
  }
  assert.equal(DEFAULT_SETTINGS.theme, 'light', 'New visitors receive the light editorial canvas');
});

test('Product typography has serif display, humanist sans and mono code fallbacks', () => {
  const tailwind = read('tailwind.config.js');
  assert.match(tailwind, /serif: \['Copernicus', 'Tiempos Headline', 'Cormorant Garamond'/);
  assert.match(tailwind, /sans: \['StyreneB', 'Inter'/);
  assert.match(tailwind, /mono: \['JetBrains Mono'/);
  assert.match(read('index.html'), /family=Cormorant\+Garamond/);
  assert.match(read('index.html'), /family=Inter/);
});

test('Shared shell, greeting, sidebar, composer and contextual studio use editorial surfaces', () => {
  const app = read('src/App.tsx');
  const sidebar = read('src/components/Sidebar.tsx');
  const composer = read('src/components/ChatInput.tsx');
  const greeting = read('src/components/GreetingScreen.tsx');
  const workspace = read('src/components/UnifiedWorkspace.tsx');
  const responsive = read('src/styles/adaptiveStudio.css');

  assert.match(app, /aira-editorial-app/);
  assert.match(app, /aira-editorial-header/);
  assert.match(sidebar, /aira-sidebar-shell/);
  assert.match(sidebar, /bg-claude-terracotta-hover/);
  assert.match(composer, /aira-composer-card/);
  assert.match(greeting, /aira-editorial-greeting/);
  assert.match(greeting, /font-serif font-normal/);
  assert.match(workspace, /data-testid="unified-workspace"/);
  assert.match(responsive, /--adaptive-surface: var\(--bg-main\)/);
  assert.doesNotMatch(responsive, /#305ee5/i, 'Adaptive workspace may not retain the obsolete blue');
});

test('Sidebar follows each aesthetic preset and Light/Dark mode', () => {
  const sidebar = read('src/components/Sidebar.tsx');
  const responsive = read('src/styles/adaptiveStudio.css');
  assert.match(tokens, /\.aira-editorial-app \.aira-sidebar-shell \{\s*background-color: var\(--bg-surface-secondary\)/);
  assert.match(tokens, /\.aira-editorial-app \.aira-sidebar-footer \{\s*background-color: var\(--bg-surface-secondary\)/);
  assert.match(responsive, /--adaptive-rail: var\(--bg-surface-secondary\)/);
  assert.match(sidebar, /bg-claude-terracotta-hover/);
  assert.match(sidebar, /text-claude-onAccent/);
  assert.doesNotMatch(sidebar, /#a9583e|#94452e/i, 'Sidebar accents must not be hardcoded to the default preset');
  for (const preset of ['warm-parchment', 'liquid-glass', 'industrial-brutalist', 'nordic-moss', 'solar-gold', 'tokyo-neon', 'vanguard-monolith']) {
    const selectorIndex = tokens.indexOf(`[data-theme="${preset}"]`);
    const blockStart = tokens.indexOf('{', selectorIndex);
    const block = selectorIndex < 0 ? '' : tokens.slice(blockStart, tokens.indexOf('}', blockStart));
    assert.match(block || '', /--bg-surface-secondary:/, `${preset} must provide its own sidebar surface`);
  }
});

test('Aira Atelier retains the existing preset ID and updates user-facing text', () => {
  const settings = read('src/components/SettingsModal.tsx');
  assert.match(settings, /id: 'linear-precision',\s*name: 'Aira Atelier'/);
  assert.doesNotMatch(settings, /Claude Editorial/);
  assert.match(read('src/components/HelpCenterModal.tsx'), /Choose from Aira Atelier/);
});

test('Greeting removes suggestion cards while keeping mode-specific copy and recent history', () => {
  const greeting = read('src/components/GreetingScreen.tsx');
  const app = read('src/App.tsx');
  assert.doesNotMatch(greeting, /dynamicStarters|PromptCard|grid-flow-dense|onSelectStarter/);
  assert.doesNotMatch(app, /onSelectStarter=/);
  assert.match(greeting, /Autonomous Agent Mission/);
  assert.match(greeting, /Continue:/);
});

test('Visual refactor keeps AIRA identity and existing interaction contracts', () => {
  const app = read('src/App.tsx');
  const composer = read('src/components/ChatInput.tsx');
  const sidebar = read('src/components/Sidebar.tsx');
  const workspace = read('src/components/UnifiedWorkspace.tsx');

  assert.match(sidebar, /<AiraMark size="md"/);
  assert.match(composer, /onWorkspaceModeChange\('chat'\)/);
  assert.match(composer, /onWorkspaceModeChange\('agent'\)/);
  assert.match(composer, /onSendMessage\(finalPrompt, attachments\)/);
  assert.match(app, /onDeleteChat=\{handleDeleteChat\}/);
  assert.match(app, /onOpenSettings=\{handleOpenSettings\}/);
  assert.match(app, /if \(!activeConversation\?\.messages\.length\) \{\s*scrollRegion\.scrollTo\(\{ top: 0/, 'Welcome screen must start at the top rather than auto-scrolling behind the header');
  assert.match(workspace, /builderPreviewUrl/);
  assert.match(workspace, /builderSteps/);
  assert.match(workspace, /onApproveTask/);
  assert.match(workspace, /sandboxProvider/);
});
