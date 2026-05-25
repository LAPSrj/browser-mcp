#!/usr/bin/env node
/**
 * N>2 concurrent server scaling test. Phase 1+2 verified for 2 workers;
 * this exercises 4 workers attached simultaneously to the same profile.
 *
 * Verifies:
 *  - Sidecar refcount handles 4 entries
 *  - Each worker's opener-filter sees only its own popups
 *  - Closing 3 of 4 keeps browser alive
 *  - Last worker close kills the tree
 *  - PID-liveness sweep still functions with N>2
 */
import { fork, execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { readSidecar } from "../dist/utils/browser-sidecar.js";

// --- portability guard (auto-applied) ---
import { requireWindows, requireChromium } from "./_helpers.mjs";
requireWindows();
const { processName: BROWSER_PROC, processBaseName: BROWSER_PROC_BASE } = requireChromium();

const N_WORKERS = 4;
const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const log = (...a) => console.log("[parent]", ...a);
const fail = (m) => { console.error("[parent] FAIL", m); cleanupAll(); process.exit(1); };
const ok = (m) => log("PASS —", m);

function runPS(s) {
  return execFileSync(PS, ["-NoProfile", "-Command", s], { encoding: "utf8", timeout: 10000 }).trim();
}

const PROFILE_WIN = runPS('Join-Path $env:TEMP ("bm-n-" + (Get-Random -Maximum 99999))');
const PROFILE_WSL = execFileSync("/usr/bin/wslpath", ["-u", PROFILE_WIN], { encoding: "utf8" }).trim();
log(`profile: ${PROFILE_WIN}`);
runPS(`if (Test-Path '${PROFILE_WIN}') { Remove-Item -Recurse -Force '${PROFILE_WIN}' }; New-Item -ItemType Directory -Path '${PROFILE_WIN}' | Out-Null`);

function procsCount() {
  try {
    return parseInt(runPS(`(Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | Measure-Object).Count`), 10) || 0;
  } catch { return -1; }
}

let workers = [];
function cleanupAll() {
  for (const w of workers) {
    if (w && !w.killed) try { w.kill("SIGKILL"); } catch {}
  }
  try { runPS(`Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch {}
  try { runPS(`Remove-Item -Recurse -Force '${PROFILE_WIN}' -ErrorAction SilentlyContinue`); } catch {}
}

function spawnWorker(label) {
  const w = fork(new URL("./_multiagent-worker.mjs", import.meta.url), [], {
    silent: false,
    env: { ...process.env },
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
        reject(new Error(`worker ${worker.label} error: ${m.error}`));
      }
    };
    worker.on("message", onMessage);
    worker.send(msg);
  });
}

async function main() {
  // ---- Fork N workers ----
  log(`\n=== Forking ${N_WORKERS} workers ===`);
  for (let i = 0; i < N_WORKERS; i++) {
    workers.push(await spawnWorker(`W${i}`));
    log(`forked W${i}, pid=${workers[i].pid}`);
  }

  // ---- All workers open concurrently ----
  log("\n=== All workers open sessions on the same profile concurrently ===");
  const opens = await Promise.all(
    workers.map((w) => rpc(w, { cmd: "open", user_data_dir: PROFILE_WIN }, "opened")),
  );
  for (let i = 0; i < N_WORKERS; i++) {
    log(`  W${i}: session_id=${opens[i].session_id.slice(0, 8)}, browser_mcp_pid=${opens[i].browser_mcp_pid}`);
    if (opens[i].browser_mcp_pid !== workers[i].pid) fail(`W${i} reported pid mismatch`);
  }
  ok(`all ${N_WORKERS} workers attached successfully`);

  const sidecar = readSidecar(PROFILE_WSL);
  log(`sidecar attached_sessions: ${sidecar.attached_sessions.length}`);
  log(`  PIDs in sidecar: ${sidecar.attached_sessions.map((s) => s.browser_mcp_pid).join(", ")}`);
  if (sidecar.attached_sessions.length !== N_WORKERS) fail(`expected ${N_WORKERS} sidecar entries, got ${sidecar.attached_sessions.length}`);
  const sidecarPids = sidecar.attached_sessions.map((s) => s.browser_mcp_pid).sort();
  const expectedPids = workers.map((w) => w.pid).sort();
  if (JSON.stringify(sidecarPids) !== JSON.stringify(expectedPids)) fail(`sidecar PIDs ${sidecarPids} vs expected ${expectedPids}`);
  ok(`sidecar correctly records all ${N_WORKERS} workers' PIDs`);

  // ---- Each worker opens its own popup; verify each sees only its own ----
  log("\n=== Each worker opens its own popup ===");
  await Promise.all(
    workers.map((w) => rpc(w, { cmd: "open_popup", url: "about:blank" }, "popup_opened")),
  );
  await wait(1500);

  for (let i = 0; i < N_WORKERS; i++) {
    const tabs = await rpc(workers[i], { cmd: "tabs" }, "tabs");
    log(`  W${i} tabs: ${tabs.tabs.length} — ${tabs.tabs.map((t) => t.tab_id).join(", ")}`);
    if (tabs.tabs.length !== 2) fail(`W${i} should have 2 tabs (main + own popup), got ${tabs.tabs.length}`);
  }
  ok(`each of ${N_WORKERS} workers sees exactly 2 tabs (main + own popup; opener filter holds at N>2)`);

  // ---- Close all but one ----
  log(`\n=== Close ${N_WORKERS - 1} workers, last one keeps browser alive ===`);
  for (let i = 0; i < N_WORKERS - 1; i++) {
    await rpc(workers[i], { cmd: "close" }, "closed");
    await wait(500);
    const procs = procsCount();
    const sc = readSidecar(PROFILE_WSL);
    log(`  after W${i} close: procs=${procs}, sidecar=${sc ? sc.attached_sessions.length + " entries" : "GONE"}`);
    if (!sc) fail(`sidecar should still exist; W${i} was not last`);
    if (sc.attached_sessions.length !== N_WORKERS - 1 - i) fail(`expected ${N_WORKERS - 1 - i} entries, got ${sc.attached_sessions.length}`);
    if (procs === 0) fail(`browser died after W${i} close (others still attached)`);
  }
  ok(`browser survived ${N_WORKERS - 1} closes; only 1 worker remaining`);

  // ---- Close last worker — browser tree dies ----
  log("\n=== Close last worker (last-out) ===");
  await rpc(workers[N_WORKERS - 1], { cmd: "close" }, "closed");
  await wait(2500);

  const procsAfter = procsCount();
  const scAfter = readSidecar(PROFILE_WSL);
  log(`after final close: procs=${procsAfter}, sidecar=${scAfter ? "still present" : "GONE"}`);
  if (procsAfter !== 0) fail(`expected 0 procs after last-out, got ${procsAfter}`);
  if (scAfter) fail("sidecar should be removed on last-out");
  ok("browser tree fully torn down on last-out at N>2");

  // Shut down workers
  for (const w of workers) {
    w.send({ cmd: "exit" });
  }
  await wait(500);
  cleanupAll();

  log(`\n===== ${N_WORKERS}-worker concurrent scaling test PASSED =====`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[parent] FATAL", e);
  cleanupAll();
  process.exit(1);
});
