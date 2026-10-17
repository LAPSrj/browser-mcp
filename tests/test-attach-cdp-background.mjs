#!/usr/bin/env node
// attach_cdp launches the browser hidden: a transparent, click-through tool
// window (no taskbar button, no Alt+Tab entry) sized to the screen's work
// area, which never takes focus and keeps drawing. Checks that state, the
// screenshots, open_tab + switch_tab, set_window show/hide, and a second
// session attached through the browser's endpoint URL.
//
// Needs a focused window on the desktop (the terminal running this test): the
// checks look at where focus goes. set_window show briefly brings the browser
// to the front. Don't click around while it runs.
//
// Build with `npx tsc` first, then run:
//   node tests/test-attach-cdp-background.mjs

import { sessionManager } from "../dist/core/sessions.js";
import { setBrowserWindows } from "../dist/utils/cdp-relay.js";
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

// One PowerShell round-trip: the tagged browser's visible top-level windows
// (iconic, extended style, layered alpha), the foreground window, and whether
// it belongs to the tagged browser.
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
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
  [DllImport("user32.dll")] static extern bool GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public static string Run(int[] ids) {
    var set = new HashSet<uint>(); foreach (var i in ids) set.Add((uint)i);
    var parts = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64);
      if (set.Contains(p) && IsWindowVisible(h) && sb.ToString() == "Chrome_WidgetWin_1") {
        int ex = GetWindowLong(h, -20);
        uint key, flags; byte alpha = 255;
        bool layered = (ex & 0x80000) != 0 && GetLayeredWindowAttributes(h, out key, out alpha, out flags);
        parts.Add("{\"iconic\":" + (IsIconic(h) ? "true" : "false") + ",\"ex\":" + ex + ",\"alpha\":" + (layered ? alpha : 255) + "}");
      }
      return true;
    }, IntPtr.Zero);
    var fgw = GetForegroundWindow(); uint fg; GetWindowThreadProcessId(fgw, out fg);
    return "{\"procs\":" + ids.Length + ",\"fg\":" + (long)fgw + ",\"fgIsOurs\":" + (set.Contains(fg) ? "true" : "false") + ",\"windows\":[" + string.Join(",", parts) + "]}";
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

// The screen pixel 200px below the center of the tagged browser's largest
// window, as "r,g,b" (below the center to stay clear of the page's text).
function screenPixelAtWindowCenter(tag) {
  const ps = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BmP {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public static int[] Center(int[] ids) {
    var set = new HashSet<uint>(); foreach (var i in ids) set.Add((uint)i);
    long best = -1; int[] c = { 0, 0 };
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p) && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        long a = (long)(r.R - r.L) * (r.B - r.T);
        if (a > best) { best = a; c = new int[] { (r.L + r.R) / 2, (r.T + r.B) / 2 + 200 }; }
      }
      return true;
    }, IntPtr.Zero);
    return c;
  }
}
"@
$ids = [int[]]@(Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { [int]$_.ProcessId })
$c = [BmP]::Center($ids)
$bmp = New-Object System.Drawing.Bitmap(1, 1)
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($c[0], $c[1], 0, 0, $bmp.Size)
$p = $bmp.GetPixel(0, 0)
"$($p.R),$($p.G),$($p.B)"
`;
  return execFileSync(
    windowsSystemBinary("WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-Command", ps],
    { encoding: "utf8", timeout: 20000 },
  ).trim();
}

// WS_EX_TOOLWINDOW (no taskbar button, no Alt+Tab), WS_EX_LAYERED, WS_EX_TRANSPARENT (click-through)
const HIDDEN_BITS = 0x80 | 0x80000 | 0x20;
const APPWINDOW = 0x40000;
const isHidden = (w) => (w.ex & HIDDEN_BITS) === HIDDEN_BITS && (w.ex & APPWINDOW) === 0 && w.alpha === 0;

function checkHidden(s, when) {
  const d = JSON.stringify(s);
  check(s.windows.length > 0, `browser has a window (${when})`, d);
  check(s.windows.every((w) => !w.iconic), `window is restored, not minimized (${when})`, d);
  check(s.windows.every(isHidden), `window is hidden: transparent, click-through, no taskbar button (${when})`, d);
  check(!s.fgIsOurs, `browser does not have focus (${when})`, d);
}

async function screenshotsWork(page, n, label) {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    await page.goto(`data:text/html,<h1>${label}-${i}</h1>`);
    try { if ((await page.screenshot({ timeout: 5000 })).length > 1000) ok++; } catch { /* counted */ }
  }
  check(ok === n, `${n}/${n} screenshots succeed (${label})`, `${ok}/${n}`);
}

const session = await sessionManager.open({ attach_cdp: true });
const id = session.session_id;
const tag = `bm-cdp-${id}`;
try {
  console.log("\n=== after open_session ===");
  const s1 = windowState(tag);
  check(s1.procs > 0, "tagged browser processes running", JSON.stringify(s1));
  checkHidden(s1, "after open");

  const page = sessionManager.getPage(id);
  const size = await page.evaluate(() => ({
    x: screenX, y: screenY, w: outerWidth, h: outerHeight,
    ax: screen.availLeft, ay: screen.availTop, aw: screen.availWidth, ah: screen.availHeight,
  }));
  const sized = Math.abs(size.x - size.ax) <= 2 && Math.abs(size.y - size.ay) <= 2 &&
    Math.abs(size.w - size.aw) <= 2 && Math.abs(size.h - size.ah) <= 2;
  check(sized, "window covers the screen's work area", JSON.stringify(size));

  console.log("\n=== hidden window renders ===");
  await page.goto("data:text/html,<title>bg</title><h1 id=h>bg-ok</h1>");
  check((await page.evaluate(() => document.getElementById("h")?.textContent)) === "bg-ok", "evaluate reads the page");
  const raf = await page.evaluate(
    () => Promise.race([
      new Promise((r) => requestAnimationFrame(() => r(true))),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]),
  );
  check(raf === true, "requestAnimationFrame fires");
  await screenshotsWork(page, 3, "hidden");
  checkHidden(windowState(tag), "after navigate + screenshots");

  console.log("\n=== open_tab + switch_tab ===");
  const first = sessionManager.list().find((x) => x.session_id === id)?.active_tab_id;
  const tab = await sessionManager.addTab(id, undefined, "data:text/html,<h1>tab2</h1>");
  await sessionManager.switchTab(id, tab.tab_id);
  if (first) await sessionManager.switchTab(id, first);
  await new Promise((r) => setTimeout(r, 1000));
  checkHidden(windowState(tag), "after open_tab + switch_tab");
  for (const [label, p] of [["switched-back tab", page], ["new tab", sessionManager.getPage(id, tab.tab_id)]]) {
    let shot = null;
    try { shot = await p.screenshot({ timeout: 5000 }); } catch (e) { shot = e; }
    check(Buffer.isBuffer(shot), `screenshot of ${label} succeeds`, String(shot?.message ?? ""));
  }

  console.log("\n=== open_tab tabs share one window and screenshot in the background ===");
  const colors = ["0,200,0", "0,0,255"];
  const bgTabs = [];
  for (const color of colors) {
    const t = await sessionManager.addTab(
      id,
      undefined,
      `data:text/html,<body style='margin:0'><div style='height:3000px;background:rgb(${color})'></div><div id=el style='height:200px;background:rgb(${color})'></div></body>`,
    );
    bgTabs.push({ page: sessionManager.getPage(id, t.tab_id), color });
  }
  const s3 = windowState(tag);
  check(s3.windows.length === 1, "all tabs are in one window", JSON.stringify(s3));
  checkHidden(s3, "after opening more tabs");
  // Center pixel of a PNG, decoded in the first tab.
  const centerPixel = (buf) => page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
    const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d");
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(img.width >> 1, img.height >> 1, 1, 1).data.slice(0, 3)).join(",");
  }, buf.toString("base64"));
  for (const { page: p, color } of bgTabs) {
    for (const [kind, fn] of [
      ["viewport", () => p.screenshot({ timeout: 10000 })],
      ["fullPage", () => p.screenshot({ fullPage: true, timeout: 10000 })],
      ["element", () => p.locator("#el").screenshot({ timeout: 10000 })],
    ]) {
      let px;
      try { px = await centerPixel(await fn()); } catch (e) { px = e.message.split("\n")[0]; }
      check(px === color, `${kind} screenshot of background tab rgb(${color}) shows its content`, px);
    }
  }
  check(!windowState(tag).fgIsOurs, "browser does not have focus (after background-tab screenshots)");

  console.log("\n=== set_window show / hide ===");
  // Make a background tab the session's active tab: show must put it in front.
  const activeTab = sessionManager.list().find((x) => x.session_id === id).tabs.at(-1).tab_id;
  await sessionManager.switchTab(id, activeTab);
  const activePage = sessionManager.getPage(id, activeTab);
  const before = windowState(tag);
  const shown = await sessionManager.setWindow(id, "show");
  check(shown.windows >= 1 && shown.focused === true, "show reports the browser has focus", JSON.stringify(shown));
  const s4 = windowState(tag);
  check(s4.windows.every((w) => (w.ex & HIDDEN_BITS) === 0 && w.alpha === 255), "window is visible after show", JSON.stringify(s4));
  check(s4.fgIsOurs, "browser has focus after show", JSON.stringify(s4));
  // document.hasFocus() is true on every page under Playwright, so read the
  // screen: the active tab is solid blue, the main tab white.
  const px = screenPixelAtWindowCenter(tag);
  check(px === "0,0,255", "show puts the session's active tab in front (screen shows its color)", px);
  await screenshotsWork(page, 2, "shown");
  if (first) await sessionManager.switchTab(id, first);
  const hidden = await sessionManager.setWindow(id, "hide");
  check(hidden.focused === false, "hide reports the browser doesn't have focus", JSON.stringify(hidden));
  const s5 = windowState(tag);
  checkHidden(s5, "after hide");
  check(s5.fg === before.fg, "focus is back on the window that had it before show", `before ${before.fg}, after ${s5.fg}`);
  await screenshotsWork(page, 2, "hidden again");

  console.log("\n=== second session attached through the endpoint URL ===");
  const handle = sessionManager.get(id).attachCdp;
  const firstTabs = [...sessionManager.get(id).pages.values()];
  const tabCount = () => sessionManager.get(id).context.pages().length;
  const tabsBefore = tabCount();
  // Default restore_previous_tabs (false): it must still leave the first session's tabs open.
  const second = await sessionManager.open({ attach_cdp: handle.endpoint });
  check(sessionManager.get(second.session_id).windowPid === handle.browserPid, "CDP reports the same browser process", `${sessionManager.get(second.session_id).windowPid} vs ${handle.browserPid}`);
  check(firstTabs.every((p) => !p.isClosed()), "the first session's tabs are still open", `${firstTabs.filter((p) => p.isClosed()).length} of ${firstTabs.length} closed`);
  await new Promise((r) => setTimeout(r, 500));
  check(tabCount() === tabsBefore + 1, "the second session got its own new tab", `${tabsBefore} tabs before, ${tabCount()} after`);
  const secondPage = sessionManager.getPage(second.session_id);
  await secondPage.goto("data:text/html,<h1>second</h1>");
  check((await page.evaluate(() => document.body.textContent)).includes("hidden again"), "navigating the second session's tab leaves the first session's tab alone");
  checkHidden(windowState(tag), "after the second session attaches");
  await sessionManager.close(second.session_id);
  checkHidden(windowState(tag), "after closing the second session (the first still uses the browser)");

  console.log("\n=== unhide (closing the last session on a browser the user started) ===");
  setBrowserWindows(handle.browserPid, "unhide");
  const s6 = windowState(tag);
  check(s6.windows.every((w) => (w.ex & HIDDEN_BITS) === 0 && w.alpha === 255), "window is visible after unhide", JSON.stringify(s6));
  check(!s6.fgIsOurs, "unhide doesn't give the browser focus", JSON.stringify(s6));
  setBrowserWindows(handle.browserPid, "hide");
  checkHidden(windowState(tag), "after hiding again");
} finally {
  await sessionManager.close(id);
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
