#!/usr/bin/env node
/**
 * Live test: tabs of a closed agent don't stay in a shared browser.
 *
 * Worker B opens the profile first and stays attached for the whole run, so
 * the browser outlives every other agent. Then three agents attach, open a
 * second tab, and go away in a different way each:
 *   1. close_session: its tabs close at once.
 *   2. Its MCP client closes stdin (how a client ends a stdio server): the
 *      server closes its session and exits on its own, and its tabs close.
 *   3. SIGKILL, so no cleanup runs: B's next janitor run closes its tabs,
 *      using the target ids the sidecar recorded.
 * B's own tab stays open through all of it.
 */
import { fork, spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { readSidecar } from "../dist/utils/browser-sidecar.js";
import { requireWindows, requireChromium } from "./_helpers.mjs";

requireWindows();
const { processName: BROWSER_PROC } = requireChromium();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const log = (...a) => console.log("[parent]", ...a);
const ok = (m) => log("PASS —", m);
const fail = (m) => { console.error("[parent] FAIL", m); cleanupAll(); process.exit(1); };

function runPS(s) {
  return execFileSync(PS, ["-NoProfile", "-Command", s], { encoding: "utf8", timeout: 10000 }).trim();
}

const PROFILE_WIN = runPS('Join-Path $env:TEMP ("bm-closed-" + (Get-Random -Maximum 99999))');
const PROFILE_WSL = execFileSync("/usr/bin/wslpath", ["-u", PROFILE_WIN], { encoding: "utf8" }).trim();
log(`profile: ${PROFILE_WIN}`);
runPS(`if (Test-Path '${PROFILE_WIN}') { Remove-Item -Recurse -Force '${PROFILE_WIN}' }; New-Item -ItemType Directory -Path '${PROFILE_WIN}' | Out-Null`);

const children = [];
function cleanupAll() {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) try { c.kill("SIGKILL"); } catch {}
  }
  try { runPS(`Get-CimInstance Win32_Process -Filter "Name='${BROWSER_PROC}'" | Where-Object { $_.CommandLine -like '*${PROFILE_WIN.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`); } catch {}
  try { runPS(`Remove-Item -Recurse -Force '${PROFILE_WIN}' -ErrorAction SilentlyContinue`); } catch {}
}

function spawnWorker(label) {
  const w = fork(new URL("./_multiagent-worker.mjs", import.meta.url), [], { silent: false });
  w.label = label;
  children.push(w);
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.type === "ready") { w.off("message", onMessage); resolve(w); }
    };
    w.on("message", onMessage);
    w.on("error", reject);
  });
}

function rpc(worker, msg, expectedType) {
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m.type === expectedType) { worker.off("message", onMessage); resolve(m); }
      else if (m.type === "error") { worker.off("message", onMessage); reject(new Error(`worker ${worker.label}: ${m.error}\n${m.stack ?? ""}`)); }
    };
    worker.on("message", onMessage);
    worker.send(msg);
  });
}

/** The sidecar's tab ids for a browser-mcp process, once it lists `count` of them. */
async function sidecarTabs(pid, count) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const entry = readSidecar(PROFILE_WSL)?.attached_sessions.find((s) => s.browser_mcp_pid === pid);
    if (entry?.tab_target_ids?.length === count) return entry.tab_target_ids;
    await wait(200);
  }
  fail(`sidecar never listed ${count} tabs for pid ${pid}: ${JSON.stringify(readSidecar(PROFILE_WSL))}`);
}

async function openTargets(worker) {
  return new Set((await rpc(worker, { cmd: "targets" }, "targets")).ids);
}

/** An MCP server over stdio, driven with hand-written JSON-RPC so the test controls when stdin closes. */
function startServer() {
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "dist", "index.js")], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.push(child);
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args });
    if (r.error || r.result.isError) fail(`${name}: ${JSON.stringify(r.error ?? r.result)}`);
    return JSON.parse(r.result.content.find((c) => c.type === "text").text);
  };
  return {
    child,
    call,
    async init() {
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
  };
}

async function main() {
  const B = await spawnWorker("B");
  await rpc(B, { cmd: "open", user_data_dir: PROFILE_WIN }, "opened");
  const [bMain] = await sidecarTabs(B.pid, 1);
  ok("B opened the browser and the sidecar lists its tab");

  // ---- 1. close_session ----
  log("\n=== 1. close_session closes the agent's tabs ===");
  const A = await spawnWorker("A");
  await rpc(A, { cmd: "open", user_data_dir: PROFILE_WIN }, "opened");
  await rpc(A, { cmd: "add_tab" }, "tab_added");
  const aTabs = await sidecarTabs(A.pid, 2);
  let open = await openTargets(B);
  if (!aTabs.every((t) => open.has(t))) fail("A's tabs should be open before its close");
  await rpc(A, { cmd: "close" }, "closed");
  await wait(500);
  open = await openTargets(B);
  const aLeft = aTabs.filter((t) => open.has(t));
  if (aLeft.length) fail(`A's tabs still open after close_session: ${aLeft}`);
  if (!open.has(bMain)) fail("B's tab closed along with A's");
  ok("A's 2 tabs closed, B's tab stayed open");
  A.send({ cmd: "exit" });

  // ---- 2. stdin closed ----
  log("\n=== 2. closing an MCP server's stdin closes its session and tabs ===");
  const server = startServer();
  await server.init();
  const opened = await server.call("open_session", { attach_cdp: true, user_data_dir: PROFILE_WIN });
  await server.call("open_tab", { session_id: opened.session_id });
  const sTabs = await sidecarTabs(server.child.pid, 2);
  const exited = new Promise((r) => server.child.on("exit", (code, signal) => r({ code, signal })));
  server.child.stdin.end();
  const exit = await Promise.race([exited, wait(20000).then(() => null)]);
  if (!exit) fail("server didn't exit within 20s of its stdin closing");
  log(`server exited code=${exit.code} signal=${exit.signal}`);
  open = await openTargets(B);
  const sLeft = sTabs.filter((t) => open.has(t));
  if (sLeft.length) fail(`server's tabs still open after its stdin closed: ${sLeft}`);
  if (readSidecar(PROFILE_WSL).attached_sessions.some((s) => s.browser_mcp_pid === server.child.pid)) {
    fail("sidecar still lists the server's session");
  }
  if (!open.has(bMain)) fail("B's tab closed along with the server's");
  ok("server exited on its own, its 2 tabs closed, B's tab stayed open");

  // ---- 3. SIGKILL ----
  log("\n=== 3. a peer closes a killed agent's tabs ===");
  const K = await spawnWorker("K");
  await rpc(K, { cmd: "open", user_data_dir: PROFILE_WIN }, "opened");
  await rpc(K, { cmd: "add_tab" }, "tab_added");
  const kTabs = await sidecarTabs(K.pid, 2);
  const kExited = new Promise((r) => K.on("exit", r));
  K.kill("SIGKILL");
  await kExited;
  open = await openTargets(B);
  if (!kTabs.every((t) => open.has(t))) fail("K's tabs should still be open right after SIGKILL (no cleanup ran)");
  await rpc(B, { cmd: "reap" }, "reaped");
  await wait(500);
  open = await openTargets(B);
  const kLeft = kTabs.filter((t) => open.has(t));
  if (kLeft.length) fail(`K's tabs still open after B's janitor run: ${kLeft}`);
  if (!open.has(bMain)) fail("B's tab closed along with K's");
  const sidecar = readSidecar(PROFILE_WSL);
  if (sidecar.dead_tab_target_ids?.length) fail(`sidecar still lists dead tabs: ${sidecar.dead_tab_target_ids}`);
  ok("B's janitor closed K's 2 tabs and cleared the sidecar's list");

  await rpc(B, { cmd: "close" }, "closed");
  B.send({ cmd: "exit" });
  await wait(500);
  cleanupAll();
  log("\n===== closed-agent tabs test PASSED =====");
  process.exit(0);
}

main().catch((e) => {
  console.error("[parent] FATAL", e);
  cleanupAll();
  process.exit(1);
});
