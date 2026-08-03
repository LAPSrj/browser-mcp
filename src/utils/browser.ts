import { execSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { chromium, firefox, webkit, type Browser, type BrowserType, type BrowserServer, type BrowserContext, type Page } from "playwright";
import { connectBrowserStack, type BrowserStackCaps } from "./browserstack.js";
import { Semaphore } from "./semaphore.js";
import { isWsl } from "./wsl.js";
import type { SessionHook } from "../plugins/types.js";

export type BrowserName = "chromium" | "firefox" | "webkit";

/**
 * Build a realistic user-agent string that strips Playwright's headless
 * markers. Chromium's headless UA contains "HeadlessChrome" which sites
 * commonly detect and block — this replaces it with a standard Chrome UA
 * using the actual browser version. Firefox and WebKit headless UAs are
 * already indistinguishable from headed mode; this function returns
 * undefined for them (= use Playwright's default).
 *
 * Controlled by the BROWSER_MCP_REALISTIC_UA env var (default: "1").
 * Set to "0" to keep the original headless UA — useful for test
 * environments that rely on the HeadlessChrome marker.
 */
export function realisticUserAgent(browserName: BrowserName, browserInstance: Browser): string | undefined {
  const flag = (process.env.BROWSER_MCP_REALISTIC_UA ?? "1").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") {
    return undefined;
  }

  if (browserName === "chromium") {
    const version = browserInstance.version();
    const platform = process.platform === "darwin"
      ? "(Macintosh; Intel Mac OS X 10_15_7)"
      : process.platform === "win32"
        ? "(Windows NT 10.0; Win64; x64)"
        : "(X11; Linux x86_64)";
    return `Mozilla/5.0 ${platform} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }

  // Firefox and WebKit headless UAs have no "Headless" marker — Playwright
  // already uses realistic UA strings for them. Return undefined to keep
  // Playwright's default.
  return undefined;
}

/**
 * Per-tool-invocation context. Tracks the BrowserServers spawned by this
 * invocation so that a tool timeout can forcibly kill them, which unblocks
 * any playwright await still suspended inside the tool handler and lets its
 * finally blocks run closeSession (releasing the semaphore slot).
 */
export interface ToolContext {
  activeServers: Set<BrowserServer>;
  aborted: boolean;
  /**
   * Session hooks resolved from the tool call's `use` param (via
   * `resolveModes`). Applied on top of any hooks explicitly passed to
   * `launchSession({ sessionHooks })`. Lets core tools opt into plugin
   * capabilities (e.g. WP auth) without changing their own signatures.
   */
  sessionHooks: SessionHook[];
  /**
   * Set true once a code path has actually RUN the resolved sessionHooks
   * (launchSession). The server wrapper uses this to fail-loud: if `use:`
   * resolved hooks but nothing consumed them — e.g. a mode passed to a
   * persistent / attach_cdp session, which doesn't apply session hooks — it
   * appends a warning instead of silently no-op'ing a recognized param.
   */
  hooksConsumed: boolean;
}

export const toolContextStorage = new AsyncLocalStorage<ToolContext>();

export function createToolContext(sessionHooks: SessionHook[] = []): ToolContext {
  return { activeServers: new Set<BrowserServer>(), aborted: false, sessionHooks, hooksConsumed: false };
}

/**
 * Abort a tool context: mark it aborted and synchronously fire off kills for
 * every tracked BrowserServer. Returns a promise that resolves once all kills
 * settle, but callers usually don't need to await it — the kills cause any
 * in-flight playwright call to reject, unblocking the tool handler.
 */
export async function abortToolContext(ctx: ToolContext): Promise<void> {
  ctx.aborted = true;
  const servers = Array.from(ctx.activeServers);
  ctx.activeServers.clear();
  await Promise.all(servers.map(killServerSafely));
}

async function killServerSafely(server: BrowserServer): Promise<void> {
  try {
    await server.kill();
  } catch {
    // ignore — process may already be gone
  }
}

const browserTypes: Record<BrowserName, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

// 0 = unlimited (no concurrency limit)
const MAX_BROWSERS = Math.max(0, parseInt(process.env.BROWSER_MCP_MAX_BROWSERS || "3", 10) || 3);
const semaphore = new Semaphore(MAX_BROWSERS);

// Configurable via env, overridable at runtime via setLaunchConfig()
let LAUNCH_TIMEOUT = parseInt(process.env.BROWSER_MCP_LAUNCH_TIMEOUT || "30000", 10) || 30000;
let LAUNCH_RETRIES = parseInt(process.env.BROWSER_MCP_LAUNCH_RETRIES || "2", 10) || 2;

export function setLaunchConfig(opts: { launchTimeout?: number; launchRetries?: number }): void {
  if (opts.launchTimeout !== undefined) LAUNCH_TIMEOUT = opts.launchTimeout;
  if (opts.launchRetries !== undefined) LAUNCH_RETRIES = opts.launchRetries;
}

/**
 * Hardware-accelerated (GPU) rendering for local browsers.
 *
 * Behaviour differs per engine (all measured live on this WSL box with a
 * fragment-heavy WebGL benchmark; fast+low-CPU = GPU, slow+high-CPU = software):
 *
 * - Chromium: defaults to SwiftShader, a pure-CPU rasterizer. On shader-heavy
 *   pages that pegs a CPU core (8.3s / 80% CPU for the 60-frame bench) and
 *   spins the fan. Pointing ANGLE at the D3D12 GL driver moves it onto the GPU
 *   (~1.0s / 3% CPU — ~8x faster). Output is byte-identical across separate
 *   launches on a machine, so it is safe for screenshot/visual-diff baselines
 *   *once the baseline is regenerated* (GPU pixels differ from SwiftShader).
 * - Firefox: Playwright ships it with WebGL disabled entirely — no software
 *   burn, but WebGL simply does not render. Enabling it via firefoxUserPrefs
 *   makes WebGL work AND it is GPU-accelerated automatically (~0.84s / 5% CPU),
 *   no ANGLE flags or Mesa env needed.
 * - WebKit: already renders WebGL on the GPU by default (~0.9s / 4% CPU) — no
 *   override required.
 *
 * Enabled by default. Disable with BROWSER_MCP_GPU=0 — e.g. if goldens must
 * match a SwiftShader/CI environment, the GPU path proves flaky on some host,
 * or you want Firefox back to its stock WebGL-off default. Only affects
 * locally-launched browsers; BrowserStack is untouched.
 */
export function gpuEnabled(): boolean {
  const v = (process.env.BROWSER_MCP_GPU ?? "1").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/**
 * Firefox prefs that (a) turn WebGL on — it is off by default in Playwright's
 * headless Firefox — and (b) allow hardware acceleration. With these, Firefox
 * renders WebGL on the GPU with no extra flags or env. Verified live.
 */
const FIREFOX_GPU_PREFS: Record<string, boolean | number | string> = {
  "webgl.force-enabled": true,
  "webgl.disabled": false,
  "webgl.forbid-hardware": false,
  "gfx.webrender.all": true,
  "gfx.webrender.force-enabled": true,
  "gfx.canvas.accelerated": true,
  "layers.acceleration.force-enabled": true,
  "gfx.x11-egl.force-enabled": true,
};

export interface GpuLaunchOverrides {
  args: string[];
  env?: Record<string, string>;
  firefoxUserPrefs?: Record<string, boolean | number | string>;
}

/**
 * GPU launch overrides for a local browser, keyed by engine (see gpuEnabled's
 * doc for the per-engine rationale). Empty when GPU is disabled. Chromium gets
 * ANGLE flags + a WSL-only MESA d3d12 env; Firefox gets WebGL-enabling prefs;
 * WebKit needs nothing (already GPU).
 */
export function gpuLaunchOverrides(browserName: BrowserName): GpuLaunchOverrides {
  if (!gpuEnabled()) return { args: [] };

  if (browserName === "chromium") {
    const args = [
      "--use-gl=angle",
      "--use-angle=gl",
      "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization",
    ];
    const env = isWsl() ? { ...process.env, MESA_LOADER_DRIVER_OVERRIDE: "d3d12" } as Record<string, string> : undefined;
    return { args, env };
  }

  if (browserName === "firefox") {
    return { args: [], firefoxUserPrefs: { ...FIREFOX_GPU_PREFS } };
  }

  // webkit: already GPU-accelerated by default.
  return { args: [] };
}

export interface LaunchOptions {
  browser: BrowserName;
  viewport?: { width: number; height: number };
  useBrowserStack?: boolean;
  /** BrowserStack desktop OS to target (e.g. "Windows", "OS X"). Only used when useBrowserStack is true and no device. Defaults to Windows. */
  browserStackOs?: string;
  /** BrowserStack OS/device version (e.g. "11", "Sequoia", or iOS "17"). Only used when useBrowserStack is true. */
  browserStackOsVersion?: string;
  /** Real BrowserStack device name (e.g. "iPhone 15 Pro Max"). When set, runs on a real device (real iOS Safari). */
  browserStackDevice?: string;
  /** Route the BrowserStack session through a Local tunnel to reach localhost/private URLs served from this machine. */
  browserStackLocal?: boolean;
  /** Playwright storageState to inject auth cookies/localStorage into the context. */
  storageState?: object;
  /** Session hooks to run after context creation (e.g. plugin auth). */
  sessionHooks?: SessionHook[];
  /** Name of the tool launching this session (passed to session hooks). */
  toolName?: string;
}

/**
 * The per-call BrowserStack targeting fields a tool receives (from
 * `browserStackFields` in its schema). Tool param interfaces can mix this in,
 * and `pickBrowserStack` forwards them into `launchSession` in one shot.
 */
export interface BrowserStackTarget {
  browserStackOs?: string;
  browserStackOsVersion?: string;
  browserStackDevice?: string;
  browserStackLocal?: boolean;
}

export function pickBrowserStack(p: BrowserStackTarget): BrowserStackTarget {
  return {
    browserStackOs: p.browserStackOs,
    browserStackOsVersion: p.browserStackOsVersion,
    browserStackDevice: p.browserStackDevice,
    browserStackLocal: p.browserStackLocal,
  };
}

export interface BrowserSession {
  server?: BrowserServer;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export function getBrowserType(name: BrowserName): BrowserType {
  const bt = browserTypes[name];
  if (!bt) {
    throw new Error(`Unknown browser: ${name}. Use chromium, firefox, or webkit.`);
  }
  return bt;
}

function killStaleBrowserProcesses(): void {
  try {
    execSync("pkill -f chrome-headless-shell 2>/dev/null || true", { timeout: 5000 });
  } catch {
    // ignore — no stale processes or pkill unavailable
  }
}

interface LaunchResult {
  server?: BrowserServer;
  browser: Browser;
}

async function launchBrowserWithRetry(
  browserName: BrowserName,
  useBrowserStack: boolean,
  browserStack?: { os?: string; osVersion?: string; device?: string; local?: boolean },
): Promise<LaunchResult> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= LAUNCH_RETRIES; attempt++) {
    try {
      if (useBrowserStack) {
        // os/osVersion/device left undefined → connectBrowserStack defaults to
        // desktop Windows 11; a device routes to a real mobile device.
        const caps: BrowserStackCaps = {
          browser: browserName,
          os: browserStack?.os,
          osVersion: browserStack?.osVersion,
          device: browserStack?.device,
          local: browserStack?.local,
        };
        const browser = await connectBrowserStack(caps);
        return { browser };
      }

      const bt = getBrowserType(browserName);
      const gpu = gpuLaunchOverrides(browserName);
      const server = await bt.launchServer({ headless: true, timeout: LAUNCH_TIMEOUT, args: gpu.args, env: gpu.env, firefoxUserPrefs: gpu.firefoxUserPrefs });
      const browser = await bt.connect(server.wsEndpoint());
      return { server, browser };
    } catch (error) {
      lastError = error as Error;

      if (attempt < LAUNCH_RETRIES) {
        killStaleBrowserProcesses();
        const delay = 1000 * attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}

export async function launchSession(options: LaunchOptions): Promise<BrowserSession> {
  await semaphore.acquire();

  // If the tool was already aborted while we were queued on the semaphore,
  // release the slot and bail out immediately rather than launching a browser
  // that will never be closed.
  const ctx = toolContextStorage.getStore();
  if (ctx?.aborted) {
    semaphore.release();
    throw new Error("Tool aborted before launch");
  }

  let server: BrowserServer | undefined;
  let browser: Browser | undefined;

  try {
    const {
      browser: browserName,
      viewport,
      useBrowserStack = false,
      browserStackOs,
      browserStackOsVersion,
      browserStackDevice,
      browserStackLocal,
      storageState,
      sessionHooks,
      toolName = "",
    } = options;

    const launchResult = await launchBrowserWithRetry(browserName, useBrowserStack, {
      os: browserStackOs,
      osVersion: browserStackOsVersion,
      device: browserStackDevice,
      local: browserStackLocal,
    });
    server = launchResult.server;
    browser = launchResult.browser;

    // Register the server with the invocation context so a timeout can kill it.
    // Do this as soon as we have a server reference, before any later await can
    // hang, so the abort handler can always reach it.
    if (server && ctx) {
      ctx.activeServers.add(server);
      // If abort fired between semaphore acquire and now, let the catch clean up.
      if (ctx.aborted) {
        throw new Error("Tool aborted during launch");
      }
    }

    const contextOptions: Record<string, unknown> = {};
    if (viewport) {
      contextOptions.viewport = viewport;
    }
    if (storageState) {
      contextOptions.storageState = storageState;
    }
    if (!useBrowserStack) {
      const ua = realisticUserAgent(browserName, browser);
      if (ua) contextOptions.userAgent = ua;
    }

    const context = await browser.newContext(contextOptions);
    // Real BrowserStack devices boot slowly — the first navigation can take
    // far longer than a local browser, so give the context a generous default.
    context.setDefaultTimeout(browserStackDevice ? 120000 : 30000);
    const page = await context.newPage();

    // Run plugin session hooks (e.g. auth) after context is ready.
    // Hooks from the tool context (resolved from the caller's `use` param)
    // run first, followed by any explicit sessionHooks. Order lets an
    // explicit hook override context-provided state if they ever conflict.
    const ctxHooks = ctx?.sessionHooks ?? [];
    const allHooks = [...ctxHooks, ...(sessionHooks ?? [])];
    for (const hook of allHooks) {
      await hook(context, page, toolName);
    }
    // Mark the caller's `use:`-resolved hooks as actually applied, so the
    // server wrapper doesn't warn that they were silently dropped.
    if (ctx && ctxHooks.length > 0) ctx.hooksConsumed = true;

    return { server, browser, context, page };
  } catch (error) {
    // Clean up any resources that were created before the failure.
    // Browser launch may have succeeded before context/page/hooks failed.
    if (server && ctx) {
      ctx.activeServers.delete(server);
    }
    if (browser) {
      await closeBrowserGracefully(browser);
    }
    if (server) {
      await closeServerBounded(server);
    }
    semaphore.release();
    throw error;
  }
}

const CLOSE_TIMEOUT = 5000;
const SERVER_CLOSE_TIMEOUT = 5000;

function closeBrowserGracefully(browser: Browser): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, CLOSE_TIMEOUT);

    browser.close()
      .then(() => {
        clearTimeout(timer);
        resolve(true);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}

/**
 * Close a BrowserServer with a hard time bound. If server.close() doesn't
 * settle within SERVER_CLOSE_TIMEOUT, fall through to server.kill() so the
 * subprocess can't outlive the session.
 */
async function closeServerBounded(server: BrowserServer): Promise<void> {
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), SERVER_CLOSE_TIMEOUT);
    server.close()
      .then(() => { clearTimeout(timer); resolve(true); })
      .catch(() => { clearTimeout(timer); resolve(false); });
  });

  if (!closed) {
    await killServerSafely(server);
  }
}

export async function closeSession(session: BrowserSession): Promise<void> {
  // Remove from the invocation context first so the abort handler doesn't
  // race with us on kill(). Safe to no-op if the context is gone.
  const ctx = toolContextStorage.getStore();
  if (ctx && session.server) {
    ctx.activeServers.delete(session.server);
  }

  await closeBrowserGracefully(session.browser);

  // browser.close() disconnects the websocket but does not stop the server
  // process. We always need to terminate the BrowserServer so it does not
  // outlive the session and leak subprocesses.
  if (session.server) {
    await closeServerBounded(session.server);
  }

  semaphore.release();
}
