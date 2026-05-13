import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from "playwright";
import { getBrowserType, type BrowserName } from "../utils/browser.js";
import { spawnAttachCdpRelay, type AttachCdpHandle } from "../utils/cdp-relay.js";
import {
  BROWSER_PRODUCT_SPECS,
  defaultExePath,
  resolveBrowserProduct,
} from "../utils/browser-products.js";
import { isWsl } from "../utils/wsl.js";

// Persistent browser sessions an agent can keep alive across MCP tool
// calls. Guards against runaway lifetimes with idle + wall-clock TTLs,
// a configurable session cap, and a SIGTERM/SIGINT cleanup hook.

export interface OpenSessionOptions {
  browser?: BrowserName;
  viewport?: { width: number; height: number };
  url?: string;
  user_agent?: string;
  locale?: string;
  timezone?: string;
  storageState?: object;
  record_video?: boolean;
  idle_ttl_ms?: number;
  wall_ttl_ms?: number;
  output_dir?: string;
  /**
   * Open the browser with a visible window (default: headless). Useful for
   * human-in-the-loop flows where the user takes over to solve a captcha or
   * complete login. WSLg renders Linux Chromium's window directly into the
   * Windows desktop. Ignored when attach_cdp is set (the attached browser's
   * own visibility is determined by the user-launched process).
   */
  headless?: boolean;
  /**
   * Attach to an existing or auto-launched Chromium-channel browser via CDP
   * instead of launching a Playwright-managed Chromium. Pass `true` to use
   * config defaults (auto-launch a fresh isolated browser of the configured
   * product — see BROWSER_MCP_PRODUCT), or a string endpoint URL like
   * `http://localhost:9222` to attach to a user-managed browser. Strict
   * footgun: do NOT call browser.close() on attach_cdp sessions — it kills
   * the attached browser process.
   */
  attach_cdp?: boolean | string;
  /**
   * Override config-default auto_launch for this session. When attach_cdp
   * is `true`, controls whether to spawn the configured browser if no CDP
   * endpoint is already reachable. Per-call override takes precedence over
   * config.
   */
  auto_launch?: boolean;
  /** Override config executable_path (Windows path on WSL). attach_cdp only. */
  executable_path?: string;
  /** Override config user_data_dir (Windows path on WSL). attach_cdp only. */
  user_data_dir?: string;
  /**
   * When reusing a profile dir (user_data_dir) that has session-restore state
   * from a prior run, Chromium reopens the previous tabs by default. The
   * agent then sees a window full of unrelated pages on attach. Pass
   * `restore_previous_tabs: true` to opt into that behavior; default `false`
   * closes every restored tab on attach and keeps one clean page (about:blank
   * when no `url` is given). attach_cdp only.
   */
  restore_previous_tabs?: boolean;
}

export interface TabInfo {
  tab_id: string;
  url: string;
  active: boolean;
}

export interface SessionInfo {
  session_id: string;
  browser: BrowserName;
  record_video: boolean;
  video_dir?: string;
  active_tab_id: string;
  tabs: TabInfo[];
  created_at: string;
  last_active_at: string;
  idle_ttl_ms: number;
  wall_ttl_ms: number;
  expires_at: string;
}

export interface CloseResult {
  session_id: string;
  closed_reason: string;
  videos?: string[];
  uptime_ms: number;
}

/**
 * Opaque-ish state-handover blob produced by `pause_session` and consumed by
 * `resume_session`. Carries the storage layer (cookies + origin storage) and
 * the launch options needed to reopen an equivalent session.
 *
 * NOT preserved across pause/resume: in-page JS state, scroll position,
 * in-progress form data, dynamic SPA state, secondary tabs. Use this for
 * post-login or post-captcha handover where reaching a state via cookies
 * is enough; not for mid-flow handover.
 */
export interface SessionSnapshot {
  /** Playwright storageState() output — cookies + per-origin localStorage / sessionStorage / IndexedDB. */
  storage_state: object;
  /** Active tab URL at pause time. resume_session navigates here on open. */
  url: string;
  /** Viewport carried from the paused session. */
  viewport: { width: number; height: number };
  /** Optional fields propagated from the original open_session call. */
  user_agent?: string;
  locale?: string;
  timezone?: string;
  /** Browser engine. resume_session refuses if the consumer requests a different engine. */
  browser: BrowserName;
  /** ISO timestamp the snapshot was taken — for debugging stale snapshots. */
  paused_at: string;
}

export interface PauseSessionResult {
  session_id: string;
  paused_at: string;
  snapshot: SessionSnapshot;
}

interface Session {
  id: string;
  browserName: BrowserName;
  server?: BrowserServer;
  browser: Browser;
  context: BrowserContext;
  pages: Map<string, Page>;
  pageOrder: string[];
  activeTabId: string;
  createdAt: number;
  lastActiveAt: number;
  idleTTLMs: number;
  wallTTLMs: number;
  recordVideo: boolean;
  videoDir?: string;
  outputDir: string;
  tracing: boolean;
  closing: boolean;
  /** True for any attach_cdp session (auto_launch or explicit endpoint). Skips browser.close() in close path — that would kill the attached browser process. */
  isAttachCdp: boolean;
  /** Set ONLY on auto_launch attach_cdp sessions. Holds the relay/browser handle for teardown. Undefined for explicit-string-endpoint attaches (user owns lifecycle). */
  attachCdp?: AttachCdpHandle;
  /** Launch-time options captured for pause_session — replayed verbatim into resume_session's open(). */
  pauseFields: {
    viewport: { width: number; height: number };
    user_agent?: string;
    locale?: string;
    timezone?: string;
  };
}

const DEFAULT_IDLE_TTL = 5 * 60 * 1000;
const DEFAULT_WALL_TTL = 30 * 60 * 1000;
const VIDEO_DEFAULT_WALL_TTL = 2 * 60 * 1000;
const VIDEO_MAX_WALL_TTL = 10 * 60 * 1000;
const JANITOR_INTERVAL = 30 * 1000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

class SessionManager {
  private sessions = new Map<string, Session>();
  private janitor?: NodeJS.Timeout;
  private signalsBound = false;
  private maxSessions = Math.max(
    1,
    parseInt(process.env.BROWSER_MCP_MAX_SESSIONS || "5", 10) || 5,
  );

  private ensureJanitor() {
    if (this.janitor) return;
    this.janitor = setInterval(() => {
      this.reap().catch(() => {
        // ignore — reaper failures must never crash the server
      });
    }, JANITOR_INTERVAL);
    this.janitor.unref?.();
  }

  bindShutdownSignals(): void {
    if (this.signalsBound) return;
    this.signalsBound = true;
    // Only arm `beforeExit` here — SIGINT/SIGTERM are handled by index.ts
    // so the server can also flush plugin destroys + any other cleanup in
    // the right order. Adding exit() handlers from two places races.
    process.on("beforeExit", () => {
      this.closeAll("beforeExit").catch(() => {});
    });
  }

  async open(opts: OpenSessionOptions): Promise<SessionInfo> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Session limit reached (${this.maxSessions} open). Close an existing ` +
          `session first or raise BROWSER_MCP_MAX_SESSIONS.`,
      );
    }

    const browserName = opts.browser ?? "chromium";
    const outputDir = opts.output_dir ?? ".browser";
    const recordVideo = opts.record_video === true;
    const id = randomUUID();
    const viewport = opts.viewport ?? DEFAULT_VIEWPORT;

    // Video-enabled sessions are deliberately short-lived — video files get
    // huge fast, and "I forgot to stop recording" should cost you minutes,
    // not hours. Clamp both the default and the max.
    let wallTTL = opts.wall_ttl_ms;
    if (recordVideo) {
      if (wallTTL === undefined) wallTTL = VIDEO_DEFAULT_WALL_TTL;
      if (wallTTL > VIDEO_MAX_WALL_TTL) wallTTL = VIDEO_MAX_WALL_TTL;
    } else if (wallTTL === undefined) {
      wallTTL = DEFAULT_WALL_TTL;
    }
    const idleTTL = opts.idle_ttl_ms ?? DEFAULT_IDLE_TTL;

    let server: BrowserServer | undefined;
    let browser: Browser;
    let attachCdp: AttachCdpHandle | undefined;

    if (opts.attach_cdp) {
      // attach_cdp path — connectOverCDP to an existing or auto-launched browser.
      // record_video does not work over CDP attach (Playwright's video API requires
      // a context launched by Playwright, not a connected one).
      if (recordVideo) {
        throw new Error(
          "attach_cdp sessions cannot record video — Playwright's video API requires a launched context, not an attached one.",
        );
      }
      if (browserName !== "chromium") {
        throw new Error(
          `attach_cdp sessions are chromium-only (got "${browserName}"). Use a Chromium-channel browser (edge/chrome/brave/vivaldi/opera) via attach_cdp; firefox/webkit do not speak CDP.`,
        );
      }

      const explicitEndpoint =
        typeof opts.attach_cdp === "string" ? opts.attach_cdp : undefined;

      if (explicitEndpoint) {
        // user-managed browser: connect to the URL they gave us, no auto-launch
        browser = await chromium.connectOverCDP(explicitEndpoint);
      } else {
        // config-driven auto-launch
        const isWslOrWin = isWsl() || process.platform === "win32";
        const product = resolveBrowserProduct({ isWslOrWin });
        const exe = opts.executable_path ?? defaultExePath(product, { isWslOrWin });
        if (!exe) {
          throw new Error(
            `attach_cdp: no executable_path configured for product "${product}" on this platform, and no canonical default is available. ` +
              `Pass executable_path on open_session or set BROWSER_MCP_EXECUTABLE_PATH.`,
          );
        }
        attachCdp = await spawnAttachCdpRelay({
          sessionId: id,
          executablePath: exe,
          processName: BROWSER_PRODUCT_SPECS[product].processName,
          userDataDirOverride: opts.user_data_dir,
        });
        browser = await chromium.connectOverCDP(attachCdp.endpoint);
      }
    } else {
      const bt = getBrowserType(browserName);
      const headless = opts.headless ?? true;
      server = await bt.launchServer({ headless });
      browser = await bt.connect(server.wsEndpoint());
    }

    let videoDir: string | undefined;
    if (recordVideo) {
      videoDir = path.join(outputDir, "videos", id);
      await fs.mkdir(videoDir, { recursive: true });
    }

    let context: BrowserContext;
    let page: Page;
    if (opts.attach_cdp) {
      // attached browsers come with at least one default context + page already.
      // Reuse the first context to honor the user's existing profile state.
      const existingContexts = browser.contexts();
      context = existingContexts[0] ?? (await browser.newContext());
      const existingPages = context.pages();
      page = existingPages[0] ?? (await context.newPage());
      context.setDefaultTimeout(30000);

      // Default: don't let Chromium's session-restore tabs leak into the
      // agent's view. When attaching to a profile that has saved session
      // state (the common case for persistent per-agent profiles), Edge
      // reopens every previous tab on top of the startup URL we asked for.
      // The agent then has to disambiguate "did I open this or did the
      // last run?" Opt in with restore_previous_tabs:true if you want
      // those tabs back.
      if (opts.restore_previous_tabs !== true) {
        const allPages = context.pages();
        // Prefer keeping a page already on about:blank — less wasteful
        // than navigating an arbitrary restored page away from its URL.
        const blankPage = allPages.find((p) => p.url() === "about:blank");
        if (blankPage && blankPage !== page) {
          page = blankPage;
        }
        for (const p of allPages) {
          if (p !== page) {
            await p.close().catch(() => { /* page may already be navigating; ignore */ });
          }
        }
        if (!opts.url && page.url() !== "about:blank") {
          try { await page.goto("about:blank", { timeout: 5000 }); } catch { /* best-effort */ }
        }
      }
    } else {
      const contextOpts: Record<string, unknown> = {
        viewport,
        userAgent: opts.user_agent,
        locale: opts.locale,
        timezoneId: opts.timezone,
        storageState: opts.storageState,
      };
      if (recordVideo && videoDir) {
        contextOpts.recordVideo = { dir: videoDir, size: viewport };
      }
      context = await browser.newContext(contextOpts as any);
      context.setDefaultTimeout(30000);
      page = await context.newPage();
    }

    if (opts.url) {
      try {
        await page.goto(opts.url, { waitUntil: "load", timeout: 30000 });
      } catch {
        // Surface navigation errors through the first interactive call rather
        // than failing session open — the page is still usable.
      }
    }

    const tabId = "main";
    const session: Session = {
      id,
      browserName,
      server,
      browser,
      context,
      pages: new Map([[tabId, page]]),
      pageOrder: [tabId],
      activeTabId: tabId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      idleTTLMs: idleTTL,
      wallTTLMs: wallTTL,
      recordVideo,
      videoDir,
      outputDir,
      tracing: false,
      closing: false,
      isAttachCdp: !!opts.attach_cdp,
      attachCdp,
      pauseFields: {
        viewport,
        user_agent: opts.user_agent,
        locale: opts.locale,
        timezone: opts.timezone,
      },
    };
    this.sessions.set(id, session);
    this.ensureJanitor();
    this.bindShutdownSignals();
    return this.info(session);
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.closing) {
      throw new Error(`Session "${id}" not found or already closed.`);
    }
    return s;
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastActiveAt = Date.now();
  }

  info(s: Session): SessionInfo {
    const tabs: TabInfo[] = s.pageOrder.map((tid) => {
      const p = s.pages.get(tid);
      return {
        tab_id: tid,
        url: p?.url() ?? "about:blank",
        active: tid === s.activeTabId,
      };
    });
    const expires = Math.min(
      s.lastActiveAt + s.idleTTLMs,
      s.createdAt + s.wallTTLMs,
    );
    return {
      session_id: s.id,
      browser: s.browserName,
      record_video: s.recordVideo,
      video_dir: s.videoDir,
      active_tab_id: s.activeTabId,
      tabs,
      created_at: new Date(s.createdAt).toISOString(),
      last_active_at: new Date(s.lastActiveAt).toISOString(),
      idle_ttl_ms: s.idleTTLMs,
      wall_ttl_ms: s.wallTTLMs,
      expires_at: new Date(expires).toISOString(),
    };
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => !s.closing)
      .map((s) => this.info(s));
  }

  async close(id: string): Promise<CloseResult> {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session "${id}" not found.`);
    return this.closeInternal(s, "manual");
  }

  /**
   * Snapshot the session's storage state + launch options, then close it.
   *
   * Use case: an agent's automated flow hit a step that needs human input
   * (post-login captcha, MFA prompt, age gate). pause_session captures the
   * cookies/storage and closes the headless session; the human solves the
   * step in a separate headed instance launched with the snapshot via
   * resume_session, then the automation continues with the updated state.
   *
   * NOT supported on attach_cdp sessions — their state lives in the
   * underlying browser's User Data profile, not in a Playwright-managed
   * context, so the snapshot model doesn't apply.
   *
   * NOT preserved across pause/resume: in-page JS state, scroll position,
   * in-progress form data, dynamic SPA state, secondary tabs. Cookies +
   * origin storage carry; the rest is reset on resume.
   */
  async pauseSession(id: string): Promise<PauseSessionResult> {
    const s = this.get(id);
    if (s.isAttachCdp) {
      throw new Error(
        `pause_session: not supported on attach_cdp sessions — their state is in the underlying browser's profile. ` +
          `Close the session normally; reattach with a fresh open_session({ attach_cdp: ... }) when ready.`,
      );
    }
    if (s.recordVideo) {
      throw new Error(
        `pause_session: not supported when record_video is true (would truncate the video). ` +
          `Close the session normally to finalize the recording, or open without record_video to enable pause/resume.`,
      );
    }
    if (s.tracing) {
      throw new Error(
        `pause_session: not supported while a trace is running. Call trace_stop({ session_id }) first.`,
      );
    }

    // storageState() reads cookies + per-origin localStorage / sessionStorage.
    const storageState = await s.context.storageState();
    const activePage = s.pages.get(s.activeTabId);
    const url = activePage?.url() ?? "about:blank";

    const snapshot: SessionSnapshot = {
      storage_state: storageState,
      url,
      viewport: s.pauseFields.viewport,
      user_agent: s.pauseFields.user_agent,
      locale: s.pauseFields.locale,
      timezone: s.pauseFields.timezone,
      browser: s.browserName,
      paused_at: new Date().toISOString(),
    };

    await this.closeInternal(s, "paused");

    return {
      session_id: id,
      paused_at: snapshot.paused_at,
      snapshot,
    };
  }

  /**
   * Reopen a session from a snapshot produced by pause_session.
   *
   * Calls open() with the snapshot's storageState + viewport + user_agent /
   * locale / timezone + url. Returns a NEW session_id (the resumed session
   * is a fresh session that happens to inherit storage state — it isn't the
   * "same" session as the one that was paused).
   *
   * Accepts per-call overrides for ttl, headless, record_video, output_dir.
   * The browser engine is locked to the snapshot's value (resuming on a
   * different engine wouldn't honor the storageState anyway).
   */
  async resumeSession(opts: {
    snapshot: SessionSnapshot;
    /** Optional overrides — passed through to open(). browser is locked to the snapshot. */
    headless?: boolean;
    idle_ttl_ms?: number;
    wall_ttl_ms?: number;
    output_dir?: string;
  }): Promise<SessionInfo> {
    const snap = opts.snapshot;
    if (!snap || typeof snap !== "object" || !snap.storage_state || !snap.browser) {
      throw new Error(
        `resume_session: snapshot is missing required fields (storage_state + browser at minimum). ` +
          `Pass the exact object returned by pause_session.`,
      );
    }
    return this.open({
      browser: snap.browser,
      url: snap.url,
      viewport: snap.viewport,
      user_agent: snap.user_agent,
      locale: snap.locale,
      timezone: snap.timezone,
      storageState: snap.storage_state,
      headless: opts.headless,
      idle_ttl_ms: opts.idle_ttl_ms,
      wall_ttl_ms: opts.wall_ttl_ms,
      output_dir: opts.output_dir,
    });
  }

  async closeAll(reason: string): Promise<void> {
    const all = Array.from(this.sessions.values());
    await Promise.all(
      all.map((s) => this.closeInternal(s, reason).catch(() => null)),
    );
  }

  async addTab(id: string, tab_id?: string, url?: string): Promise<{ tab_id: string; url: string }> {
    const s = this.get(id);
    const tid = tab_id ?? this.nextAutoTabId(s);
    if (s.pages.has(tid)) {
      throw new Error(`Tab "${tid}" already exists in session.`);
    }
    const page = await s.context.newPage();
    s.pages.set(tid, page);
    s.pageOrder.push(tid);
    s.activeTabId = tid;
    if (url) {
      try {
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
      } catch {
        // non-fatal
      }
    }
    this.touch(id);
    return { tab_id: tid, url: page.url() };
  }

  async switchTab(id: string, tab_id: string): Promise<void> {
    const s = this.get(id);
    if (!s.pages.has(tab_id)) {
      throw new Error(`Tab "${tab_id}" not found in session.`);
    }
    s.activeTabId = tab_id;
    try {
      await s.pages.get(tab_id)?.bringToFront();
    } catch {
      // bringToFront is best-effort in headless mode
    }
    this.touch(id);
  }

  async closeTab(id: string, tab_id: string): Promise<void> {
    const s = this.get(id);
    if (s.pages.size <= 1) {
      throw new Error("Can't close the last tab — close the session instead.");
    }
    const page = s.pages.get(tab_id);
    if (!page) throw new Error(`Tab "${tab_id}" not found.`);
    try { await page.close(); } catch { /* ignore */ }
    s.pages.delete(tab_id);
    s.pageOrder = s.pageOrder.filter((t) => t !== tab_id);
    if (s.activeTabId === tab_id) {
      s.activeTabId = s.pageOrder[s.pageOrder.length - 1];
    }
    this.touch(id);
  }

  getPage(session_id: string, tab_id?: string): Page {
    const s = this.get(session_id);
    const tid = tab_id ?? s.activeTabId;
    const page = s.pages.get(tid);
    if (!page) throw new Error(`Tab "${tid}" not found in session.`);
    return page;
  }

  getContext(session_id: string): BrowserContext {
    return this.get(session_id).context;
  }

  isTracing(session_id: string): boolean {
    return this.get(session_id).tracing;
  }

  setTracing(session_id: string, on: boolean): void {
    this.get(session_id).tracing = on;
  }

  private nextAutoTabId(s: Session): string {
    for (let n = 2; n < 10000; n++) {
      const id = `tab${n}`;
      if (!s.pages.has(id)) return id;
    }
    return randomUUID();
  }

  private async reap() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.closing) continue;
      const idleAge = now - s.lastActiveAt;
      const wallAge = now - s.createdAt;
      if (idleAge > s.idleTTLMs) {
        await this.closeInternal(s, "idle_ttl").catch(() => null);
      } else if (wallAge > s.wallTTLMs) {
        await this.closeInternal(s, "wall_ttl").catch(() => null);
      }
    }
  }

  private async closeInternal(s: Session, reason: string): Promise<CloseResult> {
    if (s.closing) {
      return { session_id: s.id, closed_reason: reason, uptime_ms: Date.now() - s.createdAt };
    }
    s.closing = true;
    this.sessions.delete(s.id);

    // Capture video paths by closing each page first (that flushes video
    // frames), then the context, then the underlying server.
    const videos: string[] = [];
    if (s.recordVideo) {
      for (const page of s.pages.values()) {
        const vid = page.video();
        try { await page.close(); } catch { /* ignore */ }
        if (vid) {
          try {
            const p = await vid.path();
            if (p) videos.push(p);
          } catch { /* ignore */ }
        }
      }
    }

    if (s.isAttachCdp) {
      // FOOTGUN GUARD: never call browser.close() on attach_cdp sessions —
      // it sends Browser.close to the CDP target, which terminates the
      // attached Edge process. The user's real Edge (in explicit-endpoint
      // mode) or our isolated spawn (in auto_launch mode) must survive the
      // disconnect.
      //
      // Playwright does not expose a public disconnect on Browsers obtained
      // via connectOverCDP; the WebSocket simply tears down when the Browser
      // is GC'd or the process exits. Best we can do here is drop our
      // references and rely on cleanup() (auto_launch only) to kill the
      // procs we own. For explicit-endpoint mode, the user keeps Edge alive
      // and we just leak the WS for the remainder of this process.
      if (s.attachCdp) {
        try { await s.attachCdp.cleanup(); } catch { /* ignore */ }
      }
    } else {
      try { await s.context.close(); } catch { /* ignore */ }
      try { await s.browser.close(); } catch { /* ignore */ }
      if (s.server) {
        try { await s.server.close(); } catch { /* ignore */ }
      }
    }

    return {
      session_id: s.id,
      closed_reason: reason,
      videos: s.recordVideo ? videos : undefined,
      uptime_ms: Date.now() - s.createdAt,
    };
  }
}

export const sessionManager = new SessionManager();
