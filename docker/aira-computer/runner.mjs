import express from 'express';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';

const app = express();
app.use(express.json({ limit: '1mb' }));
const PORT = 7777;
const DATA_ROOT = '/data';
const PROFILE_ROOT = path.join(DATA_ROOT, 'profile');
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TERMINAL_BYTES = 128 * 1024;
const MAX_FILES = 200;
const token = process.env.AIRA_RUNNER_TOKEN || '';
const allowedPrograms = Array.from(new Set((process.env.AIRA_COMPUTER_PROGRAMS || 'node,npm,npx,python3,git').split(',').map(v => path.basename(v.trim()).toLowerCase()).filter(Boolean))).sort();
let context;
let page;
let lastView;

function fail(res, status, error) { res.status(status).json({ error }); }
function requireAuth(req, res, next) {
  if (!token || req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, 'Unauthorized runner request.');
  next();
}
app.use(requireAuth);

function botKey(raw) {
  const value = String(raw || '');
  if (!/^[a-f0-9]{24,64}$/.test(value)) throw new Error('Invalid bot workspace key.');
  return value;
}
function botRoot(raw) { return path.join(DATA_ROOT, 'bots', botKey(raw)); }

function privateIp(address) {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('ff') || lower.startsWith('2001:db8')) return true;
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? privateIp(mapped) : false;
  }
  return true;
}

async function publicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Browser URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser only allows http and https URLs.');
  if (url.username || url.password) throw new Error('Browser URLs cannot contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Loopback browser navigation is blocked.');
  if (isIP(host)) {
    if (privateIp(host)) throw new Error('Private or reserved network targets are blocked.');
  } else {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => privateIp(entry.address))) throw new Error('Private or reserved network targets are blocked.');
  }
  return url;
}

async function ensureBrowser() {
  if (context && page && !page.isClosed()) return;
  await fs.mkdir(PROFILE_ROOT, { recursive: true, mode: 0o700 });
  context = await chromium.launchPersistentContext(PROFILE_ROOT, {
    headless: true,
    viewport: { width: 1365, height: 768 },
    args: ['--disable-dev-shm-usage']
  });
  await context.route('**/*', async route => {
    const raw = route.request().url();
    if (!/^https?:/i.test(raw)) return route.continue();
    try { await publicUrl(raw); return route.continue(); }
    catch { return route.abort('blockedbyclient'); }
  });
  page = context.pages()[0] || await context.newPage();
}

async function ensureBotRoot(raw) {
  const root = botRoot(raw);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function safeTarget(root, relativePath, forWrite = false) {
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.includes('\0') || path.posix.isAbsolute(clean) || clean.split('/').some(part => part === '..' || part === '')) throw new Error('Workspace path is invalid.');
  const target = path.resolve(root, ...clean.split('/'));
  if (!target.startsWith(root + path.sep)) throw new Error('Workspace path escapes the bot workspace.');
  let cursor = root;
  for (const part of clean.split('/').slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Symlink traversal is not allowed in bot workspaces.');
      if (!stat.isDirectory()) throw new Error('Workspace parent path is not a directory.');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      if (!forWrite) throw new Error('Workspace path does not exist.');
      await fs.mkdir(cursor, { mode: 0o700 });
    }
  }
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error('Symlink access is not allowed in bot workspaces.');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    if (!forWrite) throw new Error('Workspace file does not exist.');
  }
  return target;
}

async function capture(rawBotKey, action) {
  await ensureBrowser();
  const root = await ensureBotRoot(rawBotKey);
  const [title, text, links] = await Promise.all([
    page.title(),
    page.locator('body').innerText({ timeout: 5000 }).catch(() => ''),
    page.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 40).map(node => ({ text: (node.textContent || '').trim().slice(0, 160), href: node.href }))).catch(() => [])
  ]);
  const screenshotDir = path.join(root, 'screenshots');
  await fs.mkdir(screenshotDir, { recursive: true, mode: 0o700 });
  const screenshotPath = 'screenshots/latest.png';
  await page.screenshot({ path: path.join(root, screenshotPath), fullPage: false });
  lastView = {
    action,
    url: page.url(),
    title: title.slice(0, 500),
    text: text.slice(0, MAX_TEXT_BYTES),
    links: links.filter(link => /^https?:/i.test(link.href)).slice(0, 30),
    screenshotPath
  };
  return lastView;
}

app.get('/health', (_req, res) => res.json({ ok: true, browser: Boolean(context), allowedPrograms }));
app.get('/status', (_req, res) => res.json({ browser: { state: context ? 'RUNNING' : 'STOPPED', url: lastView?.url, title: lastView?.title, lastScreenshotPath: lastView?.screenshotPath }, terminal: { enabled: true, allowedPrograms } }));
app.post('/browser/start', async (_req, res) => { try { await ensureBrowser(); res.json({ ok: true }); } catch (err) { fail(res, 500, err.message); } });
app.post('/browser/stop', async (_req, res) => {
  try {
    const current = context;
    context = undefined; page = undefined; lastView = undefined;
    if (current) await current.close();
    res.json({ ok: true });
  } catch (err) { fail(res, 500, err.message); }
});
app.post('/browser/open', async (req, res) => {
  try { const url = await publicUrl(req.body?.url); await ensureBrowser(); await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 25000 }); res.json(await capture(req.body?.botKey, 'open')); }
  catch (err) { fail(res, 400, err.message); }
});
app.post('/browser/click', async (req, res) => {
  try { await ensureBrowser(); const selector = String(req.body?.selector || '').slice(0, 512); if (!selector) throw new Error('A selector is required.'); await page.locator(selector).first().click({ timeout: 10000 }); res.json(await capture(req.body?.botKey, 'click')); }
  catch (err) { fail(res, 400, err.message); }
});
app.post('/browser/type', async (req, res) => {
  try {
    await ensureBrowser(); const selector = String(req.body?.selector || '').slice(0, 512); const text = String(req.body?.text ?? '').slice(0, 16000); if (!selector) throw new Error('A selector is required.');
    const locator = page.locator(selector).first(); await locator.fill(text, { timeout: 10000 }); if (req.body?.submit === true) await locator.press('Enter'); res.json(await capture(req.body?.botKey, 'type'));
  } catch (err) { fail(res, 400, err.message); }
});
app.post('/browser/scroll', async (req, res) => {
  try { await ensureBrowser(); const deltaY = Math.max(-5000, Math.min(5000, Number(req.body?.deltaY) || 0)); await page.mouse.wheel(0, deltaY); res.json(await capture(req.body?.botKey, 'scroll')); }
  catch (err) { fail(res, 400, err.message); }
});
app.post('/browser/wait', async (req, res) => {
  try { await ensureBrowser(); const selector = String(req.body?.selector || '').slice(0, 512); if (!selector) throw new Error('A selector is required.'); const timeoutMs = Math.max(100, Math.min(15000, Number(req.body?.timeoutMs) || 5000)); await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs }); res.json(await capture(req.body?.botKey, 'wait')); }
  catch (err) { fail(res, 400, err.message); }
});
app.post('/browser/screenshot', async (req, res) => { try { res.json(await capture(req.body?.botKey, 'screenshot')); } catch (err) { fail(res, 400, err.message); } });

app.get('/files', async (req, res) => {
  try {
    const root = await ensureBotRoot(req.query.botKey); const output = [];
    const walk = async (dir, prefix = '') => {
      if (output.length >= MAX_FILES) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (output.length >= MAX_FILES) break;
        const absolute = path.join(dir, entry.name); const relative = path.posix.join(prefix, entry.name); const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) continue;
        output.push({ path: relative, type: stat.isDirectory() ? 'directory' : 'file', sizeBytes: stat.size, updatedAt: stat.mtimeMs });
        if (stat.isDirectory()) await walk(absolute, relative);
      }
    };
    await walk(root); res.json(output);
  } catch (err) { fail(res, 400, err.message); }
});
app.get('/file', async (req, res) => {
  try { const root = await ensureBotRoot(req.query.botKey); const target = await safeTarget(root, req.query.path, false); const stat = await fs.stat(target); if (!stat.isFile()) throw new Error('Workspace path is not a file.'); if (stat.size > MAX_TEXT_BYTES) throw new Error('Workspace file exceeds read limit.'); res.json({ path: req.query.path, content: await fs.readFile(target, 'utf8'), sizeBytes: stat.size }); }
  catch (err) { fail(res, 400, err.message); }
});
app.put('/file', async (req, res) => {
  try { const content = String(req.body?.content ?? ''); if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new Error('Workspace write exceeds limit.'); const root = await ensureBotRoot(req.body?.botKey); const target = await safeTarget(root, req.body?.path, true); await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o600 }); res.json({ path: req.body?.path, sizeBytes: Buffer.byteLength(content, 'utf8') }); }
  catch (err) { fail(res, 400, err.message); }
});

app.post('/terminal', async (req, res) => {
  try {
    const program = path.basename(String(req.body?.program || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
    if (!allowedPrograms.includes(program)) throw new Error(`Program "${program}" is not in the terminal allowlist.`);
    const args = Array.isArray(req.body?.args) ? req.body.args.map(String) : [];
    if (args.length > 64 || args.some(arg => arg.includes('\0') || arg.length > 4096)) throw new Error('Terminal arguments exceed bounded limits.');
    const cwd = await ensureBotRoot(req.body?.botKey); const timeoutMs = Math.max(100, Math.min(30000, Number(req.body?.timeoutMs) || 20000));
    const result = await new Promise((resolve, reject) => execFile(program, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_TERMINAL_BYTES, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') return reject(new Error(`Program "${program}" is not installed in the isolated computer.`));
      const out = String(stdout || ''); const err = String(stderr || ''); resolve({ program, args, exitCode: Number(error?.code ?? 0), stdout: out.slice(0, MAX_TERMINAL_BYTES), stderr: err.slice(0, 32 * 1024), truncated: out.length >= MAX_TERMINAL_BYTES });
    }));
    res.json(result);
  } catch (err) { fail(res, 400, err.message); }
});

process.on('SIGTERM', async () => { try { if (context) await context.close(); } finally { process.exit(0); } });
app.listen(PORT, '0.0.0.0', () => process.stdout.write(`Aira isolated computer runner listening on ${PORT}\n`));
