// Browser-product abstraction for attach_cdp.
//
// Generalizes the previously Edge-only auto-launch path so we can spawn any
// Chromium-channel browser the user has installed. Replaces the hardcoded
// `msedge.exe` paths and PowerShell `Name='msedge.exe'` filters.
//
// Single-product-per-host config model (per Leandro): the resolved product is
// global to the MCP server, set via the BROWSER_MCP_PRODUCT env var. If unset,
// platform default is used (edge on Windows/WSL, chrome on macOS/Linux). The
// executable path is taken from the product's per-platform default; users can
// override with BROWSER_MCP_EXECUTABLE_PATH (the renamed BROWSER_MCP_EDGE_EXE).
//
// Day-1 product scope (Phase A): edge, chrome, brave, vivaldi, opera. All five
// share the same Chromium CDP wire-format and command-line flags
// (--remote-debugging-port, --user-data-dir, --no-first-run, --disable-sync,
// --remote-allow-origins) so the spawn + relay path is identical — only the
// exe path and Win32_Process Name= filter differ per product.

export type BrowserProduct =
  | "edge"
  | "chrome"
  | "brave"
  | "vivaldi"
  | "opera";

export const BROWSER_PRODUCTS: readonly BrowserProduct[] = [
  "edge",
  "chrome",
  "brave",
  "vivaldi",
  "opera",
];

interface BrowserProductSpec {
  /**
   * Windows process name used for Win32_Process Name='<x>' filters. Must match
   * exactly what shows up in tasklist, including case (Windows is
   * case-insensitive for the filter, but we keep canonical lowercase).
   */
  processName: string;
  /**
   * Default executable path per platform. `undefined` means there's no
   * canonical machine-wide default (e.g. Opera installs per-user on Windows
   * under %LOCALAPPDATA%\\Programs\\Opera, varying by username) — caller must
   * set BROWSER_MCP_EXECUTABLE_PATH explicitly.
   */
  defaultExePath: {
    /** Windows path string. Used on both native Windows and WSL (the same
     * Windows-side path is launched via cmd.exe /c start). */
    windows: string | undefined;
    darwin: string | undefined;
    linux: string | undefined;
  };
}

export const BROWSER_PRODUCT_SPECS: Record<BrowserProduct, BrowserProductSpec> = {
  edge: {
    processName: "msedge.exe",
    defaultExePath: {
      windows: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
      darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      linux: "/usr/bin/microsoft-edge",
    },
  },
  chrome: {
    processName: "chrome.exe",
    defaultExePath: {
      windows: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
      darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      linux: "/usr/bin/google-chrome",
    },
  },
  brave: {
    processName: "brave.exe",
    defaultExePath: {
      windows: String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
      darwin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      linux: "/usr/bin/brave-browser",
    },
  },
  vivaldi: {
    processName: "vivaldi.exe",
    defaultExePath: {
      windows: String.raw`C:\Program Files\Vivaldi\Application\vivaldi.exe`,
      darwin: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
      linux: "/usr/bin/vivaldi",
    },
  },
  opera: {
    processName: "opera.exe",
    defaultExePath: {
      // Opera installs per-user under %LOCALAPPDATA%\Programs\Opera by default;
      // there is no canonical machine-wide path. Force the user to set
      // BROWSER_MCP_EXECUTABLE_PATH on Windows/WSL.
      windows: undefined,
      darwin: "/Applications/Opera.app/Contents/MacOS/Opera",
      linux: "/usr/bin/opera",
    },
  },
};

/**
 * Resolve which product to use, given the current platform.
 *
 * Reads BROWSER_MCP_PRODUCT (case-insensitive). If unset, falls back to the
 * platform default: edge on Windows/WSL, chrome on macOS/Linux. Throws on an
 * unrecognized value rather than silently falling back, so a typo (e.g.
 * "chromium") fails loudly instead of running the wrong browser.
 */
export function resolveBrowserProduct(opts: {
  isWslOrWin: boolean;
}): BrowserProduct {
  const fromEnv = process.env.BROWSER_MCP_PRODUCT?.trim().toLowerCase();
  if (fromEnv) {
    if ((BROWSER_PRODUCTS as readonly string[]).includes(fromEnv)) {
      return fromEnv as BrowserProduct;
    }
    throw new Error(
      `BROWSER_MCP_PRODUCT="${fromEnv}" is not a recognized browser product. ` +
        `Pick one of: ${BROWSER_PRODUCTS.join(", ")}.`,
    );
  }
  return opts.isWslOrWin ? "edge" : "chrome";
}

/**
 * Resolve the executable path for a product on the current platform.
 *
 * Reads BROWSER_MCP_EXECUTABLE_PATH first (overrides everything). Otherwise
 * returns the product's platform default, or `undefined` if there is none
 * (caller errors with a clear message naming the env var).
 */
export function defaultExePath(
  product: BrowserProduct,
  opts: { isWslOrWin: boolean },
): string | undefined {
  const fromEnv = process.env.BROWSER_MCP_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  const spec = BROWSER_PRODUCT_SPECS[product];
  if (opts.isWslOrWin) return spec.defaultExePath.windows;
  if (process.platform === "darwin") return spec.defaultExePath.darwin;
  return spec.defaultExePath.linux;
}

/**
 * Sanitize a process name before interpolating it into a PowerShell
 * Win32_Process -Filter "Name='<x>'" query. Even though the value is enum-
 * sourced (not user input), this is defense-in-depth — refuses anything that
 * isn't a plain `<word>.exe` so a typo in the spec table can't smuggle a
 * quote-break or backtick into the PS string.
 */
export function sanitizeProcessName(name: string): string {
  if (!/^[A-Za-z0-9_-]+\.exe$/.test(name)) {
    throw new Error(
      `Refusing to interpolate process name "${name}" into a PowerShell query — ` +
        `must match /^[A-Za-z0-9_-]+\\.exe$/.`,
    );
  }
  return name;
}
