#!/usr/bin/env node
/**
 * Worker process. Driven by parent via IPC (process.send / process.on('message')).
 *
 * Protocol:
 *   parent → worker: { cmd: "open", user_data_dir: "..." }
 *   worker → parent: { type: "opened", session_id, browser_mcp_pid }
 *
 *   parent → worker: { cmd: "tabs" }
 *   worker → parent: { type: "tabs", tabs: [...], active_tab_id }
 *
 *   parent → worker: { cmd: "open_popup", url: "..." }
 *   worker → parent: { type: "popup_opened" }
 *
 *   parent → worker: { cmd: "close" }
 *   worker → parent: { type: "closed" }
 *
 *   parent → worker: { cmd: "exit" }
 *   worker exits.
 */
import { sessionManager } from "../dist/core/sessions.js";

// --- portability guard (auto-applied) ---
import { requireWindows, requireChromium } from "./_helpers.mjs";
requireWindows();
const { processName: BROWSER_PROC, processBaseName: BROWSER_PROC_BASE } = requireChromium();

let session = null;

process.on("message", async (msg) => {
  try {
    if (msg.cmd === "open") {
      session = await sessionManager.open({
        attach_cdp: true,
        user_data_dir: msg.user_data_dir,
      });
      process.send({ type: "opened", session_id: session.session_id, browser_mcp_pid: process.pid });
    } else if (msg.cmd === "tabs") {
      const info = sessionManager.list().find((s) => s.session_id === session.session_id);
      process.send({ type: "tabs", tabs: info.tabs, active_tab_id: info.active_tab_id });
    } else if (msg.cmd === "open_popup") {
      const page = sessionManager.getPage(session.session_id);
      await page.evaluate(({ url }) => {
        const a = document.createElement("a");
        a.id = "p-link"; a.target = "_blank"; a.href = url;
        a.textContent = "popup";
        document.body.appendChild(a);
      }, { url: msg.url });
      const popupPromise = page.context().waitForEvent("page");
      await page.click("#p-link");
      await popupPromise;
      await new Promise((r) => setTimeout(r, 500));
      process.send({ type: "popup_opened" });
    } else if (msg.cmd === "list_tabs_with_orphans") {
      // Mirror the include_other_agents:true logic
      const s = sessionManager.get(session.session_id);
      const ourPages = new Set();
      for (const sx of sessionManager.list()) {
        const live = sessionManager.get(sx.session_id);
        if (live.context === s.context) {
          for (const pg of live.pages.values()) ourPages.add(pg);
        }
      }
      const ownTabs = sessionManager.list().find((s) => s.session_id === session.session_id).tabs;
      const orphans = s.context.pages()
        .filter((pg) => !ourPages.has(pg))
        .map((pg) => ({ url: pg.url() }));
      process.send({ type: "list_with_orphans", own: ownTabs, orphans });
    } else if (msg.cmd === "close") {
      await sessionManager.close(session.session_id);
      process.send({ type: "closed" });
    } else if (msg.cmd === "exit") {
      process.exit(0);
    } else {
      process.send({ type: "error", error: `unknown cmd: ${msg.cmd}` });
    }
  } catch (e) {
    process.send({ type: "error", error: e.message, stack: e.stack });
  }
});

process.send({ type: "ready" });
