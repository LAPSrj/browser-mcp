import fs from "node:fs";
import type { Page } from "playwright";
import { sessionManager } from "./sessions.js";
import {
  WATCH_BINDING,
  appendEvents,
  diffSnapshot,
  readSpec,
  readState,
  readStorage,
  urlMatches,
  watchPaths,
  watchScript,
  writeState,
  writeStatus,
  type Snapshot,
  type WatchEventBody,
} from "./watches.js";

// The background process behind a watch (`browser-mcp watch-run --name=<name>`,
// started by ensureWatcher). It opens its own session from the watch's saved
// options, compares every snapshot of the page with the saved state, and
// appends what changed to the events log. It ends itself, with an "ended"
// event, when the site logs out or the browser goes away; the next
// `browser-mcp watch` run starts it again.

/** A watcher session never closes on its own. */
const FOREVER_MS = 10 * 365 * 24 * 3600 * 1000;
/** A page that hasn't shown the logged_in_selector this long after loading is logged out. */
const LOGIN_GRACE_MS = 15_000;
/** The page must report a first snapshot within this long. */
const FIRST_SNAPSHOT_MS = 60_000;

export async function runWatcher(name: string): Promise<number> {
  const p = watchPaths(name);
  const spec = readSpec(name);
  if (!spec) {
    console.error(`[watch ${name}] no watch.json in ${p.dir}`);
    return 1;
  }
  fs.writeFileSync(p.pid, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  writeStatus(name, { state: "starting" });
  const log = (msg: string) => console.error(`${new Date().toISOString()} [watch ${name}] ${msg}`);

  const state = readState(name);
  let sessionId: string | null = null;
  let ended = false;
  let ready = false;
  let finishRun: (code: number) => void = () => {};
  const done = new Promise<number>((r) => { finishRun = r; });

  const emit = (bodies: WatchEventBody[], url?: string) => {
    if (bodies.length === 0) return;
    appendEvents(name, state, bodies, url);
    writeState(name, state);
    for (const b of bodies) log(`event ${b.type}`);
  };

  const end = (reason: "logged_out" | "browser_closed" | "error", message: string, code: number) => {
    if (ended) return;
    ended = true;
    emit([{ type: "ended", reason, message }]);
    writeStatus(name, { state: "ended", error: `${reason}: ${message}` });
    log(`ended (${reason}): ${message}`);
    finishRun(code);
  };

  const onSnapshot = (snap: Snapshot & { age_ms?: number; error?: string }) => {
    if (ended) return;
    if (snap.error) {
      end("error", `the page script failed: ${snap.error}`, 1);
      return;
    }
    if (spec.logged_out_url && urlMatches(spec.logged_out_url, snap.url)) {
      end("logged_out", `the page went to ${snap.url}, which matches logged_out_url`, 3);
      return;
    }
    if (!snap.logged_in) {
      if ((snap.age_ms ?? 0) >= LOGIN_GRACE_MS) {
        end("logged_out", `${spec.config.logged_in_selector} isn't on ${snap.url}`, 3);
      }
      return; // a page still loading can lack it; compare once it's there
    }
    emit(diffSnapshot(spec.config, state, snap), snap.url);
    if (!ready) {
      ready = true;
      writeStatus(name, { state: "ready" });
      log(`ready on ${snap.url}`);
    }
  };

  const shutdown = (signal: string) => {
    log(`stopping (${signal})`);
    if (!ended) {
      ended = true;
      finishRun(0);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  let reloadTimer: NodeJS.Timeout | undefined;
  try {
    const info = await sessionManager.open({
      ...spec.open,
      storageState: spec.has_storage ? readStorage(name) : undefined,
      headless: true,
      idle_ttl_ms: FOREVER_MS,
      wall_ttl_ms: FOREVER_MS,
      output_dir: p.dir,
    });
    sessionId = info.session_id;
    const page: Page = sessionManager.getPage(sessionId);

    // A held dialog stops the page, so the watcher can't wait for an answer.
    sessionManager.getPrompts(sessionId).onOpen((prompt) => {
      emit([{
        type: "prompt",
        kind: prompt.kind,
        message: prompt.message ?? prompt.permissions?.join(", ") ?? prompt.url,
        answer: "dismissed",
      }], prompt.url);
      sessionManager.getPrompts(sessionId!).respond(prompt.prompt_id, { action: "dismiss" }).catch(() => {});
    });

    await page.exposeBinding(WATCH_BINDING, (_source, msg: any) => {
      if (msg?.type === "snapshot") onSnapshot(msg);
      else if (msg?.type === "notification") {
        emit([{ type: "notification", title: String(msg.title ?? ""), body: String(msg.body ?? "") }], page.url());
      }
    });
    await page.addInitScript(watchScript(spec.config));
    page.on("crash", () => {
      log("the page crashed; reloading");
      page.reload().catch((e) => end("error", `the page crashed and didn't reload: ${(e as Error).message}`, 1));
    });
    page.on("close", () => end("browser_closed", "the watcher's tab or browser closed", 1));

    await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (spec.reload_ms) {
      reloadTimer = setInterval(() => {
        page.reload({ waitUntil: "domcontentloaded" }).catch((e) => log(`reload failed: ${(e as Error).message}`));
      }, spec.reload_ms);
    }
    setTimeout(() => {
      if (!ready && !ended) end("error", `the page didn't report a snapshot within ${FIRST_SNAPSHOT_MS / 1000}s of loading ${spec.url}`, 1);
    }, FIRST_SNAPSHOT_MS).unref();
  } catch (e) {
    end("error", `could not open the page: ${(e as Error).message}`, 1);
  }

  const code = await done;
  if (reloadTimer) clearInterval(reloadTimer);
  // An "ended" event before close() wins over the close event close() fires.
  ended = true;
  try { await sessionManager.closeAll("watch_ended"); } catch { /* exiting anyway */ }
  fs.rmSync(p.pid, { force: true });
  return code;
}
