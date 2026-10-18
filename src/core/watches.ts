import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OpenSessionOptions } from "./sessions.js";

// Page watches that outlive the agent, the MCP server and a reboot.
//
// watch_page saves a watch folder (~/.browser-mcp/watches/<name>/) with the
// page, the selector and the session's open options, and returns a command.
// `browser-mcp watch --name=<name>` starts a background watcher process for
// it when none is running (the first run, after a crash, after a reboot),
// prints the events the last run didn't print, and exits. The watcher opens
// its own session on the same profile, so it stays logged in, and writes
// events to the folder's events.jsonl.
//
// A MutationObserver only reports changes made after it starts, and a
// restarted watcher must not report the whole page as new. So state.json keeps
// what the agent was last told about: a count per message text (items mode)
// or the last value (value mode), plus the title. Each snapshot of the page
// is compared to it, including the first one after a restart, which reports
// what changed while no watcher was running.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TEXT = 2000;
const MAX_ITEMS = 500;
const MAX_SEEN = 5000;
/** Wait after a DOM change before taking a snapshot, so a burst of changes is one snapshot. */
const DEBOUNCE_MS = 400;
/** Snapshot at least this often, for changes the observer misses and for the login check. */
const HEARTBEAT_MS = 5000;
/** How long a started watcher gets to load the page and report the first snapshot. */
const START_TIMEOUT_MS = 120_000;

export interface WatchConfig {
  /** CSS selector for the items (items mode) or the element (value mode). null watches only title and notifications. */
  selector: string | null;
  mode: "items" | "value";
  title: boolean;
  notifications: boolean;
  /** CSS selector that exists only while logged in. */
  logged_in_selector: string | null;
}

export interface WatchSpec {
  version: 1;
  name: string;
  created_at: string;
  url: string;
  config: WatchConfig;
  /** Substring or /regex/flags of the URL the site sends a logged-out visitor to. */
  logged_out_url: string | null;
  /** Reload the page this often, for sites that only update on reload. */
  reload_ms: number | null;
  /** open_session options the watcher reopens the session with. */
  open: OpenSessionOptions;
  /** BROWSER_MCP_* variables of the process that created the watch, so a later run from another shell opens the same browser. */
  env: Record<string, string>;
  /** storage.json holds the session's cookies and storage (Playwright-launched sessions only). */
  has_storage: boolean;
}

export interface WatchState {
  version: 1;
  /** Highest count of each text (hashed) seen on the page at one time. */
  seen: Record<string, number>;
  /** Hashes in the order first seen, to drop the oldest past MAX_SEEN. */
  seen_order: string[];
  value: string | null;
  title: string | null;
  last_seq: number;
}

export interface Snapshot {
  items: string[];
  title: string;
  url: string;
  logged_in: boolean;
}

export type WatchEventBody =
  | { type: "added"; text: string }
  | { type: "changed"; from: string | null; to: string }
  | { type: "title"; from: string; to: string }
  | { type: "notification"; title: string; body: string }
  | { type: "prompt"; kind: string; message: string; answer: "dismissed" }
  | { type: "ended"; reason: "logged_out" | "browser_closed" | "error"; message: string };

export type WatchEvent = WatchEventBody & { seq: number; time: string; url?: string };

export interface WatchStatus {
  state: "starting" | "ready" | "ended";
  pid: number;
  at: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// In-page code
// ---------------------------------------------------------------------------

/** The document and every open shadow root in it (chat apps often render their UI in one). */
const ROOTS_FN = `function () {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const w = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.shadowRoot) roots.push(n.shadowRoot);
  }
  return roots;
}`;

/** Reads the page. Shared by watch_page's first snapshot and the watcher's page script. */
const SNAPSHOT_FN = `function (cfg, roots) {
  const norm = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, ${MAX_TEXT});
  const all = (sel) => roots.flatMap((r) => Array.from(r.querySelectorAll(sel)));
  let items = [];
  if (cfg.selector) {
    items = all(cfg.selector)
      .map((e) => norm(e.innerText != null ? e.innerText : e.textContent))
      .filter(Boolean);
    if (items.length > ${MAX_ITEMS}) items = items.slice(-${MAX_ITEMS});
  }
  return {
    items,
    title: document.title,
    url: location.href,
    logged_in: cfg.logged_in_selector ? roots.some((r) => r.querySelector(cfg.logged_in_selector)) : true,
  };
}`;

/** Expression that returns one snapshot of the page. Throws on an invalid selector. */
export function snapshotExpression(cfg: WatchConfig): string {
  return `(${SNAPSHOT_FN})(${JSON.stringify(cfg)}, (${ROOTS_FN})())`;
}

/**
 * Init script for the watcher's page: reports a snapshot after DOM changes
 * and every few seconds, and reports the site's desktop notifications.
 * Main frame only. Each report is console.debug(marker, JSON), from the
 * page's original console.debug (see utils/internal-console.ts).
 */
export function watchScript(cfg: WatchConfig, marker: string): string {
  return `(() => {
  if (window.top !== window || window.__browserMcpWatchInstalled) return;
  Object.defineProperty(window, "__browserMcpWatchInstalled", { value: true });
  const cfg = ${JSON.stringify(cfg)};
  const snapshot = ${SNAPSHOT_FN};
  const findRoots = ${ROOTS_FN};
  const started = Date.now();
  const debug = console.debug.bind(console);
  const send = (m) => {
    try { debug(${JSON.stringify(marker)}, JSON.stringify(m)); } catch {}
  };
  let timer = null;
  const observing = new WeakSet();
  const opts = { childList: true, subtree: true, characterData: true };
  const report = () => {
    timer = null;
    let s;
    try {
      const roots = findRoots();
      // A document observer doesn't see changes inside shadow roots.
      for (const r of roots) if (r !== document && !observing.has(r)) { observing.add(r); mo.observe(r, opts); }
      s = snapshot(cfg, roots);
    } catch (e) { s = { error: String((e && e.message) || e) }; }
    send(Object.assign({ type: "snapshot", age_ms: Date.now() - started }, s));
  };
  const schedule = () => { if (!timer) timer = setTimeout(report, ${DEBOUNCE_MS}); };
  const mo = new MutationObserver(schedule);
  const observe = () => {
    mo.observe(document.documentElement, opts);
    schedule();
  };
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });
  setInterval(schedule, ${HEARTBEAT_MS});

  if (cfg.notifications) {
    const told = (title, options) => send({
      type: "notification",
      title: String(title),
      body: options && options.body != null ? String(options.body) : "",
    });
    const N = window.Notification;
    if (typeof N === "function") {
      const Wrapped = function Notification(title, options) {
        told(title, options);
        return new N(title, options);
      };
      Wrapped.prototype = N.prototype;
      Object.defineProperty(Wrapped, "permission", { get: () => N.permission });
      Object.defineProperty(Wrapped, "maxActions", { get: () => N.maxActions });
      Wrapped.requestPermission = function (...args) { return N.requestPermission.apply(N, args); };
      window.Notification = Wrapped;
    }
    const R = window.ServiceWorkerRegistration;
    if (R && typeof R.prototype.showNotification === "function") {
      const show = R.prototype.showNotification;
      R.prototype.showNotification = function (title, options) {
        told(title, options);
        return show.call(this, title, options);
      };
    }
  }
})();`;
}

// ---------------------------------------------------------------------------
// Comparing a snapshot with the saved state
// ---------------------------------------------------------------------------

export function emptyState(): WatchState {
  return { version: 1, seen: {}, seen_order: [], value: null, title: null, last_seq: 0 };
}

const hashText = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

/**
 * Update the state from a snapshot and return what changed since the agent
 * was last told. With baseline, the state takes the snapshot as is and
 * nothing is reported.
 *
 * Items mode reports a text when it appears on the page more times than it
 * ever did before, so a second identical message ("ok") is reported and a
 * message the page re-renders (scrolling, a reload) isn't.
 */
export function diffSnapshot(
  cfg: WatchConfig,
  state: WatchState,
  snap: Snapshot,
  baseline = false,
): WatchEventBody[] {
  const events: WatchEventBody[] = [];
  if (cfg.selector && cfg.mode === "items") {
    const onPage = new Map<string, number>();
    for (const text of snap.items) {
      const h = hashText(text);
      const n = (onPage.get(h) ?? 0) + 1;
      onPage.set(h, n);
      if (n <= (state.seen[h] ?? 0)) continue;
      if (!(h in state.seen)) state.seen_order.push(h);
      state.seen[h] = n;
      if (!baseline) events.push({ type: "added", text });
    }
    while (state.seen_order.length > MAX_SEEN) delete state.seen[state.seen_order.shift()!];
  } else if (cfg.selector) {
    // A missing element (still loading, re-rendering) isn't a change.
    const value = snap.items[0];
    if (value !== undefined && value !== state.value) {
      if (!baseline) events.push({ type: "changed", from: state.value, to: value });
      state.value = value;
    }
  }
  if (cfg.title && snap.title !== state.title) {
    if (!baseline && state.title !== null) events.push({ type: "title", from: state.title, to: snap.title });
    state.title = snap.title;
  }
  return events;
}

/** Substring, or /regex/flags. */
export function urlMatches(pattern: string, url: string): boolean {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  return m ? new RegExp(m[1], m[2]).test(url) : url.includes(pattern);
}

// ---------------------------------------------------------------------------
// Watch folder
// ---------------------------------------------------------------------------

export function watchesRoot(): string {
  return process.env.BROWSER_MCP_WATCH_DIR || path.join(os.homedir(), ".browser-mcp", "watches");
}

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`Watch name must be 1-64 letters, digits, "-" or "_", starting with a letter or digit (got ${JSON.stringify(name)}).`);
  }
  return name;
}

export function watchPaths(name: string) {
  const dir = path.join(watchesRoot(), checkName(name));
  return {
    dir,
    spec: path.join(dir, "watch.json"),
    state: path.join(dir, "state.json"),
    storage: path.join(dir, "storage.json"),
    events: path.join(dir, "events.jsonl"),
    cursor: path.join(dir, "cursor.json"),
    pid: path.join(dir, "watcher.pid"),
    status: path.join(dir, "status.json"),
    log: path.join(dir, "watcher.log"),
    startLock: path.join(dir, "start.lock"),
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write through a temp file and rename, so a crash never leaves half a file. */
function writeJson(file: string, value: unknown, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export function readSpec(name: string): WatchSpec | null {
  return readJson<WatchSpec>(watchPaths(name).spec);
}

export function readState(name: string): WatchState {
  return readJson<WatchState>(watchPaths(name).state) ?? emptyState();
}

export function writeState(name: string, state: WatchState): void {
  writeJson(watchPaths(name).state, state);
}

export function readStorage(name: string): object | undefined {
  return readJson<object>(watchPaths(name).storage) ?? undefined;
}

export function writeStatus(name: string, status: Omit<WatchStatus, "pid" | "at">): void {
  writeJson(watchPaths(name).status, { ...status, pid: process.pid, at: new Date().toISOString() });
}

/** Create or replace a watch: stop its watcher and start over with a fresh state and events log. */
export async function createWatch(
  spec: WatchSpec,
  state: WatchState,
  storage: object | undefined,
): Promise<void> {
  const p = watchPaths(spec.name);
  if (fs.existsSync(p.dir)) await removeWatch(spec.name);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  // Cookies and tokens: readable by the user only.
  if (storage) writeJson(p.storage, storage, 0o600);
  writeJson(p.state, state);
  writeJson(p.spec, spec);
}

export function listWatchNames(): string[] {
  try {
    return fs
      .readdirSync(watchesRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && fs.existsSync(path.join(watchesRoot(), d.name, "watch.json")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Append events with the next sequence numbers. Watcher process only. */
export function appendEvents(name: string, state: WatchState, bodies: WatchEventBody[], url?: string): WatchEvent[] {
  if (bodies.length === 0) return [];
  const time = new Date().toISOString();
  const events = bodies.map((b) => ({ seq: ++state.last_seq, time, ...(url ? { url } : {}), ...b }) as WatchEvent);
  fs.appendFileSync(watchPaths(name).events, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return events;
}

export function readEvents(name: string, afterSeq: number): WatchEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(watchPaths(name).events, "utf8");
  } catch {
    return [];
  }
  const out: WatchEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as WatchEvent;
      if (e.seq > afterSeq) out.push(e);
    } catch {
      // a line the watcher was writing when it was killed
    }
  }
  return out;
}

export function readCursor(name: string): number {
  return readJson<{ seq: number }>(watchPaths(name).cursor)?.seq ?? 0;
}

function writeCursor(name: string, seq: number): void {
  writeJson(watchPaths(name).cursor, { seq });
}

// ---------------------------------------------------------------------------
// Watcher process
// ---------------------------------------------------------------------------

/** The watcher's pid when its process is running, else null. */
export function runningPid(name: string): number | null {
  const rec = readJson<{ pid: number }>(watchPaths(name).pid);
  if (!rec || !Number.isInteger(rec.pid)) return null;
  try {
    process.kill(rec.pid, 0);
  } catch (e) {
    // EPERM: alive but someone else's process, so not our watcher.
    return null;
  }
  // After a reboot the old pid can belong to an unrelated process.
  try {
    const cmd = fs.readFileSync(`/proc/${rec.pid}/cmdline`, "utf8").split("\0");
    if (!cmd.includes("watch-run") || !cmd.includes(`--name=${name}`)) return null;
  } catch {
    if (fs.existsSync("/proc/self/cmdline")) return null; // process ended in between
  }
  return rec.pid;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENTRY = fileURLToPath(new URL("../index.js", import.meta.url));

export interface EnsureResult {
  pid: number | null;
  started: boolean;
  /** Set when the watcher failed to start or ended right away (e.g. logged out). */
  error?: string;
}

/**
 * Start the watch's watcher process unless one is running, and wait until it
 * has compared the page with the saved state (so what changed while it was
 * down is already in the events log). A lock file keeps two callers from
 * starting two watchers.
 */
export async function ensureWatcher(name: string, timeoutMs = START_TIMEOUT_MS): Promise<EnsureResult> {
  const p = watchPaths(name);
  const spec = readSpec(name);
  if (!spec) throw new Error(`No watch named "${name}".`);

  const deadline = Date.now() + timeoutMs;
  let lock: number | null = null;
  while (lock === null) {
    const pid = runningPid(name);
    if (pid) return { pid, started: false };
    try {
      lock = fs.openSync(p.startLock, "wx");
      fs.writeSync(lock, String(process.pid));
    } catch {
      // Another caller is starting it. A lock older than the start timeout is left from a crash.
      try {
        if (Date.now() - fs.statSync(p.startLock).mtimeMs > START_TIMEOUT_MS + 10_000) fs.rmSync(p.startLock, { force: true });
      } catch { /* removed in between */ }
      if (Date.now() > deadline) return { pid: null, started: false, error: "another run is still starting the watcher" };
      await sleep(250);
    }
  }

  try {
    const pid = runningPid(name);
    if (pid) return { pid, started: false };
    fs.rmSync(p.status, { force: true });
    const log = fs.openSync(p.log, "a");
    const child = spawn(process.execPath, [ENTRY, "watch-run", `--name=${name}`], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...spec.env, BROWSER_MCP_WATCH_DIR: watchesRoot() },
    });
    fs.closeSync(log);
    let exited: number | null = null;
    child.on("exit", (code) => { exited = code ?? 1; });
    child.unref();

    while (Date.now() < deadline) {
      const status = readJson<WatchStatus>(p.status);
      if (status && status.pid === child.pid) {
        if (status.state === "ready") return { pid: child.pid!, started: true };
        if (status.state === "ended") return { pid: null, started: true, error: status.error ?? "the watcher ended" };
      }
      if (exited !== null) {
        return { pid: null, started: true, error: `the watcher exited (code ${exited}) before it was ready; see ${p.log}` };
      }
      await sleep(250);
    }
    return { pid: child.pid ?? null, started: true, error: `the watcher was still loading the page after ${Math.round(timeoutMs / 1000)}s; see ${p.log}` };
  } finally {
    fs.closeSync(lock);
    fs.rmSync(p.startLock, { force: true });
  }
}

/** Stop the watch's watcher, if running. Resolves once the process is gone. */
export async function stopWatcher(name: string): Promise<boolean> {
  const pid = runningPid(name);
  if (!pid) return false;
  try { process.kill(pid, "SIGTERM"); } catch { return false; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(200);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  return true;
}

export async function removeWatch(name: string): Promise<{ removed: boolean; stopped: boolean }> {
  const p = watchPaths(name);
  if (!fs.existsSync(p.dir)) return { removed: false, stopped: false };
  const stopped = await stopWatcher(name);
  fs.rmSync(p.dir, { recursive: true, force: true });
  return { removed: true, stopped };
}

export function watchCommand(name: string): string {
  return `browser-mcp watch --name=${name}`;
}

export interface WatchSummary {
  name: string;
  url: string;
  selector: string | null;
  mode: WatchConfig["mode"];
  running: boolean;
  pid: number | null;
  unread: number;
  last_event: WatchEvent | null;
  command: string;
}

export function summarizeWatch(name: string): WatchSummary | null {
  const spec = readSpec(name);
  if (!spec) return null;
  const pid = runningPid(name);
  const all = readEvents(name, 0);
  const cursor = readCursor(name);
  return {
    name,
    url: spec.url,
    selector: spec.config.selector,
    mode: spec.config.mode,
    running: pid !== null,
    pid,
    unread: all.filter((e) => e.seq > cursor).length,
    last_event: all[all.length - 1] ?? null,
    command: watchCommand(name),
  };
}

// ---------------------------------------------------------------------------
// CLI: browser-mcp watch / unwatch
// ---------------------------------------------------------------------------

type Verdict = "EVENTS" | "NONE" | "TIMEOUT" | "ENDED" | "ERROR";
const EXIT: Record<Verdict, number> = { EVENTS: 0, NONE: 0, TIMEOUT: 2, ENDED: 3, ERROR: 1 };

function finish(verdict: Verdict, note?: string): number {
  if (note) console.error(note);
  console.log(`VERDICT: ${verdict}`);
  return EXIT[verdict];
}

/** Print events after the reader's position and move the position past them. */
function printUnread(name: string): WatchEvent[] {
  const events = readEvents(name, readCursor(name));
  for (const e of events) console.log(JSON.stringify(e));
  if (events.length) writeCursor(name, events[events.length - 1].seq);
  return events;
}

const endedIn = (events: WatchEvent[]) => events.some((e) => e.type === "ended");

/**
 * `browser-mcp watch --name=<name> [--wait] [--timeout=<ms>] [--follow]`
 *
 * Starts the watcher if it isn't running, prints each unread event as a JSON
 * line, and ends with `VERDICT: EVENTS | NONE | TIMEOUT | ENDED | ERROR`
 * (exit 0 / 0 / 2 / 3 / 1). --wait waits for the first event when there are
 * none; --follow keeps printing events until the watch ends.
 */
export async function runWatchCli(command: string, params: Record<string, unknown>): Promise<number> {
  // parseArgs reads --name=123 as a number.
  if (typeof params.name === "number") params.name = String(params.name);
  if (command === "unwatch") {
    const name = checkName(params.name);
    const r = await removeWatch(name);
    console.log(JSON.stringify({ name, ...r }));
    return r.removed ? 0 : 1;
  }

  if (params.name === undefined) {
    const watches = listWatchNames().map(summarizeWatch).filter(Boolean);
    console.log(JSON.stringify(watches, null, 2));
    return 0;
  }
  const name = checkName(params.name);
  if (!readSpec(name)) {
    const names = listWatchNames();
    return finish("ERROR", `No watch named "${name}". ${names.length ? `Watches: ${names.join(", ")}.` : "There are no watches."} Create one with the watch_page tool.`);
  }
  const wait = params.wait === true || params.follow === true;
  const follow = params.follow === true;
  const timeout = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : null;
  const deadline = timeout ? Date.now() + timeout : Infinity;

  const ensure = async (): Promise<string | null> => {
    const r = await ensureWatcher(name);
    if (r.started && r.pid) console.error(`Started the watcher for "${name}" (pid ${r.pid}).`);
    return r.error ?? null;
  };

  let error = await ensure();
  let printed = printUnread(name);
  if (endedIn(printed)) return finish("ENDED");
  if (error) return finish("ERROR", `The watcher for "${name}" didn't start: ${error}`);
  if (printed.length && !follow) return finish("EVENTS");
  if (!wait) return finish("NONE");

  while (Date.now() < deadline) {
    await sleep(500);
    printed = printUnread(name);
    if (endedIn(printed)) return finish("ENDED");
    if (printed.length && !follow) return finish("EVENTS");
    if (!runningPid(name)) {
      // Killed or crashed without ending the watch: start it again.
      error = await ensure();
      printed = printUnread(name);
      if (endedIn(printed)) return finish("ENDED");
      if (error) return finish("ERROR", `The watcher for "${name}" stopped and didn't restart: ${error}`);
      if (printed.length && !follow) return finish("EVENTS");
    }
  }
  return finish("TIMEOUT");
}
