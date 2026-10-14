import assert from 'node:assert/strict';
import { selectExecutableTool } from '../packages/agent-runtime/src/tool-selector.js';

const select = (prompt: string, intent: 'TOOL_ACTION' | 'AGENT_MISSION' = 'TOOL_ACTION') =>
  selectExecutableTool(prompt, intent);

assert.deepEqual(
  select('Open https://example.org/ and extract the page heading'),
  { ok: true, name: 'browser_navigate', args: { url: 'https://example.org/' } }
);
assert.deepEqual(
  select('Capture screenshot of https://example.org/path.'),
  { ok: true, name: 'browser_screenshot', args: { url: 'https://example.org/path' } }
);
assert.deepEqual(
  select('Calculate 23 * 7'),
  { ok: true, name: 'calculator', args: { expression: '23 * 7' } }
);
assert.deepEqual(
  select('Read src/App.tsx'),
  { ok: true, name: 'file_system_read', args: { filePath: 'src/App.tsx' } }
);
assert.deepEqual(
  select('Check git status'),
  { ok: true, name: 'repo_git_status', args: {} }
);
assert.deepEqual(
  select('Show the last 8 commits'),
  { ok: true, name: 'repo_git_log', args: { count: 8 } }
);
assert.deepEqual(
  select('Search the web for solid state batteries'),
  { ok: true, name: 'web_search', args: { query: 'Search the web for solid state batteries' } }
);
assert.deepEqual(
  select('Run command: npm test'),
  { ok: true, name: 'system_shell', args: { command: 'npm test' } }
);

const ambiguous = [
  'Fill the form',
  'Calculate it',
  'Inspect the repository',
  'Do everything',
  'Run shell command',
  'Read the file',
  'Open the website',
];
for (const prompt of ambiguous) {
  const result = select(prompt);
  assert.equal(result.ok, false, `Must not invent a tool target for: ${prompt}`);
}
assert.equal(select('Fill the form').ok, false, 'Never autofill with synthetic sample values');
assert.equal(select('Calculate this').ok, false, 'Never run fallback sample arithmetic');
assert.equal(select('Inspect the repo', 'AGENT_MISSION').ok, false, 'Never pretend to inspect an arbitrary file');
const mission = select('Investigate the build failure, fix the code, and deploy it', 'AGENT_MISSION');
assert.equal(mission.ok, false, 'One tool execution is not a completed multi-step mission');
if (!mission.ok) assert.equal(mission.code, 'MISSION_EXECUTOR_NOT_READY');

const desktop = select('Use computer use to click my desktop');
assert.equal(desktop.ok, false);
if (!desktop.ok) assert.equal(desktop.code, 'COMPUTER_USE_NOT_AVAILABLE');

console.log('PASS: 8 grounded selections, ambiguous-target guards and multi-step mission rejection');
