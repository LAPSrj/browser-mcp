#!/usr/bin/env node
// Page watches: watch_page / list_watches / unwatch_page and the
// `browser-mcp watch` / `unwatch` commands, against a local chat page whose
// messages, title, status, notifications and login come from the test server.
//
// 1. diffSnapshot on its own: re-rendered messages aren't new, a second
//    identical message is, value and title changes report from/to.
// 2. Playwright-launched session: the watcher opens the page with the
//    session's cookies; new messages, duplicates, a notification, a value
//    watch and a title-only watch are reported; after the watcher is killed
//    (a crash or reboot) the next run restarts it and reports only the
//    messages that came in while it was down; a logout ends the watch, and
//    the next run reports it again; unwatch stops the watcher.
// 3. attach_cdp with a profile folder (WSL with mirrored networking or
//    Windows, when a Chromium-channel browser is installed): the watcher
//    opens the same profile logged in, and after the watcher and the browser
//    are killed, the next run starts both and reports what it missed.
//
// Build with `npx tsc` first, then run:
//   node tests/test-watch.mjs

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allPrimitives } from "../dist/core/primitives.js";
import { sessionManager } from "../dist/core/sessions.js";
import { diffSnapshot, emptyState, watchPaths } from "../dist/core/watches.js";
import { forceKillProfile } from "../dist/utils/cdp-relay.js";
import { isWsl } from "../dist/utils/wsl.js";
import { detectInstalledChromium, isWindowsOrWsl } from "./_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "..", "dist", "index.js");
const tmp = mkdtempSync(path.join(os.tmpdir(), "bm-watch-"));
process.env.BROWSER_MCP_WATCH_DIR = path.join(tmp, "watches");

const tools = allPrimitives();
let pass = 0, fail = 0;
function check(cond, name, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
async function call(name, params) {
  const r = await tools[name].handler(params);
  const text = r.content[0].text;
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { isError: !!r.isError, body };
}
/** Run the CLI without blocking this process, which also serves the page. */
function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      const verdict = lines.at(-1)?.replace(/^VERDICT: /, "") ?? "";
      const events = lines.slice(0, -1).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
      resolve({ code, verdict, events, stderr });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const added = (r) => r.events.filter((e) => e.type === "added").map((e) => e.text);
const pidOf = (name) => JSON.parse(readFileSync(watchPaths(name).pid, "utf8")).pid;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
// The chat page. The page polls /state and re-renders the whole list each
// time, like a chat app re-rendering, so unchanged messages keep producing
// DOM changes.

const site = { messages: [], notify: [], title: "Chat", status: "Processing", loggedOut: false };
const PAGE = `<!doctype html><html><head><title>Chat</title></head><body>
<div id="who"></div><ul id="msgs"></ul><p id="status"></p><div id="host"></div>
<script>
const shadow = document.getElementById("host").attachShadow({ mode: "open" });
let notified = null;
async function tick() {
  let s;
  try { s = await (await fetch("/state", { cache: "no-store" })).json(); } catch { return; }
  if (notified === null) notified = s.notify.length; // only notifications sent after the page loaded
  document.title = s.title;
  document.getElementById("who").innerHTML = s.logged_in ? '<span id="me">Me</span>' : '<a href="/login">Log in</a>';
  document.getElementById("msgs").innerHTML = s.logged_in
    ? s.messages.map((m, i) => '<li><span class="text">' + m + '</span> <time>' + i + '</time></li>').join("")
    : "";
  document.getElementById("status").textContent = s.status;
  shadow.innerHTML = s.messages.map((m) => '<p class="stext">' + m + '</p>').join("");
  while (notified < s.notify.length) {
    const n = s.notify[notified++];
    try { new Notification(n.title, { body: n.body }); } catch {}
  }
}
tick();
setInterval(tick, 300);
</script></body></html>`;
const server = createServer((req, res) => {
  if (req.url === "/state") {
    const logged_in = /(^|;\s*)auth=1/.test(req.headers.cookie ?? "") && !site.loggedOut;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...site, logged_in }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function waitFor(name, opts = {}) {
  return cli("watch", `--name=${name}`, "--wait", `--timeout=${opts.timeout ?? 20000}`);
}

try {
  console.log("\n=== 1. diffSnapshot ===");
  {
    const cfg = { selector: ".m", mode: "items", title: true, notifications: false, logged_in_selector: null };
    const st = emptyState();
    const snap = (items, title = "Chat") => ({ items, title, url: "x", logged_in: true });
    check(diffSnapshot(cfg, st, snap(["a", "b"]), true).length === 0, "baseline reports nothing");
    check(diffSnapshot(cfg, st, snap(["a", "b"])).length === 0, "the same messages again aren't new");
    check(diffSnapshot(cfg, st, snap(["b"])).length === 0, "a message leaving the page isn't reported");
    const e1 = diffSnapshot(cfg, st, snap(["a", "b", "ok", "ok"]));
    check(e1.length === 2 && e1.every((e) => e.type === "added" && e.text === "ok"), "two identical new messages are two events", e1);
    check(diffSnapshot(cfg, st, snap(["ok"])).length === 0, "re-rendering fewer of them isn't new");
    const e2 = diffSnapshot(cfg, st, snap(["a", "b", "ok", "ok"], "(1) Chat"));
    check(e2.length === 1 && e2[0].type === "title" && e2[0].from === "Chat" && e2[0].to === "(1) Chat", "title change reports from/to", e2);
    const vcfg = { ...cfg, mode: "value", title: false };
    const vs = emptyState();
    diffSnapshot(vcfg, vs, snap(["Processing"]), true);
    check(diffSnapshot(vcfg, vs, snap([])).length === 0, "value mode: a missing element isn't a change");
    const v = diffSnapshot(vcfg, vs, snap(["Shipped"]));
    check(v.length === 1 && v[0].from === "Processing" && v[0].to === "Shipped", "value mode reports from/to", v);
  }

  console.log("\n=== 2. Playwright-launched session ===");
  site.messages = ["m1", "m2"];
  const open = await call("open_session", { output_dir: path.join(tmp, "out"), url: `${base}/` });
  const sid = open.body.session_id;
  try {
    await sessionManager.getPage(sid).evaluate(() => { document.cookie = "auth=1; path=/"; });
    await call("navigate", { session_id: sid, url: `${base}/chat` });
    await sessionManager.getPage(sid).waitForSelector("#me");

    const bad = await call("watch_page", { session_id: sid, name: "chat", selector: "role=listitem" });
    check(bad.isError && /must be CSS/.test(bad.body), "a non-CSS selector is refused", bad.body);
    const badLogin = await call("watch_page", { session_id: sid, name: "chat", selector: "#msgs .text", logged_in_selector: "#nope" });
    check(badLogin.isError && /isn't on/.test(badLogin.body), "a logged_in_selector missing now is refused", badLogin.body);

    const w = await call("watch_page", { session_id: sid, name: "chat", selector: "#msgs .text", logged_in_selector: "#me" });
    check(!w.isError && w.body.matched === 2, "watch_page matches the 2 messages", w.body);
    check(w.body.watcher?.started && w.body.watcher.pid && !w.body.watcher.error, "watch_page starts the watcher", w.body.watcher);
    check(w.body.command === "browser-mcp watch --name=chat", "watch_page returns the command", w.body.command);
    check(existsSync(watchPaths("chat").storage), "the session's cookies are saved with the watch");

    let r = await cli("watch", "--name=chat");
    check(r.verdict === "NONE" && r.code === 0 && r.events.length === 0, "first run: nothing new (exit 0)", r);

    site.messages.push("hello");
    r = await waitFor("chat");
    check(r.verdict === "EVENTS" && added(r).join() === "hello", "--wait reports the new message", r);
    check(r.events[0]?.url === `${base}/chat` && r.events[0]?.seq > 0, "events have seq and url", r.events[0]);

    r = await cli("watch", "--name=chat");
    check(r.verdict === "NONE", "the next run doesn't print it again", r);

    site.messages.push("ok", "ok");
    r = await waitFor("chat");
    check(added(r).join() === "ok,ok", "two identical messages are two events", r);

    site.notify.push({ title: "New message", body: "from Ana" });
    r = await waitFor("chat");
    const n = r.events.find((e) => e.type === "notification");
    check(n?.title === "New message" && n?.body === "from Ana", "the site's notification is reported", r);

    site.title = "(1) Chat";
    await sleep(1500);
    r = await cli("watch", "--name=chat");
    check(!r.events.some((e) => e.type === "title"), "title isn't watched by default with a selector", r);

    console.log("  (killing the watcher, as a crash or reboot would)");
    const pid1 = pidOf("chat");
    process.kill(pid1, "SIGKILL");
    await sleep(300);
    site.messages.push("while down 1", "while down 2");
    r = await cli("watch", "--name=chat");
    check(/Started the watcher/.test(r.stderr), "the next run restarts the watcher", r.stderr);
    check(r.verdict === "EVENTS" && added(r).join() === "while down 1,while down 2", "it reports only the messages from while it was down", r);
    check(pidOf("chat") !== pid1 && alive(pidOf("chat")), "a new watcher process is running");

    const [r1, r2] = await Promise.all([cli("watch", "--name=chat"), cli("watch", "--name=chat")]);
    check(!/Started/.test(r1.stderr + r2.stderr), "two runs at once don't start a second watcher", r1.stderr + r2.stderr);

    console.log("  (value watch and title-only watch)");
    const vw = await call("watch_page", { session_id: sid, name: "status", selector: "#status", mode: "value" });
    check(!vw.isError && vw.body.value === "Processing", "value watch reads the current value", vw.body);
    site.status = "Shipped";
    r = await waitFor("status");
    const ch = r.events.find((e) => e.type === "changed");
    check(ch?.from === "Processing" && ch?.to === "Shipped", "value change reports from/to", r);

    const tw = await call("watch_page", { session_id: sid, name: "titles" });
    check(!tw.isError && tw.body.title === "(1) Chat", "title-only watch", tw.body);
    site.title = "(2) Chat";
    r = await waitFor("titles");
    const t = r.events.find((e) => e.type === "title");
    check(t?.from === "(1) Chat" && t?.to === "(2) Chat", "title change is reported", r);

    const sw = await call("watch_page", { session_id: sid, name: "shadow", selector: ".stext" });
    check(!sw.isError && sw.body.matched === site.messages.length, "the selector matches inside a shadow root", sw.body);
    site.messages.push("in the shadow");
    r = await waitFor("shadow");
    check(added(r).join() === "in the shadow", "a new message inside a shadow root is reported", r);
    await call("unwatch_page", { name: "shadow" });
    await cli("watch", "--name=chat"); // read past "in the shadow" on the chat watch

    const list = await call("list_watches", {});
    check(list.body.map((x) => x.name).join() === "chat,status,titles" && list.body.every((x) => x.running), "list_watches shows 3 running watches", list.body);

    console.log("  (logging out; the watch ends 15s after #me disappears)");
    const pidBeforeLogout = pidOf("chat");
    site.loggedOut = true;
    r = await waitFor("chat", { timeout: 40000 });
    const end = r.events.find((e) => e.type === "ended");
    check(r.verdict === "ENDED" && r.code === 3 && end?.reason === "logged_out", "logout ends the watch (exit 3)", r);
    await sleep(1000);
    check(!alive(pidBeforeLogout) && !existsSync(watchPaths("chat").pid), "the watcher exited");
    r = await cli("watch", "--name=chat");
    check(r.verdict === "ENDED" && r.events.some((e) => e.reason === "logged_out"), "a run while still logged out restarts it and reports the logout again", r);
    site.loggedOut = false;
    r = await cli("watch", "--name=chat");
    check(r.verdict === "NONE" && r.code === 0, "after logging back in, the next run restarts it with nothing new", r);

    const pidChat = pidOf("chat");
    const un = await call("unwatch_page", { name: "chat" });
    check(un.body.removed && un.body.stopped && !existsSync(watchPaths("chat").dir), "unwatch_page deletes the watch", un.body);
    check(!alive(pidChat), "unwatch_page stops the watcher");
    const pidStatus = pidOf("status");
    r = await cli("unwatch", "--name=status");
    check(r.code === 0 && !alive(pidStatus) && !existsSync(watchPaths("status").dir), "browser-mcp unwatch deletes the watch", r);
    r = await cli("watch", "--name=chat");
    check(r.verdict === "ERROR" && r.code === 1 && /No watch named "chat"/.test(r.stderr), "a deleted watch is an error", r);
    await call("unwatch_page", { name: "titles" });
  } finally {
    await sessionManager.close(sid).catch(() => {});
  }

  console.log("\n=== 3. attach_cdp with a profile folder ===");
  const browser = detectInstalledChromium();
  const mirrored = isWsl() && (() => {
    try { return execFileSync("wslinfo", ["--networking-mode"], { encoding: "utf8" }).trim() === "mirrored"; } catch { return false; }
  })();
  if (!browser || !isWindowsOrWsl() || (isWsl() && !mirrored)) {
    console.log("  skipped: needs a Chromium-channel browser on Windows, and mirrored networking on WSL so it can reach the test server");
  } else {
    process.env.BROWSER_MCP_PRODUCT = browser.product;
    process.env.BROWSER_MCP_EXECUTABLE_PATH = browser.executablePath;
    const winTemp = isWsl()
      ? execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", cwd: "/mnt/c" }).trim()
      : os.tmpdir();
    const profile = `${winTemp}\\bm-watch-test-${process.pid}`;
    site.messages = ["c1"];
    site.title = "Chat";
    const o = await call("open_session", { attach_cdp: true, user_data_dir: profile, url: `${base}/` });
    const csid = o.body.session_id;
    try {
      check(!!csid, "open_session attach_cdp", o.body);
      await sessionManager.getPage(csid).evaluate(() => { document.cookie = "auth=1; path=/; max-age=3600"; });
      await call("navigate", { session_id: csid, url: `${base}/chat` });
      await sessionManager.getPage(csid).waitForSelector("#me");

      const tmpProfile = await call("open_session", { attach_cdp: true });
      try {
        const refuse = await call("watch_page", { session_id: tmpProfile.body.session_id, name: "edge", selector: "#msgs .text" });
        check(refuse.isError && /temporary profile/.test(refuse.body), "a session on a temporary profile is refused", refuse.body);
      } finally {
        await sessionManager.close(tmpProfile.body.session_id).catch(() => {});
      }

      const w = await call("watch_page", { session_id: csid, name: "edge", selector: "#msgs .text", logged_in_selector: "#me" });
      check(!w.isError && w.body.watcher?.pid && !w.body.watcher.error, "watch_page starts a watcher on the same profile", w.body);
      check(!existsSync(watchPaths("edge").storage), "no cookies file: the profile has them");

      site.messages.push("edge hello");
      let r = await waitFor("edge");
      check(added(r).join() === "edge hello", "the watcher reports a new message from Edge", r);

      // Windows asks apps to close on a restart, so the browser closes itself
      // (and saves its cookies); a forced kill seconds after the login can
      // lose the cookie before Chromium writes it to disk.
      console.log("  (killing the watcher and closing the browser, as a reboot would)");
      process.kill(pidOf("edge"), "SIGKILL");
      const cdp = await sessionManager.getContext(csid).browser().newBrowserCDPSession();
      await cdp.send("Browser.close").catch(() => {});
      await sessionManager.close(csid).catch(() => {});
      await sleep(3000);
      await forceKillProfile(profile).catch(() => {});
      site.messages.push("while off");
      r = await cli("watch", "--name=edge");
      check(/Started the watcher/.test(r.stderr), "the next run starts the watcher and the browser", r.stderr);
      check(r.verdict === "EVENTS" && added(r).join() === "while off", "it reports the message from while everything was off, logged in", r);
    } finally {
      await call("unwatch_page", { name: "edge" });
      await sessionManager.close(csid).catch(() => {});
      await forceKillProfile(profile).catch(() => {});
      if (isWsl()) {
        try { rmSync(execFileSync("/usr/bin/wslpath", ["-u", profile], { encoding: "utf8" }).trim(), { recursive: true, force: true }); } catch {}
      }
    }
  }
} finally {
  for (const name of ["chat", "status", "titles", "shadow", "edge"]) {
    await tools.unwatch_page.handler({ name }).catch(() => {});
  }
  await sessionManager.closeAll("test_end");
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
