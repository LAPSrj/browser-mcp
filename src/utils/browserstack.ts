import { chromium, type Browser } from "playwright";

export interface BrowserStackCaps {
  browser: string;
  os?: string;
  osVersion?: string;
}

/**
 * BrowserStack's Playwright CDP endpoint only accepts a fixed set of browser
 * identifiers and rejects Playwright's own internal names (`chromium` /
 * `firefox` / `webkit`) with "Invalid 'browser'". Map our internal names to
 * the `playwright-*` identifiers BrowserStack expects. Any other value
 * (e.g. `chrome`, `edge`) is passed through unchanged so callers can still
 * request real browsers.
 */
const BROWSERSTACK_BROWSER_MAP: Record<string, string> = {
  chromium: "playwright-chromium",
  firefox: "playwright-firefox",
  webkit: "playwright-webkit",
};

function toBrowserStackBrowser(browser: string): string {
  return BROWSERSTACK_BROWSER_MAP[browser] ?? browser;
}

export function getBrowserStackCredentials(): { username: string; accessKey: string } {
  const username = process.env.BROWSERSTACK_USERNAME;
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;

  if (!username || !accessKey) {
    throw new Error(
      "BrowserStack credentials not found. Set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY environment variables."
    );
  }

  return { username, accessKey };
}

export async function connectBrowserStack(caps: BrowserStackCaps): Promise<Browser> {
  const { username, accessKey } = getBrowserStackCredentials();

  const capsPayload = {
    browser: toBrowserStackBrowser(caps.browser || "chrome"),
    os: caps.os || "Windows",
    os_version: caps.osVersion || "11",
    "browserstack.username": username,
    "browserstack.accessKey": accessKey,
    build: "browser-mcp",
    name: "browser-mcp-session",
  };

  const wsEndpoint = `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(capsPayload))}`;

  const browser = await chromium.connect(wsEndpoint);
  return browser;
}
