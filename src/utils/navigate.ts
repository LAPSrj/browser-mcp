import type { Page } from "playwright";
import { diagnosePageErrors, type PageDiagnostic } from "./page-diagnostics.js";

const NETWORK_IDLE_TIMEOUT = parseInt(process.env.BROWSER_MCP_NETWORK_IDLE_TIMEOUT || "15000", 10) || 15000;

export interface NavigateResult {
  url: string;
  status: number | null;
  diagnostic: PageDiagnostic | null;
}

/**
 * Navigate to a URL. Tries networkidle first; if it times out, falls back to load.
 * When waitForNetworkIdle is false, uses load directly.
 *
 * Returns a NavigateResult with the final URL, HTTP status (when available),
 * and a diagnostic if the page landed on a browser error screen or returned
 * an HTTP error status. Callers that don't need the result can ignore it —
 * the function never throws (navigation errors are caught and diagnosed).
 */
export async function navigateTo(
  page: Page,
  url: string,
  waitForNetworkIdle = true,
): Promise<NavigateResult> {
  let status: number | null = null;

  if (!waitForNetworkIdle) {
    try {
      const resp = await page.goto(url, { waitUntil: "load" });
      status = resp?.status() ?? null;
    } catch {
      // proceed — page may be on an error screen; diagnosed below
    }
  } else {
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: NETWORK_IDLE_TIMEOUT });
      status = resp?.status() ?? null;
    } catch {
      // Page is already partially loaded from the failed goto — wait for load state
      try {
        await page.waitForLoadState("load", { timeout: 15000 });
      } catch {
        // proceed anyway — diagnosed below
      }
    }
  }

  const diagnostic = await diagnosePageErrors(page, status);
  return { url: page.url(), status, diagnostic };
}
