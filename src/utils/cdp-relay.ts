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
   */
  attachedVia: "spawn" | "existing";
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

function pickFreePort(low: number, high: number): number {
  // We can't easily test bind from WSL for a Windows port. Pick random — collisions are caught downstream.
  return low + Math.floor(Math.random() * (high - low + 1));
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

  const cdpPortReq = opts.cdpPort ?? pickFreePort(9300, 9399);
  const relayPortReq = wsl ? (opts.relayPort ?? pickFreePort(9400, 9499)) : null;
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
      const stillAlive = aliveWindowsPids([current.root_pid]).has(current.root_pid);
      if (stillAlive) {
        dbg("sidecar: attaching to existing browser", {
          root_pid: current.root_pid,
          cdp_port: current.cdp_port,
          relay_port: current.relay_port,
          existing_sessions: current.attached_sessions.length,
        });
        const gateway = wsl ? readWslGatewayIp() : null;
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
        let cleaned = false;
        const cleanup = async () => {
          if (cleaned) return;
          cleaned = true;
          const removal = await removeSession({ userDataDirWsl, session_id: opts.sessionId });
          if (removal.was_last) {
            dbg("cleanup (attach-via=existing): was_last → killing browser tree + relay");
            if (current.relay_pid != null) await killProcessByPid(current.relay_pid);
            await killBrowserTreeByPid(current.root_pid);
            if (wsl) {
              try { rmSync(sessionDirWsl, { recursive: true, force: true }); } catch {}
            } else if (!opts.userDataDirOverride) {
              try { rmSync(userDataDirWin, { recursive: true, force: true }); } catch {}
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
      dbg("sidecar present but root_pid is dead; falling through to spawn", { stale_root_pid: current.root_pid });
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
        if (wsl) {
          try { rmSync(sessionDirWsl, { recursive: true, force: true }); } catch {}
        } else if (!opts.userDataDirOverride) {
          try { rmSync(userDataDirWin, { recursive: true, force: true }); } catch {}
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

export const _internals = {
  RELAY_PS,
  resolveWindowsTemp,
  winToWslPath,
  wslToWinPath,
};
