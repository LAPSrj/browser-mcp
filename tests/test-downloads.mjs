#!/usr/bin/env node
// Downloads: wait_for_download / list_downloads / set_download_dir and the
// open_session download_dir option, through the tool handlers.
//
// Part 1 runs everywhere on Playwright's Chromium. Part 2 runs an attach_cdp
// session on WSL/Windows when a Chromium-channel browser is installed: it
// checks the browser saves into its own Downloads folder (Playwright's
// default sends it to a Linux temp path a Windows browser can't write to)
// and that download_dir moves the file.
//
// Build with `npx tsc` first, then run:
//   node tests/test-downloads.mjs

import { mkdtempSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allPrimitives } from "../dist/core/primitives.js";
import { sessionManager } from "../dist/core/sessions.js";
import { isWsl } from "../dist/utils/wsl.js";
import { detectInstalledChromium, isWindowsOrWsl } from "./_helpers.mjs";

const tools = allPrimitives();
let pass = 0, fail = 0;
function check(cond, name, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}
async function call(name, params) {
  const r = await tools[name].handler(params);
  const text = r.content[0].text;
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { isError: !!r.isError, body };
}
async function startDownload(session_id, name, text, tab_id) {
  await sessionManager.getPage(session_id, tab_id).evaluate(([n, t]) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([t], { type: "text/plain" }));
    a.download = n;
    document.body.appendChild(a); a.click(); a.remove();
  }, [name, text]);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "bm-downloads-"));
try {
  console.log("\n=== Playwright-launched session ===");
  const outDir = path.join(tmp, "out");
  const open = await call("open_session", { output_dir: outDir, url: "data:text/html,<h1>dl</h1>" });
  const sid = open.body.session_id;
  try {
    check(open.body.download_dir === path.resolve(outDir, "downloads"), "default download_dir is <output_dir>/downloads", open.body.download_dir);

    const none = await call("wait_for_download", { session_id: sid, timeout: 300 });
    check(none.isError && /No download started/.test(none.body), "wait_for_download with no download errors out", JSON.stringify(none));

    await startDownload(sid, "report.txt", "hello one");
    const d1 = await call("wait_for_download", { session_id: sid });
    check(d1.body.state === "completed", "first download completes", JSON.stringify(d1.body));
    check(d1.body.path === path.resolve(outDir, "downloads", "report.txt"), "saved under its real name", d1.body.path);
    check(existsSync(d1.body.path) && readFileSync(d1.body.path, "utf8") === "hello one", "file content matches");
    check(d1.body.tab_id === "main", "tab_id is main", d1.body.tab_id);

    await startDownload(sid, "report.txt", "hello two");
    const d2 = await call("wait_for_download", { session_id: sid });
    check(d2.body.path === path.resolve(outDir, "downloads", "report (1).txt"), "same name gets a (1) suffix", d2.body.path);

    // set_download_dir with the Windows (\\wsl.localhost) form of a WSL path.
    const custom = path.join(tmp, "custom dir");
    const arg = isWsl() && process.env.WSL_DISTRO_NAME
      ? `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME}${custom.replace(/\//g, "\\")}`
      : custom;
    const set = await call("set_download_dir", { session_id: sid, path: arg });
    check(set.body.download_dir === custom, `set_download_dir resolves ${arg}`, set.body.download_dir);

    const tab = await call("open_tab", { session_id: sid, url: "data:text/html,<h1>tab</h1>" });
    await startDownload(sid, "from-tab.txt", "tab file", tab.body.tab_id);
    const d3 = await call("wait_for_download", { session_id: sid });
    check(d3.body.path === path.join(custom, "from-tab.txt"), "download lands in the new folder", d3.body.path);
    check(d3.body.tab_id === tab.body.tab_id, "download from open_tab tab is tracked with its tab_id", d3.body.tab_id);

    const list = await call("list_downloads", { session_id: sid });
    check(list.body.downloads.length === 3 && list.body.download_dir === custom, "list_downloads shows 3 downloads and the folder", JSON.stringify(list.body));

    const reset = await call("set_download_dir", { session_id: sid });
    check(reset.body.download_dir === path.resolve(outDir, "downloads"), "omitting path restores the default", reset.body.download_dir);

    // An open_tab tab closed outside close_tab drops out of the session.
    await sessionManager.getPage(sid, tab.body.tab_id).close();
    await new Promise((r) => setTimeout(r, 300));
    const tabs = sessionManager.list().find((s) => s.session_id === sid);
    check(!tabs.tabs.some((t) => t.tab_id === tab.body.tab_id) && tabs.active_tab_id === "main", "externally closed open_tab tab is removed", JSON.stringify(tabs.tabs));
  } finally {
    await call("close_session", { session_id: sid });
  }

  const browser = isWindowsOrWsl() ? detectInstalledChromium() : null;
  if (!browser) {
    console.log("\n(attach_cdp part skipped: needs WSL/Windows and an installed Chromium-channel browser)");
  } else {
    process.env.BROWSER_MCP_PRODUCT = browser.product;
    process.env.BROWSER_MCP_EXECUTABLE_PATH = browser.executablePath;
    console.log(`\n=== attach_cdp session (${browser.product}) ===`);
    const cdpOpen = await call("open_session", { attach_cdp: true, url: "https://example.com/" });
    const cid = cdpOpen.body.session_id;
    const created = [];
    try {
      check(cdpOpen.body.download_dir === null, "default download_dir is the browser's own folder (null)", cdpOpen.body.download_dir);

      const name = `bm-test-${Date.now()}.txt`;
      await startDownload(cid, name, "cdp file");
      const c1 = await call("wait_for_download", { session_id: cid });
      if (c1.body.path) created.push(c1.body.path);
      check(c1.body.state === "completed" && !c1.body.error, "attach_cdp download completes", JSON.stringify(c1.body));
      check(path.basename(c1.body.path ?? "") === name, "saved under its real name (not a GUID)", c1.body.path);
      check(existsSync(c1.body.path ?? "") && readFileSync(c1.body.path, "utf8") === "cdp file", "file exists at the returned path with the right content");
      if (isWsl()) check(/^[A-Za-z]:\\/.test(c1.body.browser_path ?? ""), "browser_path is the Windows path", c1.body.browser_path);

      const moved = path.join(tmp, "cdp-moved");
      await call("set_download_dir", { session_id: cid, path: moved });
      const name2 = `bm-test-${Date.now()}-b.txt`;
      await startDownload(cid, name2, "moved file");
      const c2 = await call("wait_for_download", { session_id: cid });
      if (c2.body.path) created.push(c2.body.path);
      check(c2.body.path === path.join(moved, name2) && readFileSync(c2.body.path, "utf8") === "moved file", "download_dir moves the file into the folder", JSON.stringify(c2.body));
      check(!existsSync(path.join(path.dirname(c1.body.path ?? "."), name2)), "no copy left in the browser's download folder");
    } finally {
      await call("close_session", { session_id: cid });
      for (const f of created) { try { unlinkSync(f); } catch { /* already gone */ } }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
