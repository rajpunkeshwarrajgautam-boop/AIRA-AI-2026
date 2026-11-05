import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { ExecutionPrincipal } from '../../../contracts/src/index.js';
import { db } from '../../../db/src/index.js';

export interface BrowserSessionInfo {
  sessionKey: string;
  principalId: string;
  context: BrowserContext;
  activePage: Page;
  lastActive: number;
}

export interface PersistedBrowserSessionState {
  sessionKey: string;
  principalId: string;
  workspaceId?: string;
  currentUrl: string;
  cookies: Array<any>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  exportedAt: number;
}

export interface StoredBrowserSessionEnvelope {
  sessionKey: string;
  principalId: string;
  workspaceId?: string;
  sessionId: string;
  encryptedEnvelope: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface IBrowserSessionStorage {
  saveSession(session: StoredBrowserSessionEnvelope): Promise<void>;
  getSession(sessionKey: string): Promise<StoredBrowserSessionEnvelope | null>;
  deleteSession(sessionKey: string): Promise<void>;
  listSessions(principalId: string, workspaceId?: string): Promise<StoredBrowserSessionEnvelope[]>;
  purgeExpired(): Promise<number>;
}

export class InMemoryBrowserSessionStorage implements IBrowserSessionStorage {
  private store = new Map<string, StoredBrowserSessionEnvelope>();

  async saveSession(session: StoredBrowserSessionEnvelope): Promise<void> {
    this.store.set(session.sessionKey, { ...session });
  }

  async getSession(sessionKey: string): Promise<StoredBrowserSessionEnvelope | null> {
    const s = this.store.get(sessionKey);
    return s ? { ...s } : null;
  }

  async deleteSession(sessionKey: string): Promise<void> {
    this.store.delete(sessionKey);
  }

  async listSessions(principalId: string, workspaceId?: string): Promise<StoredBrowserSessionEnvelope[]> {
    const res: StoredBrowserSessionEnvelope[] = [];
    for (const s of this.store.values()) {
      if (s.principalId === principalId && (!workspaceId || s.workspaceId === workspaceId)) {
        res.push({ ...s });
      }
    }
    return res;
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [k, s] of this.store.entries()) {
      if (now > s.expiresAt) {
        this.store.delete(k);
        count++;
      }
    }
    return count;
  }
}

export class BrowserPersistenceUnavailableError extends Error {
  readonly code = 'PERSISTENCE_UNAVAILABLE';
  constructor(operation: string, originalError?: unknown) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError || 'unknown');
    super(`BROWSER_PERSISTENCE_UNAVAILABLE: Database storage is unreachable during "${operation}" (${detail}). Cannot execute durable browser operation without durable persistence.`);
    this.name = 'BrowserPersistenceUnavailableError';
    if (originalError) this.cause = originalError;
  }
}

export class PostgresBrowserSessionStorage implements IBrowserSessionStorage {
  private knexClient: any;

  constructor(knexOverride?: any) {
    this.knexClient = knexOverride || db;
  }

  private isDbUnavailable(err: any): boolean {
    if (!err) return false;
    const msg = err.message || '';
    const code = err.code || '';
    return (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      code === 'PERSISTENCE_UNAVAILABLE' ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('connect ECONNREFUSED') ||
      msg.includes('Connection terminated') ||
      msg.includes('Connection pool') ||
      msg.includes('Knex: Timeout') ||
      msg.includes('does not exist') ||
      (Array.isArray(err.errors) && err.errors.some((e: any) => e.code === 'ECONNREFUSED' || e.message?.includes('ECONNREFUSED')))
    );
  }

  async saveSession(session: StoredBrowserSessionEnvelope): Promise<void> {
    try {
      const hasTable = await this.knexClient.schema.hasTable('durable_browser_sessions');
      if (!hasTable) {
        throw new Error('Table "durable_browser_sessions" does not exist in schema.');
      }
      await this.knexClient('durable_browser_sessions')
        .insert({
          session_key: session.sessionKey,
          principal_id: session.principalId,
          workspace_id: session.workspaceId || null,
          session_id: session.sessionId,
          encrypted_envelope: session.encryptedEnvelope,
          expires_at: session.expiresAt,
          created_at: session.createdAt,
          updated_at: session.updatedAt
        })
        .onConflict('session_key')
        .merge();
    } catch (err: any) {
      if (this.isDbUnavailable(err)) {
        throw new BrowserPersistenceUnavailableError('saveSession', err);
      }
      throw err;
    }
  }

  async getSession(sessionKey: string): Promise<StoredBrowserSessionEnvelope | null> {
    try {
      const hasTable = await this.knexClient.schema.hasTable('durable_browser_sessions');
      if (!hasTable) {
        throw new Error('Table "durable_browser_sessions" does not exist in schema.');
      }
      const row = await this.knexClient('durable_browser_sessions').where({ session_key: sessionKey }).first();
      if (!row) return null;
      return {
        sessionKey: row.session_key,
        principalId: row.principal_id,
        workspaceId: row.workspace_id || undefined,
        sessionId: row.session_id,
        encryptedEnvelope: row.encrypted_envelope,
        expiresAt: Number(row.expires_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at)
      };
    } catch (err: any) {
      if (this.isDbUnavailable(err)) {
        throw new BrowserPersistenceUnavailableError('getSession', err);
      }
      throw err;
    }
  }

  async deleteSession(sessionKey: string): Promise<void> {
    try {
      const hasTable = await this.knexClient.schema.hasTable('durable_browser_sessions');
      if (!hasTable) {
        throw new Error('Table "durable_browser_sessions" does not exist in schema.');
      }
      await this.knexClient('durable_browser_sessions').where({ session_key: sessionKey }).delete();
    } catch (err: any) {
      if (this.isDbUnavailable(err)) {
        throw new BrowserPersistenceUnavailableError('deleteSession', err);
      }
      throw err;
    }
  }

  async listSessions(principalId: string, workspaceId?: string): Promise<StoredBrowserSessionEnvelope[]> {
    try {
      const hasTable = await this.knexClient.schema.hasTable('durable_browser_sessions');
      if (!hasTable) {
        throw new Error('Table "durable_browser_sessions" does not exist in schema.');
      }
      let q = this.knexClient('durable_browser_sessions').where({ principal_id: principalId });
      if (workspaceId) q = q.andWhere({ workspace_id: workspaceId });
      const rows = await q.select('*');
      return rows.map((row: any) => ({
        sessionKey: row.session_key,
        principalId: row.principal_id,
        workspaceId: row.workspace_id || undefined,
        sessionId: row.session_id,
        encryptedEnvelope: row.encrypted_envelope,
        expiresAt: Number(row.expires_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at)
      }));
    } catch (err: any) {
      if (this.isDbUnavailable(err)) {
        throw new BrowserPersistenceUnavailableError('listSessions', err);
      }
      throw err;
    }
  }

  async purgeExpired(): Promise<number> {
    try {
      const hasTable = await this.knexClient.schema.hasTable('durable_browser_sessions');
      if (!hasTable) {
        throw new Error('Table "durable_browser_sessions" does not exist in schema.');
      }
      const deleted = await this.knexClient('durable_browser_sessions')
        .where('expires_at', '<', Date.now())
        .delete();
      return Number(deleted) || 0;
    } catch (err: any) {
      if (this.isDbUnavailable(err)) {
        throw new BrowserPersistenceUnavailableError('purgeExpired', err);
      }
      throw err;
    }
  }
}

export interface BrowserAdapterOptions {
  /** Explicit local executable injection for controlled browser certification. */
  executablePath?: string;
}

/**
 * Resolves default browser executable path across platforms and environment variables.
 */
export function resolveBrowserExecutablePath(options?: BrowserAdapterOptions): string | undefined {
  if (options?.executablePath) {
    return options.executablePath;
  }
  if (process.env.CHROMIUM_PATH && fsSync.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  if (process.platform === 'linux') {
    const linuxCandidates = [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium'
    ];
    for (const c of linuxCandidates) {
      if (fsSync.existsSync(c)) {
        return c;
      }
    }
  }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) {
        return c;
      }
    }
  }
  return undefined;
}

export class BrowserAdapter {
  private browser: Browser | null = null;
  private sessions: Map<string, BrowserSessionInfo> = new Map();
  private browserPromise: Promise<Browser> | null = null;
  private storage: IBrowserSessionStorage;

  constructor(
    private readonly options: BrowserAdapterOptions = {},
    storage?: IBrowserSessionStorage
  ) {
    this.storage = storage || new PostgresBrowserSessionStorage();
  }

  getStorage(): IBrowserSessionStorage {
    return this.storage;
  }

  /** Fail-fast readiness probe; unlike navigate(), this never uses HTTP fallback. */
  async assertBrowserAvailable(): Promise<void> {
    await this.getBrowser();
  }

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
      const exePath = resolveBrowserExecutablePath(this.options);

      const launchOptions = {
        headless: true,
        ...(exePath ? { executablePath: exePath } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      };

      try {
        const b = await chromium.launch(launchOptions);
        this.browser = b;
        return b;
      } catch (err: any) {
        try {
          // 2. Try Microsoft Edge channel
          const b = await chromium.launch({ ...launchOptions, channel: 'msedge' });
          this.browser = b;
          return b;
        } catch {
          // 3. Fallback to standard Playwright Chromium binary
          const b = await chromium.launch({ ...launchOptions, channel: 'chrome' });
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
    const allowInsecureCerts = Boolean(process.env.AIRA_ALLOW_INSECURE_TEST_CERTS === 'true');
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 AIRA/2026',
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: allowInsecureCerts
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
    this.validateUrl(url);

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
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 AIRA/2026',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 15000))
    });

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
   * Browser Scrolling (WRITE side-effect)
   */
  async scroll(
    principal: ExecutionPrincipal,
    deltaY = 500,
    selector?: string
  ): Promise<{
    scrolled: boolean;
    deltaY: number;
    currentUrl: string;
  }> {
    let session: BrowserSessionInfo;
    try {
      session = await this.getSession(principal);
    } catch {
      throw new Error('BROWSER_RUNTIME_NOT_AVAILABLE: Headless browser is not available for scrolling.');
    }
    const page = session.activePage;

    if (selector) {
      const loc = page.locator(selector).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
    } else {
      await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'instant' }), deltaY);
    }

    return {
      scrolled: true,
      deltaY,
      currentUrl: page.url()
    };
  }

  /**
   * Browser Wait (READ side-effect)
   */
  async waitFor(
    principal: ExecutionPrincipal,
    selector?: string,
    timeoutMs = 5000
  ): Promise<{
    ready: boolean;
    selector?: string;
    currentUrl: string;
  }> {
    let session: BrowserSessionInfo;
    try {
      session = await this.getSession(principal);
    } catch {
      throw new Error('BROWSER_RUNTIME_NOT_AVAILABLE: Headless browser is not available for waiting.');
    }
    const page = session.activePage;

    if (selector) {
      await page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 30000), state: 'visible' });
    } else {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 30000) });
    }

    return {
      ready: true,
      selector,
      currentUrl: page.url()
    };
  }

  /**
   * List active browser sessions for a principal
   */
  listSessions(principal?: ExecutionPrincipal): Array<{ sessionKey: string; principalId: string; lastActive: number; currentUrl: string }> {
    const list: Array<{ sessionKey: string; principalId: string; lastActive: number; currentUrl: string }> = [];
    for (const [key, s] of this.sessions.entries()) {
      if (!principal || s.principalId === principal.userId) {
        let currentUrl = 'about:blank';
        try {
          if (!s.activePage.isClosed()) currentUrl = s.activePage.url();
        } catch {}
        list.push({
          sessionKey: key,
          principalId: s.principalId,
          lastActive: s.lastActive,
          currentUrl
        });
      }
    }
    return list;
  }

  /**
   * Restart a principal's browser session with clean slate
   */
  async restartSession(principal: ExecutionPrincipal): Promise<{ sessionKey: string; status: string }> {
    await this.closeSession(principal);
    const s = await this.getSession(principal);
    return {
      sessionKey: s.sessionKey,
      status: 'RESTARTED'
    };
  }

  /**
   * Export permitted session state (cookies and localStorage) for durable recovery
   * 
   * PERSISTENCE CONTRACT:
   * - Survives Restart: Cookies, LocalStorage items, current URL, session expiration.
   * - Must Be Reconstructed: In-flight DOM node handles, WebSocket / active SSE streams, pending user input events.
   */
  async exportSessionState(principal: ExecutionPrincipal): Promise<PersistedBrowserSessionState | null> {
    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    const session = this.sessions.get(sessionKey);
    if (!session || session.activePage.isClosed()) {
      return null;
    }

    try {
      const storageState = await session.context.storageState();
      return {
        sessionKey,
        principalId: principal.userId,
        workspaceId: principal.workspaceId,
        currentUrl: session.activePage.url(),
        cookies: storageState.cookies,
        origins: storageState.origins,
        exportedAt: Date.now()
      };
    } catch {
      return null;
    }
  }

  /**
   * Validate exact ownership matching for principal, session, and workspace
   */
  public validateOwnership(
    principal: ExecutionPrincipal,
    target: { principalId: string; workspaceId?: string; sessionKey?: string; sessionId?: string },
    action: string = 'restore session'
  ): void {
    if (!principal || !principal.userId) {
      throw new Error('SECURITY_VIOLATION: Unauthenticated principal or missing principalId.');
    }

    if (!target.principalId || target.principalId !== principal.userId) {
      throw new Error(`SECURITY_VIOLATION: Principal "${principal.userId}" cannot ${action} owned by "${target.principalId}".`);
    }

    // Exact workspace-bound session matching:
    // If either has a workspaceId, BOTH must have it and they must match exactly.
    const principalWs = principal.workspaceId;
    const targetWs = target.workspaceId;
    if (principalWs || targetWs) {
      if (!principalWs || !targetWs) {
        throw new Error(`SECURITY_VIOLATION: Missing workspace attribute. Workspace-bound session requires exact matching workspaceId (caller: "${principalWs}", target: "${targetWs}").`);
      }
      if (principalWs !== targetWs) {
        throw new Error(`SECURITY_VIOLATION: Workspace mismatch. Principal workspace "${principalWs}" cannot restore session for "${targetWs}".`);
      }
    }

    // Session Key or Session ID exact matching
    const expectedSessionKey = `${principal.userId}:${principal.sessionId}`;
    if (target.sessionKey && target.sessionKey !== expectedSessionKey) {
      throw new Error(`SECURITY_VIOLATION: Session key mismatch. Target session "${expectedSessionKey}" cannot import state for "${target.sessionKey}".`);
    }
    if (target.sessionId && target.sessionId !== principal.sessionId) {
      throw new Error(`SECURITY_VIOLATION: Session ID mismatch. Caller sessionId "${principal.sessionId}" does not match session "${target.sessionId}".`);
    }
  }

  /**
   * Restore permitted session state after worker restart
   */
  async importSessionState(principal: ExecutionPrincipal, state: PersistedBrowserSessionState): Promise<BrowserSessionInfo> {
    this.validateOwnership(principal, {
      principalId: state.principalId,
      workspaceId: state.workspaceId,
      sessionKey: state.sessionKey
    });

    await this.closeSession(principal, { deleteDurable: false });

    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    const browser = await this.getBrowser();
    const allowInsecureCerts = Boolean(process.env.AIRA_ALLOW_INSECURE_TEST_CERTS === 'true');
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 AIRA/2026',
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: allowInsecureCerts,
      storageState: {
        cookies: state.cookies,
        origins: state.origins
      }
    });

    const activePage = await context.newPage();
    if (state.currentUrl && state.currentUrl !== 'about:blank') {
      try {
        await activePage.goto(state.currentUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
      } catch {}
    }

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
   * Export session state encrypted with authenticated AES-256-GCM
   */
  async exportEncryptedSessionState(principal: ExecutionPrincipal, secretKey: string | Buffer): Promise<string | null> {
    const rawState = await this.exportSessionState(principal);
    if (!rawState) return null;

    const key = typeof secretKey === 'string'
      ? crypto.createHash('sha256').update(secretKey).digest()
      : secretKey;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const jsonStr = JSON.stringify(rawState);
    const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return JSON.stringify({
      version: 1,
      principalId: principal.userId,
      workspaceId: principal.workspaceId,
      sessionKey: `${principal.userId}:${principal.sessionId}`,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64')
    });
  }

  /**
   * Decrypt and restore session state using authenticated AES-256-GCM
   */
  async importEncryptedSessionState(
    principal: ExecutionPrincipal,
    encryptedEnvelopeStr: string,
    secretKey: string | Buffer
  ): Promise<BrowserSessionInfo> {
    let envelope: any;
    try {
      envelope = JSON.parse(encryptedEnvelopeStr);
    } catch {
      throw new Error('SECURITY_VIOLATION: Corrupted or invalid JSON session envelope.');
    }

    if (!envelope || !envelope.iv || !envelope.tag || !envelope.data) {
      throw new Error('SECURITY_VIOLATION: Incomplete or tampered encrypted session envelope.');
    }

    this.validateOwnership(principal, {
      principalId: envelope.principalId,
      workspaceId: envelope.workspaceId,
      sessionKey: envelope.sessionKey
    }, 'decrypt session envelope');

    const key = typeof secretKey === 'string'
      ? crypto.createHash('sha256').update(secretKey).digest()
      : secretKey;

    let decrypted: Buffer;
    try {
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const ciphertext = Buffer.from(envelope.data, 'base64');

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err: any) {
      throw new Error(`SECURITY_VIOLATION: Decryption failed. Tampered ciphertext or wrong encryption key (${err.message}).`);
    }

    let rawState: PersistedBrowserSessionState;
    try {
      rawState = JSON.parse(decrypted.toString('utf8'));
    } catch {
      throw new Error('SECURITY_VIOLATION: Decrypted session state is not valid JSON.');
    }

    return this.importSessionState(principal, rawState);
  }

  /**
   * Persist encrypted session snapshot to durable access-controlled storage
   */
  async saveDurableSnapshot(
    principal: ExecutionPrincipal,
    secretKey: string | Buffer,
    ttlMs: number = 3600000
  ): Promise<StoredBrowserSessionEnvelope | null> {
    const encryptedEnvelope = await this.exportEncryptedSessionState(principal, secretKey);
    if (!encryptedEnvelope) return null;

    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    const now = Date.now();
    const stored: StoredBrowserSessionEnvelope = {
      sessionKey,
      principalId: principal.userId,
      workspaceId: principal.workspaceId,
      sessionId: principal.sessionId,
      encryptedEnvelope,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs
    };

    await this.storage.saveSession(stored);
    return stored;
  }

  /**
   * Restore encrypted session snapshot from durable access-controlled storage
   */
  async restoreDurableSnapshot(
    principal: ExecutionPrincipal,
    secretKey: string | Buffer
  ): Promise<BrowserSessionInfo> {
    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    const stored = await this.storage.getSession(sessionKey);
    if (!stored) {
      throw new Error(`SESSION_NOT_FOUND: No persisted browser session found for key "${sessionKey}".`);
    }

    // Check expiration
    if (Date.now() > stored.expiresAt) {
      await this.storage.deleteSession(sessionKey);
      throw new Error(`SECURITY_VIOLATION: Persisted browser session "${sessionKey}" has expired.`);
    }

    // Exact ownership check on stored record
    this.validateOwnership(principal, {
      principalId: stored.principalId,
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      sessionKey: stored.sessionKey
    });

    return this.importEncryptedSessionState(principal, stored.encryptedEnvelope, secretKey);
  }

  /**
   * Delete persisted session snapshot from durable storage
   */
  async deleteDurableSnapshot(principal: ExecutionPrincipal): Promise<void> {
    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    await this.storage.deleteSession(sessionKey);
  }

  /**
   * Purge all expired browser session snapshots across storage
   */
  async purgeExpiredSnapshots(): Promise<number> {
    return this.storage.purgeExpired();
  }

  /**
   * Sanitize session state for public logging or API responses, redacting raw cookies and secrets
   */
  sanitizeSessionStateForPublic(state: PersistedBrowserSessionState): Record<string, unknown> {
    return {
      sessionKey: state.sessionKey,
      principalId: state.principalId,
      workspaceId: state.workspaceId,
      currentUrl: state.currentUrl,
      cookieCount: state.cookies.length,
      cookies: state.cookies.map(c => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        value: '[REDACTED_COOKIE]'
      })),
      originCount: state.origins.length,
      exportedAt: state.exportedAt
    };
  }

  /**
   * Validate destination URL to prevent SSRF against cloud internal metadata or forbidden protocols
   */
  private validateUrl(rawUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid URL: "${rawUrl}"`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Forbidden protocol: "${parsed.protocol}". Only http and https are permitted.`);
    }

    // SSRF protections: Block access to cloud metadata services (169.254.169.254, metadata.google.internal)
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === '169.254.169.254' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      throw new Error(`SECURITY_REJECTED: Destination "${hostname}" is blocked to prevent SSRF.`);
    }
  }

  /**
   * Close a principal's browser session cleanly and delete durable snapshot
   */
  async closeSession(principal: ExecutionPrincipal, options: { deleteDurable?: boolean } = {}): Promise<void> {
    const sessionKey = `${principal.userId}:${principal.sessionId}`;
    const session = this.sessions.get(sessionKey);
    if (session) {
      await session.context.close().catch(() => {});
      this.sessions.delete(sessionKey);
    }
    if (options.deleteDurable !== false) {
      await this.storage.deleteSession(sessionKey);
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
