#!/usr/bin/env node
import { sessionManager } from "../dist/core/sessions.js";
import { detectInstalledChromium, isWindowsOrWsl } from "./_helpers.mjs";

// browser_status's attach_cdp branch needs a Chromium spawn path (Win/WSL +
// any installed Chromium product). The non-attach_cdp branch uses Playwright's
// bundled Chromium and works anywhere. Run whichever the environment supports.

if (isWindowsOrWsl()) {
  const hit = detectInstalledChromium();
  if (hit) {
    process.env.BROWSER_MCP_PRODUCT = hit.product;
    process.env.BROWSER_MCP_EXECUTABLE_PATH = hit.executablePath;
    const s = await sessionManager.open({ attach_cdp: true });
    const status1 = await sessionManager.browserStatus(s.session_id);
    console.log(`=== browser_status (attach_cdp session, product=${hit.product}) ===`);
    console.log(JSON.stringify(status1, null, 2));
    await sessionManager.close(s.session_id);
  } else {
    console.log("=== browser_status (attach_cdp branch SKIPPED — no Chromium installed) ===");
  }
} else {
  console.log(`=== browser_status (attach_cdp branch SKIPPED — platform ${process.platform} has no WSL/Windows spawn path) ===`);
}

// Non-attach_cdp branch — uses Playwright's bundled Chromium, works anywhere.
// data: URL keeps the test offline.
const sNonCdp = await sessionManager.open({ url: "data:text/html,<h1>browser-status</h1>" });
const status2 = await sessionManager.browserStatus(sNonCdp.session_id);
console.log("\n=== browser_status (non-attach_cdp Playwright session) ===");
console.log(JSON.stringify(status2, null, 2));
await sessionManager.close(sNonCdp.session_id);
process.exit(0);
