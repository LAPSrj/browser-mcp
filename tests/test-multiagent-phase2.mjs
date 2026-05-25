#!/usr/bin/env node
/**
 * Phase 2 multi-server primitives: close_browser (polite + force),
 * claim_tab (URL-pattern match on unowned pages), list_tabs with
 * include_other_agents=true.
 */
import { execFileSync } from "node:child_process";
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

const PROFILE_WIN = runPS('Join-Path $env:TEMP ("bm-p2-" + (Get-Random -Maximum 99999))');
const PROFILE_WSL = execFileSync("/usr/bin/wslpath", ["-u", PROFILE_WIN], { encoding: "utf8" }).trim();
log(`profile: ${PROFILE_WIN}`);
runPS(`if (Test-Path '${PROFILE_WIN}') { Remove-Item -Recurse -Force '${PROFILE_WIN}' }; New-Item -ItemType Directory -Path '${PROFILE_WIN}' | Out-Null`);

function procsCount(filter) {
  try {
    return parseInt(runPS(`(Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${filter}*' } | Measure-Object).Count`), 10) || 0;
  } catch { return -1; }
}

function cleanupGlobal() {
  try { runPS(`Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch {}
  try { runPS(`Remove-Item -Recurse -Force '${PROFILE_WIN}' -ErrorAction SilentlyContinue`); } catch {}
}

async function main() {
  // ---- Test 1: close_browser polite — refuses when others attached ----
  // Simulate another browser-mcp server by writing a fake attached_sessions
  // entry directly to the sidecar with a foreign-but-alive PID. We do NOT
  // open a real session for that entry — it represents a session in another
  // Node process.
  log("\n=== Test 1 — close_browser({force:false}) refuses when other sessions attached ===");
  const sA = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });
  log(`A=${sA.session_id.slice(0, 8)}`);

  const sidecarPath = `${PROFILE_WSL}/.bm-browser.json`;
  const { readFileSync, writeFileSync } = await import("node:fs");
  const sc1 = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const foreignPid = process.pid === 1 ? 2 : 1; // PID 1 (init) is always alive
  sc1.attached_sessions = [
    ...sc1.attached_sessions,
    { session_id: "foreign-fake-session", browser_mcp_pid: foreignPid, attached_at: new Date().toISOString() },
  ];
  writeFileSync(sidecarPath, JSON.stringify(sc1, null, 2));
  log(`injected fake foreign session entry with browser_mcp_pid=${foreignPid}`);

  const polite = await sessionManager.closeBrowser(sA.session_id, false);
  log(`close_browser({force:false}) result: killed=${polite.killed}, force_used=${polite.force_used}, reason=${polite.reason?.slice(0, 100)}`);
  if (polite.killed) fail("expected polite close_browser to refuse when others attached");
  if (!polite.reason || !/refused/.test(polite.reason)) fail("expected refusal reason");
  ok("polite close_browser correctly refused with explanation");

  if (procsCount(PROFILE_WIN) === 0) fail("polite close_browser actually killed the browser anyway");
  ok("browser is still alive after polite refusal");

  // ---- Test 2: close_browser force — nukes anyway ----
  log("\n=== Test 2 — close_browser({force:true}) nukes even with others attached ===");
  const beforeProcs = procsCount(PROFILE_WIN);
  log(`procs before force-close: ${beforeProcs}`);

  const forceful = await sessionManager.closeBrowser(sA.session_id, true);
  log(`close_browser({force:true}) result: killed=${forceful.killed}, force_used=${forceful.force_used}, abandoned=${forceful.other_sessions_abandoned}, own_closed=${forceful.own_sessions_closed.length}`);
  if (!forceful.killed) fail("expected force close_browser to kill");
  if (!forceful.force_used) fail("expected force_used to be true");
  if (forceful.other_sessions_abandoned < 1) fail("expected at least 1 abandoned session");
  await wait(2000);

  const afterProcs = procsCount(PROFILE_WIN);
  log(`procs after force-close: ${afterProcs}`);
  if (afterProcs !== 0) fail(`expected 0 procs after force, got ${afterProcs}`);
  if (readSidecar(PROFILE_WSL)) fail("sidecar should be gone after force-close");
  ok("force close_browser nuked browser tree + removed sidecar");
  await wait(500);

  // ---- Test 3: claim_tab on a true orphan ----
  // True orphans are pages in the context with NO opener — created by
  // direct context.newPage() rather than as popups from another page.
  // (rel=noopener affects window.opener JS-side but CDP's Target.openerId
  // still tracks parent-child, so the opener-filter claims those normally.)
  log("\n=== Test 3 — claim_tab on a true orphan (context.newPage with no opener) ===");
  const sC = await sessionManager.open({ attach_cdp: true, user_data_dir: PROFILE_WIN });

  // Create an orphan: a page with no opener. context.newPage() does this
  // directly. The page event fires on sC's listener with opener=null, so
  // the filter skips claiming.
  const ctx = sessionManager.get(sC.session_id).context;
  const orphanPage = await ctx.newPage();
  await orphanPage.goto("data:text/html,<title>orphan-target</title><h1>orphan</h1>", { waitUntil: "domcontentloaded" });
  await wait(500);

  // Verify the orphan is NOT in our session.pages (filter skipped)
  const tabsBeforeClaim = sessionManager.list().find((s) => s.session_id === sC.session_id).tabs;
  log(`session tabs before claim: ${tabsBeforeClaim.length} — ${tabsBeforeClaim.map((t) => t.url.slice(0, 35)).join(", ")}`);
  if (tabsBeforeClaim.length !== 1) fail(`opener filter should not claim opener-less page; expected 1 own tab, got ${tabsBeforeClaim.length}`);
  ok("opener filter correctly left opener-less page as orphan");

  // Now claim it
  const claimed = await sessionManager.claimTab({
    session_id: sC.session_id,
    url_pattern: "orphan-target",
  });
  log(`claim_tab returned: tab_id=${claimed.tab_id}, url=${claimed.url.slice(0, 60)}`);
  const tabsAfterClaim = sessionManager.list().find((s) => s.session_id === sC.session_id).tabs;
  log(`session tabs after claim: ${tabsAfterClaim.length}`);
  if (tabsAfterClaim.length !== 2) fail(`expected 2 tabs after claim, got ${tabsAfterClaim.length}`);
  if (!tabsAfterClaim.find((t) => t.tab_id === claimed.tab_id)) fail("claimed tab not in session.tabs");
  ok("claim_tab successfully claimed orphan; tab is now switchable/closable");

  // Verify switch_tab works on the claimed tab
  await sessionManager.switchTab(sC.session_id, claimed.tab_id);
  const claimedPage = sessionManager.getPage(sC.session_id);
  const title = await claimedPage.evaluate(() => document.title);
  if (title !== "orphan-target") fail(`switch_tab to claimed tab returned wrong page (title=${title})`);
  ok("switch_tab + getPage work on claimed tab");

  // ---- Test 4: claim_tab refuses with no match ----
  log("\n=== Test 4 — claim_tab errors when no unowned page matches ===");
  let claimFailed = false;
  try {
    await sessionManager.claimTab({ session_id: sC.session_id, url_pattern: "nonexistent-12345" });
  } catch (e) {
    claimFailed = true;
    if (!/no unowned page/.test(e.message)) fail(`unexpected error: ${e.message}`);
  }
  if (!claimFailed) fail("expected claim_tab to throw when no match");
  ok("claim_tab errors clearly when no match");

  // ---- Test 5: list_tabs with include_other_agents reports orphans ----
  log("\n=== Test 5 — list_tabs include_other_agents surfaces unowned pages ===");
  // Create another orphan via direct context.newPage()
  const orphanPage2 = await ctx.newPage();
  await orphanPage2.goto("data:text/html,<title>second-orphan</title>", { waitUntil: "domcontentloaded" });
  await wait(500);

  // Simulate calling the list_tabs primitive's enriched mode by replicating
  // its logic directly (the primitives.ts handler isn't directly importable
  // without firing up the MCP server). Verify it surfaces the orphan.
  const session = sessionManager.get(sC.session_id);
  const ourPages = new Set();
  for (const sx of sessionManager.list()) {
    const live = sessionManager.get(sx.session_id);
    if (live.context === session.context) {
      for (const pg of live.pages.values()) ourPages.add(pg);
    }
  }
  const orphanUrls = session.context.pages()
    .filter((pg) => !ourPages.has(pg))
    .map((pg) => pg.url());
  log(`orphan URLs visible via include_other_agents: ${orphanUrls.length} — ${orphanUrls.map((u) => u.slice(0, 50)).join(", ")}`);
  if (orphanUrls.length < 1) fail("expected at least 1 orphan after creating noopener popup");
  if (!orphanUrls.some((u) => u.includes("second-orphan"))) fail("second-orphan not surfaced as orphan");
  ok("include_other_agents-style enumeration surfaces orphan tabs");

  // ---- Cleanup ----
  await sessionManager.close(sC.session_id);
  await wait(1500);
  cleanupGlobal();

  log("\n===== Phase 2 multi-server primitives smoke PASSED =====");
  process.exit(0);
}

main().catch((e) => {
  console.error("[t] FATAL", e);
  cleanupGlobal();
  process.exit(1);
});
