#!/usr/bin/env node
// attach_cdp launches the browser without taking focus and leaves its window
// behind the user's windows (restored, not minimized, so it keeps rendering).
// Checks focus, window-stack position and screenshots, then again after
// open_tab + switch_tab (which calls page.bringToFront()).
//
// Needs a focused window on the desktop (the terminal running this test) for
// the "behind the focused window" checks. Don't click around while it runs.
//
// Build with `npx tsc` first, then run:
//   node tests/test-attach-cdp-background.mjs

import { sessionManager } from "../dist/core/sessions.js";
import { windowsSystemBinary } from "../dist/utils/wsl.js";
import { execFileSync } from "node:child_process";
import { requireWindows, requireChromium } from "./_helpers.mjs";

requireWindows();
const { processName: BROWSER_PROC } = requireChromium();

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

// One PowerShell round-trip: the tagged browser's visible top-level windows,
// each with iconic state and how many other visible windows sit above it, plus
// whether the foreground window belongs to the tagged browser.
function windowState(tag) {
  const ps = String.raw`
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BmT {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static string Run(int[] ids) {
    var set = new HashSet<uint>(); foreach (var i in ids) set.Add((uint)i);
    var parts = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p) && IsWindowVisible(h)) {
        // Walk up the z-order. Count only ordinary windows (not always-on-top
        // like the taskbar, not cloaked/hidden UWP frames), and note whether
        // the user's focused window is among them.
        int above = 0; bool fgAbove = false; var fgw = GetForegroundWindow();
        for (var w = GetWindow(h, 3); w != IntPtr.Zero; w = GetWindow(w, 3)) {
          if (w == fgw) fgAbove = true;
          uint q; GetWindowThreadProcessId(w, out q);
          int cloaked = 0; DwmGetWindowAttribute(w, 14, out cloaked, 4);
          if (!set.Contains(q) && IsWindowVisible(w) && !IsIconic(w) && (GetWindowLong(w, -20) & 8) == 0 && cloaked == 0) above++;
        }
        parts.Add("{\"iconic\":" + (IsIconic(h) ? "true" : "false") + ",\"above\":" + above + ",\"fgAbove\":" + (fgAbove ? "true" : "false") + "}");
      }
      return true;
    }, IntPtr.Zero);
    uint fg; GetWindowThreadProcessId(GetForegroundWindow(), out fg);
    return "{\"procs\":" + ids.Length + ",\"fgIsOurs\":" + (set.Contains(fg) ? "true" : "false") + ",\"windows\":[" + string.Join(",", parts) + "]}";
  }
}
"@
$ids = [int[]]@(Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { [int]$_.ProcessId })
[BmT]::Run($ids)
`;
  const out = execFileSync(
    windowsSystemBinary("WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-Command", ps],
    { encoding: "utf8", timeout: 20000 },
  ).trim();
  return JSON.parse(out);
}

function checkBackground(s, when) {
  const d = JSON.stringify(s);
  check(s.windows.length > 0, `browser has a visible window (${when})`, d);
  check(s.windows.every((w) => !w.iconic), `window is restored, not minimized (${when})`, d);
  check(s.windows.every((w) => w.above > 0 && w.fgAbove), `window is behind the focused window (${when})`, d);
  check(!s.fgIsOurs, `browser does not have focus (${when})`, d);
}

const session = await sessionManager.open({ attach_cdp: true });
const tag = `bm-cdp-${session.session_id}`;
try {
  console.log("\n=== after open_session ===");
  const s1 = windowState(tag);
  check(s1.procs > 0, "tagged browser processes running", JSON.stringify(s1));
  checkBackground(s1, "after open");

  console.log("\n=== background window renders ===");
  const page = sessionManager.getPage(session.session_id);
  await page.goto("data:text/html,<title>bg</title><h1 id=h>bg-ok</h1>");
  check((await page.evaluate(() => document.getElementById("h")?.textContent)) === "bg-ok", "evaluate reads the page");
  const raf = await page.evaluate(
    () => Promise.race([
      new Promise((r) => requestAnimationFrame(() => r(true))),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]),
  );
  check(raf === true, "requestAnimationFrame fires");
  let ok = 0;
  for (let i = 0; i < 3; i++) {
    await page.goto(`data:text/html,<h1>shot-${i}</h1>`);
    try { if ((await page.screenshot({ timeout: 5000 })).length > 1000) ok++; } catch { /* counted */ }
  }
  check(ok === 3, "3/3 screenshots succeed", `${ok}/3`);
  checkBackground(windowState(tag), "after navigate + screenshots");

  console.log("\n=== open_tab + switch_tab ===");
  const first = sessionManager.list().find((x) => x.session_id === session.session_id)?.active_tab_id;
  const tab = await sessionManager.addTab(session.session_id, undefined, "data:text/html,<h1>tab2</h1>");
  await sessionManager.switchTab(session.session_id, tab.tab_id);
  if (first) await sessionManager.switchTab(session.session_id, first);
  await new Promise((r) => setTimeout(r, 1000));
  checkBackground(windowState(tag), "after open_tab + switch_tab");
  for (const [label, p] of [["switched-back tab", page], ["new tab", sessionManager.getPage(session.session_id, tab.tab_id)]]) {
    let shot = null;
    try { shot = await p.screenshot({ timeout: 5000 }); } catch (e) { shot = e; }
    check(Buffer.isBuffer(shot), `screenshot of ${label} succeeds`, String(shot?.message ?? ""));
  }
} finally {
  await sessionManager.close(session.session_id);
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
