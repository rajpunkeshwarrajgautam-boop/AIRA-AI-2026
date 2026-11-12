import { chromium } from 'playwright';

async function testClick() {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage();
  await page.goto('https://staging.virexaaiventures.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.click('[data-testid="account-button"]');
  await page.waitForTimeout(1000);
  
  const modalInfo = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-testid*="modal"], [data-testid*="auth"], [data-testid*="dialog"]'));
    return dialogs.map(d => ({
      tagName: d.tagName,
      className: d.className,
      testId: d.getAttribute('data-testid'),
      buttons: Array.from(d.querySelectorAll('button, a')).map(b => ({
        text: b.innerText.trim(),
        href: b.getAttribute('href'),
        testId: b.getAttribute('data-testid')
      }))
    }));
  });
  console.log('Modal info:', JSON.stringify(modalInfo, null, 2));
  await browser.close();
}
testClick();
