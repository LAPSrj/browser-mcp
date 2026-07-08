import { chromium, type Browser } from "playwright";
import { createRequire } from "node:module";
import { browserStackLocalTunnel } from "./browserstack-local.js";

export interface BrowserStackCaps {
  browser: string;
  os?: string;
  osVersion?: string;
  /** Real BrowserStack device name (e.g. "iPhone 15 Pro Max"). When set, the
   *  session runs on a real device instead of a desktop OS host. */
  device?: string;
  /** Route this session through a BrowserStack Local tunnel so the remote
   *  browser/device can reach localhost + private URLs served from this
   *  machine (e.g. http://clw.localhost/). Starts a shared tunnel daemon on
   *  demand and injects the `browserstack.local` caps. */
  local?: boolean;
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

/**
 * For a REAL device, BrowserStack wants the platform browser identifier, not a
 * `playwright-*` one: "safari" for iOS (real Apple Safari), "chrome" for
 * Android. We infer it from the device name. Only iOS is supported today; the
 * Android branch produces the correct cap but the connection is not yet wired
 * (BrowserStack serves real Android via a path bare Playwright connect can't
 * consume — tracked separately).
 */
function deviceBrowser(device: string): string {
  return /iphone|ipad|ipod/i.test(device) ? "safari" : "chrome";
}

/** Playwright version of the client — BrowserStack uses it to map protocol
 *  correctly, and it is required for real-device sessions. Resolved once. */
const clientPlaywrightVersion: string | undefined = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require("playwright/package.json").version as string;
  } catch {
    return undefined;
  }
})();

/** Real devices allocate slowly; the connect handshake needs a long timeout. */
const REAL_DEVICE_CONNECT_TIMEOUT_MS = 150000;

export function isBrowserStackRealDevice(caps: Pick<BrowserStackCaps, "device">): boolean {
  return Boolean(caps.device);
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

  const common = {
    "browserstack.username": username,
    "browserstack.accessKey": accessKey,
    ...(clientPlaywrightVersion ? { "client.playwrightVersion": clientPlaywrightVersion } : {}),
    // Keep the remote session alive through gaps between tool calls. BrowserStack's
    // default idle timeout is 90s; 300s (5 min, the max) avoids premature teardown
    // — important for slow real-device sessions and multi-step agent flows.
    "browserstack.idleTimeout": 300,
    build: "browser-mcp",
    name: "browser-mcp-session",
  };

  let capsPayload: Record<string, unknown>;
  let connectTimeout: number | undefined;

  if (caps.device) {
    // Real device: deviceName + realMobile, platform browser id (safari/chrome),
    // osVersion is the device OS version (default iOS 17). No desktop os field.
    capsPayload = {
      browser: deviceBrowser(caps.device),
      deviceName: caps.device,
      osVersion: caps.osVersion || "17",
      realMobile: "true",
      ...common,
    };
    connectTimeout = REAL_DEVICE_CONNECT_TIMEOUT_MS;
  } else {
    // Desktop OS host.
    capsPayload = {
      browser: toBrowserStackBrowser(caps.browser || "chrome"),
      os: caps.os || "Windows",
      os_version: caps.osVersion || "11",
      ...common,
    };
  }

  // Local Testing: bring up the shared tunnel and tag this session's caps so
  // BrowserStack routes it through the tunnel. The tunnel ref is released when
  // this session's browser disconnects (close_session, idle-reap, or crash).
  let localAcquired = false;
  if (caps.local) {
    const localIdentifier = await browserStackLocalTunnel.acquire();
    localAcquired = true;
    // String values throughout the caps payload, matching realMobile/idleTimeout.
    capsPayload["browserstack.local"] = "true";
    capsPayload["browserstack.localIdentifier"] = localIdentifier;
  }

  const wsEndpoint = `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(capsPayload))}`;

  let browser: Browser;
  try {
    browser = await chromium.connect(wsEndpoint, connectTimeout ? { timeout: connectTimeout } : undefined);
  } catch (err) {
    if (localAcquired) await browserStackLocalTunnel.release().catch(() => {});
    throw err;
  }
  if (localAcquired) {
    // Fires on browser.close() (both close paths) and on remote-side teardown.
    // `once` guards against a double release.
    browser.once("disconnected", () => { void browserStackLocalTunnel.release().catch(() => {}); });
  }
  return browser;
}
