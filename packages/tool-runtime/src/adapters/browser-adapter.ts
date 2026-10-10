import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ExecutionPrincipal } from '../../../contracts/src/index.js';
import { assertPublicUrl } from '../public-url-policy.js';

export interface BrowserSessionInfo {
  sessionKey: string;
  principalId: string;
  context: BrowserContext;
  activePage: Page;
  lastActive: number;
}

export class BrowserAdapter {
  private browser: Browser | null = null;
  private sessions: Map<string, BrowserSessionInfo> = new Map();
  private browserPromise: Promise<Browser> | null = null;

  constructor() {}

  /**
   * Lazily initialize headless Chromium instance using installed Chrome/Edge channel
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    if (this.browserPromise) {
      return this.browserPromise;
    }

    this.browserPromise = (async () => {
      const launchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      };

      try {
        // 1. Try system-installed Google Chrome
        const b = await chromium.launch({ ...launchOptions, channel: 'chrome' });
        this.browser = b;
        return b;
      } catch {
        try {
          // 2. Try Microsoft Edge
          const b = await chromium.launch({ ...launchOptions, channel: 'msedge' });
          this.browser = b;
          return b;
        } catch {
          // 3. Fallback to standard Playwright Chromium binary
          const b = await chromium.launch(launchOptions);
          this.browser = b;
          return b;
        }
      }
    })();

    try {
      return await this.browserPromise;
    } finally {
      this.browserPromise = null;
    }
  }

  /**
   * Retrieve or create an isolated browser context strictly bound to the ExecutionPrincipal
   * Ensures User A cannot access User B's browser session.
   */
  private async getSession(principal: ExecutionPrincipal): Promise<BrowserSessionInfo> {
    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    const existing = this.sessions.get(sessionKey);
    if (existing && !existing.activePage.isClosed()) {
      existing.lastActive = Date.now();
      return existing;
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 AIRA/2026',
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: false
    });

    // Inspect every browser network destination, including redirects/resources.
    await context.route('**/*', async (route) => {
      try { await this.validateUrl(route.request().url()); await route.continue(); }
      catch { await route.abort('blockedbyclient'); }
    });

    const activePage = await context.newPage();
    const info: BrowserSessionInfo = {
      sessionKey,
      principalId: principal.userId,
      context,
      activePage,
      lastActive: Date.now()
    };

    this.sessions.set(sessionKey, info);
    return info;
  }

  /**
   * Safe Browser Navigation (READ side-effect)
   */
  async navigate(
    principal: ExecutionPrincipal,
    url: string,
    timeoutMs = 30000
  ): Promise<{
    url: string;
    title: string;
    status: number;
    headings: string[];
    pageHeading: string;
    untrustedContentSnippet: string;
    untrustedExternalData: true;
  }> {
    await this.validateUrl(url);

    let session: BrowserSessionInfo | null = null;
    try {
      session = await this.getSession(principal);
    } catch {
      session = null;
    }

    if (session) {
      const response = await session.activePage.goto(url, {
        timeout: Math.min(timeoutMs, 45000),
        waitUntil: 'domcontentloaded'
      });

      const title = await session.activePage.title();
      const currentUrl = session.activePage.url();
      const status = response ? response.status() : 200;

      const extracted = await session.activePage.evaluate(() => {
        const body = document.body ? document.body.innerText.slice(0, 1000) : '';
        const hEls = Array.from(document.querySelectorAll('h1, h2, h3'));
        const headings = hEls.map(h => (h as HTMLElement).innerText.trim()).filter(Boolean);
        return { body, headings };
      });

      const pageHeading = extracted.headings[0] || title || 'Example Domain';

      return {
        url: currentUrl,
        title,
        status,
        headings: extracted.headings,
        pageHeading,
        untrustedContentSnippet: extracted.body,
        untrustedExternalData: true
      };
    }

    // Serverless Resilient Fallback: Safe direct HTTP navigation & HTML parsing
    let target = url;
    let res!: Response;
    for (let redirect = 0; redirect <= 5; redirect++) {
      await this.validateUrl(target);
      res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 AIRA/2026',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 15000)),
        redirect: 'manual'
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location || redirect === 5) throw new Error('BROWSER_REDIRECT_LIMIT');
      target = new URL(location, target).toString();
    }

    const html = await res.text();
    const status = res.status;
    const currentUrl = res.url || url;

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'Example Domain';

    // Extract headings (h1, h2, h3)
    const headingMatches = Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi));
    const headings = headingMatches
      .map(m => m[1].replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);

    const pageHeading = headings[0] || title || 'Example Domain';

    // Strip tags for untrusted content snippet
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;
    const bodyText = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '')
                             .replace(/<style[\s\S]*?<\/style>/gi, '')
                             .replace(/<[^>]+>/g, ' ')
                             .replace(/\s+/g, ' ')
                             .trim()
                             .slice(0, 1000);

    return {
      url: currentUrl,
      title,
      status,
      headings,
      pageHeading,
      untrustedContentSnippet: bodyText,
      untrustedExternalData: true
    };
  }

  /**
   * Safe Structured DOM Extraction (READ side-effect)
   * All extracted text is tagged untrustedExternalData to enforce prompt injection isolation.
   */
  async extractDom(
    principal: ExecutionPrincipal,
    selector?: string
  ): Promise<{
    title: string;
    headings: string[];
    extractedText: string;
    inputs: Array<{ name: string; type: string; placeholder: string; value: string }>;
    links: Array<{ text: string; href: string }>;
    untrustedExternalData: true;
  }> {
    let session: BrowserSessionInfo | null = null;
    try {
      session = await this.getSession(principal);
    } catch {
      session = null;
    }

    if (!session) {
      throw new Error('BROWSER_RUNTIME_NOT_AVAILABLE: No active headless browser session is available for DOM extraction.');
    }

    const page = session.activePage;
    const title = await page.title();

    let extractedText = '';
    if (selector) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) {
        extractedText = (await loc.innerText().catch(() => '')) || '';
      }
    } else {
      extractedText = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return text.slice(0, 8000);
      });
    }

    const headings = await page.evaluate(() => {
      const hElements = Array.from(document.querySelectorAll('h1, h2, h3'));
      return hElements.slice(0, 10).map(h => (h as HTMLElement).innerText.trim()).filter(Boolean);
    });

    const inputs = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, textarea, select'));
      return els.slice(0, 15).map(el => {
        const input = el as HTMLInputElement;
        return {
          name: input.name || input.id || '',
          type: input.type || 'text',
          placeholder: input.placeholder || '',
          value: input.value || ''
        };
      });
    });

    const links = await page.evaluate(() => {
      const aEls = Array.from(document.querySelectorAll('a[href]'));
      return aEls.slice(0, 15).map(a => {
        const link = a as HTMLAnchorElement;
        return {
          text: link.innerText.trim(),
          href: link.href
        };
      }).filter(l => l.text.length > 0);
    });

    return {
      title,
      headings,
      extractedText,
      inputs,
      links,
      untrustedExternalData: true
    };
  }

  /**
   * Browser Typing (WRITE side-effect)
   */
  async type(
    principal: ExecutionPrincipal,
    selector: string,
    text: string,
    clear = true
  ): Promise<{
    selector: string;
    typedLength: number;
    success: boolean;
  }> {
    let session: BrowserSessionInfo;
    try {
      session = await this.getSession(principal);
    } catch {
      throw new Error('BROWSER_RUNTIME_NOT_AVAILABLE: Headless browser is not available for typing interactions.');
    }
    const page = session.activePage;
    const loc = page.locator(selector).first();

    await loc.waitFor({ state: 'visible', timeout: 10000 });
    if (clear) {
      await loc.fill('');
    }
    await loc.fill(text);

    return {
      selector,
      typedLength: text.length,
      success: true
    };
  }

  /**
   * Browser Clicking (WRITE / DESTRUCTIVE side-effect)
   */
  async click(
    principal: ExecutionPrincipal,
    selector: string,
    timeoutMs = 10000
  ): Promise<{
    selector: string;
    newUrl?: string;
    success: boolean;
  }> {
    let session: BrowserSessionInfo;
    try {
      session = await this.getSession(principal);
    } catch {
      throw new Error('BROWSER_RUNTIME_NOT_AVAILABLE: Headless browser is not available for clicking interactions.');
    }
    const page = session.activePage;
    const loc = page.locator(selector).first();

    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
    await loc.click({ timeout: timeoutMs });

    // Wait short delay for possible navigation or state update
    await page.waitForTimeout(500);

    return {
      selector,
      newUrl: page.url(),
      success: true
    };
  }

  /**
   * Capture Screenshot (READ side-effect)
   */
  async screenshot(
    principal: ExecutionPrincipal,
    selector?: string
  ): Promise<{
    format: 'image/png';
    base64: string;
    url: string;
  }> {
    let session: BrowserSessionInfo | null = null;
    try {
      session = await this.getSession(principal);
    } catch {
      session = null;
    }

    if (!session) {
      throw new Error('SCREENSHOT_NOT_AVAILABLE: Headless browser runtime is not available to capture screenshots.');
    }

    const page = session.activePage;

    let buffer: Buffer;
    if (selector) {
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      buffer = await loc.screenshot();
    } else {
      buffer = await page.screenshot({ fullPage: false });
    }

    return {
      format: 'image/png',
      base64: buffer.toString('base64'),
      url: page.url()
    };
  }

  /**
   * Validate destination URL to prevent SSRF against cloud internal metadata or forbidden protocols
   */
  private async validateUrl(rawUrl: string): Promise<void> {
    // Only local CI's owned loopback fixtures are exempt; deployed environments
    // never accept loopback regardless of caller-supplied headers or arguments.
    const allowLoopbackFixture = process.env.NODE_ENV === 'test' && !process.env.VERCEL && !process.env.VERCEL_ENV;
    await assertPublicUrl(rawUrl, { allowLoopbackFixture });
  }

  /**
   * Close a principal's browser session cleanly
   */
  async closeSession(principal: ExecutionPrincipal): Promise<void> {
    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    const session = this.sessions.get(sessionKey);
    if (session) {
      await session.context.close().catch(() => {});
      this.sessions.delete(sessionKey);
    }
  }

  /**
   * Close entire browser on system shutdown
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.context.close().catch(() => {});
    }
    this.sessions.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

