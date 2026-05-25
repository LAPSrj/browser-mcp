#!/usr/bin/env node
/**
 * Verifies that --hide-crash-restore-bubble suppresses Edge's "Restore tabs
 * from your last session?" prompt when browser-mcp attaches via attach_cdp.
 *
 * Setup:
 *  - Creates a scratch user_data_dir under C:\temp (NOT C:\edge-cdp-profile —
 *    the user's real credentialed profile is NEVER touched).
 *  - Pre-seeds <scratch>\Default\Preferences with the "crashed" state Edge
 *    writes after a dirty exit (profile.exit_type = "Crashed",
 *    profile.exited_cleanly = false).
 *  - Opens attach_cdp session with user_data_dir override → exercises the same
 *    code path as the real CDP flow.
 *  - Verifies the spawn completes, the page loads as requested, and a probe
 *    navigate returns the expected content.
 *  - Cleans up the scratch profile.
 *
 * Visual verification of "no yellow bubble in toolbar" is on the human (browser
 * chrome is outside Playwright's viewport screenshot). This test validates the
 * code change is wired correctly and the crashed-state launch doesn't break.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { sessionManager } from "../dist/core/sessions.js";
import { setTimeout as wait } from "node:timers/promises";

// --- portability guard (auto-applied) ---
import { requireWindows, requireChromium } from "./_helpers.mjs";
requireWindows();
const { processName: BROWSER_PROC, processBaseName: BROWSER_PROC_BASE } = requireChromium();

const log = (...a) => console.log("[t]", ...a);
const fail = (msg) => {
  console.error("[t] FAIL:", msg);
  process.exit(1);
};

const ts = Date.now();
const scratchWin = `C:\\temp\\bm-bubble-test-${ts}`;
const scratchWsl = `/mnt/c/temp/bm-bubble-test-${ts}`;

// ---- 0. Static source check: confirm the flag is wired into cdp-relay.ts ----
log("--- (0) source check: --hide-crash-restore-bubble in cdp-relay browserArgs ---");
const relaySrc = readFileSync("../src/utils/cdp-relay.ts", "utf8");
if (!relaySrc.includes("--hide-crash-restore-bubble")) {
  fail("--hide-crash-restore-bubble not present in src/utils/cdp-relay.ts");
}
log("(0) PASS — flag present in source");

const compiledRelay = readFileSync("../dist/utils/cdp-relay.js", "utf8");
if (!compiledRelay.includes("--hide-crash-restore-bubble")) {
  fail("--hide-crash-restore-bubble not present in dist/utils/cdp-relay.js (rebuild needed?)");
}
log("(0b) PASS — flag present in compiled dist");

// ---- 1. Pre-seed scratch profile with crashed state ----
log("--- (1) pre-seed scratch profile with crashed state ---");
mkdirSync(`${scratchWsl}/Default`, { recursive: true });
const crashedPrefs = JSON.stringify({
  profile: {
    exit_type: "Crashed",
    exited_cleanly: false,
  },
});
writeFileSync(`${scratchWsl}/Default/Preferences`, crashedPrefs, "utf8");
log(`(1) scratch dir: ${scratchWin}`);
log(`(1) Preferences seeded with profile.exit_type=Crashed, exited_cleanly=false`);

// ---- 2. Open attach_cdp session with user_data_dir override ----
log("--- (2) open attach_cdp with crashed profile ---");
const t0 = Date.now();
let session;
try {
  session = await sessionManager.open({
    attach_cdp: true,
    user_data_dir: scratchWin,
  });
} catch (e) {
  fail(`session open threw: ${e?.message}`);
}
log(`(2) session_id: ${session.session_id} (opened in ${Date.now() - t0} ms)`);

// ---- 3. Drive the page — first navigate should not be intercepted ----
log("--- (3) drive page — first navigate ---");
const page = sessionManager.getPage(session.session_id);
try {
  await page.goto("data:text/html,<h1 id=h>crash-restore-suppressed</h1>");
  const h1 = await page.evaluate(() => document.getElementById("h")?.textContent);
  if (h1 !== "crash-restore-suppressed") {
    fail(`page content mismatch: got "${h1}"`);
  }
  log(`(3) PASS — first navigate completed, page content: "${h1}"`);
} catch (e) {
  await sessionManager.close(session.session_id).catch(() => {});
  fail(`first navigate / eval threw: ${e?.message}`);
}

// ---- 4. Second navigate as a smoke (the bubble would typically affect first only) ----
log("--- (4) second navigate ---");
try {
  await page.goto("data:text/html,<p id=p>second-page-ok</p>");
  const p = await page.evaluate(() => document.getElementById("p")?.textContent);
  if (p !== "second-page-ok") {
    fail(`second page content mismatch: got "${p}"`);
  }
  log(`(4) PASS — second navigate completed, page content: "${p}"`);
} catch (e) {
  await sessionManager.close(session.session_id).catch(() => {});
  fail(`second navigate threw: ${e?.message}`);
}

// ---- 5. Close session ----
log("--- (5) close session ---");
const closeResult = await sessionManager.close(session.session_id);
log("(5) close result:", JSON.stringify(closeResult));

// Brief pause to let cleanup complete (sidecar removal, process exit)
await wait(1500);

// ---- 6. Clean up scratch profile ----
log("--- (6) clean up scratch profile ---");
try {
  if (existsSync(scratchWsl)) {
    rmSync(scratchWsl, { recursive: true, force: true });
    log(`(6) removed ${scratchWsl}`);
  }
} catch (e) {
  log(`(6) cleanup warning (non-fatal): ${e?.message}`);
}

log("===== crash-restore-bubble suppression test PASSED =====");
log("elapsed:", Date.now() - ts, "ms");
process.exit(0);
