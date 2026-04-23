import type { Page } from "playwright";

const NETWORK_IDLE_TIMEOUT = parseInt(process.env.BROWSER_MCP_NETWORK_IDLE_TIMEOUT || "15000", 10) || 15000;

/**
 * Navigate to a URL. Tries networkidle first; if it times out, falls back to load.
 * When waitForNetworkIdle is false, uses load directly.
 */
export async function navigateTo(
  page: Page,
  url: string,
  waitForNetworkIdle = true,
): Promise<void> {
  if (!waitForNetworkIdle) {
    await page.goto(url, { waitUntil: "load" });
    return;
  }

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: NETWORK_IDLE_TIMEOUT });
  } catch {
    // Page is already partially loaded from the failed goto — wait for load state
    try {
      await page.waitForLoadState("load", { timeout: 15000 });
    } catch {
      // proceed anyway
    }
  }
}
