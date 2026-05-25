#!/usr/bin/env node
/**
 * Smoke: verify the default attach_cdp behavior closes restored tabs.
 *
 * Two-phase test:
 *   Phase 1: open a session against a persistent user_data_dir, open
 *            multiple tabs, close the session (Chromium saves the tabs
 *            into the profile's session-restore state).
 *   Phase 2: open another session against the SAME user_data_dir with
 *            the default behavior. Verify only ONE tab is open after
 *            attach (the restored tabs were closed).
 *   Phase 3: same setup but with restore_previous_tabs:true. Verify all
 *            restored tabs are present in context.pages().
 *
 * Then deletes the test profile dir.
 */
import { sessionManager } from "../dist/core/sessions.js";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

// --- portability guard (auto-applied) ---
import { requireWindows, requireChromium } from "./_helpers.mjs";
requireWindows();
const { processName: BROWSER_PROC, processBaseName: BROWSER_PROC_BASE } = requireChromium();

const log = (...a) => console.log("[t]", ...a);
const fail = (m) => { console.error("[t] FAIL", m); process.exit(1); };
const ok = (m) => log("PASS —", m);

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

function runPS(s) {
  return execFileSync(PS, ["-NoProfile", "-Command", s], { encoding: "utf8", timeout: 10000 }).trim();
}

const profileWin = runPS("Join-Path $env:TEMP 'bm-test-restore-tabs'");
log(`profile dir: ${profileWin}`);
runPS(`if (Test-Path '${profileWin}') { Remove-Item -Recurse -Force '${profileWin}' }; New-Item -ItemType Directory -Force -Path '${profileWin}\\Default' | Out-Null`);

// ---- Phase 1: plant multiple tabs and close ----
log("\n=== Phase 1: open a session, plant 3 tabs, close ===");
const s1 = await sessionManager.open({
  attach_cdp: true,
  user_data_dir: profileWin,
});
log(`session 1 opened: ${s1.session_id}`);

const ctx1 = sessionManager.get(s1.session_id).context;
const tab1 = sessionManager.getPage(s1.session_id);
await tab1.goto("data:text/html,<title>Tab1</title><h1>Tab1</h1>", { waitUntil: "domcontentloaded" });

const tab2 = await ctx1.newPage();
await tab2.goto("data:text/html,<title>Tab2</title><h1>Tab2</h1>", { waitUntil: "domcontentloaded" });

const tab3 = await ctx1.newPage();
await tab3.goto("data:text/html,<title>Tab3</title><h1>Tab3</h1>", { waitUntil: "domcontentloaded" });

const pagesPhase1 = ctx1.pages();
log(`pages open before close: ${pagesPhase1.length}`);
if (pagesPhase1.length !== 3) fail(`expected 3 tabs, got ${pagesPhase1.length}`);
ok("planted 3 tabs in session 1");

await sessionManager.close(s1.session_id);
await wait(2000); // let Chromium fsync session state

// ---- Phase 2: reopen default (should close restored tabs) ----
log("\n=== Phase 2: reopen with default behavior — restored tabs should be closed ===");
const s2 = await sessionManager.open({
  attach_cdp: true,
  user_data_dir: profileWin,
});
log(`session 2 opened: ${s2.session_id}`);

const ctx2 = sessionManager.get(s2.session_id).context;
const pagesPhase2 = ctx2.pages();
log(`pages open after attach: ${pagesPhase2.length}`);
log(`page URLs: ${pagesPhase2.map((p) => p.url()).join(", ")}`);
if (pagesPhase2.length !== 1) fail(`expected 1 tab after default attach, got ${pagesPhase2.length}`);
if (pagesPhase2[0].url() !== "about:blank") fail(`expected the remaining tab to be about:blank, got ${pagesPhase2[0].url()}`);
ok("default attach left only 1 tab on about:blank — restored tabs closed");

await sessionManager.close(s2.session_id);
await wait(2000);

// ---- Phase 3: re-plant + reopen with restore_previous_tabs:true ----
log("\n=== Phase 3: plant tabs again, reopen with restore_previous_tabs:true ===");
const s3 = await sessionManager.open({
  attach_cdp: true,
  user_data_dir: profileWin,
});
log(`session 3 opened: ${s3.session_id}`);
const ctx3 = sessionManager.get(s3.session_id).context;
await sessionManager.getPage(s3.session_id).goto("data:text/html,<title>X</title>", { waitUntil: "domcontentloaded" });
await (await ctx3.newPage()).goto("data:text/html,<title>Y</title>", { waitUntil: "domcontentloaded" });
log(`planted ${ctx3.pages().length} tabs`);
await sessionManager.close(s3.session_id);
await wait(2000);

const s4 = await sessionManager.open({
  attach_cdp: true,
  user_data_dir: profileWin,
  restore_previous_tabs: true,
});
log(`session 4 opened (opt-in restore): ${s4.session_id}`);
const ctx4 = sessionManager.get(s4.session_id).context;
const pagesPhase4 = ctx4.pages();
log(`pages open after attach: ${pagesPhase4.length}`);
log(`page URLs: ${pagesPhase4.map((p) => p.url()).join(", ")}`);
if (pagesPhase4.length < 2) fail(`expected restore_previous_tabs:true to surface multiple tabs, got ${pagesPhase4.length}`);
ok("opt-in restore_previous_tabs:true surfaced multiple tabs");

await sessionManager.close(s4.session_id);
await wait(1500);

// ---- Cleanup ----
log("\ncleaning up test profile...");
try {
  runPS(`Remove-Item -Recurse -Force '${profileWin}' -ErrorAction SilentlyContinue`);
} catch {}

log("\n===== restore-tabs smoke PASSED =====");
process.exit(0);
