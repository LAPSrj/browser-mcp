import { randomUUID } from "node:crypto";
import type { ConsoleMessage } from "playwright";

// browser-mcp's init scripts talk to the server through console.debug instead
// of page.exposeBinding. exposeBinding makes Playwright add
// __playwright__binding__ to every tab in the browser while it's connected,
// and Cloudflare's challenge fails on any tab that has it (verified live:
// tests/test-cloudflare-challenge.mjs). A console message adds nothing to the
// page. Each script keeps the page's original console.debug from before page
// scripts run, so a page that replaces console.debug doesn't see the calls.

const PREFIX = "__browserMcp:";

/** A new marker for one script's messages; random, so a page can't forge them. */
export function newConsoleMarker(): string {
  return `${PREFIX}${randomUUID()}`;
}

/** True for messages from browser-mcp's own scripts, which console listeners shown to agents skip. */
export function isInternalConsoleMessage(msg: ConsoleMessage): boolean {
  return msg.type() === "debug" && msg.text().startsWith(PREFIX);
}
