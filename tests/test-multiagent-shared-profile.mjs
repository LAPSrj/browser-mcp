#!/usr/bin/env node
/**
 * Multi-agent shared-browser-profile end-to-end test.
 *
 * Simulates two browser-mcp servers sharing a persistent user_data_dir:
 *   - Server A opens a session — spawns Chromium, writes the sidecar.
 *   - Server B opens a session on the SAME user_data_dir — sidecar tells it
 *     to attach to A's already-running browser.
 *
 * Then verifies the safety properties Leandro asked for:
 *   1. Each session has its OWN main tab (B doesn't inherit A's tabs).
 *   2. Popup auto-tracking is opener-filtered (A's popups go to A, B's
 *      listener does NOT claim them).
 *   3. Closing Session A does NOT kill the browser (B is still attached).
 *   4. Session A's tabs close on A's close, but B's tabs survive.
 *   5. Last-out: closing B kills the browser tree.
 *   6. Sidecar PID-liveness sweep auto-cleans dead entries.
 *
 * Both "servers" run in this single Node process (each open_session call
 * goes through its own chromium.connectOverCDP, getting distinct Playwright
 * Browser handles with distinct Page object identities — same isolation
 * as separate Node processes for the purposes of the opener filter).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

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

// Use a brand-new profile dir so a previous run's state doesn't bleed in.
const PROFILE_WIN = runPS('Join-Path $env:TEMP ("bm-multi-" + (Get-Random -Maximum 99999))');
const PROFILE_WSL = execFileSync("/usr/bin/wslpath", ["-u", PROFILE_WIN], { encoding: "utf8" }).trim();
log(`profile dir (Windows): ${PROFILE_WIN}`);
log(`profile dir (WSL):     ${PROFILE_WSL}`);
runPS(`if (Test-Path '${PROFILE_WIN}') { Remove-Item -Recurse -Force '${PROFILE_WIN}' }; New-Item -ItemType Directory -Path '${PROFILE_WIN}' | Out-Null`);

function msedgeProcsTagged(filter) {
  try {
    const out = runPS(`(Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${filter}*' } | Measure-Object).Count`);
    return parseInt(out, 10) || 0;
  } catch { return -1; }
}

function cleanupGlobal() {
  try { runPS(`Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch {}
  try { runPS(`Remove-Item -Recurse -Force '${PROFILE_WIN}' -ErrorAction SilentlyContinue`); } catch {}
}

async function main() {
  // ---- Test 1: Server A spawns the browser, sidecar reflects it ----
  log("\n=== Test 1 — Server A opens session, sidecar records the spawn ===");
  const sA = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });
  log(`Server A session_id=${sA.session_id}`);

  const sidecar1 = readSidecar(PROFILE_WSL);
  if (!sidecar1) fail("sidecar should exist after first open");
  log(`sidecar: root_pid=${sidecar1.root_pid}, cdp_port=${sidecar1.cdp_port}, relay_port=${sidecar1.relay_port}, attached_sessions=${sidecar1.attached_sessions.length}`);
  if (sidecar1.attached_sessions.length !== 1) fail(`expected 1 attached session, got ${sidecar1.attached_sessions.length}`);
  if (sidecar1.attached_sessions[0].session_id !== sA.session_id) fail("sidecar's first entry should be Server A's session");
  ok("sidecar created with Server A's session entry");

  const procsAfterA = msedgeProcsTagged(PROFILE_WIN);
  log(`msedge.exe procs tagged with profile: ${procsAfterA}`);
  if (procsAfterA <= 0) fail("expected msedge procs to be running");
  ok(`Server A spawned ${procsAfterA} msedge.exe procs against the profile`);

  // ---- Test 2: Server B opens on SAME user_data_dir — attaches to existing ----
  log("\n=== Test 2 — Server B opens on same user_data_dir, attaches to existing browser ===");
  const procsBeforeB = msedgeProcsTagged(PROFILE_WIN);
  const sB = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });
  log(`Server B session_id=${sB.session_id}`);
  const procsAfterB = msedgeProcsTagged(PROFILE_WIN);
  log(`msedge procs: before B=${procsBeforeB}, after B=${procsAfterB}`);
  if (procsAfterB > procsBeforeB + 1) fail(`Server B should NOT spawn another browser; procs grew from ${procsBeforeB} to ${procsAfterB} (more than +1 renderer)`);
  ok("Server B did NOT spawn another browser — attached to existing");

  const sidecar2 = readSidecar(PROFILE_WSL);
  if (!sidecar2) fail("sidecar missing after Server B attach");
  log(`sidecar attached_sessions after B: ${sidecar2.attached_sessions.length}`);
  if (sidecar2.attached_sessions.length !== 2) fail(`expected 2 attached sessions, got ${sidecar2.attached_sessions.length}`);
  if (sidecar2.root_pid !== sidecar1.root_pid) fail(`root_pid should be unchanged across attach (was ${sidecar1.root_pid}, now ${sidecar2.root_pid})`);
  ok("sidecar updated: 2 attached sessions, same root_pid");

  // ---- Test 3: Sessions have distinct main tabs, B did NOT inherit A's pages ----
  log("\n=== Test 3 — Server B's session.pages does NOT contain Server A's main ===");
  const pageA = sessionManager.getPage(sA.session_id);
  const pageB = sessionManager.getPage(sB.session_id);
  await pageA.goto("data:text/html,<title>A-main</title><h1>A-main</h1>", { waitUntil: "domcontentloaded" });
  await pageB.goto("data:text/html,<title>B-main</title><h1>B-main</h1>", { waitUntil: "domcontentloaded" });
  const titleA = await pageA.evaluate(() => document.title);
  const titleB = await pageB.evaluate(() => document.title);
  log(`A's main title="${titleA}", B's main title="${titleB}"`);
  if (titleA !== "A-main") fail(`A's main should be A-main, got ${titleA}`);
  if (titleB !== "B-main") fail(`B's main should be B-main, got ${titleB}`);
  ok("A's and B's main tabs are independent — B got a fresh page via context.newPage()");

  // ---- Test 4: A's popup auto-tracking — B's listener does NOT claim ----
  log("\n=== Test 4 — A opens a target=_blank popup; A claims it, B does not ===");
  await pageA.evaluate(() => {
    const a = document.createElement("a");
    a.id = "popper"; a.target = "_blank"; a.href = "about:blank";
    a.textContent = "open popup";
    document.body.appendChild(a);
  });
  const popupPromise = pageA.context().waitForEvent("page");
  await pageA.click("#popper");
  await popupPromise;
  await wait(500); // let opener-filter resolve in both listeners

  const tabsA = sessionManager.list().find((s) => s.session_id === sA.session_id).tabs;
  const tabsB = sessionManager.list().find((s) => s.session_id === sB.session_id).tabs;
  log(`A's tabs: ${tabsA.length} — ${tabsA.map((t) => `${t.tab_id}@${t.url.slice(0, 35)}`).join(", ")}`);
  log(`B's tabs: ${tabsB.length} — ${tabsB.map((t) => `${t.tab_id}@${t.url.slice(0, 35)}`).join(", ")}`);
  if (tabsA.length !== 2) fail(`A should have 2 tabs (main + popup), got ${tabsA.length}`);
  if (tabsB.length !== 1) fail(`B should still have only 1 tab (main), got ${tabsB.length} — opener-filter leaked`);
  ok("Opener-filter works — A claimed the popup, B did not");

  // ---- Test 5: Close Server A — browser must NOT die (B still attached) ----
  log("\n=== Test 5 — close Server A; browser stays alive for Server B ===");
  const rootPid = sidecar2.root_pid;
  await sessionManager.close(sA.session_id);
  await wait(1000);

  const sidecar3 = readSidecar(PROFILE_WSL);
  if (!sidecar3) fail("sidecar should still exist after only A closed");
  if (sidecar3.attached_sessions.length !== 1) fail(`expected 1 remaining session after A closed, got ${sidecar3.attached_sessions.length}`);
  if (sidecar3.attached_sessions[0].session_id !== sB.session_id) fail("remaining session should be B");
  ok(`sidecar reflects A's departure; ${sidecar3.attached_sessions.length} session(s) still attached`);

  const rootAlive = runPS(`if (Get-Process -Id ${rootPid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  if (rootAlive !== "yes") fail(`browser root PID ${rootPid} should still be alive after A's close`);
  ok(`browser root PID ${rootPid} survived Server A's close`);

  // Server B should still be able to drive its page
  const stillWorks = await pageB.evaluate(() => document.title);
  log(`B's page still drivable; title="${stillWorks}"`);
  if (stillWorks !== "B-main") fail("B should still see its own page after A closed");
  ok("Server B's session is unaffected by Server A's close");

  // ---- Test 6: Last-out — closing B kills the browser ----
  log("\n=== Test 6 — close Server B; last-out kills the browser ===");
  await sessionManager.close(sB.session_id);
  await wait(2000);

  const sidecar4 = readSidecar(PROFILE_WSL);
  if (sidecar4) fail("sidecar should be GONE after last session closed");
  ok("sidecar removed (last-out cleanup)");

  const procsAfterAllClosed = msedgeProcsTagged(PROFILE_WIN);
  log(`msedge.exe procs tagged with profile after B closed: ${procsAfterAllClosed}`);
  if (procsAfterAllClosed !== 0) fail(`expected 0 procs after last-out, got ${procsAfterAllClosed}`);
  ok("browser tree fully torn down on last-out");

  // ---- Test 7: PID-liveness sweep — bogus entry gets pruned on next attach ----
  log("\n=== Test 7 — stale attached_sessions entry from a dead browser-mcp PID gets swept ===");
  // Fresh spawn first
  const sC = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });
  log(`Server C session_id=${sC.session_id}`);

  // Manually inject a stale entry pointing to a never-existed PID
  const sidecar5 = readSidecar(PROFILE_WSL);
  const sidecarPath = `${PROFILE_WSL}/.bm-browser.json`;
  const sidecar5Tampered = {
    ...sidecar5,
    attached_sessions: [
      ...sidecar5.attached_sessions,
      { session_id: "ghost-session", browser_mcp_pid: 999999, attached_at: new Date().toISOString() },
    ],
  };
  writeFileSync(sidecarPath, JSON.stringify(sidecar5Tampered, null, 2));
  log(`injected ghost entry pointing to dead PID 999999`);

  // Open another session — triggers withSidecarLock which auto-sweeps dead entries
  const sD = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });
  log(`Server D session_id=${sD.session_id}`);
  const sidecar6 = readSidecar(PROFILE_WSL);
  log(`attached_sessions after D + sweep: ${sidecar6.attached_sessions.map((s) => s.session_id).join(", ")}`);
  if (sidecar6.attached_sessions.some((s) => s.session_id === "ghost-session")) fail("ghost-session should have been swept");
  if (sidecar6.attached_sessions.length !== 2) fail(`expected 2 entries after sweep, got ${sidecar6.attached_sessions.length}`);
  ok("dead PID entry auto-swept on next sidecar lock acquisition");

  // Cleanup remaining sessions
  await sessionManager.close(sC.session_id);
  await sessionManager.close(sD.session_id);
  await wait(2000);

  // ---- Final cleanup ----
  cleanupGlobal();
  log("\n===== multi-agent shared-profile smoke PASSED =====");
  process.exit(0);
}

main().catch((e) => {
  console.error("[t] FATAL", e);
  cleanupGlobal();
  process.exit(1);
});
