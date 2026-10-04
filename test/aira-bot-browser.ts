import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

export async function verifyBotBrowser(botId: string, runId: string) {
  process.env.VITE_AIRA_DEV_IDENTITY = 'true';
  const vite = await createServer({ mode: 'development', server: { host: '127.0.0.1', port: 5178, strictPort: true } });
  await vite.listen();
  const browser = await chromium.launch({
    executablePath: process.env.AIRA_CHROMIUM_PATH || undefined,
    args: process.env.AIRA_CHROMIUM_PATH ? ['--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : undefined
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir('/tmp/aira-bot-review', { recursive: true });
  try {
    await page.goto('http://127.0.0.1:5178/bots');
    await page.getByRole('heading', { name: 'Your own capable team.' }).waitFor();
    await page.getByRole('button', { name: 'Create bot', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.ab-home-heading button')?.disabled);
    assert.equal(await page.getByRole('button', { name: 'Agents', exact: true }).count(), 0);
    await page.screenshot({ path: '/tmp/aira-bot-review/home-desktop.png' });
    await page.getByRole('button', { name: 'Create bot', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByLabel('Name', { exact: true }).evaluate(el => document.activeElement === el), true);
    await page.getByLabel('Name', { exact: true }).fill('Browser verified teammate');
    await page.getByLabel('Purpose').fill('Checks the real interface');
    await page.getByLabel('Instructions', { exact: true }).fill('Produce accurate task results.');
    await page.getByLabel('Calculator', { exact: true }).check();
    await page.getByLabel('Approval policy').selectOption('always_ask');
    await page.getByText('Memory and reusable skills').click();
    await page.getByLabel('Saved memory').fill('Reports use INR.');
    await page.getByRole('button', { name: 'Add a skill' }).click();
    await page.getByLabel('Skill name').fill('Report');
    await page.getByLabel('Procedure').fill('State the evidence for each conclusion.');
    await page.screenshot({ path: '/tmp/aira-bot-review/create-bot.png' });
    await page.getByRole('dialog').getByRole('button', { name: 'Create bot', exact: true }).click();
    await page.getByRole('heading', { name: 'Browser verified teammate', exact: true }).waitFor();
    assert.match(page.url(), /\/bots\/bot_/);
    await page.reload();
    await page.getByRole('heading', { name: 'Browser verified teammate', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Configure' }).click();
    assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Browser verified teammate');
    await page.getByText('Memory and reusable skills').click();
    assert.equal(await page.getByLabel('Saved memory').inputValue(), 'Reports use INR.');
    assert.equal(await page.getByLabel('Skill name').inputValue(), 'Report');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByLabel('Task objective').fill('Calculate 7*9');
    await page.getByRole('button', { name: 'Start bot task' }).click();
    await page.getByRole('heading', { name: 'Aira Bot asks for permission' }).waitFor();
    await page.getByRole('button', { name: 'Approve once' }).click();
    await page.getByText('Verified calculation result: 63', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'files' }).click();
    await page.getByRole('button', { name: 'Task result Markdown result' }).waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    assert.match((await downloadPromise).suggestedFilename(), /^aira-bot-run_.*\.md$/);
    await page.getByRole('tab', { name: 'computer' }).click();
    await page.getByRole('heading', { name: 'Computer is not connected' }).waitFor();
    await page.getByRole('tab', { name: 'activity' }).click();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'files' }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    await page.screenshot({ path: '/tmp/aira-bot-review/task-desktop.png' });
    await page.goto(`http://127.0.0.1:5178/bots/${botId}/runs/${runId}`);
    await page.getByText('Verified calculation result: 63', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to your bots' }).click();
    assert.match(page.url(), /\/bots$/);
    await page.goBack();
    await page.getByText('Verified calculation result: 63', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByText('Verified calculation result: 63', { exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: '/tmp/aira-bot-review/task-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Back to your bots' }).click();
    await page.getByRole('heading', { name: 'Your own capable team.' }).waitFor();
    await page.screenshot({ path: '/tmp/aira-bot-review/home-mobile.png', fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.ab-primary').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.deepEqual(errors, []);
    console.log('PASS browser: bot CRUD, memory/skills persistence, task execution, files/download, deep links/back navigation, 390px layout, reduced motion, no page errors');
  } finally { await browser.close(); await vite.close(); }
}
