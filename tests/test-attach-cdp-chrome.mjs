#!/usr/bin/env node
/**
 * Cross-product validation: attach_cdp + Chrome on Windows/WSL.
 * Mirror of test-attach-cdp-prod.mjs (which validated Edge) — sets
 * BROWSER_MCP_PRODUCT=chrome to exercise the cross-product code path.
 */
import { execFileSync } from "node:child_process";
import { sessionManager } from "../dist/core/sessions.js";
import { setTimeout as wait } from "node:timers/promises";

// --- portability guard (auto-applied) ---
import { requireWindows, detectInstalledChromium } from "./_helpers.mjs";
requireWindows();
{
  const hit = detectInstalledChromium();
  if (!hit || hit.product !== "chrome") {
    console.log("SKIP: this test validates the Chrome cross-product code path; install Google Chrome.");
    process.exit(0);
  }
  process.env.BROWSER_MCP_PRODUCT = "chrome";
  process.env.BROWSER_MCP_EXECUTABLE_PATH = hit.executablePath;
}


const log = (...a) => console.log("[t]", ...a);

function tasklistCount(filterContains) {
  try {
    const out = execFileSync(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      [
        "-NoProfile",
        "-Command",
        filterContains
          ? `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${filterContains}*' } | Measure-Object).Count`
          : `(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count`,
      ],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return -1;
  }
}

const t0 = Date.now();
log("opening session via attach_cdp + auto_launch (chrome)...");
const session = await sessionManager.open({ attach_cdp: true });
log("session_id:", session.session_id, "opened in", Date.now() - t0, "ms");

const tag = `bm-cdp-${session.session_id}`;
const procsAfterOpen = tasklistCount(tag);
log(`tagged chrome.exe procs after open: ${procsAfterOpen}`);
if (procsAfterOpen <= 0) {
  console.error("[t] FAIL: no chrome procs found with our session tag");
  await sessionManager.close(session.session_id);
  process.exit(1);
}

// (c) drive the page
log("--- (c) drive a page ---");
const page = sessionManager.getPage(session.session_id);
await page.goto("data:text/html,<h1 id=h>chrome-cdp-ok</h1>");
const h1 = await page.evaluate(() => document.getElementById("h")?.textContent);
log("h1 read:", h1);
if (h1 !== "chrome-cdp-ok") {
  console.error("[t] FAIL: page eval mismatch");
  await sessionManager.close(session.session_id);
  process.exit(1);
}
log("(c) PASS — Playwright drove the attached Chrome");

// (d) close-without-killing user's real Chrome
log("--- (d) close-without-killing ---");
const procsBeforeClose = tasklistCount(tag);
log(`tagged chrome.exe procs before close: ${procsBeforeClose}`);

const closeResult = await sessionManager.close(session.session_id);
log("close result:", JSON.stringify(closeResult));

await wait(2000);
const procsAfterClose = tasklistCount(tag);
log(`tagged chrome.exe procs after close: ${procsAfterClose}`);
if (procsAfterClose !== 0) {
  console.error(`[t] FAIL: zombie chrome procs survived close (${procsAfterClose})`);
  process.exit(1);
}

const userChromeCount = tasklistCount();
log(`total chrome.exe procs (user Chrome + extensions): ${userChromeCount}`);

log("===== Chrome cross-product validation PASSED =====");
log("elapsed:", Date.now() - t0, "ms");
process.exit(0);
