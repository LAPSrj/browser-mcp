// Shared helpers for the browser-mcp test suite.
//
// Tests should not hardcode Edge or `/mnt/c/Windows/...` paths. The codebase
// already supports five Chromium-family browsers (edge / chrome / brave /
// vivaldi / opera) on three platforms (Windows-or-WSL / macOS / Linux) via
// `src/utils/browser-products.ts`. These helpers thread that abstraction into
// the tests so they work on any machine where a Chromium channel is installed,
// and SKIP cleanly otherwise.
//
// Usage:
//
//   import { requireChromium, requireWindows, requireWp } from "./_helpers.mjs";
//
//   const { product, executablePath } = requireChromium();   // CDP-attach tests
//   requireWindows();                                         // Win32-only tests
//   const wpUrl = await requireWp();                          // wp-gutenberg tests
//
// Each `require*` either returns the resolved env, or prints `SKIP: <reason>`
// and exits 0 (so a test runner sees a clean pass on machines that lack the
// dependency, instead of a confusing crash).

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, "..", "dist");

const {
  BROWSER_PRODUCTS,
  BROWSER_PRODUCT_SPECS,
  resolveBrowserProduct,
  defaultExePath,
} = await import(path.join(distRoot, "utils/browser-products.js"));
const { isWsl } = await import(path.join(distRoot, "utils/wsl.js"));

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

function isWslOrWin() {
  return isWsl() || process.platform === "win32";
}

/**
 * Probe-style platform check. Returns `true` on WSL or native Windows, `false`
 * elsewhere. Use when a test has both a Windows-only branch and a portable
 * branch — combine with `detectInstalledChromium()` so the Windows branch only
 * runs when the dependencies are actually present.
 */
export function isWindowsOrWsl() {
  return isWslOrWin();
}

/**
 * Convert a Windows path (`C:\...`) to whatever path the current process can
 * actually `existsSync`. On WSL this shells out to `wslpath -u`; on native
 * Windows / macOS / Linux it's a no-op (the path is already POSIX or already
 * a usable Windows path on Win32).
 */
export function toFsPath(exePath) {
  if (!exePath) return null;
  if (!isWsl()) return exePath;
  if (!/^[A-Za-z]:[\\/]/.test(exePath)) return exePath;
  try {
    return execFileSync("/usr/bin/wslpath", ["-u", exePath], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function probeInstalled(product) {
  const exe = defaultExePath(product, { isWslOrWin: isWslOrWin() });
  if (!exe) return null;
  const fsPath = toFsPath(exe);
  if (!fsPath || !existsSync(fsPath)) return null;
  const processName = BROWSER_PRODUCT_SPECS[product].processName;
  return {
    product,
    executablePath: exe,
    processName,
    processBaseName: processName.replace(/\.exe$/i, ""),
  };
}

/**
 * Find a Chromium-family browser this machine can drive.
 *
 * Resolution order:
 *   1. `BROWSER_MCP_EXECUTABLE_PATH` (verify the file exists)
 *   2. `BROWSER_MCP_PRODUCT` (verify the product's default exe is installed)
 *   3. Platform default (edge on Win/WSL, chrome on macOS/Linux)
 *   4. Walk every BROWSER_PRODUCTS entry; return the first one with an
 *      installed exe.
 *
 * Returns `{ product, executablePath }` or `null` when nothing is found.
 */
export function detectInstalledChromium() {
  const explicit = process.env.BROWSER_MCP_EXECUTABLE_PATH;
  if (explicit) {
    const fsPath = toFsPath(explicit);
    if (fsPath && existsSync(fsPath)) {
      const fromEnv = process.env.BROWSER_MCP_PRODUCT?.trim().toLowerCase();
      const product = BROWSER_PRODUCTS.includes(fromEnv) ? fromEnv : "chrome";
      const processName = BROWSER_PRODUCT_SPECS[product].processName;
      return {
        product,
        executablePath: explicit,
        processName,
        processBaseName: processName.replace(/\.exe$/i, ""),
      };
    }
  }

  const fromEnv = process.env.BROWSER_MCP_PRODUCT?.trim().toLowerCase();
  if (fromEnv && BROWSER_PRODUCTS.includes(fromEnv)) {
    const hit = probeInstalled(fromEnv);
    if (hit) return hit;
  }

  const def = resolveBrowserProduct({ isWslOrWin: isWslOrWin() });
  const defHit = probeInstalled(def);
  if (defHit) return defHit;

  for (const p of BROWSER_PRODUCTS) {
    if (p === def) continue;
    const hit = probeInstalled(p);
    if (hit) return hit;
  }

  return null;
}

/**
 * Resolve a Chromium-family browser for the test, propagate it into the env
 * (so `sessionManager.open({ attach_cdp: true })` picks up the same product),
 * and return `{ product, executablePath }`. SKIPs if nothing is installed.
 */
export function requireChromium() {
  const hit = detectInstalledChromium();
  if (!hit) {
    skip(
      "no Chromium-family browser found. Install Edge / Chrome / Brave / Vivaldi / Opera, " +
      "or set BROWSER_MCP_PRODUCT + BROWSER_MCP_EXECUTABLE_PATH explicitly.",
    );
  }
  process.env.BROWSER_MCP_PRODUCT = hit.product;
  process.env.BROWSER_MCP_EXECUTABLE_PATH = hit.executablePath;
  return hit;
}

/**
 * Assert this test is running where Win32-specific code paths exist (WSL2
 * driving Windows processes, or native Windows). Used by tests that probe
 * `Win32_Process`, run `cmd.exe /c start`, or otherwise depend on Windows
 * binaries that have no Linux/macOS equivalent in the codebase today.
 */
export function requireWindows() {
  if (!isWslOrWin()) {
    skip(
      `this test exercises Win32-specific code paths; current platform is ${process.platform}. ` +
      `Re-run on WSL2 or Windows.`,
    );
  }
}

/**
 * Probe `WP_URL` for a reachable WordPress install. SKIPs if `WP_URL` is unset
 * or the host doesn't answer. Pass `requireAuth: true` to also require
 * `WP_USER` + `WP_PASS`. Returns the cleaned WP_URL (trailing slash stripped).
 */
export async function requireWp(opts = {}) {
  const wpUrl = process.env.WP_URL?.replace(/\/+$/, "");
  if (!wpUrl) {
    skip("WP_URL not set. Point it at a live WordPress install to run this test.");
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(`${wpUrl}/wp-login.php`, { method: "HEAD", signal: ac.signal });
    clearTimeout(timer);
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    skip(`WP_URL ${wpUrl} not reachable: ${e?.message ?? e}`);
  }
  if (opts.requireAuth) {
    if (!process.env.WP_USER) skip("WP_USER not set (required for this test).");
    if (!process.env.WP_PASS) skip("WP_PASS not set (required for this test).");
  }
  return wpUrl;
}
