// WSL2 NAT mode cannot reach Windows-host loopback. Edge's CDP endpoint
// binds to 127.0.0.1:<port> only, even with --remote-debugging-address=0.0.0.0
// (Chromium silently ignores non-localhost bind addresses since ~2023 hardening).
// We launch a small PowerShell TCP relay on the Windows side that listens on
// 0.0.0.0:<relay-port> and forwards to 127.0.0.1:<edge-port>. WSL connects to
// the relay via the WSL-gateway IP. Do NOT remove without restoring an
// equivalent reachability path (mirrored networking detection / netsh portproxy
// / Go helper EXE).
//
// On native Windows / macOS / Linux, no relay is needed and the same code path
// connects directly to localhost:<edge-port>.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isWsl, readWslGatewayIp } from "./wsl.js";

export interface SpawnAttachCdpOptions {
  sessionId: string;
  /** Windows path to the browser executable, e.g. C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe */
  edgeExePath: string;
  /** Optional Windows path to override user-data-dir. When omitted, a session-scoped temp profile is used. */
  userDataDirOverride?: string;
  /** Edge --remote-debugging-port. Random 9300-9399 if omitted. */
  edgePort?: number;
  /** PS relay listen port. Random 9400-9499 if omitted. WSL only. */
  relayPort?: number;
  /** How long to wait for CDP /json/version to come up (ms). Default 15000. */
  startupTimeoutMs?: number;
  /** Idle-timeout safety net for the PS relay (sec). Edge-PID-watch is the primary teardown trigger; this only fires if the watch fails. Default 600 (10 min). */
  relayIdleSeconds?: number;
}

export interface AttachCdpHandle {
  /** http URL to pass to chromium.connectOverCDP. */
  endpoint: string;
  /** Windows path to the user-data-dir actually used. */
  userDataDir: string;
  /** Edge root msedge.exe PID (the one with --remote-debugging-port). null if we couldn't resolve it. */
  edgePid: number | null;
  /** PS relay PID. null on native (no relay). */
  relayPid: number | null;
  /** Relay port if WSL, else null. */
  relayPort: number | null;
  /** Edge port. */
  edgePort: number;
  /** WSL-gateway IP used for the endpoint, if WSL. */
  gateway: string | null;
  /** Tear down: kill relay, kill our Edge profile procs, remove temp files. Idempotent. */
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
            L 'watched edge pid gone; exiting'
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

async function findEdgeRootPid(edgePort: number, sessionTag: string): Promise<number | null> {
  // Find the msedge.exe whose CommandLine contains both --remote-debugging-port=<port>
  // and the unique session tag (so we never match the user's real Edge).
  try {
    const cmd = String.raw`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${edgePort}*' -and $_.CommandLine -like '*${sessionTag}*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
    const out = runPS(cmd, 5000);
    const n = parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function killEdgeBySessionTag(sessionTag: string): Promise<void> {
  try {
    const cmd = String.raw`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${sessionTag}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }`;
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

  const edgePort = opts.edgePort ?? pickFreePort(9300, 9399);
  const relayPort = wsl ? (opts.relayPort ?? pickFreePort(9400, 9499)) : null;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 15_000;

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

    // Note: WatchPid is 0 here because Edge isn't spawned yet. We update it
    // after we have an Edge PID by writing a sentinel file, OR — simpler — we
    // just spawn Edge first when we have its PID, then start the relay with
    // that PID. So actually: rearrange order. Spawn Edge first, then relay.
    // Skip this branch; we'll re-enter it below after Edge spawn.
  }

  // ---- 2. Spawn Edge ----
  // user-data-dir prefilled (sessionTag is part of the path so we can kill only our procs).
  // Use an isolated tmp profile per session so the user's real Edge data is untouched.
  if (!opts.userDataDirOverride) {
    // ensure dir exists
    if (wsl) {
      mkdirSync(winToWslPath(userDataDirWin), { recursive: true });
    } else if (process.platform === "win32") {
      mkdirSync(userDataDirWin, { recursive: true });
    }
  }

  const edgeArgs = [
    `--remote-debugging-port=${edgePort}`,
    "--remote-allow-origins=*", // accept WS handshakes from non-localhost origins (the relay)
    `--user-data-dir=${userDataDirWin}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-features=Translate",
    "about:blank",
  ];

  dbg("spawning edge:", { wsl, edgeExe: opts.edgeExePath, port: edgePort, profile: userDataDirWin });
  dbg("edgeArgs:", edgeArgs);
  if (wsl) {
    const cmdArgs = [
      "/c",
      "start",
      '""',
      "/B",
      opts.edgeExePath,
      ...edgeArgs,
    ];
    dbg("cmd.exe args:", cmdArgs);
    spawnDetachedWindows(cmdArgs);
    // brief tasklist diagnostic so we can tell if msedge.exe ever starts
    if (DBG) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const cnt = runPS(
          String.raw`(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${sessionTag}*' } | Measure-Object).Count`,
          5000,
        );
        dbg(`tagged msedge procs +1s after spawn: ${cnt}`);
      } catch (e) {
        dbg("tasklist diagnostic failed:", e);
      }
    }
  } else if (process.platform === "win32") {
    const child = spawn(opts.edgeExePath, edgeArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else {
    // macOS / Linux native — spawn directly
    const child = spawn(opts.edgeExePath, edgeArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // ---- 3. Wait for Edge CDP to bind on the Windows side ----
  // Probe the port we asked for. Edge picks the requested port if free; we
  // generated a random port from a wide range so collisions are unlikely.
  // DevToolsActivePort would tell us the actual bound port if we needed it,
  // but Edge in some environments does not write the file even when the
  // server is up (verified empirically) — don't gate on it.
  const edgeDeadline = Date.now() + startupTimeoutMs;
  let edgeUp = false;
  let attempts = 0;
  while (Date.now() < edgeDeadline) {
    attempts++;
    if (wsl) {
      edgeUp = await probeWindowsLocalhostCdp(edgePort);
    } else {
      edgeUp = await probeCdp("localhost", edgePort);
    }
    if (edgeUp) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const actualEdgePort = edgeUp ? edgePort : (readDevToolsActivePort(userDataDirWin) ?? edgePort);

  if (!edgeUp) {
    dbg(`edge did not come up. attempts=${attempts} requested_port=${edgePort} dev_tools_active_port=${actualEdgePort !== edgePort ? actualEdgePort : "n/a"}`);
    await killEdgeBySessionTag(sessionTag);
    throw new Error(
      `attach_cdp: Edge spawned but did not open CDP port within ${startupTimeoutMs}ms. ` +
        `attempts=${attempts}, asked_port=${edgePort}. ` +
        `Possible causes: profile lock (--user-data-dir already in use by another Edge), ` +
        `--remote-debugging-port disabled by group policy, or executable_path is wrong (${opts.edgeExePath}).`,
    );
  }
  dbg(`edge up on ${actualEdgePort} after ${attempts} attempts`);

  const edgePid = await findEdgeRootPid(actualEdgePort, sessionTag);
  dbg(`edge root pid: ${edgePid}`);

  // ---- 4. Start the PS relay now that we know the Edge PID to watch ----
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
      String(actualEdgePort),
      "-PidFile",
      pidFile,
      "-LogFile",
      logFile,
      "-WatchPid",
      String(edgePid ?? 0),
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
      await killEdgeBySessionTag(sessionTag);
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
    : `http://localhost:${edgePort}`;

  const e2eDeadline = Date.now() + 5000;
  let e2eUp = false;
  while (Date.now() < e2eDeadline) {
    if (wsl) {
      // probe through gateway:relayPort
      e2eUp = await probeCdp(gateway!, relayPort!, 1500);
    } else {
      e2eUp = await probeCdp("localhost", edgePort, 1500);
    }
    if (e2eUp) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!e2eUp) {
    if (relayPid != null) await killProcessByPid(relayPid);
    await killEdgeBySessionTag(sessionTag);
    throw new Error(
      `attach_cdp: end-to-end probe at ${endpoint} failed. ` +
        (wsl
          ? `Relay log: ${relayLogFileWsl}. Possible causes: Windows Firewall blocking 0.0.0.0:${relayPort}, gateway IP ${gateway} unreachable.`
          : "Edge CDP did not respond on localhost."),
    );
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (relayPid != null) await killProcessByPid(relayPid);
    await killEdgeBySessionTag(sessionTag);
    if (wsl) {
      try { rmSync(sessionDirWsl, { recursive: true, force: true }); } catch {}
    } else if (!opts.userDataDirOverride) {
      try { rmSync(userDataDirWin, { recursive: true, force: true }); } catch {}
    }
  };

  return {
    endpoint,
    userDataDir: userDataDirWin,
    edgePid,
    relayPid,
    relayPort,
    edgePort: actualEdgePort,
    gateway,
    cleanup,
  };
}

export const _internals = {
  RELAY_PS,
  resolveWindowsTemp,
  winToWslPath,
  wslToWinPath,
};
