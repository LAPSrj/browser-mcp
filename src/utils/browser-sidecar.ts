// Cross-process coordination for "multiple browser-mcp servers sharing one
// Chromium profile" — the architecture forced by Chromium's hard one-process-
// per-User-Data-dir lock combined with the "each Claude Code conversation
// spawns its own MCP server" reality.
//
// Each persistent user_data_dir gets a sidecar JSON file (.bm-browser.json)
// recording:
//   - the Chromium root PID + CDP / relay ports we spawned for it
//   - the list of browser-mcp sessions currently attached
//
// First session to open the profile spawns Chromium + writes the sidecar.
// Subsequent sessions read the sidecar, verify the recorded PID is alive,
// and attach to the existing CDP port instead of trying to spawn a
// competitor (which would deadlock on Chromium's profile file lock).
//
// On close, sessions remove their own entry. The session that drops the
// last entry is responsible for taskkilling the browser tree + deleting
// the sidecar. Until then, the browser stays running so other attached
// sessions keep working.
//
// Concurrency discipline: a .bm-browser.lock companion file gates all
// read-modify-write operations. Lock is created with O_EXCL ('wx') for
// atomicity; stale locks (owned by a dead PID) are auto-stolen.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";

const SCHEMA_VERSION = 1;
const SIDECAR_FILENAME = ".bm-browser.json";
const LOCK_FILENAME = ".bm-browser.lock";
const LOCK_RETRY_INTERVAL_MS = 50;
// Lock held during the entire decide-spawn-record sequence in cdp-relay
// (spawn itself can take 3-15s for Chromium boot + CDP up + relay up + e2e
// probe). 60s gives generous headroom while still bailing out if something
// is hung. Other concurrent open_session calls on the same profile will
// wait on this lock; that's the desired serialization.
const LOCK_MAX_WAIT_MS = 60_000;

export interface AttachedSession {
  session_id: string;
  /** PID of the browser-mcp Node process holding this session (for crash-recovery sweep). */
  browser_mcp_pid: number;
  attached_at: string;
}

export interface SidecarInfo {
  schema_version: number;
  /** CDP port the Chromium root is listening on (Windows-side localhost). */
  cdp_port: number;
  /** WSL relay port (0.0.0.0:relay_port → 127.0.0.1:cdp_port). null on native. */
  relay_port: number | null;
  /** Relay process PID. null on native. */
  relay_pid: number | null;
  /** Chromium root process PID (the one with --remote-debugging-port). */
  root_pid: number;
  /** Process name (msedge.exe / chrome.exe / brave.exe / ...). For PID-liveness lookups. */
  process_name: string;
  /** Canonical user_data_dir (Windows path). */
  user_data_dir: string;
  /** ISO timestamp the sidecar was first written. */
  spawned_at: string;
  /** Currently-attached browser-mcp sessions. */
  attached_sessions: AttachedSession[];
}

function sidecarPath(userDataDirWsl: string): string {
  return `${userDataDirWsl}/${SIDECAR_FILENAME}`;
}

function lockFilePath(userDataDirWsl: string): string {
  return `${userDataDirWsl}/${LOCK_FILENAME}`;
}

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/**
 * Check if a Windows PID is alive. Used for sidecar PID-liveness sweep
 * + stale-lock detection. Single-PID variant.
 */
export function isWindowsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    const out = execFileSync(
      PS,
      ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    return out === "yes";
  } catch {
    return false;
  }
}

/**
 * Batched PID-liveness check. Pass an array of Windows PIDs; returns the
 * subset that are currently alive. One PS round-trip regardless of N
 * (vs N round-trips for repeated isWindowsPidAlive calls).
 */
export function aliveWindowsPids(pids: number[]): Set<number> {
  const valid = pids.filter((p) => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return new Set();
  try {
    const idList = valid.join(",");
    const out = execFileSync(
      PS,
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id @(${idList}) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
      ],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    const result = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n) && n > 0) result.add(n);
    }
    return result;
  } catch {
    return new Set();
  }
}

/**
 * Check if a local Node process is alive. Used for sweeping stale
 * attached_sessions entries from dead browser-mcp processes. Uses
 * process.kill(pid, 0) which is the POSIX "exists check" idiom.
 */
function isLocalPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // EPERM means it exists but we don't have rights — still alive
  }
}

async function acquireLock(userDataDirWsl: string): Promise<() => void> {
  const lp = lockFilePath(userDataDirWsl);
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT_MS) {
    try {
      // O_EXCL via 'wx' flag — atomic create-if-not-exists. EEXIST means
      // another process holds the lock right now (or holds a stale file).
      const fd = openSync(lp, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try { unlinkSync(lp); } catch { /* lock already gone — fine */ }
      };
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // Stale-lock detection: read the owner PID; if it's dead, steal.
      try {
        const ownerPidStr = readFileSync(lp, "utf8").trim();
        const ownerPid = parseInt(ownerPidStr, 10);
        if (Number.isFinite(ownerPid) && ownerPid !== process.pid && !isLocalPidAlive(ownerPid)) {
          unlinkSync(lp);
          continue; // try again immediately — we just freed the lock
        }
      } catch {
        // unreadable lock — wait and retry; another process might be mid-write
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
    }
  }
  throw new Error(
    `browser-sidecar: could not acquire lock at ${lp} within ${LOCK_MAX_WAIT_MS}ms — ` +
      `another browser-mcp instance may be hung. Inspect/manually delete the lock file to recover.`,
  );
}

/** Read the sidecar without locking. Caller must already hold the lock. */
function readSidecarUnlocked(userDataDirWsl: string): SidecarInfo | null {
  const p = sidecarPath(userDataDirWsl);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as SidecarInfo;
    if (parsed.schema_version !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Public lock-free read; for cheap checks where stale-by-one-write is OK. */
export function readSidecar(userDataDirWsl: string): SidecarInfo | null {
  return readSidecarUnlocked(userDataDirWsl);
}

/**
 * Read-modify-write under exclusive lock. The callback receives the current
 * sidecar (or null if absent) and returns the updated sidecar to persist
 * (or null to delete the file — used for last-out cleanup).
 *
 * Auto-sweeps dead browser-mcp PIDs from attached_sessions before passing
 * to the callback, so the caller always sees a fresh-as-of-this-moment view.
 */
export async function withSidecarLock<T>(
  userDataDirWsl: string,
  fn: (current: SidecarInfo | null) => Promise<{ updated: SidecarInfo | null; result: T }>,
): Promise<T> {
  const release = await acquireLock(userDataDirWsl);
  try {
    let current = readSidecarUnlocked(userDataDirWsl);
    if (current) {
      const alivePids = current.attached_sessions.length > 0
        ? new Set(current.attached_sessions.filter((s) => isLocalPidAlive(s.browser_mcp_pid)).map((s) => s.browser_mcp_pid))
        : new Set<number>();
      const swept = current.attached_sessions.filter((s) => alivePids.has(s.browser_mcp_pid));
      if (swept.length !== current.attached_sessions.length) {
        current = { ...current, attached_sessions: swept };
      }
    }
    const { updated, result } = await fn(current);
    if (updated === null) {
      try { unlinkSync(sidecarPath(userDataDirWsl)); } catch { /* fine */ }
    } else {
      writeFileSync(sidecarPath(userDataDirWsl), JSON.stringify(updated, null, 2), "utf8");
    }
    return result;
  } finally {
    release();
  }
}

/**
 * Record a fresh browser spawn — called after the caller successfully
 * launched Chromium + relay and is about to connect over CDP. Creates the
 * sidecar with the spawning session already in attached_sessions.
 */
export async function recordSpawn(opts: {
  userDataDirWsl: string;
  user_data_dir: string;
  cdp_port: number;
  relay_port: number | null;
  relay_pid: number | null;
  root_pid: number;
  process_name: string;
  session_id: string;
  browser_mcp_pid: number;
}): Promise<SidecarInfo> {
  return withSidecarLock(opts.userDataDirWsl, async (current) => {
    if (current) {
      // Race: someone else spawned between our spawnOrAttachDecision and
      // recordSpawn. Surface as a hard error rather than papering over —
      // the caller's spawned Chromium will be the orphan in this race.
      // Practically rare given the lock, but possible if the lock was
      // held across the spawn.
      throw new Error(
        `browser-sidecar: recordSpawn race — sidecar already exists for ${opts.user_data_dir}. ` +
          `Another browser-mcp instance spawned concurrently.`,
      );
    }
    const info: SidecarInfo = {
      schema_version: SCHEMA_VERSION,
      cdp_port: opts.cdp_port,
      relay_port: opts.relay_port,
      relay_pid: opts.relay_pid,
      root_pid: opts.root_pid,
      process_name: opts.process_name,
      user_data_dir: opts.user_data_dir,
      spawned_at: new Date().toISOString(),
      attached_sessions: [
        {
          session_id: opts.session_id,
          browser_mcp_pid: opts.browser_mcp_pid,
          attached_at: new Date().toISOString(),
        },
      ],
    };
    return { updated: info, result: info };
  });
}

/**
 * Append the current session to an already-existing sidecar's
 * attached_sessions list (the "attach to existing browser" path).
 */
export async function appendSession(opts: {
  userDataDirWsl: string;
  session_id: string;
  browser_mcp_pid: number;
}): Promise<SidecarInfo> {
  return withSidecarLock(opts.userDataDirWsl, async (current) => {
    if (!current) {
      throw new Error("browser-sidecar: appendSession with no existing sidecar — call recordSpawn instead");
    }
    // Idempotent: if this session is already listed (re-open after error?), don't double-add
    if (current.attached_sessions.some((s) => s.session_id === opts.session_id)) {
      return { updated: current, result: current };
    }
    const updated: SidecarInfo = {
      ...current,
      attached_sessions: [
        ...current.attached_sessions,
        {
          session_id: opts.session_id,
          browser_mcp_pid: opts.browser_mcp_pid,
          attached_at: new Date().toISOString(),
        },
      ],
    };
    return { updated, result: updated };
  });
}

/**
 * Remove the session from attached_sessions. Returns:
 *   - was_last: true → caller is responsible for taskkilling the browser
 *               tree + relay AND then calling finalizeSidecarTeardown to
 *               unlink the sidecar. The sidecar is left on disk with an
 *               empty attached_sessions list so that if the kill fails,
 *               the next open_session can still discover state.
 *   - was_last: false → other sessions remain. Just disconnect CDP,
 *               leave browser running.
 *
 * Ordering rationale: sidecar deletion is decoupled from "I am the last
 * attached session" and reattached to "the browser has actually exited."
 * If a taskkill partial-fails (Edge tray respawn, watchdog, swallowed PS
 * error), the next open_session sees a sidecar pointing at the still-alive
 * browser and attaches normally instead of falling into the spawn path and
 * lock-conflicting with the surviving Chromium.
 */
export interface RemoveSessionResult {
  was_last: boolean;
  remaining: number;
  sidecar: SidecarInfo | null;
}

export async function removeSession(opts: {
  userDataDirWsl: string;
  session_id: string;
}): Promise<RemoveSessionResult> {
  return withSidecarLock<RemoveSessionResult>(opts.userDataDirWsl, async (current) => {
    if (!current) {
      // No sidecar — nothing to remove. Treat as "was_last" so caller's
      // cleanup proceeds (defensive; in practice this means the sidecar
      // was already removed by a peer's last-out cleanup).
      return { updated: null, result: { was_last: true, remaining: 0, sidecar: null } };
    }
    const filtered = current.attached_sessions.filter((s) => s.session_id !== opts.session_id);
    if (filtered.length === 0) {
      // Empty the attached_sessions but keep the sidecar on disk. The caller's
      // finalizeSidecarTeardown unlinks once the browser is confirmed dead.
      const drained: SidecarInfo = { ...current, attached_sessions: [] };
      return { updated: drained, result: { was_last: true, remaining: 0, sidecar: drained } };
    }
    const updated: SidecarInfo = { ...current, attached_sessions: filtered };
    return { updated, result: { was_last: false, remaining: filtered.length, sidecar: updated } };
  });
}

/**
 * Unlink the sidecar file after the caller has verified the browser
 * process is actually dead. Pairs with removeSession's was_last branch
 * (which now leaves the sidecar on disk instead of unlinking it
 * eagerly). Safe to call when the sidecar is already gone — returns
 * without error.
 */
export async function finalizeSidecarTeardown(opts: {
  userDataDirWsl: string;
}): Promise<void> {
  await withSidecarLock<void>(opts.userDataDirWsl, async () => {
    return { updated: null, result: undefined };
  });
}
