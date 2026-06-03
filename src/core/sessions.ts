import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from "playwright";
import { getBrowserType, type BrowserName } from "../utils/browser.js";
import { connectBrowserStack } from "../utils/browserstack.js";
import { forceKillProfile, spawnAttachCdpRelay, type AttachCdpHandle } from "../utils/cdp-relay.js";
import { readSidecar } from "../utils/browser-sidecar.js";
import { execFileSync } from "node:child_process";
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
  /**
   * Run this session on BrowserStack's cloud grid instead of a locally-launched
   * Playwright browser. The session is persistent and its session_id is reusable
   * across calls exactly like a local one. Mutually exclusive with attach_cdp.
   *
   * CEILING: BrowserStack tears the remote session down after 300s (5 min) of
   * inactivity — its server-side idle timeout, the maximum the platform allows
   * (set in connectBrowserStack). A session left untouched past that is killed
   * BrowserStack-side regardless of this session's idle_ttl_ms; the next tool
   * call then surfaces a disconnect. Keep the session active (any tool call
   * within ~5 min) to hold it open. record_video is not supported (Playwright's
   * video API needs a locally-launched context, not a remote connect()).
   */
  useBrowserStack?: boolean;
  /** BrowserStack desktop OS (e.g. "Windows", "OS X"). useBrowserStack only, no device. Default Windows 11. */
  browserStackOs?: string;
  /** BrowserStack OS/device version (desktop "11"/"Sequoia"…, or the iOS version e.g. "17" for a real device). useBrowserStack only. */
  browserStackOsVersion?: string;
  /** Real BrowserStack device name (e.g. "iPhone 15 Pro Max"). When set, the session runs on a real device — real iOS Safari. useBrowserStack only. */
  browserStackDevice?: string;
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
  /** True when this session runs on a real BrowserStack device (useBrowserStack + browserStackDevice). Real iOS Safari does not surface a file-chooser event to automation, so click_to_upload fast-fails on these. */
  isBrowserStackRealDevice: boolean;
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

    if (opts.useBrowserStack && opts.attach_cdp) {
      throw new Error(
        "useBrowserStack and attach_cdp are mutually exclusive — BrowserStack runs a remote cloud browser, attach_cdp attaches to a local Chromium-channel browser. Pick one.",
      );
    }

    const browserName = opts.browser ?? "chromium";
    const outputDir = opts.output_dir ?? ".browser";
    const recordVideo = opts.record_video === true;

    if (opts.useBrowserStack && recordVideo) {
      throw new Error(
        "record_video is not supported on BrowserStack sessions — Playwright's video API requires a locally-launched context, not a remote connect(). Use BrowserStack's own session video in its dashboard.",
      );
    }
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
          restorePreviousTabs: opts.restore_previous_tabs === true,
        });
        browser = await chromium.connectOverCDP(attachCdp.endpoint);
      }
    } else if (opts.useBrowserStack) {
      // BrowserStack cloud grid. connectBrowserStack returns a connect()'d
      // Browser (no BrowserServer). A device name routes to a real mobile
      // device (real iOS Safari); otherwise a desktop OS host. The remote
      // session ends when we browser.close() in the non-attach close path.
      browser = await connectBrowserStack({
        browser: browserName,
        os: opts.browserStackOs,
        osVersion: opts.browserStackOsVersion,
        device: opts.browserStackDevice,
      });
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
      context.setDefaultTimeout(30000);

      const attachedToExisting = attachCdp?.attachedVia === "existing";

      if (attachedToExisting) {
        // Multi-server mode: another browser-mcp session is already attached
        // to this profile and may own existing tabs in the shared context.
        // DON'T inherit any existing page — create a fresh one. The owner-
        // ship filter on context.on('page') (added below) will keep our
        // session.pages clean of other servers' tabs going forward.
        page = await context.newPage();
        // restore_previous_tabs cleanup is also skipped — those "previous"
        // tabs may be another active session's current work.
      } else {
        // Single-server / spawn path: behavior unchanged from before.
        const existingPages = context.pages();
        page = existingPages[0] ?? (await context.newPage());

        // Default: don't let Chromium's session-restore tabs leak into the
        // agent's view. When attaching to a profile that has saved session
        // state (the common case for persistent per-agent profiles), Edge
        // reopens every previous tab on top of the startup URL we asked for.
        // The agent then has to disambiguate "did I open this or did the
        // last run?" Opt in with restore_previous_tabs:true if you want
        // those tabs back. Skipped on attached-to-existing — those tabs may
        // belong to OTHER active sessions.
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
      }
    } else if (opts.useBrowserStack) {
      // BrowserStack: mirror the proven ephemeral path (utils/browser.ts).
      // Pass ONLY viewport + storageState — deliberately NOT user_agent /
      // locale / timezone, so a real device keeps its genuine platform UA
      // (the whole point of a real-iOS session is the real iOS Safari UA).
      const contextOpts: Record<string, unknown> = {};
      if (viewport) contextOpts.viewport = viewport;
      if (opts.storageState) contextOpts.storageState = opts.storageState;
      context = await browser.newContext(contextOpts as any);
      // Real devices boot slowly — first navigation can far exceed a local
      // browser, so give the context a generous default (matches ephemeral).
      context.setDefaultTimeout(opts.browserStackDevice ? 120000 : 30000);
      page = await context.newPage();
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
      isBrowserStackRealDevice: !!(opts.useBrowserStack && opts.browserStackDevice),
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

    // Auto-track popup tabs. Without this, target="_blank" links and
    // window.open() calls create new Pages in the BrowserContext that our
    // session.pages map never learns about — list_tabs / switch_tab go
    // blind to them and the agent has to fall back to evaluate_script
    // window.open hacks. context.on('page') catches every popup;
    // page.on('close') catches external closes (user X-button, page.close).
    //
    // Multi-server safety: in shared-profile mode another browser-mcp
    // server may be attached to the same context. Its tabs (and the
    // popups it opens) fire 'page' events on OUR listener too. Use
    // Page.opener() — the browser's own parent-child tracking — to claim
    // only popups whose opener is a page in OUR session.pages map.
    // Pages with no opener (rel=noopener, or sibling-server's main tabs
    // surfaced at attach time) are not claimed.
    this.attachPageLifecycle(session, page, "main");
    context.on("page", (popupPage) => {
      // De-dup against addTab's pre-registration. addTab calls
      // context.newPage() then synchronously inserts the new Page under
      // a caller-chosen tab_id; the 'page' event for that creation fires
      // microtasks later. If our session.pages already references this
      // Page object, addTab already claimed it.
      for (const p of session.pages.values()) {
        if (p === popupPage) return;
      }
      // Opener-based ownership: only claim popups whose opener is a tab
      // WE own. context.on('page') fires on every server attached to the
      // shared context, but Page.opener() resolves locally to each
      // server's Playwright connection — only the server that owns the
      // opening page sees opener as one of its own session.pages.
      const opener = popupPage.opener?.() ?? null;
      Promise.resolve(opener).then((resolvedOpener) => {
        if (!resolvedOpener) return; // rel=noopener, or sibling server's tab — leave as orphan
        let isOurs = false;
        for (const p of session.pages.values()) {
          if (p === resolvedOpener) { isOurs = true; break; }
        }
        if (!isOurs) return;
        // Belated re-check the dedup in case addTab claimed during the await
        for (const p of session.pages.values()) {
          if (p === popupPage) return;
        }
        const tid = this.nextAutoTabId(session);
        session.pages.set(tid, popupPage);
        session.pageOrder.push(tid);
        // Do NOT auto-switch activeTabId — leave that to the caller via
        // switch_tab. The agent gets visibility (list_tabs surfaces it)
        // but explicit-attention semantics stay intact.
        this.attachPageLifecycle(session, popupPage, tid);
      }).catch(() => { /* opener() can reject if the page closed mid-resolve; ignore */ });
    });

    return this.info(session);
  }

  /**
   * Wire a Page's close lifecycle into the session so external closes
   * (popup user-X, page.close() from script) automatically prune the
   * session's pages map + pageOrder + reselect activeTabId if needed.
   */
  private attachPageLifecycle(session: Session, page: Page, tabId: string): void {
    page.on("close", () => {
      if (session.closing) return; // closeInternal handles its own teardown
      session.pages.delete(tabId);
      session.pageOrder = session.pageOrder.filter((t) => t !== tabId);
      if (session.activeTabId === tabId) {
        // Fall back to the most-recently-added remaining tab, or "main"
        // if everything is gone (the session will get reaped soon).
        session.activeTabId = session.pageOrder[session.pageOrder.length - 1] ?? "main";
      }
    });
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
   * Force-nuke the entire browser tree for an attach_cdp session — even
   * if other browser-mcp servers are attached. Polite default (`force:
   * false`) refuses if siblings are attached and tells the caller to
   * close their own session normally (auto last-out will handle the
   * common case). Force mode taskkills the shared browser and removes
   * the sidecar; other servers' sessions become abandoned-but-running
   * until they discover the CDP disconnect on their next tool call.
   *
   * Use force when you really need the profile gone (recovery from a
   * weird browser state, clearing for a fresh start). Plain close_session
   * is the right move 99% of the time.
   */
  async closeBrowser(id: string, force = false): Promise<{
    session_id: string;
    killed: boolean;
    force_used: boolean;
    other_sessions_abandoned: number;
    own_sessions_closed: string[];
    reason?: string;
  }> {
    const s = this.get(id);
    if (!s.isAttachCdp || !s.attachCdp) {
      throw new Error(
        `close_browser: session "${id}" is not an attach_cdp session. ` +
          `For Playwright-launched sessions, plain close_session is the correct teardown.`,
      );
    }

    const userDataDirWin = s.attachCdp.userDataDir;
    const userDataDirWsl = isWsl()
      ? execFileSync("/usr/bin/wslpath", ["-u", userDataDirWin], { encoding: "utf8" }).trim()
      : userDataDirWin;
    const sidecar = readSidecar(userDataDirWsl);

    // No sidecar — fall back to plain close. There's nothing to "force".
    if (!sidecar) {
      const closed = await this.closeInternal(s, "close_browser");
      return {
        session_id: id,
        killed: true,
        force_used: false,
        other_sessions_abandoned: 0,
        own_sessions_closed: [closed.session_id],
      };
    }

    const ourPid = process.pid;
    const otherServers = sidecar.attached_sessions.filter((a) => a.browser_mcp_pid !== ourPid);
    if (otherServers.length > 0 && !force) {
      return {
        session_id: id,
        killed: false,
        force_used: false,
        other_sessions_abandoned: 0,
        own_sessions_closed: [],
        reason:
          `refused: ${otherServers.length} other browser-mcp server(s) are still attached to this browser. ` +
          `Use close_session (last-out auto-kills when they all leave), or pass force:true to nuke anyway ` +
          `(their sessions will be abandoned — their next tool call will surface a CDP disconnect).`,
      };
    }

    // Close all OUR sessions attached to this same user_data_dir first, so
    // Playwright drops its references cleanly before the browser dies.
    const ourSessionsHere: Session[] = [];
    for (const sx of this.sessions.values()) {
      if (sx.isAttachCdp && sx.attachCdp && !sx.closing && sx.attachCdp.userDataDir === userDataDirWin) {
        ourSessionsHere.push(sx);
      }
    }
    const ownClosedIds: string[] = [];
    for (const sx of ourSessionsHere) {
      try {
        const r = await this.closeInternal(sx, "close_browser");
        ownClosedIds.push(r.session_id);
      } catch { /* best-effort */ }
    }

    // If force was needed (others were attached when we started), our
    // closeInternal -> handle.cleanup -> removeSession dance may have left
    // the browser alive because was_last:false. Drop the hammer.
    let abandoned = 0;
    if (force && otherServers.length > 0) {
      const result = await forceKillProfile(userDataDirWin);
      abandoned = result.abandoned_sessions;
    }

    return {
      session_id: id,
      killed: true,
      force_used: force && otherServers.length > 0,
      other_sessions_abandoned: abandoned,
      own_sessions_closed: ownClosedIds,
    };
  }

  /**
   * Read-only snapshot of a shared-profile's coordination state, from
   * this session's perspective. Returns the sidecar's view (root_pid,
   * cdp_port, attached_sessions[]) plus counts of own-tabs vs orphans
   * visible to this agent. Useful when debugging "which session owns
   * this tab" in multi-agent scenarios.
   */
  async browserStatus(session_id: string): Promise<{
    session_id: string;
    is_attach_cdp: boolean;
    attached_via: "spawn" | "existing" | "adopted" | null;
    user_data_dir: string | null;
    sidecar: {
      cdp_port: number;
      relay_port: number | null;
      root_pid: number;
      process_name: string;
      spawned_at: string;
      attached_sessions: Array<{ session_id: string; browser_mcp_pid: number; attached_at: string }>;
    } | null;
    own_tabs_count: number;
    orphan_tabs_count: number;
    peer_count: number;
    this_browser_mcp_pid: number;
  }> {
    const s = this.get(session_id);
    if (!s.isAttachCdp || !s.attachCdp) {
      return {
        session_id,
        is_attach_cdp: false,
        attached_via: null,
        user_data_dir: null,
        sidecar: null,
        own_tabs_count: s.pages.size,
        orphan_tabs_count: 0,
        peer_count: 0,
        this_browser_mcp_pid: process.pid,
      };
    }
    const userDataDirWin = s.attachCdp.userDataDir;
    const userDataDirWsl = isWsl()
      ? execFileSync("/usr/bin/wslpath", ["-u", userDataDirWin], { encoding: "utf8" }).trim()
      : userDataDirWin;
    const sidecar = readSidecar(userDataDirWsl);
    const ownPages = new Set<Page>();
    for (const sx of this.sessions.values()) {
      if (!sx.closing && sx.context === s.context) {
        for (const p of sx.pages.values()) ownPages.add(p);
      }
    }
    const allPages = s.context.pages();
    const orphanCount = allPages.filter((p) => !ownPages.has(p)).length;
    const peerCount = sidecar
      ? sidecar.attached_sessions.filter((a) => a.browser_mcp_pid !== process.pid).length
      : 0;
    return {
      session_id,
      is_attach_cdp: true,
      attached_via: s.attachCdp.attachedVia,
      user_data_dir: userDataDirWin,
      sidecar: sidecar
        ? {
            cdp_port: sidecar.cdp_port,
            relay_port: sidecar.relay_port,
            root_pid: sidecar.root_pid,
            process_name: sidecar.process_name,
            spawned_at: sidecar.spawned_at,
            attached_sessions: sidecar.attached_sessions,
          }
        : null,
      own_tabs_count: s.pages.size,
      orphan_tabs_count: orphanCount,
      peer_count: peerCount,
      this_browser_mcp_pid: process.pid,
    };
  }

  /**
   * Take ownership of an unowned tab in the shared browser context.
   * Useful for rel="noopener" popups (opener is null, so the
   * context.on('page') filter doesn't auto-claim them) and for tabs
   * that pre-existed before our session attached.
   *
   * Matches by URL pattern (substring or `/regex/flags` form). Returns
   * the new tab_id under which the page is now tracked, or throws if
   * no unowned page matches.
   */
  async claimTab(opts: {
    session_id: string;
    url_pattern: string;
    target_index?: number;
  }): Promise<{ tab_id: string; url: string }> {
    const s = this.get(opts.session_id);
    const allPages = s.context.pages();

    // Determine which pages this Node's SessionManager already owns
    // (across all our sessions on this BrowserContext, not just this one).
    const ownedPages = new Set<Page>();
    for (const sx of this.sessions.values()) {
      if (!sx.closing && sx.context === s.context) {
        for (const p of sx.pages.values()) ownedPages.add(p);
      }
    }
    const unowned = allPages.filter((p) => !ownedPages.has(p));

    // Match by URL pattern. /…/flags = regex; else substring.
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(opts.url_pattern);
    const re = m ? new RegExp(m[1], m[2]) : null;
    const candidates = unowned.filter((p) => {
      const url = p.url();
      return re ? re.test(url) : url.includes(opts.url_pattern);
    });

    if (candidates.length === 0) {
      throw new Error(
        `claim_tab: no unowned page matches "${opts.url_pattern}". ` +
          `Unowned page URLs in this context: ${unowned.map((p) => p.url()).join(", ") || "(none)"}.`,
      );
    }

    const idx = opts.target_index ?? 0;
    if (idx >= candidates.length) {
      throw new Error(`claim_tab: target_index ${idx} out of range (${candidates.length} matches)`);
    }
    const page = candidates[idx];

    const tid = this.nextAutoTabId(s);
    s.pages.set(tid, page);
    s.pageOrder.push(tid);
    this.attachPageLifecycle(s, page, tid);
    this.touch(opts.session_id);
    return { tab_id: tid, url: page.url() };
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
    // newPage() fires context.on('page') — but that handler would auto-assign
    // a tab id from nextAutoTabId() (potentially a different one than the
    // caller-supplied tab_id). Pre-seed the map with our chosen tid so the
    // context handler sees it already exists and skips re-tracking.
    const page = await s.context.newPage();
    // The context.on('page') handler already registered this page under a
    // freshly-allocated auto tab id. Re-key it under the caller's chosen id.
    let autoTid: string | undefined;
    for (const [k, v] of s.pages.entries()) {
      if (v === page) { autoTid = k; break; }
    }
    if (autoTid && autoTid !== tid) {
      s.pages.delete(autoTid);
      s.pageOrder = s.pageOrder.filter((t) => t !== autoTid);
    }
    s.pages.set(tid, page);
    if (!s.pageOrder.includes(tid)) s.pageOrder.push(tid);
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

  /** True when the session runs on a real BrowserStack device (real iOS Safari). */
  isBrowserStackRealDevice(session_id: string): boolean {
    return this.get(session_id).isBrowserStackRealDevice;
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
