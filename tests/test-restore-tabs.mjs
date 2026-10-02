#!/usr/bin/env node
/**
 * Smoke: verify attach_cdp keeps the previous session's tabs out of view by
 * default and brings them back with restore_previous_tabs:true.
 *
 * Three-phase test on one persistent user_data_dir:
 *   Phase 1: open a session, plant 3 tabs, close the session (Chromium saves
 *            the tabs into the profile's session-restore state).
 *   Phase 2: reopen with the default behavior. Verify only ONE tab is open,
 *            on about:blank.
 *   Phase 3: reopen with restore_previous_tabs:true. Verify all 3 phase-1
 *            tabs are back in context.pages(). This also proves phase 2 had
 *            those tabs to restore and kept them out of the agent's view.
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
// Close open sessions before exiting so the spawned browser doesn't outlive the
// test and lock the profile dir for the next run.
const fail = async (m) => {
  console.error("[t] FAIL", m);
  await sessionManager.closeAll("test-fail").catch(() => {});
  process.exit(1);
};
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
const plantedUrls = [1, 2, 3].map((i) => `data:text/html,<title>Tab${i}</title><h1>Tab${i}</h1>`);
const tab1 = sessionManager.getPage(s1.session_id);
await tab1.goto(plantedUrls[0], { waitUntil: "domcontentloaded" });

const tab2 = await ctx1.newPage();
await tab2.goto(plantedUrls[1], { waitUntil: "domcontentloaded" });

const tab3 = await ctx1.newPage();
await tab3.goto(plantedUrls[2], { waitUntil: "domcontentloaded" });

const pagesPhase1 = ctx1.pages();
log(`pages open before close: ${pagesPhase1.length}`);
if (pagesPhase1.length !== 3) await fail(`expected 3 tabs, got ${pagesPhase1.length}`);
ok("planted 3 tabs in session 1");

// close() kills the browser, so it only keeps what Chromium already wrote to
// the session file. Chromium batches those writes; closing right after the
// navigations left no session file at all in a live run, 3s was always enough.
await wait(3000);
await sessionManager.close(s1.session_id);
await wait(2000);

// ---- Phase 2: reopen default (the previous tabs must stay out of view) ----
log("\n=== Phase 2: reopen with default behavior — only about:blank should be open ===");
const s2 = await sessionManager.open({
  attach_cdp: true,
  user_data_dir: profileWin,
});
log(`session 2 opened: ${s2.session_id}`);

const ctx2 = sessionManager.get(s2.session_id).context;
const pagesPhase2 = ctx2.pages();
log(`pages open after attach: ${pagesPhase2.length}`);
log(`page URLs: ${pagesPhase2.map((p) => p.url()).join(", ")}`);
if (pagesPhase2.length !== 1) await fail(`expected 1 tab after default attach, got ${pagesPhase2.length}`);
if (pagesPhase2[0].url() !== "about:blank") await fail(`expected the remaining tab to be about:blank, got ${pagesPhase2[0].url()}`);
ok("default attach left only 1 tab on about:blank");

await wait(3000); // same session-file write delay as phase 1
await sessionManager.close(s2.session_id);
await wait(2000);

// ---- Phase 3: reopen with restore_previous_tabs:true ----
log("\n=== Phase 3: reopen with restore_previous_tabs:true — the phase-1 tabs should be back ===");
const s3 = await sessionManager.open({
  attach_cdp: true,
  user_data_dir: profileWin,
  restore_previous_tabs: true,
});
log(`session 3 opened (opt-in restore): ${s3.session_id}`);
const ctx3 = sessionManager.get(s3.session_id).context;
const pagesPhase3 = ctx3.pages();
const urlsPhase3 = pagesPhase3.map((p) => p.url());
log(`pages open after attach: ${pagesPhase3.length}`);
log(`page URLs: ${urlsPhase3.join(", ")}`);
const missing = plantedUrls.filter((u) => !urlsPhase3.includes(u));
if (missing.length) await fail(`expected restore_previous_tabs:true to bring back all 3 phase-1 tabs, missing: ${missing.join(", ")}`);
ok("restore_previous_tabs:true brought back all 3 phase-1 tabs (phase 2 had them to restore and kept them out of view)");

await sessionManager.close(s3.session_id);
await wait(1500);

// ---- Cleanup ----
log("\ncleaning up test profile...");
try {
  runPS(`Remove-Item -Recurse -Force '${profileWin}' -ErrorAction SilentlyContinue`);
} catch {}

log("\n===== restore-tabs smoke PASSED =====");
process.exit(0);
