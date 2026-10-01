import path from "node:path";
import fs from "node:fs/promises";
import type { Browser, CDPSession, Download, Page } from "playwright";
import { isWindowsPath, isWsl, toLocalPath, winToWslPath } from "../utils/wsl.js";

// Tracks the files a session downloads and where they end up.
//
// attach_cdp: connectOverCDP sends Browser.setDownloadBehavior pointing the
// browser at a temp folder on the machine running browser-mcp, with files
// named by GUID. When the browser runs on Windows and browser-mcp in WSL,
// that folder is a Linux path the browser can't write to, and every download
// fails with "Couldn't download - Download error" (verified live on Edge).
// We switch the browser back to its own download settings (its Downloads
// folder, real filenames) and read where it saved each file from the
// Browser.downloadProgress events.
//
// Other sessions: Playwright keeps each download in a GUID-named temp file
// that is deleted with the session, so we copy it out under its real name.
//
// Ownership comes from Playwright's per-page "download" event, which only
// fires on pages this session tracks. That keeps a shared attach_cdp profile
// from mixing up downloads between sessions.

export type DownloadState = "in_progress" | "completed" | "failed";

export interface DownloadInfo {
  id: number;
  tab_id: string | null;
  url: string;
  suggested_filename: string;
  state: DownloadState;
  /** Absolute path of the saved file, openable by this process. */
  path?: string;
  /** The path as the browser reported it, when it differs from `path` (a Windows browser driven from WSL). */
  browser_path?: string;
  bytes?: number;
  error?: string;
  started_at: string;
  finished_at?: string;
}

interface BrowserReport {
  state: "completed" | "canceled";
  filePath?: string;
}

const MAX_RECORDS = 200;
const MAX_BROWSER_REPORTS = 500;
// The browser's progress event and Playwright's finished event arrive on
// different CDP sessions, in either order.
const BROWSER_REPORT_WAIT_MS = 5000;

export class DownloadTracker {
  private records: Array<DownloadInfo & { reported: boolean }> = [];
  private nextId = 1;
  private dir: string | undefined;
  private watched = new WeakSet<Page>();
  private listeners = new Set<() => void>();
  private cdp?: CDPSession;
  private browserReports = new Map<string, BrowserReport>();
  private closed = false;

  constructor(
    private readonly opts: {
      attachCdp: boolean;
      /** Where non-attach_cdp sessions save when no dir is set. */
      fallbackDir: string;
      tabIdOf: (page: Page) => string | null;
    },
  ) {}

  /**
   * attach_cdp only. Call right after connectOverCDP, before anything can
   * start a download. Keeps a CDP session open for the progress events.
   */
  async useBrowserDownloadSettings(browser: Browser): Promise<void> {
    const cdp = await browser.newBrowserCDPSession();
    cdp.on("Browser.downloadProgress", (e) => {
      if (e.state === "inProgress") return;
      this.browserReports.set(e.guid, { state: e.state, filePath: e.filePath });
      if (this.browserReports.size > MAX_BROWSER_REPORTS) {
        this.browserReports.delete(this.browserReports.keys().next().value!);
      }
      this.notify();
    });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
    this.cdp = cdp;
  }

  /** Folder downloads are saved into. null = the browser's own download folder (attach_cdp default). */
  downloadDir(): string | null {
    return this.dir ?? (this.opts.attachCdp ? null : this.opts.fallbackDir);
  }

  /** Set the folder for downloads that start from now on; undefined restores the default. */
  async setDir(input: string | undefined): Promise<string | null> {
    if (input === undefined || input.trim() === "") {
      this.dir = undefined;
    } else {
      const dir = toLocalPath(input.trim());
      await fs.mkdir(dir, { recursive: true });
      this.dir = dir;
    }
    return this.downloadDir();
  }

  watchPage(page: Page): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    page.on("download", (d) => {
      this.track(page, d).catch(() => { /* recorded on the entry */ });
    });
  }

  list(): DownloadInfo[] {
    return this.records.map(strip);
  }

  /**
   * The oldest download not yet returned by this method, once it finishes.
   * On timeout, returns it still in progress (and returns it again next
   * call), or null if no download has started.
   */
  async waitNext(timeoutMs: number): Promise<DownloadInfo | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.closed) throw new Error("Session closed while waiting for a download.");
      const next = this.records.find((r) => !r.reported);
      if (next && next.state !== "in_progress") {
        next.reported = true;
        return strip(next);
      }
      const left = deadline - Date.now();
      if (left <= 0) return next ? strip(next) : null;
      await this.changed(left);
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.notify();
    if (this.cdp) await this.cdp.detach().catch(() => {});
  }

  private async track(page: Page, d: Download): Promise<void> {
    const rec: DownloadInfo & { reported: boolean } = {
      id: this.nextId++,
      tab_id: this.opts.tabIdOf(page),
      url: d.url(),
      suggested_filename: d.suggestedFilename(),
      state: "in_progress",
      started_at: new Date().toISOString(),
      reported: false,
    };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) {
      const i = this.records.findIndex((r) => r.reported);
      this.records.splice(i >= 0 ? i : 0, 1);
    }
    // The folder in effect when the download started, not when it finished.
    const dir = this.dir;
    this.notify();
    try {
      const failure = await d.failure();
      if (failure) {
        rec.state = "failed";
        rec.error = failure;
      } else if (this.opts.attachCdp) {
        await this.locateBrowserFile(rec, d, dir);
      } else {
        await this.saveCopy(rec, d, dir ?? this.opts.fallbackDir);
      }
    } catch (e) {
      rec.state = "failed";
      rec.error = (e as Error).message;
    } finally {
      rec.finished_at = new Date().toISOString();
      this.notify();
    }
  }

  private async locateBrowserFile(rec: DownloadInfo, d: Download, dir: string | undefined): Promise<void> {
    // Playwright names its (unused) copy after the browser's download GUID.
    const guid = path.basename(await d.path());
    const report = await this.browserReport(guid);
    if (!report?.filePath) {
      rec.state = "completed";
      rec.error = "The browser finished the download but didn't report where it saved the file. Check its download folder.";
      return;
    }
    const browserPath = report.filePath;
    let local = isWsl() && isWindowsPath(browserPath) ? winToWslPath(browserPath) : browserPath;
    let moved = false;
    if (dir && path.dirname(local) !== dir) {
      try {
        local = await moveInto(local, dir);
        moved = true;
      } catch (e) {
        rec.error = `Saved, but couldn't move the file into ${dir}: ${(e as Error).message}`;
      }
    }
    if (!moved && browserPath !== local) rec.browser_path = browserPath;
    rec.path = local;
    rec.bytes = (await fs.stat(local)).size;
    rec.state = "completed";
  }

  private async saveCopy(rec: DownloadInfo, d: Download, dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const target = await reservePath(dir, rec.suggested_filename);
    try {
      await d.saveAs(target);
    } catch (e) {
      await fs.unlink(target).catch(() => {});
      throw e;
    }
    rec.path = target;
    rec.bytes = (await fs.stat(target)).size;
    rec.state = "completed";
  }

  private async browserReport(guid: string): Promise<BrowserReport | undefined> {
    const deadline = Date.now() + BROWSER_REPORT_WAIT_MS;
    for (;;) {
      const report = this.browserReports.get(guid);
      if (report) {
        this.browserReports.delete(guid);
        return report;
      }
      const left = deadline - Date.now();
      if (left <= 0 || this.closed) return undefined;
      await this.changed(left);
    }
  }

  private changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(done);
    });
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

function strip({ reported: _, ...info }: DownloadInfo & { reported: boolean }): DownloadInfo {
  return { ...info };
}

/**
 * Create an empty `name` in `dir`, or `name (1)`, `name (2)`… if taken, and
 * return its path. Creating it claims the name, so two downloads finishing
 * at once can't pick the same one.
 */
async function reservePath(dir: string, name: string): Promise<string> {
  let base = path.basename(name);
  if (!base || base === "." || base === "..") base = "download";
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? base : `${stem} (${n})${ext}`);
    try {
      await (await fs.open(candidate, "wx")).close();
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

async function moveInto(src: string, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const target = await reservePath(dir, path.basename(src));
  try {
    try {
      await fs.rename(src, target);
    } catch (e) {
      // /mnt/c → the WSL filesystem is a different device.
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      await fs.copyFile(src, target);
      await fs.unlink(src);
    }
  } catch (e) {
    await fs.unlink(target).catch(() => {});
    throw e;
  }
  return target;
}
