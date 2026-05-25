#!/usr/bin/env node
/**
 * Orphan-adoption end-to-end test (WSL/Edge).
 *
 * Reproduces the "browser-mcp Node process died before cleanup, Edge survived,
 * sidecar gone" failure mode and verifies the next open_session adopts the
 * orphaned browser instead of falling into the spawn path + lock-conflicting.
 *
 * Steps:
 *   1. Open Session A on a fresh persistent user_data_dir → spawns Edge,
 *      writes sidecar.
 *   2. Simulate a Node-side crash: kill the PS relay process AND manually
 *      delete the .bm-browser.json sidecar — but DON'T kill the browser.
 *   3. Open Session B on the SAME user_data_dir.
 *   4. Verify Session B succeeded, has `attached_via === "adopted"`, and its
 *      browser root PID matches Session A's.
 *   5. Verify a fresh sidecar was written by the adoption path.
 *   6. Close Session B → last-out kills the browser, finalizeSidecarTeardown
 *      removes the sidecar.
 *
 * Each phase prints PASS lines; any FAIL exits 1 after global cleanup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

import { sessionManager } from "../dist/core/sessions.js";
import { readSidecar } from "../dist/utils/browser-sidecar.js";

// --- portability guard (auto-applied) ---
import { requireWindows, requireChromium } from "./_helpers.mjs";
requireWindows();
const { processName: BROWSER_PROC, processBaseName: BROWSER_PROC_BASE } = requireChromium();

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const log = (...a) => console.log("[t]", ...a);
const fail = (m) => { console.error("[t] FAIL", m); cleanupGlobal(); process.exit(1); };
const ok = (m) => log("PASS —", m);

function runPS(s) {
  return execFileSync(PS, ["-NoProfile", "-Command", s], { encoding: "utf8", timeout: 10000 }).trim();
}

const PROFILE_WIN = runPS('Join-Path $env:TEMP ("bm-orphan-" + (Get-Random -Maximum 99999))');
const PROFILE_WSL = execFileSync("/usr/bin/wslpath", ["-u", PROFILE_WIN], { encoding: "utf8" }).trim();
log(`profile dir (Windows): ${PROFILE_WIN}`);
log(`profile dir (WSL):     ${PROFILE_WSL}`);
runPS(`if (Test-Path '${PROFILE_WIN}') { Remove-Item -Recurse -Force '${PROFILE_WIN}' }; New-Item -ItemType Directory -Path '${PROFILE_WIN}' | Out-Null`);

function isWindowsPidAlive(pid) {
  try {
    const out = runPS(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
    return out === "yes";
  } catch { return false; }
}

function cleanupGlobal() {
  try { runPS(`Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch {}
  try { runPS(`Remove-Item -Recurse -Force '${PROFILE_WIN}' -ErrorAction SilentlyContinue`); } catch {}
}

async function main() {
  // ---- Phase 1: Session A spawns Edge, writes sidecar ----
  log("\n=== Phase 1 — Session A spawns Edge, writes sidecar ===");
  const sA = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });
  log(`Session A session_id=${sA.session_id}`);

  const sidecar1 = readSidecar(PROFILE_WSL);
  if (!sidecar1) fail("sidecar should exist after first open");
  const originalRootPid = sidecar1.root_pid;
  const originalCdpPort = sidecar1.cdp_port;
  const originalRelayPid = sidecar1.relay_pid;
  log(`sidecar: root_pid=${originalRootPid}, cdp_port=${originalCdpPort}, relay_pid=${originalRelayPid}`);
  ok("Session A spawned Edge + wrote sidecar");

  if (!isWindowsPidAlive(originalRootPid)) fail("Edge root PID should be alive after open");
  ok(`Edge root PID ${originalRootPid} confirmed alive Windows-side`);

  // ---- Phase 2: Simulate orphan — kill relay + delete sidecar, leave Edge running ----
  log("\n=== Phase 2 — Simulate Node-side crash (kill relay, delete sidecar, keep Edge) ===");
  if (originalRelayPid != null) {
    runPS(`Stop-Process -Id ${originalRelayPid} -Force -ErrorAction SilentlyContinue`);
    log(`killed relay pid ${originalRelayPid}`);
  }
  // Wait for relay to actually exit (file watch timing)
  for (let i = 0; i < 20; i++) {
    if (originalRelayPid == null || !isWindowsPidAlive(originalRelayPid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (originalRelayPid != null && isWindowsPidAlive(originalRelayPid)) {
    fail(`relay pid ${originalRelayPid} did not exit after Stop-Process`);
  }
  ok("relay process killed");

  const sidecarPath = `${PROFILE_WSL}/.bm-browser.json`;
  if (!existsSync(sidecarPath)) fail(`sidecar file missing before manual delete? ${sidecarPath}`);
  unlinkSync(sidecarPath);
  if (existsSync(sidecarPath)) fail("sidecar still present after unlink");
  ok("sidecar manually deleted (simulating orphaned-Node failure)");

  if (!isWindowsPidAlive(originalRootPid)) fail("Edge root PID should still be alive — we did NOT kill the browser");
  ok(`Edge root PID ${originalRootPid} still alive — orphan reproduced`);

  // ---- Phase 3: Open Session B on the SAME profile → expect adoption ----
  log("\n=== Phase 3 — Session B opens on same profile, should ADOPT (not spawn + lock-conflict) ===");
  let sB;
  try {
    sB = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });
  } catch (e) {
    fail(`Session B open threw: ${e.message}`);
  }
  log(`Session B session_id=${sB.session_id}`);

  // Pull the internal AttachCdpHandle to check attached_via
  const sBInternal = sessionManager.get(sB.session_id);
  if (!sBInternal.isAttachCdp || !sBInternal.attachCdp) fail("Session B is not an attach_cdp session");
  if (sBInternal.attachCdp.attachedVia !== "adopted") {
    fail(`expected attached_via='adopted', got '${sBInternal.attachCdp.attachedVia}'`);
  }
  ok(`Session B attached_via='adopted'`);

  // Verify same browser root PID
  const sidecar2 = readSidecar(PROFILE_WSL);
  if (!sidecar2) fail("sidecar should have been rebuilt by adoption");
  if (sidecar2.root_pid !== originalRootPid) {
    fail(`adopted sidecar root_pid ${sidecar2.root_pid} ≠ original ${originalRootPid}`);
  }
  if (sidecar2.cdp_port !== originalCdpPort) {
    fail(`adopted sidecar cdp_port ${sidecar2.cdp_port} ≠ original ${originalCdpPort}`);
  }
  if (sidecar2.attached_sessions.length !== 1 || sidecar2.attached_sessions[0].session_id !== sB.session_id) {
    fail("adopted sidecar should have exactly Session B in attached_sessions");
  }
  ok("adopted sidecar points at original Edge root PID + CDP port; Session B recorded");

  if (sidecar2.relay_pid === originalRelayPid) {
    fail("adopted sidecar should have a NEW relay_pid (old one was killed)");
  }
  if (sidecar2.relay_pid == null || !isWindowsPidAlive(sidecar2.relay_pid)) {
    fail(`adopted relay pid ${sidecar2.relay_pid} is not alive`);
  }
  ok(`fresh relay spawned (pid ${sidecar2.relay_pid}) — distinct from killed original (${originalRelayPid})`);

  // ---- Phase 4: Drive a tab through the adopted session ----
  log("\n=== Phase 4 — Session B can drive a tab through the adopted browser ===");
  const pageB = sessionManager.getPage(sB.session_id);
  await pageB.goto("data:text/html,<title>adopted-OK</title><body>adopted</body>", { waitUntil: "domcontentloaded" });
  const title = await pageB.evaluate(() => document.title);
  if (title !== "adopted-OK") fail(`Session B page title expected 'adopted-OK', got '${title}'`);
  ok("Session B successfully drove a navigation + DOM read through the adopted CDP path");

  // ---- Phase 5: Close Session B → last-out kills the browser + removes sidecar ----
  log("\n=== Phase 5 — Close Session B → last-out kills Edge + sidecar removed ===");
  await sessionManager.close(sB.session_id);
  // Give cleanup time to verify pid-dead + finalize
  await new Promise((r) => setTimeout(r, 2000));
  if (isWindowsPidAlive(originalRootPid)) fail(`Edge root PID ${originalRootPid} should be dead after last-out close`);
  ok(`Edge root PID ${originalRootPid} confirmed dead`);

  if (existsSync(sidecarPath)) fail("sidecar should be removed after last-out finalizeSidecarTeardown");
  ok("sidecar removed by finalizeSidecarTeardown");

  cleanupGlobal();
  log("\n===== orphan-adoption test PASSED =====");
}

main().catch((e) => {
  console.error("[t] uncaught:", e);
  cleanupGlobal();
  process.exit(1);
});
