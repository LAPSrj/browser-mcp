import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { Browser, BrowserContext, BrowserServer, Page } from "playwright";
import { getBrowserType, type BrowserName } from "../utils/browser.js";

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

    const bt = getBrowserType(browserName);
    const server = await bt.launchServer({ headless: true });
    const browser = await bt.connect(server.wsEndpoint());

    let videoDir: string | undefined;
    if (recordVideo) {
      videoDir = path.join(outputDir, "videos", id);
      await fs.mkdir(videoDir, { recursive: true });
    }

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

    const context = await browser.newContext(contextOpts as any);
    context.setDefaultTimeout(30000);

    const page = await context.newPage();
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

    try { await s.context.close(); } catch { /* ignore */ }
    try { await s.browser.close(); } catch { /* ignore */ }
    if (s.server) {
      try { await s.server.close(); } catch { /* ignore */ }
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
