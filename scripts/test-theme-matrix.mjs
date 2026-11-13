import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';

const SCREENSHOT_DIR = path.resolve('test/screenshots/theme-repair');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function parseRgb(rgbStr) {
  const match = rgbStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function getLuminance([r, g, b]) {
  const a = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function getContrast(rgb1, rgb2) {
  const lum1 = getLuminance(rgb1);
  const lum2 = getLuminance(rgb2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

async function runThemeMatrix() {
  console.log('=== STARTING LOCAL THEME & PRESET MATRIX VERIFICATION ===');

  // 1. Start vite preview server
  console.log('Spawning vite preview on port 4173...');
  const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
    shell: true,
    stdio: 'pipe'
  });

  server.stdout.on('data', data => {
    // console.log(`[vite preview] ${data}`);
  });
  server.stderr.on('data', data => {
    console.error(`[vite preview err] ${data}`);
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const results = [];

  try {
    console.log('Loading http://localhost:4173...');
    await page.goto('http://localhost:4173', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);

    // Initial Light state
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01_initial_light.png') });
    const initialMetrics = await getMetrics(page, 'initial_light');
    console.log('01. Initial Light Mode:', initialMetrics);
    assert(initialMetrics.isDark === false, 'Initial state should not be dark');
    assert(initialMetrics.contrastBody >= 4.5, 'Light mode contrast must meet WCAG AA');
    results.push({ name: 'Linear Precision (Light)', ...initialMetrics });

    // Click Dark Mode button
    console.log('Clicking Dark Theme button in sidebar...');
    const darkBtn = page.locator('button[aria-label="Use dark theme"]').first();
    await darkBtn.click();
    await page.waitForTimeout(800);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_switched_dark.png') });
    const darkMetrics = await getMetrics(page, 'switched_dark');
    console.log('02. Switched Dark Mode:', darkMetrics);
    assert(darkMetrics.isDark === true, 'DOM must have .dark class');
    assert(darkMetrics.bodyBgRgb[0] < 50, 'Body background must be dark (< 50 rgb)');
    assert(darkMetrics.sidebarBgRgb[0] < 50, 'Sidebar background must be dark (< 50 rgb)');
    assert(darkMetrics.contrastBody >= 4.5, 'Dark mode contrast must meet WCAG AA');
    results.push({ name: 'Linear Precision (Dark)', ...darkMetrics });

    // Test persistence across reload
    console.log('Testing persistence across page reload...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const reloadedMetrics = await getMetrics(page, 'reloaded_dark');
    console.log('03. Reloaded Dark Mode:', reloadedMetrics);
    assert(reloadedMetrics.isDark === true, 'Dark mode must survive page reload');
    assert(reloadedMetrics.bodyBgRgb[0] < 50, 'Body background must remain dark after reload');

    // Switch back to Light
    console.log('Clicking Light Theme button in sidebar...');
    const lightBtn = page.locator('button[aria-label="Use light theme"]').first();
    await lightBtn.click();
    await page.waitForTimeout(800);
    const lightBackMetrics = await getMetrics(page, 'switched_back_light');
    assert(lightBackMetrics.isDark === false, 'Must switch back to light');
    assert(lightBackMetrics.bodyBgRgb[0] > 200, 'Body background must return to light (> 200 rgb)');

    // Now test all 8 aesthetic presets in both Light and Dark mode!
    const presets = [
      'linear-precision',
      'warm-parchment',
      'liquid-glass',
      'industrial-brutalist',
      'nordic-moss',
      'solar-gold',
      'tokyo-neon',
      'vanguard-monolith'
    ];

    console.log('\n--- Testing all 8 presets in Light and Dark ---');
    for (const preset of presets) {
      console.log(`\nTesting Preset: ${preset}...`);

      // Set preset via page.evaluate
      await page.evaluate((p) => {
        const root = document.documentElement;
        root.dataset.theme = p;
        root.classList.remove('dark');
        const raw = localStorage.getItem('aira_device_preferences_v1') || '{}';
        const prefs = JSON.parse(raw);
        prefs.aestheticPreset = p;
        prefs.theme = 'light';
        localStorage.setItem('aira_device_preferences_v1', JSON.stringify(prefs));
      }, preset);
      await page.waitForTimeout(300);

      const lightPresetMetrics = await getMetrics(page, `${preset}_light`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `preset_${preset}_light.png`) });
      console.log(`  [LIGHT] ${preset}:`, {
        bodyBg: lightPresetMetrics.bodyBg,
        textPrimary: lightPresetMetrics.textPrimary,
        contrast: lightPresetMetrics.contrastBody.toFixed(2)
      });
      assert(lightPresetMetrics.contrastBody >= 4.5, `${preset} light contrast must be >= 4.5`);
      results.push({ name: `${preset} (Light)`, ...lightPresetMetrics });

      // Now Dark mode for preset
      await page.evaluate((p) => {
        const root = document.documentElement;
        root.classList.add('dark');
        const raw = localStorage.getItem('aira_device_preferences_v1') || '{}';
        const prefs = JSON.parse(raw);
        prefs.theme = 'dark';
        localStorage.setItem('aira_device_preferences_v1', JSON.stringify(prefs));
      }, preset);
      await page.waitForTimeout(300);

      const darkPresetMetrics = await getMetrics(page, `${preset}_dark`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `preset_${preset}_dark.png`) });
      console.log(`  [DARK]  ${preset}:`, {
        bodyBg: darkPresetMetrics.bodyBg,
        textPrimary: darkPresetMetrics.textPrimary,
        contrast: darkPresetMetrics.contrastBody.toFixed(2)
      });
      assert(darkPresetMetrics.contrastBody >= 4.5, `${preset} dark contrast must be >= 4.5`);
      results.push({ name: `${preset} (Dark)`, ...darkPresetMetrics });
    }

    console.log('\n=== ALL 16 PRESET COMBINATIONS VERIFIED SUCCESSFULLY! ===');

  } finally {
    await browser.close();
    server.kill();
  }

  return results;
}

async function getMetrics(page, tag) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const sidebar = document.querySelector('.aira-sidebar-shell');
    const main = document.querySelector('main') || document.querySelector('.aira-adaptive-main');

    const bodyStyle = window.getComputedStyle(body);
    const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : null;
    const mainStyle = main ? window.getComputedStyle(main) : null;

    function parse(c) {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [255, 255, 255];
    }
    function lum([r, g, b]) {
      const a = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }
    function contrast(c1, c2) {
      const l1 = lum(c1);
      const l2 = lum(c2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    const bodyBgRgb = parse(bodyStyle.backgroundColor);
    const bodyColorRgb = parse(bodyStyle.color);
    const sidebarBgRgb = sidebarStyle ? parse(sidebarStyle.backgroundColor) : null;

    return {
      isDark: root.classList.contains('dark'),
      preset: root.dataset.theme || 'default',
      bodyBg: bodyStyle.backgroundColor,
      bodyBgRgb,
      bodyColor: bodyStyle.color,
      bodyColorRgb,
      sidebarBg: sidebarStyle ? sidebarStyle.backgroundColor : null,
      sidebarBgRgb,
      mainBg: mainStyle ? mainStyle.backgroundColor : null,
      textPrimary: window.getComputedStyle(root).getPropertyValue('--text-primary'),
      contrastBody: contrast(bodyBgRgb, bodyColorRgb),
    };
  });
}

runThemeMatrix().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
