#!/usr/bin/env node
/**
 * Live multi-PROCESS test of shared-profile coordination. Two real Node
 * subprocesses (via child_process.fork), each with its own SessionManager
 * + Playwright connection, attach to the same user_data_dir.
 *
 * Closest you can get to "two Claude Code conversations sharing a profile"
 * without coordinating with another agent.
 */
import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { readSidecar } from "../dist/utils/browser-sidecar.js";

// --- portability guard (auto-applied) ---
import { requireWindows, requireChromium } from "./_helpers.mjs";
requireWindows();
const { processName: BROWSER_PROC, processBaseName: BROWSER_PROC_BASE } = requireChromium();

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const log = (...a) => console.log("[parent]", ...a);
const fail = (m) => { console.error("[parent] FAIL", m); cleanupAll(); process.exit(1); };
const ok = (m) => log("PASS —", m);

function runPS(s) {
  return execFileSync(PS, ["-NoProfile", "-Command", s], { encoding: "utf8", timeout: 10000 }).trim();
}

const PROFILE_WIN = runPS('Join-Path $env:TEMP ("bm-mp-" + (Get-Random -Maximum 99999))');
const PROFILE_WSL = execFileSync("/usr/bin/wslpath", ["-u", PROFILE_WIN], { encoding: "utf8" }).trim();
log(`profile: ${PROFILE_WIN}`);
runPS(`if (Test-Path '${PROFILE_WIN}') { Remove-Item -Recurse -Force '${PROFILE_WIN}' }; New-Item -ItemType Directory -Path '${PROFILE_WIN}' | Out-Null`);

function procsCount() {
  try {
    return parseInt(runPS(`(Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | Measure-Object).Count`), 10) || 0;
  } catch { return -1; }
}

let workerA, workerB;
function cleanupAll() {
  for (const w of [workerA, workerB]) {
    if (w && !w.killed) try { w.kill("SIGKILL"); } catch {}
  }
  try { runPS(`Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch {}
  try { runPS(`Remove-Item -Recurse -Force '${PROFILE_WIN}' -ErrorAction SilentlyContinue`); } catch {}
}

function spawnWorker(label) {
  const w = fork(new URL("./_multiagent-worker.mjs", import.meta.url), [], {
    silent: false,
    env: { ...process.env, BROWSER_MCP_CDP_DEBUG: process.env.BROWSER_MCP_CDP_DEBUG },
  });
  w.label = label;
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.type === "ready") {
        w.off("message", onMessage);
        resolve(w);
      }
    };
    w.on("message", onMessage);
    w.on("error", reject);
    w.on("exit", (code, signal) => log(`worker ${label} exited code=${code} signal=${signal}`));
  });
}

function rpc(worker, msg, expectedType) {
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.type === expectedType) {
        worker.off("message", onMessage);
        resolve(m);
      } else if (m.type === "error") {
        worker.off("message", onMessage);
        reject(new Error(`worker ${worker.label} error: ${m.error}\n${m.stack ?? ""}`));
      }
    };
    worker.on("message", onMessage);
    worker.send(msg);
  });
}

async function main() {
  log("forking worker A...");
  workerA = await spawnWorker("A");
  log(`worker A spawned, pid=${workerA.pid}`);

  log("forking worker B...");
  workerB = await spawnWorker("B");
  log(`worker B spawned, pid=${workerB.pid}`);

  // ---- Test 1: A opens (spawns), B opens (attaches) ----
  log("\n=== Test 1 — A opens (spawn), B opens (attach) on same profile ===");
  const openA = await rpc(workerA, { cmd: "open", user_data_dir: PROFILE_WIN }, "opened");
  log(`A: session_id=${openA.session_id.slice(0, 8)}, browser_mcp_pid=${openA.browser_mcp_pid}`);
  if (openA.browser_mcp_pid !== workerA.pid) fail(`A's reported pid (${openA.browser_mcp_pid}) doesn't match fork pid (${workerA.pid})`);

  const procsAfterA = procsCount();
  log(`procs after A open: ${procsAfterA}`);
  if (procsAfterA === 0) fail("A failed to spawn browser");
  ok(`A spawned browser (${procsAfterA} msedge procs)`);

  const openB = await rpc(workerB, { cmd: "open", user_data_dir: PROFILE_WIN }, "opened");
  log(`B: session_id=${openB.session_id.slice(0, 8)}, browser_mcp_pid=${openB.browser_mcp_pid}`);
  if (openB.browser_mcp_pid !== workerB.pid) fail(`B's reported pid doesn't match fork pid`);
  if (openA.browser_mcp_pid === openB.browser_mcp_pid) fail("A and B should have DIFFERENT browser_mcp_pids (separate Node processes)");

  const procsAfterB = procsCount();
  log(`procs after B open: ${procsAfterB}`);
  // B should NOT add many more procs (maybe +1-3 from CDP attach overhead but not a full new browser)
  if (procsAfterB > procsAfterA + 3) fail(`B appears to have spawned its own browser; procs jumped from ${procsAfterA} to ${procsAfterB}`);
  ok(`B attached to A's browser (proc count stable)`);

  const sidecar1 = readSidecar(PROFILE_WSL);
  log(`sidecar attached_sessions: ${sidecar1.attached_sessions.length} entries`);
  log(`  PIDs in sidecar: ${sidecar1.attached_sessions.map((s) => s.browser_mcp_pid).join(", ")}`);
  if (sidecar1.attached_sessions.length !== 2) fail(`expected 2 sidecar entries, got ${sidecar1.attached_sessions.length}`);
  const sidecarPids = sidecar1.attached_sessions.map((s) => s.browser_mcp_pid).sort();
  const forkPids = [workerA.pid, workerB.pid].sort();
  if (JSON.stringify(sidecarPids) !== JSON.stringify(forkPids)) fail(`sidecar PIDs ${sidecarPids} don't match fork PIDs ${forkPids}`);
  ok("sidecar correctly records both workers' actual PIDs");

  // ---- Test 2: A opens a popup; B's listener does NOT claim it ----
  log("\n=== Test 2 — A opens popup, B does not see it as a tab ===");
  await rpc(workerA, { cmd: "open_popup", url: "about:blank" }, "popup_opened");
  await wait(800); // let cross-process opener-filter resolutions settle

  const tabsA = await rpc(workerA, { cmd: "tabs" }, "tabs");
  const tabsB = await rpc(workerB, { cmd: "tabs" }, "tabs");
  log(`A's tabs: ${tabsA.tabs.length} — ${tabsA.tabs.map((t) => `${t.tab_id}@${t.url.slice(0, 30)}`).join(", ")}`);
  log(`B's tabs: ${tabsB.tabs.length} — ${tabsB.tabs.map((t) => `${t.tab_id}@${t.url.slice(0, 30)}`).join(", ")}`);
  if (tabsA.tabs.length !== 2) fail(`A should have 2 tabs (main + popup), got ${tabsA.tabs.length}`);
  if (tabsB.tabs.length !== 1) fail(`B should have 1 tab (main), got ${tabsB.tabs.length} — opener filter leaked across processes`);
  ok("cross-process opener filter works — A claims its popup, B's separate Node listener does NOT");

  // ---- Test 3: A's popup is an orphan from B's perspective ----
  log("\n=== Test 3 — A's popup shows as orphan in B's include_other_agents view ===");
  const orphanView = await rpc(workerB, { cmd: "list_tabs_with_orphans" }, "list_with_orphans");
  log(`B's own tabs: ${orphanView.own.length}, B's view of orphans: ${orphanView.orphans.length}`);
  log(`  orphan URLs visible to B: ${orphanView.orphans.map((o) => o.url.slice(0, 50)).join(", ")}`);
  // B sees its OWN main + A's main (which B's context.pages() includes) + A's popup
  // = 3 total pages in the context. B owns 1 (its main). So orphans count should be 2.
  if (orphanView.orphans.length < 1) fail(`B should see at least 1 orphan (A's tabs), got ${orphanView.orphans.length}`);
  ok(`B sees ${orphanView.orphans.length} orphan(s) — cross-process visibility works`);

  // ---- Test 4: Close A — browser stays alive for B ----
  log("\n=== Test 4 — close A, browser must stay alive for B ===");
  const procsBeforeAClose = procsCount();
  await rpc(workerA, { cmd: "close" }, "closed");
  await wait(1500);

  const procsAfterAClose = procsCount();
  log(`procs: before A close=${procsBeforeAClose}, after A close=${procsAfterAClose}`);
  if (procsAfterAClose === 0) fail("browser died when only A closed (B should still hold it alive)");
  ok(`browser stayed alive (${procsAfterAClose} procs) after A's close`);

  const sidecar2 = readSidecar(PROFILE_WSL);
  log(`sidecar entries after A close: ${sidecar2.attached_sessions.length}`);
  if (sidecar2.attached_sessions.length !== 1) fail(`expected 1 entry after A closed, got ${sidecar2.attached_sessions.length}`);
  if (sidecar2.attached_sessions[0].browser_mcp_pid !== workerB.pid) fail("remaining sidecar entry should be B's PID");
  ok("sidecar reflects A's exit, B remains");

  // B should still be able to read its tabs (its CDP connection still works)
  const tabsBAfter = await rpc(workerB, { cmd: "tabs" }, "tabs");
  log(`B's tabs after A closed: ${tabsBAfter.tabs.length}`);
  if (tabsBAfter.tabs.length !== 1) fail("B's session should be unaffected");
  ok("B's session still functional after A's close (cross-process disconnect handled cleanly)");

  // ---- Test 5: Close B (last-out) — browser dies ----
  log("\n=== Test 5 — close B (last-out), browser tree fully torn down ===");
  await rpc(workerB, { cmd: "close" }, "closed");
  await wait(2500);

  const procsAfterBClose = procsCount();
  log(`procs after B close: ${procsAfterBClose}`);
  if (procsAfterBClose !== 0) fail(`expected 0 procs after last-out, got ${procsAfterBClose}`);
  if (readSidecar(PROFILE_WSL)) fail("sidecar should be gone");
  ok("browser fully torn down on cross-process last-out");

  // Shut down workers
  workerA.send({ cmd: "exit" });
  workerB.send({ cmd: "exit" });
  await wait(500);

  cleanupAll();
  log("\n===== live multi-process shared-profile test PASSED =====");
  process.exit(0);
}

main().catch((e) => {
  console.error("[parent] FATAL", e);
  cleanupAll();
  process.exit(1);
});
