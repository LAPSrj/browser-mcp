import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

let cached: boolean | undefined;

export function isWsl(): boolean {
  if (cached !== undefined) return cached;
  if (process.platform !== "linux") {
    cached = false;
    return cached;
  }
  if (process.env.WSL_DISTRO_NAME) {
    cached = true;
    return cached;
  }
  try {
    const v = readFileSync("/proc/version", "utf8");
    cached = /microsoft|WSL/i.test(v);
  } catch {
    cached = false;
  }
  return cached;
}

let mirroredCache: boolean | undefined;

/**
 * Detect WSL2 mirrored networking mode. In mirrored mode, WSL shares the
 * host's network stack — `localhost` from WSL reaches Windows directly and
 * the PowerShell TCP relay is unnecessary. Detection: Hyper-V virtual NICs
 * (NAT mode) always use the 00:15:5d OUI; mirrored-mode eth0 inherits the
 * host's physical NIC MAC.
 */
export function isWslMirrored(): boolean {
  if (mirroredCache !== undefined) return mirroredCache;
  if (!isWsl()) {
    mirroredCache = false;
    return false;
  }
  try {
    // The routing NIC isn't always eth0 (e.g. mirrored-mode hosts with
    // multiple adapters expose eth1) — resolve it from the default route.
    let iface = "eth0";
    try {
      const route = readFileSync("/proc/net/route", "utf8");
      for (const line of route.split("\n").slice(1)) {
        const cols = line.split(/\s+/);
        if (cols[1] === "00000000" && cols[0]) {
          iface = cols[0];
          break;
        }
      }
    } catch {
      // keep eth0 fallback
    }
    const mac = readFileSync(`/sys/class/net/${iface}/address`, "utf8").trim().toLowerCase();
    mirroredCache = !mac.startsWith("00:15:5d");
  } catch {
    mirroredCache = false;
  }
  return mirroredCache;
}

export function readWslGatewayIp(): string | null {
  try {
    const v = readFileSync("/proc/net/route", "utf8");
    for (const line of v.split("\n").slice(1)) {
      const [, dest, gw] = line.split(/\s+/);
      if (dest === "00000000" && gw && gw !== "00000000") {
        const b = gw.match(/.{2}/g) ?? [];
        if (b.length === 4) {
          return `${parseInt(b[3], 16)}.${parseInt(b[2], 16)}.${parseInt(b[1], 16)}.${parseInt(b[0], 16)}`;
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Path to a Windows System32 binary (e.g. "cmd.exe",
 * "WindowsPowerShell/v1.0/powershell.exe") that this process can execute:
 * the /mnt/c mount under WSL, the real path on native Windows.
 */
export function windowsSystemBinary(relPath: string): string {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return `${root}\\System32\\${relPath.replace(/\//g, "\\")}`;
  }
  return `/mnt/c/Windows/System32/${relPath}`;
}

/** Windows path (C:\..., \\wsl.localhost\...) → the WSL path this process can open. WSL only. */
export function winToWslPath(winPath: string): string {
  return execFileSync("/usr/bin/wslpath", ["-u", winPath], {
    encoding: "utf8",
    timeout: 2000,
  }).trim();
}

/** C:\... or \\server\share\... */
export function isWindowsPath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p);
}

/**
 * Resolve a path a caller passed in to an absolute path this process can
 * open. Accepts Linux/WSL paths, ~/..., and on WSL also Windows paths
 * (C:\... → /mnt/c/..., \\wsl.localhost\<distro>\... → /...).
 */
export function toLocalPath(p: string): string {
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  if (isWsl() && isWindowsPath(p)) return winToWslPath(p);
  return path.resolve(p);
}
