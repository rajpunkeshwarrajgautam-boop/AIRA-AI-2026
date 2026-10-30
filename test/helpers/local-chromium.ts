import fs from 'node:fs';
import { BrowserAdapter } from '../../packages/tool-runtime/src/adapters/browser-adapter.js';

/**
 * Creates a real, pinned local Chromium runtime.
 * On Windows, uses the verified local system Chrome or Edge executable.
 * On Linux, uses @sparticuz/chromium or system chromium without CDN downloads.
 */
export async function createLocalChromiumAdapter(): Promise<BrowserAdapter> {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const exe of candidates) {
      if (fs.existsSync(exe)) {
        return new BrowserAdapter({ executablePath: exe });
      }
    }
  }

  const originalAwsExecutionEnv = process.env.AWS_EXECUTION_ENV;
  if (!originalAwsExecutionEnv) process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs24.x';

  try {
    const chromiumModule = await import('@sparticuz/chromium');
    const executablePath = await chromiumModule.default.executablePath();
    return new BrowserAdapter({ executablePath });
  } catch {
    // Fall back to standard BrowserAdapter auto-detection
    return new BrowserAdapter();
  } finally {
    if (originalAwsExecutionEnv === undefined) delete process.env.AWS_EXECUTION_ENV;
    else process.env.AWS_EXECUTION_ENV = originalAwsExecutionEnv;
  }
}
