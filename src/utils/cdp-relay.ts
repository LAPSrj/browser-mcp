// WSL2 NAT mode cannot reach Windows-host loopback. Chromium's CDP endpoint
// binds to 127.0.0.1:<port> only, even with --remote-debugging-address=0.0.0.0
// (Chromium silently ignores non-localhost bind addresses since ~2023 hardening
// — affects all Chromium-channel browsers, not just Edge). We launch a small
// PowerShell TCP relay on the Windows side that listens on 0.0.0.0:<relay-port>
// and forwards to 127.0.0.1:<cdp-port>. WSL connects to the relay via the
// WSL-gateway IP. Do NOT remove without restoring an equivalent reachability
// path (mirrored networking detection / netsh portproxy / Go helper EXE).
//
// On native Windows / macOS / Linux, no relay is needed and the same code path
// connects directly to localhost:<cdp-port>.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { sanitizeProcessName } from "./browser-products.js";
import { isWsl, readWslGatewayIp } from "./wsl.js";
import {
  aliveWindowsPids,
  finalizeSidecarTeardown,
  removeSession,
  withSidecarLock,
} from "./browser-sidecar.js";

export interface SpawnAttachCdpOptions {
  sessionId: string;
  /** Windows (or native-platform) path to the browser executable, e.g. C:\Program Files\Google\Chrome\Application\chrome.exe */
  executablePath: string;
  /**
   * Windows process name (lowercase, with .exe) used for Win32_Process
   * Name='<x>' filters when finding/killing the spawned procs. Must be the
   * actual process image name, e.g. "msedge.exe" for Edge, "chrome.exe" for
   * Chrome, "brave.exe" for Brave. Sanitized before interpolation into PS.
   */
  processName: string;
  /** Optional Windows path to override user-data-dir. When omitted, a session-scoped temp profile is used. */
  userDataDirOverride?: string;
  /** Browser --remote-debugging-port. Random 9300-9399 if omitted. */
  cdpPort?: number;
  /** PS relay listen port. Random 9400-9499 if omitted. WSL only. */
  relayPort?: number;
  /** How long to wait for CDP /json/version to come up (ms). Default 15000. */
  startupTimeoutMs?: number;
  /** Idle-timeout safety net for the PS relay (sec). Browser-PID-watch is the primary teardown trigger; this only fires if the watch fails. Default 600 (10 min). */
  relayIdleSeconds?: number;
  /**
   * When true, omit the `--hide-crash-restore-bubble` flag so Edge/Chromium
   * actually restores the previous session's tabs. The flag is required by
   * default to keep the "Restore tabs?" yellow bubble from intercepting the
   * agent's first click on a credentialed profile, but it ALSO disables
   * silent auto-restoration — so when the caller has explicitly asked to
   * resume the prior session (`sessionManager.open({ restore_previous_tabs:
   * true })`), the flag has to be left off. Default false.
   */
  restorePreviousTabs?: boolean;
}

export interface AttachCdpHandle {
  /** http URL to pass to chromium.connectOverCDP. */
  endpoint: string;
  /** Windows path to the user-data-dir actually used. */
  userDataDir: string;
  /** Browser root PID (the process image with --remote-debugging-port). null if we couldn't resolve it. */
  browserPid: number | null;
  /** PS relay PID. null on native (no relay). */
  relayPid: number | null;
  /** Relay port if WSL, else null. */
  relayPort: number | null;
  /** Browser CDP port. */
  cdpPort: number;
  /** WSL-gateway IP used for the endpoint, if WSL. */
  gateway: string | null;
  /**
   * How this handle was obtained:
   *  - "spawn": we launched Chromium fresh and own the lifecycle.
   *  - "existing": another browser-mcp session was already running on this
   *    profile; we attached to its CDP port instead of spawning a competitor.
   *    Our cleanup must NOT kill the browser unless we're the last attached
   *    session (refcount via the sidecar file).
   *  - "adopted": no live sidecar was found, but a browser-mcp-signature
   *    Chromium was discovered running on the requested user_data_dir
   *    (orphan from a prior Node-side crash). We spawned a fresh PS relay
   *    pointing at the orphan's CDP port and wrote a new sidecar so future
   *    open_session calls take the normal attach path. Lifecycle is treated
   *    the same as "spawn" — we now own the browser and kill it on was_last.
   */
  attachedVia: "spawn" | "existing" | "adopted";
  /** Tear down: kill relay, kill our browser profile procs, remove temp files. Idempotent. Refcount-aware. */
  cleanup: () => Promise<void>;
}

const RELAY_PS = String.raw`param(
    [int]$ListenPort,
    [int]$UpstreamPort,
    [string]$PidFile,
    [string]$LogFile,
    [int]$WatchPid,
    [int]$IdleSeconds = 600
)

# Suppress all error output to console; keep going on individual failures.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function L($m) {
    try { ('{0:o} {1}' -f (Get-Date), $m) | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch {}
}

try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $ListenPort)
    $listener.Start()
} catch {
    L ('bind-failed: {0}' -f $_.Exception.Message)
    exit 2
}

[IO.File]::WriteAllText($PidFile, "$PID")
L ('bound 0.0.0.0:{0} -> 127.0.0.1:{1} watch={2} idle={3}s pid={4}' -f $ListenPort, $UpstreamPort, $WatchPid, $IdleSeconds, $PID)

# Pre-build the per-connection forwarder script (runs in its own runspace).
# Avoids scriptblock-to-Action delegate casts (broken across PS 5 runspaces);
# uses Stream.CopyToAsync (returns Task) for one direction + synchronous
# CopyTo for the other inside this runspace's thread.
$forwarderScript = {
    param($client, $upstreamPort, $logFile)
    function FL($m) { try { ('{0:o} [conn] {1}' -f (Get-Date), $m) | Out-File -FilePath $logFile -Append -Encoding utf8 } catch {} }
    $upstream = $null
    try {
        $upstream = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $upstreamPort)
        $cs = $client.GetStream()
        $us = $upstream.GetStream()

        # client→upstream: async (returns Task; runs on .NET threadpool)
        $upTask = $cs.CopyToAsync($us)
        # upstream→client: synchronous on this runspace's thread.
        try { $us.CopyTo($cs) } catch {}
        try { $cs.Close() } catch {}

        # Wait briefly for the other direction to drain after our side closed.
        try { [void]$upTask.Wait(2000) } catch {}
        try { $us.Close() } catch {}
    } catch {
        FL ('error: {0}' -f $_.Exception.Message)
    } finally {
        try { $client.Close() } catch {}
        if ($upstream) { try { $upstream.Close() } catch {} }
    }
}

$startedAt = Get-Date
$everConnected = $false
$activeRunspaces = New-Object System.Collections.ArrayList

while ($true) {
    if ($WatchPid -gt 0) {
        if (-not (Get-Process -Id $WatchPid -ErrorAction SilentlyContinue)) {
            L 'watched browser pid gone; exiting'
            break
        }
    }
    if (-not $everConnected) {
        $idle = (Get-Date) - $startedAt
        if ($idle.TotalSeconds -gt $IdleSeconds) {
            L 'idle timeout (no connections); exiting'
            break
        }
    }
    if (-not $listener.Pending()) {
        Start-Sleep -Milliseconds 100
        continue
    }

    $client = $listener.AcceptTcpClient()
    $everConnected = $true
    L 'accept'

    # Spawn the forwarder on a dedicated PowerShell runspace so it runs in parallel.
    $ps = [PowerShell]::Create().AddScript($forwarderScript).AddArgument($client).AddArgument($UpstreamPort).AddArgument($LogFile)
    $handle = $ps.BeginInvoke()
    [void]$activeRunspaces.Add(@{ ps = $ps; handle = $handle })

    # Reap completed runspaces opportunistically so they don't pile up.
    $done = @($activeRunspaces | Where-Object { $_.handle.IsCompleted })
    foreach ($r in $done) {
        try { $r.ps.EndInvoke($r.handle) | Out-Null } catch {}
        try { $r.ps.Dispose() } catch {}
        [void]$activeRunspaces.Remove($r)
    }
}

# Drain any in-flight forwarders briefly, then bail.
foreach ($r in $activeRunspaces) {
    try {
        if ($r.handle.AsyncWaitHandle.WaitOne(2000)) {
            $r.ps.EndInvoke($r.handle) | Out-Null
        }
    } catch {}
    try { $r.ps.Dispose() } catch {}
}

try { $listener.Stop() } catch {}
try { Remove-Item -Path $PidFile -ErrorAction SilentlyContinue } catch {}
L 'exited'
`;

function runPS(scriptText: string, timeoutMs = 5000): string {
  return execFileSync(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", scriptText],
    { encoding: "utf8", timeout: timeoutMs },
  ).trim();
}

function resolveWindowsTemp(): string {
  const t = execFileSync("/mnt/c/Windows/System32/cmd.exe", ["/c", "echo %TEMP%"], {
    encoding: "utf8",
    timeout: 3000,
  }).trim();
  if (!t || t.includes("%TEMP%")) {
    throw new Error("Could not resolve %TEMP% on Windows side");
  }
  return t;
}

function winToWslPath(winPath: string): string {
  return execFileSync("/usr/bin/wslpath", ["-u", winPath], {
    encoding: "utf8",
    timeout: 2000,
  }).trim();
}

function wslToWinPath(wslPath: string): string {
  return execFileSync("/usr/bin/wslpath", ["-w", wslPath], {
    encoding: "utf8",
    timeout: 2000,
  }).trim();
}

async function pickFreePort(low: number, high: number): Promise<number> {
  const span = high - low + 1;
  const randomPick = () => low + Math.floor(Math.random() * span);
  // The CDP port (Chromium) and relay port both bind Windows-side, so on
  // WSL/Windows we can ask the OS which ports in the range are already
  // listening and avoid them. This kills the common collision where a
  // long-lived relay or CDP port sits in the same random range (observed:
  // an orphaned relay on 9455 making a fresh session's random pick fail to
  // bind). It is best-effort, not a guarantee — a TOCTOU race remains and is
  // still caught downstream by the relay bind / e2e probe. On native
  // macOS/Linux (no PowerShell, and no long-lived-relay collision to worry
  // about) we keep a plain random pick.
  if (!isWsl() && process.platform !== "win32") return randomPick();
  let inUse: Set<number>;
  try {
    const out = runPS(
      `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.LocalPort -ge ${low} -and $_.LocalPort -le ${high} } | ` +
        `Select-Object -ExpandProperty LocalPort`,
      5000,
    );
    inUse = new Set(
      out
        .split(/\r?\n/)
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n)),
    );
  } catch {
    return randomPick(); // query failed — fall back; downstream bind still guards
  }
  if (inUse.size >= span) return randomPick(); // whole range busy (improbable for 100 ports)
  for (let i = 0; i < 20; i++) {
    const p = randomPick();
    if (!inUse.has(p)) return p;
  }
  for (let p = low; p <= high; p++) if (!inUse.has(p)) return p;
  return randomPick();
}

async function probeCdp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeWindowsLocalhostCdp(port: number): Promise<boolean> {
  // Probe via Windows-side curl.exe (System32). Faster than PowerShell (no .NET runtime startup),
  // and bypasses any IE/system proxy that Invoke-RestMethod inherits.
  try {
    const out = execFileSync(
      "/mnt/c/Windows/System32/curl.exe",
      [
        "--silent",
        "--max-time",
        "2",
        "--noproxy",
        "*",
        "-o",
        "NUL",
        "-w",
        "%{http_code}",
        `http://localhost:${port}/json/version`,
      ],
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    return out === "200";
  } catch {
    return false;
  }
}

function escapePsLikePattern(s: string): string {
  // PS -like wildcards: * ? [ ]. Escape any literal occurrence with [c].
  return s.replace(/[\[\]*?]/g, (c) => `[${c}]`);
}

async function findBrowserRootPid(
  cdpPort: number,
  userDataDirWin: string,
  processName: string,
): Promise<number | null> {
  // Find the root browser process: the one whose CommandLine carries both
  // --remote-debugging-port=<port> (only on the root, not on child renderers)
  // and --user-data-dir=<path>. The path uniquely identifies our spawn
  // regardless of whether it was auto-generated (bm-cdp-<sessionId>) or
  // caller-supplied via userDataDirOverride.
  const safe = sanitizeProcessName(processName);
  const safePath = escapePsLikePattern(userDataDirWin);
  try {
    const cmd = String.raw`Get-CimInstance Win32_Process -Filter "Name='${safe}'" | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${cdpPort}*' -and $_.CommandLine -like '*${safePath}*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
    const out = runPS(cmd, 5000);
    const n = parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function killBrowserTreeByPid(pid: number): Promise<void> {
  // taskkill /F /T kills the target AND its entire descendant tree. Chromium
  // spawns many child processes (renderer / gpu-process / utility / etc.) that
  // get reparented if you only kill the root, leaving zombies. The earlier
  // PS Stop-Process by tag implementation hit this — clone procs survived
  // session close when --user-data-dir was overridden.
  try {
    execFileSync(
      "/mnt/c/Windows/System32/taskkill.exe",
      ["/F", "/T", "/PID", String(pid)],
      { encoding: "utf8", timeout: 8000, stdio: "pipe" },
    );
  } catch {
    // best-effort: taskkill exits non-zero if the process already vanished
  }
}

async function killBrowserByUserDataDir(
  userDataDirWin: string,
  processName: string,
): Promise<void> {
  // Fallback when findBrowserRootPid couldn't resolve a PID at spawn time.
  // Children inherit --user-data-dir, so a path-based filter sweeps the tree.
  const safe = sanitizeProcessName(processName);
  const safePath = escapePsLikePattern(userDataDirWin);
  try {
    const cmd = String.raw`Get-CimInstance Win32_Process -Filter "Name='${safe}'" | Where-Object { $_.CommandLine -like '*${safePath}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }`;
    runPS(cmd, 8000);
  } catch {
    // best-effort
  }
}

async function killProcessByPid(pid: number): Promise<void> {
  try {
    runPS(`try { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue } catch {}`, 5000);
  } catch {
    // best-effort
  }
}

/**
 * Poll Windows-side until the given PID is no longer alive, or until
 * timeout. Used by cleanup paths to verify that a taskkill actually took
 * effect before unlinking the sidecar file. Returns true if confirmed
 * dead, false on timeout.
 */
async function waitForWindowsPidDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!aliveWindowsPids([pid]).has(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Scan Windows for an orphaned Chromium that matches the browser-mcp launch
 * signature on the requested user_data_dir. Returned only when EXACTLY one
 * root process is found; multiple matches surface as `{ ambiguous: N }`.
 *
 * Used by the orphan-adoption path in spawnAttachCdpRelay when the sidecar
 * file is absent or has a stale root_pid but a Chromium is still alive on
 * the profile (typical cause: prior browser-mcp Node process died before
 * running its cleanup — terminal closed, conversation killed, OS reboot).
 *
 * Match criteria (all required):
 *   - process Name == processName (e.g. "msedge.exe")
 *   - CommandLine contains `--user-data-dir=<exact path>` at a word boundary
 *   - CommandLine contains `--remote-debugging-port=<digits>` (only root has this)
 *   - CommandLine contains `--remote-allow-origins=*` (browser-mcp signature)
 *
 * Chromium's OS-level profile file lock guarantees at most one root process
 * per user_data_dir, so multi-match is unexpected in practice — but we
 * still defend against it rather than picking arbitrarily.
 */
async function findOrphanedBrowser(
  userDataDirWin: string,
  processName: string,
): Promise<{ rootPid: number; cdpPort: number } | { ambiguous: number } | null> {
  const safe = sanitizeProcessName(processName);
  // [regex]::Escape on the JS side — PS -match uses .NET regex syntax.
  const escapedPath = userDataDirWin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-boundary after the path so `C:\edge-cdp-profile` doesn't match
  // a longer `C:\edge-cdp-profile-other`.
  const pathPattern = `--user-data-dir=${escapedPath}(\\s|"|$)`;
  // \* is a literal asterisk in .NET regex.
  const signaturePattern = "--remote-allow-origins=\\*";
  const portPattern = "--remote-debugging-port=(\\d+)";
  // Emit one PID:PORT line per match, terminated newline. Avoids ConvertTo-Json
  // -AsArray (PS 6+ only) and ConvertTo-Json single-item-collapses on PS 5.1.
  const cmd = String.raw`$ErrorActionPreference='SilentlyContinue';
$found = Get-CimInstance Win32_Process -Filter "Name='${safe}'" | Where-Object {
  $_.CommandLine -match '${pathPattern}' -and
  $_.CommandLine -match '${signaturePattern}' -and
  $_.CommandLine -match '${portPattern}'
};
foreach ($p in $found) {
  $m = [regex]::Match($p.CommandLine, '${portPattern}');
  if ($m.Success) {
    Write-Output ("{0}:{1}" -f $p.ProcessId, $m.Groups[1].Value)
  }
}`;
  let raw: string;
  try {
    raw = runPS(cmd, 8000);
  } catch (e) {
    dbg("findOrphanedBrowser: PS query failed:", (e as Error).message);
    return null;
  }
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    dbg("findOrphanedBrowser: no orphan match for", { userDataDirWin, processName });
    return null;
  }
  if (lines.length > 1) {
    dbg("findOrphanedBrowser: ambiguous match", { lines });
    return { ambiguous: lines.length };
  }
  const parts = lines[0].split(":");
  const rootPid = parseInt(parts[0] ?? "", 10);
  const cdpPort = parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(rootPid) || rootPid <= 0 || !Number.isFinite(cdpPort) || cdpPort <= 0) {
    dbg("findOrphanedBrowser: malformed PS output:", lines[0]);
    return null;
  }
  dbg("findOrphanedBrowser: found", { rootPid, cdpPort });
  return { rootPid, cdpPort };
}

/**
 * Spawn a PS relay process pointing at an existing Chromium CDP port and
 * watching a given root PID. Used by both the spawn path and the orphan-
 * adoption path. Writes/refreshes relay.ps1 in the session dir, kicks off
 * powershell.exe detached, and waits for the .pid file to appear.
 *
 * Throws if the relay fails to bind within 5s. Returns the relay PID + the
 * WSL paths to the pid/log files (for diagnostics + later teardown).
 */
async function spawnRelayProcess(opts: {
  sessionDirWin: string;
  sessionDirWsl: string;
  cdpPort: number;
  relayPort: number;
  watchPid: number;
  idleSeconds: number;
}): Promise<{ relayPid: number; relayPidFileWsl: string; relayLogFileWsl: string }> {
  const psPath = `${opts.sessionDirWin}\\relay.ps1`;
  const pidFile = `${opts.sessionDirWin}\\relay.pid`;
  const logFile = `${opts.sessionDirWin}\\relay.log`;
  const psPathWsl = winToWslPath(psPath);
  const relayPidFileWsl = winToWslPath(pidFile);
  const relayLogFileWsl = winToWslPath(logFile);

  if (!existsSync(psPathWsl)) {
    writeFileSync(psPathWsl, RELAY_PS, "utf8");
  }
  try { if (existsSync(relayPidFileWsl)) rmSync(relayPidFileWsl); } catch {}

  spawnDetachedWindows([
    "/c",
    "start",
    '""',
    "/B",
    "/MIN",
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    psPath,
    "-ListenPort",
    String(opts.relayPort),
    "-UpstreamPort",
    String(opts.cdpPort),
    "-PidFile",
    pidFile,
    "-LogFile",
    logFile,
    "-WatchPid",
    String(opts.watchPid),
    "-IdleSeconds",
    String(opts.idleSeconds),
  ]);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(relayPidFileWsl)) {
      const raw = readFileSync(relayPidFileWsl, "utf8").trim();
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) {
        return { relayPid: n, relayPidFileWsl, relayLogFileWsl };
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `attach_cdp: relay failed to bind on port ${opts.relayPort} within 5s. See log: ${relayLogFileWsl}`,
  );
}

function spawnDetachedWindows(args: string[]): number {
  // Use cmd.exe /c start /B so the spawned Windows process is fully decoupled from the WSL Node parent.
  const child = spawn("/mnt/c/Windows/System32/cmd.exe", args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? -1;
}

const DBG = process.env.BROWSER_MCP_CDP_DEBUG === "1";
function dbg(...a: unknown[]) {
  if (DBG) console.error("[cdp-relay]", ...a);
}

function readDevToolsActivePort(userDataDirWin: string): number | null {
  try {
    const wslPath = winToWslPath(userDataDirWin) + "/DevToolsActivePort";
    if (!existsSync(wslPath)) return null;
    const raw = readFileSync(wslPath, "utf8");
    const firstLine = raw.split(/\r?\n/)[0]?.trim();
    const n = parseInt(firstLine ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function spawnAttachCdpRelay(
  opts: SpawnAttachCdpOptions,
): Promise<AttachCdpHandle> {
  const wsl = isWsl();
  const sessionTag = `bm-cdp-${opts.sessionId}`;

  // ---- 0. Resolve paths ----
  const winTemp = wsl ? resolveWindowsTemp() : "";
  const sessionDirWin = wsl
    ? `${winTemp}\\browser-mcp\\${opts.sessionId}`
    : "";
  const sessionDirWsl = wsl ? winToWslPath(sessionDirWin) : "";
  if (wsl) {
    mkdirSync(sessionDirWsl, { recursive: true });
  }

  // user-data-dir: caller override, or a session-scoped temp dir tagged with sessionTag in the path
  const userDataDirWin = opts.userDataDirOverride
    ?? (wsl
      ? `${sessionDirWin}\\${sessionTag}`
      : (() => {
        // native: use a local temp dir; tag with sessionTag for the kill filter
        const base = process.platform === "win32" ? (process.env.TEMP ?? "C:\\Windows\\Temp") : "/tmp";
        const sep = process.platform === "win32" ? "\\" : "/";
        const dir = `${base}${sep}browser-mcp${sep}${opts.sessionId}${sep}${sessionTag}`;
        mkdirSync(dir, { recursive: true });
        return dir;
      })());

  const cdpPortReq = opts.cdpPort ?? (await pickFreePort(9300, 9399));
  const relayPortReq = wsl ? (opts.relayPort ?? (await pickFreePort(9400, 9499))) : null;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 15_000;
  // Sanitize once up front — any per-spec typo blows up before we spawn.
  const processName = sanitizeProcessName(opts.processName);

  // Ensure user_data_dir exists so the sidecar (.bm-browser.json) can live in it.
  // The sidecar is the cross-process coordination point for "multiple browser-mcp
  // servers sharing one profile" — see browser-sidecar.ts.
  const userDataDirWsl = wsl ? winToWslPath(userDataDirWin) : userDataDirWin;
  if (!existsSync(userDataDirWsl)) {
    mkdirSync(userDataDirWsl, { recursive: true });
  }

  // ---- Sidecar-coordinated spawn-or-attach ----
  // Acquire the sidecar lock and hold it across the entire decide → spawn →
  // record sequence. Other concurrent open_session calls on the same profile
  // wait on the lock; that's the desired serialization (without it, two
  // servers could both decide to spawn and one would crash on Chromium's
  // own profile file-lock).
  return withSidecarLock<AttachCdpHandle>(userDataDirWsl, async (current) => {
    // ---- ATTACH path: existing browser is alive ----
    if (current) {
      const rootAlive = aliveWindowsPids([current.root_pid]).has(current.root_pid);
      if (rootAlive) {
        const gateway = wsl ? readWslGatewayIp() : null;
        // root_pid being alive is necessary but NOT sufficient to attach. On
        // WSL the relay is a SEPARATE process with its own PID and can die
        // independently of the browser (host sleep, PowerShell crash, relay
        // idle-timeout) while Chromium keeps running. The old attach path
        // returned the sidecar's relay endpoint without ever probing it, so a
        // dead relay made the caller's connectOverCDP hang the full 30s. Health-
        // check the EXACT endpoint we would hand back, with a short timeout,
        // before committing to attach.
        let endpointLive = false;
        if (wsl) {
          endpointLive =
            current.relay_port != null &&
            gateway != null &&
            (await probeCdp(gateway, current.relay_port, 2000));
        } else {
          endpointLive = await probeCdp("localhost", current.cdp_port, 2000);
        }

        // Stale-relay recovery (WSL): browser alive, relay dead. If the browser
        // is still serving CDP on its Windows-side localhost port, respawn ONLY
        // the relay pointing at the existing cdp_port. Cheapest possible
        // recovery — the live browser and its loaded (often credentialed)
        // session are preserved; nothing is killed.
        if (!endpointLive && wsl && gateway != null) {
          const cdpAlive = await probeWindowsLocalhostCdp(current.cdp_port);
          if (cdpAlive) {
            dbg("sidecar: root + CDP alive but relay dead — respawning relay", {
              root_pid: current.root_pid,
              cdp_port: current.cdp_port,
              dead_relay_pid: current.relay_pid,
              dead_relay_port: current.relay_port,
            });
            // Deliberately do NOT kill the old relay_pid: it's already dead
            // (that's why we're here) or wedged, and a relay that died long ago
            // may have had its PID reused by an unrelated Windows process —
            // killing a reused PID is the worse failure. A wedged old relay on
            // the old port can't conflict with a fresh relay on a new port; it
            // idle-times-out on its own.
            const newRelayPort = relayPortReq!;
            const relayInfo = await spawnRelayProcess({
              sessionDirWin,
              sessionDirWsl,
              cdpPort: current.cdp_port,
              relayPort: newRelayPort,
              watchPid: current.root_pid,
              idleSeconds: opts.relayIdleSeconds ?? 600,
            });
            const e2eDeadline = Date.now() + 5000;
            let e2eUp = false;
            while (Date.now() < e2eDeadline) {
              e2eUp = await probeCdp(gateway, newRelayPort, 1500);
              if (e2eUp) break;
              await new Promise((r) => setTimeout(r, 200));
            }
            if (!e2eUp) {
              await killProcessByPid(relayInfo.relayPid);
              throw new Error(
                `attach_cdp: browser pid ${current.root_pid} is alive and serving CDP on ` +
                  `port ${current.cdp_port}, but its relay had died and a respawned relay on ` +
                  `${newRelayPort} failed its end-to-end probe. Relay log: ${relayInfo.relayLogFileWsl}.`,
              );
            }
            // Point the (mutable) sidecar view at the fresh relay so the attach
            // return + cleanup below use the new port/pid, and the updated
            // sidecar persists them for the next open_session.
            current = { ...current, relay_pid: relayInfo.relayPid, relay_port: newRelayPort };
            endpointLive = true;
          }
        }

        if (!endpointLive) {
          // Browser root is alive but its CDP endpoint is unreachable and not
          // recoverable by a relay respawn (browser wedged, or the CDP port
          // itself is dead). Don't hang, and don't silently fall through to
          // spawn — spawning a competitor would deadlock on Chromium's profile
          // file-lock. Surface an actionable error instead.
          throw new Error(
            `attach_cdp: sidecar at ${userDataDirWin} records a live browser ` +
              `(root_pid ${current.root_pid}) but its CDP endpoint is unreachable` +
              (wsl
                ? ` (relay port ${current.relay_port} dead AND Windows-localhost CDP ` +
                  `port ${current.cdp_port} not responding)`
                : ` (localhost:${current.cdp_port} not responding)`) +
              `. The browser appears wedged. Recover with close_browser({ force: true }) ` +
              `on this profile, or manually: Stop-Process -Id ${current.root_pid} -Force.`,
          );
        }

        dbg("sidecar: attaching to existing browser", {
          root_pid: current.root_pid,
          cdp_port: current.cdp_port,
          relay_port: current.relay_port,
          existing_sessions: current.attached_sessions.length,
        });
        const endpoint = wsl
          ? `http://${gateway}:${current.relay_port}`
          : `http://localhost:${current.cdp_port}`;
        const updatedInfo = {
          ...current,
          attached_sessions: [
            ...current.attached_sessions,
            { session_id: opts.sessionId, browser_mcp_pid: process.pid, attached_at: new Date().toISOString() },
          ],
        };
        // Snapshot for the cleanup closure: `current` is a reassignable param,
        // so TS widens it back to `SidecarInfo | null` inside the async closure.
        // A const captures the confirmed-non-null (possibly relay-respawned) view.
        const attached = current;
        let cleaned = false;
        const cleanup = async () => {
          if (cleaned) return;
          cleaned = true;
          const removal = await removeSession({ userDataDirWsl, session_id: opts.sessionId });
          if (removal.was_last) {
            dbg("cleanup (attach-via=existing): was_last → killing browser tree + relay");
            if (attached.relay_pid != null) await killProcessByPid(attached.relay_pid);
            await killBrowserTreeByPid(attached.root_pid);
            const dead = await waitForWindowsPidDead(attached.root_pid);
            if (dead) {
              await finalizeSidecarTeardown({ userDataDirWsl });
              if (wsl) {
                try { rmSync(sessionDirWsl, { recursive: true, force: true }); } catch {}
              } else if (!opts.userDataDirOverride) {
                try { rmSync(userDataDirWin, { recursive: true, force: true }); } catch {}
              }
            } else {
              dbg(
                "cleanup (attach-via=existing): browser failed to die within timeout — " +
                "leaving sidecar in place so the next open_session can re-attach " +
                "instead of falling into the spawn path and lock-conflicting.",
              );
            }
          } else {
            dbg(`cleanup (attach-via=existing): ${removal.remaining} sibling session(s) still attached → leaving browser up`);
          }
        };
        return {
          updated: updatedInfo,
          result: {
            endpoint,
            userDataDir: current.user_data_dir,
            browserPid: current.root_pid,
            relayPid: current.relay_pid,
            relayPort: current.relay_port,
            cdpPort: current.cdp_port,
            gateway,
            attachedVia: "existing",
            cleanup,
          },
        };
      }
      dbg("sidecar present but root_pid is dead; falling through to orphan-scan / spawn", { stale_root_pid: current.root_pid });
    }

    // ---- ORPHAN-ADOPTION path ----
    // No live sidecar, or sidecar's recorded root_pid is dead. But there
    // may still be a browser-mcp-signature Chromium running on this
    // user_data_dir from a prior Node-side crash (terminal closed,
    // conversation killed, OS reboot — anywhere cleanup didn't run).
    // Scan for it; if found, spawn a fresh relay pointing at its CDP port
    // and write a new sidecar instead of falling into spawn (which would
    // hit Chromium's OS-level profile file lock).
    if (wsl) {
      let orphan: Awaited<ReturnType<typeof findOrphanedBrowser>> = null;
      try {
        orphan = await findOrphanedBrowser(userDataDirWin, processName);
      } catch (e) {
        dbg("orphan scan failed (non-fatal, falling through to spawn):", (e as Error).message);
      }
      if (orphan && "ambiguous" in orphan) {
        throw new Error(
          `attach_cdp: found ${orphan.ambiguous} ${processName} processes matching ` +
            `--user-data-dir=${userDataDirWin} + browser-mcp signature. ` +
            `Chromium's profile lock should make this impossible — refusing to adopt. ` +
            `Manually inspect: Get-CimInstance Win32_Process -Filter "Name='${processName}'" | ` +
            `Where-Object { $_.CommandLine -match '--user-data-dir=' } | Select ProcessId,CommandLine`,
        );
      }
      if (orphan && "rootPid" in orphan) {
        dbg("orphan-scan: found browser-mcp-signature Chromium; adopting", {
          root_pid: orphan.rootPid,
          cdp_port: orphan.cdpPort,
        });
        // Reuse the new caller's session-scoped dir for the adoption relay.
        // Each adopter spawns its own relay process; on was_last cleanup we
        // kill both the relay and the adopted browser.
        const adoptRelayPort = relayPortReq!;
        const relayInfo = await spawnRelayProcess({
          sessionDirWin,
          sessionDirWsl,
          cdpPort: orphan.cdpPort,
          relayPort: adoptRelayPort,
          watchPid: orphan.rootPid,
          idleSeconds: opts.relayIdleSeconds ?? 600,
        });
        const gateway = readWslGatewayIp();
        if (gateway == null) {
          await killProcessByPid(relayInfo.relayPid);
          throw new Error(
            "attach_cdp: orphan adoption requires WSL gateway IP but readWslGatewayIp() returned null.",
          );
        }
        // E2E probe via the new relay to confirm the orphan's CDP port is reachable.
        const e2eDeadline = Date.now() + 5000;
        let e2eUp = false;
        while (Date.now() < e2eDeadline) {
          e2eUp = await probeCdp(gateway, adoptRelayPort, 1500);
          if (e2eUp) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!e2eUp) {
          await killProcessByPid(relayInfo.relayPid);
          throw new Error(
            `attach_cdp: adopted browser pid ${orphan.rootPid} on port ${orphan.cdpPort} ` +
              `but end-to-end probe via relay ${adoptRelayPort} failed. ` +
              `Relay log: ${relayInfo.relayLogFileWsl}. ` +
              `Browser may be deadlocked; manual recovery: Stop-Process -Id ${orphan.rootPid} -Force.`,
          );
        }

        const adoptedSidecar = {
          schema_version: 1 as const,
          cdp_port: orphan.cdpPort,
          relay_port: adoptRelayPort,
          relay_pid: relayInfo.relayPid,
          root_pid: orphan.rootPid,
          process_name: processName,
          user_data_dir: userDataDirWin,
          spawned_at: new Date().toISOString(),
          attached_sessions: [
            { session_id: opts.sessionId, browser_mcp_pid: process.pid, attached_at: new Date().toISOString() },
          ],
        };

        const adoptedRelayPid = relayInfo.relayPid;
        const adoptedRootPid = orphan.rootPid;
        let cleanedAdopted = false;
        const cleanupAdopted = async () => {
          if (cleanedAdopted) return;
          cleanedAdopted = true;
          const removal = await removeSession({ userDataDirWsl, session_id: opts.sessionId });
          if (removal.was_last) {
            dbg("cleanup (attach-via=adopted): was_last → killing browser tree + relay");
            await killProcessByPid(adoptedRelayPid);
            await killBrowserTreeByPid(adoptedRootPid);
            const dead = await waitForWindowsPidDead(adoptedRootPid);
            if (dead) {
              await finalizeSidecarTeardown({ userDataDirWsl });
              try { rmSync(sessionDirWsl, { recursive: true, force: true }); } catch {}
            } else {
              dbg(
                "cleanup (attach-via=adopted): browser failed to die within timeout — " +
                "leaving sidecar in place for re-adoption.",
              );
            }
          } else {
            dbg(`cleanup (attach-via=adopted): ${removal.remaining} sibling session(s) still attached → leaving browser up`);
          }
        };

        return {
          updated: adoptedSidecar,
          result: {
            endpoint: `http://${gateway}:${adoptRelayPort}`,
            userDataDir: userDataDirWin,
            browserPid: orphan.rootPid,
            relayPid: relayInfo.relayPid,
            relayPort: adoptRelayPort,
            cdpPort: orphan.cdpPort,
            gateway,
            attachedVia: "adopted",
            cleanup: cleanupAdopted,
          },
        };
      }
      // No orphan found → fall through to spawn.
    }

    // ---- SPAWN path: no live browser, launch fresh ----
    const cdpPort = cdpPortReq;
    const relayPort = relayPortReq;

  // ---- 1. Spawn the relay (WSL only) ----
  let relayPid: number | null = null;
  let relayPidFileWsl: string | null = null;
  let relayLogFileWsl: string | null = null;
  if (wsl && relayPort != null) {
    const psPath = `${sessionDirWin}\\relay.ps1`;
    const pidFile = `${sessionDirWin}\\relay.pid`;
    const logFile = `${sessionDirWin}\\relay.log`;
    const psPathWsl = winToWslPath(psPath);
    relayPidFileWsl = winToWslPath(pidFile);
    relayLogFileWsl = winToWslPath(logFile);

    writeFileSync(psPathWsl, RELAY_PS, "utf8");

    // Note: WatchPid is 0 here because the browser isn't spawned yet. We
    // update it after we have a browser PID by writing a sentinel file, OR —
    // simpler — we just spawn the browser first when we have its PID, then
    // start the relay with that PID. So actually: rearrange order. Spawn the
    // browser first, then relay. Skip this branch; we'll re-enter it below
    // after browser spawn.
  }

  // ---- 2. Spawn the browser ----
  // user-data-dir prefilled (sessionTag is part of the path so we can kill only our procs).
  // Use an isolated tmp profile per session so the user's real browser data is untouched.
  if (!opts.userDataDirOverride) {
    // ensure dir exists
    if (wsl) {
      mkdirSync(winToWslPath(userDataDirWin), { recursive: true });
    } else if (process.platform === "win32") {
      mkdirSync(userDataDirWin, { recursive: true });
    }

    // Pre-seed Default/Preferences with translate disabled. --disable-features=Translate
    // alone is not always enough on Edge — the in-page "Translate this page?" infobar
    // is also gated on the per-profile `translate.enabled` boolean (defaults to true).
    // Writing the pref BEFORE first launch is the only way to suppress it on the very
    // first page visit; Edge picks it up at startup and respects it for the session.
    // Skipped when the caller supplies their own user_data_dir — that's their profile,
    // we don't mutate it.
    try {
      const defaultDirWin = `${userDataDirWin}\\Default`;
      const defaultDirNode = wsl ? winToWslPath(defaultDirWin) : defaultDirWin;
      mkdirSync(defaultDirNode, { recursive: true });
      const stubPrefs = JSON.stringify({
        translate: { enabled: false },
        translate_blocked_languages: ["*"],
        // Suppress the OS-account auto-sign-in modal that Edge surfaces on
        // a fresh isolated profile (it inherits the Windows account identity
        // via SSO and pops a "Use Windows credentials to sign in" prompt
        // that intercepts the agent's first interaction). Mirrors the
        // BrowserSignin=0 group policy at the per-profile level; --disable-
        // sync alone is not enough (it kills sync but the sign-in prompt
        // still appears). Skipped when the caller supplies their own
        // user_data_dir — that's their profile, we don't mutate it.
        signin: { allowed: false },
      });
      writeFileSync(`${defaultDirNode}/Preferences`, stubPrefs, "utf8");
    } catch (e) {
      dbg("pre-seed Preferences failed (non-fatal):", (e as Error).message);
    }
  }

  const browserArgs = [
    `--remote-debugging-port=${cdpPort}`,
    "--remote-allow-origins=*", // accept WS handshakes from non-localhost origins (the relay)
    `--user-data-dir=${userDataDirWin}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    // --no-first-run alone does NOT suppress Edge's sync-confirmation-dialog
    // landing page on a fresh isolated profile (and Chrome/Brave/Vivaldi/Opera
    // each have their own equivalent FRE/sync flows). --disable-sync is the
    // standard Chromium switch that turns off the Sync subsystem entirely;
    // it also short-circuits the sync FRE flow, so the requested startup URL
    // ("about:blank") wins across all five products.
    "--disable-sync",
    // Translate suppression: belt-and-suspenders.
    //   --disable-features=Translate kills the Chromium feature.
    //   TranslateUI kills the infobar specifically (separate Edge build flag).
    //   The pre-seeded Default/Preferences above sets translate.enabled=false,
    //   which catches the case where Edge honors the per-profile pref over
    //   the feature flag (observed on current Edge 147+ — flag alone isn't enough).
    "--disable-features=Translate,TranslateUI",
    // Crash-restore-bubble suppression: when Edge closes uncleanly (crash,
    // taskkill, OOM, host reboot), the next launch shows "Restore tabs from
    // your last session?". On a user-supplied user_data_dir (CDP attach to
    // the credentialed profile at C:\edge-cdp-profile), that bubble
    // intercepts the agent's first navigate/click. --hide-crash-restore-bubble
    // is the Chromium switch that suppresses the bubble specifically; flag-only
    // (no Preferences mutation) per Leandro's call to keep the
    // user-supplied-profile-immutability rule intact (see memory
    // edge-translate-suppression-needs-both-th). Omitted when the caller
    // explicitly asked to restore the previous session — the flag also
    // disables Edge's silent auto-restore path, so leaving it set would
    // make `restore_previous_tabs: true` a no-op. If the bubble ever
    // resurfaces on a newer Edge version where it can't be suppressed any
    // other way, revisit — the Preferences fix (set profile.exit_type=
    // "Normal" + exited_cleanly=true) is the backup.
    ...(opts.restorePreviousTabs ? [] : ["--hide-crash-restore-bubble"]),
    "about:blank",
  ];

  dbg("spawning browser:", { wsl, exe: opts.executablePath, processName, port: cdpPort, profile: userDataDirWin });
  dbg("browserArgs:", browserArgs);
  if (wsl) {
    const cmdArgs = [
      "/c",
      "start",
      '""',
      "/B",
      opts.executablePath,
      ...browserArgs,
    ];
    dbg("cmd.exe args:", cmdArgs);
    spawnDetachedWindows(cmdArgs);
    // brief tasklist diagnostic so we can tell if the browser process ever starts
    if (DBG) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const cnt = runPS(
          String.raw`(Get-CimInstance Win32_Process -Filter "Name='${processName}'" | Where-Object { $_.CommandLine -like '*${sessionTag}*' } | Measure-Object).Count`,
          5000,
        );
        dbg(`tagged ${processName} procs +1s after spawn: ${cnt}`);
      } catch (e) {
        dbg("tasklist diagnostic failed:", e);
      }
    }
  } else if (process.platform === "win32") {
    const child = spawn(opts.executablePath, browserArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else {
    // macOS / Linux native — spawn directly
    const child = spawn(opts.executablePath, browserArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // ---- 3. Wait for the browser CDP endpoint to bind on the Windows side ----
  // Probe the port we asked for. Chromium picks the requested port if free; we
  // generated a random port from a wide range so collisions are unlikely.
  // DevToolsActivePort would tell us the actual bound port if we needed it,
  // but some Chromium builds (notably Edge 147+) do not write the file even
  // when the server is up (verified empirically) — don't gate on it.
  const cdpDeadline = Date.now() + startupTimeoutMs;
  let cdpUp = false;
  let attempts = 0;
  while (Date.now() < cdpDeadline) {
    attempts++;
    if (wsl) {
      cdpUp = await probeWindowsLocalhostCdp(cdpPort);
    } else {
      cdpUp = await probeCdp("localhost", cdpPort);
    }
    if (cdpUp) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const actualCdpPort = cdpUp ? cdpPort : (readDevToolsActivePort(userDataDirWin) ?? cdpPort);

  if (!cdpUp) {
    dbg(`browser did not come up. attempts=${attempts} requested_port=${cdpPort} dev_tools_active_port=${actualCdpPort !== cdpPort ? actualCdpPort : "n/a"}`);
    await killBrowserByUserDataDir(userDataDirWin, processName);
    throw new Error(
      `attach_cdp: browser spawned but did not open CDP port within ${startupTimeoutMs}ms. ` +
        `attempts=${attempts}, asked_port=${cdpPort}, process=${processName}. ` +
        `Possible causes: profile lock (--user-data-dir already in use by another instance), ` +
        `--remote-debugging-port disabled by group policy, or executable_path is wrong (${opts.executablePath}).`,
    );
  }
  dbg(`browser up on ${actualCdpPort} after ${attempts} attempts`);

  const browserPid = await findBrowserRootPid(actualCdpPort, userDataDirWin, processName);
  dbg(`browser root pid: ${browserPid}`);

  // ---- 4. Start the PS relay now that we know the browser PID to watch ----
  if (wsl && relayPort != null) {
    const psPath = `${sessionDirWin}\\relay.ps1`;
    const pidFile = `${sessionDirWin}\\relay.pid`;
    const logFile = `${sessionDirWin}\\relay.log`;
    relayPidFileWsl = winToWslPath(pidFile);
    relayLogFileWsl = winToWslPath(logFile);

    if (!existsSync(winToWslPath(psPath))) {
      writeFileSync(winToWslPath(psPath), RELAY_PS, "utf8");
    }
    // remove stale pid file if any
    try { if (existsSync(relayPidFileWsl)) rmSync(relayPidFileWsl); } catch {}

    spawnDetachedWindows([
      "/c",
      "start",
      '""',
      "/B",
      "/MIN",
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      psPath,
      "-ListenPort",
      String(relayPort),
      "-UpstreamPort",
      String(actualCdpPort),
      "-PidFile",
      pidFile,
      "-LogFile",
      logFile,
      "-WatchPid",
      String(browserPid ?? 0),
      "-IdleSeconds",
      String(opts.relayIdleSeconds ?? 600),
    ]);

    // wait for .pid file to appear
    const relayDeadline = Date.now() + 5000;
    while (Date.now() < relayDeadline) {
      if (existsSync(relayPidFileWsl)) {
        const raw = readFileSync(relayPidFileWsl, "utf8").trim();
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) {
          relayPid = n;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (relayPid == null) {
      // tear down everything
      if (browserPid != null) await killBrowserTreeByPid(browserPid);
      else await killBrowserByUserDataDir(userDataDirWin, processName);
      throw new Error(
        `attach_cdp: relay failed to bind on port ${relayPort} within 5s. ` +
          `See log: ${relayLogFileWsl}`,
      );
    }
  }

  // ---- 5. Probe the relay (or localhost) end-to-end ----
  const gateway = wsl ? readWslGatewayIp() : null;
  const endpoint = wsl
    ? `http://${gateway}:${relayPort}`
    : `http://localhost:${cdpPort}`;

  const e2eDeadline = Date.now() + 5000;
  let e2eUp = false;
  while (Date.now() < e2eDeadline) {
    if (wsl) {
      // probe through gateway:relayPort
      e2eUp = await probeCdp(gateway!, relayPort!, 1500);
    } else {
      e2eUp = await probeCdp("localhost", cdpPort, 1500);
    }
    if (e2eUp) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!e2eUp) {
    if (relayPid != null) await killProcessByPid(relayPid);
    if (browserPid != null) await killBrowserTreeByPid(browserPid);
    else await killBrowserByUserDataDir(userDataDirWin, processName);
    throw new Error(
      `attach_cdp: end-to-end probe at ${endpoint} failed. ` +
        (wsl
          ? `Relay log: ${relayLogFileWsl}. Possible causes: Windows Firewall blocking 0.0.0.0:${relayPort}, gateway IP ${gateway} unreachable.`
          : "Browser CDP did not respond on localhost."),
    );
  }

    if (browserPid === null) {
      throw new Error(
        `attach_cdp: spawned Chromium but could not resolve root PID via Win32_Process. ` +
          `Sidecar refcount semantics require a stable root PID for cross-server coordination. ` +
          `Aborting spawn.`,
      );
    }

    // Build the sidecar record reflecting our fresh spawn.
    const newSidecar = {
      schema_version: 1 as const,
      cdp_port: actualCdpPort,
      relay_port: relayPort,
      relay_pid: relayPid,
      root_pid: browserPid,
      process_name: processName,
      user_data_dir: userDataDirWin,
      spawned_at: new Date().toISOString(),
      attached_sessions: [
        { session_id: opts.sessionId, browser_mcp_pid: process.pid, attached_at: new Date().toISOString() },
      ],
    };

    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      const removal = await removeSession({ userDataDirWsl, session_id: opts.sessionId });
      if (removal.was_last) {
        dbg("cleanup (attach-via=spawn): was_last → killing browser tree + relay");
        if (relayPid != null) await killProcessByPid(relayPid);
        // Prefer PID-tree teardown (covers all child procs via taskkill /T).
        // Falls back to user_data_dir path filter only when we never resolved
        // a PID at spawn — that path also catches every child since they
        // inherit --user-data-dir on the CommandLine.
        if (browserPid != null) await killBrowserTreeByPid(browserPid);
        else await killBrowserByUserDataDir(userDataDirWin, processName);
        // Verify the browser actually died before unlinking the sidecar.
        // If kill silently partial-fails (Edge tray respawn, watchdog,
        // swallowed PS error), keep the sidecar so the next open_session
        // attaches instead of falling into spawn + lock conflict.
        const dead = browserPid != null
          ? await waitForWindowsPidDead(browserPid)
          : true;
        if (dead) {
          await finalizeSidecarTeardown({ userDataDirWsl });
          if (wsl) {
            try { rmSync(sessionDirWsl, { recursive: true, force: true }); } catch {}
          } else if (!opts.userDataDirOverride) {
            try { rmSync(userDataDirWin, { recursive: true, force: true }); } catch {}
          }
        } else {
          dbg(
            "cleanup (attach-via=spawn): browser failed to die within timeout — " +
            "leaving sidecar in place so the next open_session can re-attach.",
          );
        }
      } else {
        dbg(`cleanup (attach-via=spawn): ${removal.remaining} other session(s) attached to OUR spawned browser → leaving browser up`);
      }
    };

    return {
      updated: newSidecar,
      result: {
        endpoint,
        userDataDir: userDataDirWin,
        browserPid,
        relayPid,
        relayPort,
        cdpPort: actualCdpPort,
        gateway,
        attachedVia: "spawn",
        cleanup,
      },
    };
  });
}

/**
 * Force-nuke an attach_cdp browser tree by reading the sidecar at the given
 * Windows user_data_dir. Used by close_browser({force:true}) to kill a
 * shared-profile browser even when other browser-mcp servers are still
 * attached. Those servers' Playwright connections will discover the
 * disconnect on their next CDP call.
 *
 * Removes the sidecar file as well so subsequent open_session calls on the
 * same profile see a clean slate.
 *
 * No-op if the sidecar is absent or the recorded root_pid is already dead.
 */
export async function forceKillProfile(userDataDirWin: string): Promise<{
  killed_root_pid: number | null;
  killed_relay_pid: number | null;
  abandoned_sessions: number;
}> {
  const wsl = isWsl();
  const wslPath = wsl ? winToWslPath(userDataDirWin) : userDataDirWin;
  const { readSidecar } = await import("./browser-sidecar.js");
  const sidecar = readSidecar(wslPath);
  if (!sidecar) return { killed_root_pid: null, killed_relay_pid: null, abandoned_sessions: 0 };

  if (sidecar.relay_pid != null) await killProcessByPid(sidecar.relay_pid);
  await killBrowserTreeByPid(sidecar.root_pid);

  // Best-effort sidecar removal — withSidecarLock would block other
  // operations; force mode is meant to be aggressive, not polite.
  try {
    const { unlinkSync, existsSync } = await import("node:fs");
    const sidecarFile = `${wslPath}/.bm-browser.json`;
    if (existsSync(sidecarFile)) unlinkSync(sidecarFile);
  } catch { /* ignore */ }

  return {
    killed_root_pid: sidecar.root_pid,
    killed_relay_pid: sidecar.relay_pid,
    abandoned_sessions: sidecar.attached_sessions.length,
  };
}

export const _internals = {
  RELAY_PS,
  resolveWindowsTemp,
  winToWslPath,
  wslToWinPath,
};
