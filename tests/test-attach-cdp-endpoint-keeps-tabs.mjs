#!/usr/bin/env node
// open_session({ attach_cdp: "<endpoint>" }) on a browser that a session in
// ANOTHER browser-mcp process uses must leave that session's tabs open, even
// with the default restore_previous_tabs (false), which closes leftover tabs.
// It gets its own new tab instead, and leaves the window hidden.
//
// Build with `npx tsc` first, then run:
//   node tests/test-attach-cdp-endpoint-keeps-tabs.mjs

import { fork, execFileSync } from "node:child_process";
import { sessionManager } from "../dist/core/sessions.js";
import { readSidecar } from "../dist/utils/browser-sidecar.js";
import { isWslMirrored, readWslGatewayIp } from "../dist/utils/wsl.js";
import { requireWindows, requireChromium } from "./_helpers.mjs";

requireWindows();
const { processName: BROWSER_PROC } = requireChromium();

let pass = 0, fail = 0;
function check(cond, name, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const runPS = (s) => execFileSync(PS, ["-NoProfile", "-Command", s], { encoding: "utf8", timeout: 10000 }).trim();
const PROFILE_WIN = runPS('Join-Path $env:TEMP ("bm-ep-" + (Get-Random -Maximum 99999))');
const PROFILE_WSL = execFileSync("/usr/bin/wslpath", ["-u", PROFILE_WIN], { encoding: "utf8" }).trim();
runPS(`New-Item -ItemType Directory -Force -Path '${PROFILE_WIN}' | Out-Null`);

const worker = fork(new URL("./_multiagent-worker.mjs", import.meta.url), [], { silent: false });
await new Promise((r) => worker.on("message", (m) => m.type === "ready" && r()));
function rpc(msg, expectedType) {
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.type === expectedType || m.type === "error") {
        worker.off("message", onMessage);
        m.type === "error" ? reject(new Error(m.error)) : resolve(m);
      }
    };
    worker.on("message", onMessage);
    worker.send(msg);
  });
}

let second = null;
try {
  await rpc({ cmd: "open", user_data_dir: PROFILE_WIN }, "opened");
  const before = await rpc({ cmd: "tabs" }, "tabs");
  const sidecar = readSidecar(PROFILE_WSL);
  const endpoint = sidecar.relay_port != null && !isWslMirrored()
    ? `http://${readWslGatewayIp()}:${sidecar.relay_port}`
    : `http://localhost:${sidecar.cdp_port}`;

  console.log("\n=== attach through the endpoint URL while the worker's session is open ===");
  second = await sessionManager.open({ attach_cdp: endpoint });
  check(sessionManager.get(second.session_id).windowPid === sidecar.root_pid, "CDP reports the browser's root process", `${sessionManager.get(second.session_id).windowPid} vs ${sidecar.root_pid}`);
  await new Promise((r) => setTimeout(r, 500));
  const after = await rpc({ cmd: "tabs" }, "tabs");
  check(after.tabs.length === before.tabs.length, "the worker's tabs are still open", `${before.tabs.length} before, ${after.tabs.length} after`);
  const pages = sessionManager.get(second.session_id).context.pages();
  check(pages.length === before.tabs.length + 1, "the endpoint session got its own new tab", `${pages.length} tabs in the browser`);
  const ex = parseInt(runPS(String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class BmE {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  public static int Run(uint pid) {
    int ex = -1;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h) && ex == -1) ex = GetWindowLong(h, -20); return true; }, IntPtr.Zero);
    return ex;
  }
}
"@
[BmE]::Run(${sidecar.root_pid})`), 10);
  check(ex !== -1 && (ex & 0x800a0) === 0x800a0, "the window is still hidden", `extended style ${ex}`);
} finally {
  if (second) await sessionManager.close(second.session_id).catch(() => {});
  await rpc({ cmd: "close" }, "closed").catch(() => {});
  worker.send({ cmd: "exit" });
  try { runPS(`Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch {}
  try { runPS(`Remove-Item -Recurse -Force '${PROFILE_WIN}' -ErrorAction SilentlyContinue`); } catch {}
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
