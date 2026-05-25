#!/usr/bin/env node
/**
 * Smoke: popup tabs opened via target=_blank link clicks are auto-registered
 * in the session and appear in list_tabs. External page.close() auto-removes
 * them. (window.open from a non-user-gesture eval gets popup-blocked by
 * Chromium so that path isn't testable from a synthetic JS call — the
 * realistic scenario is link clicks, which use trusted-event gestures and
 * pass the blocker.)
 */
import { sessionManager } from "../dist/core/sessions.js";
import { setTimeout as wait } from "node:timers/promises";

const log = (...a) => console.log("[t]", ...a);
const fail = (m) => { console.error("[t] FAIL", m); process.exit(1); };
const ok = (m) => log("PASS —", m);

const session = await sessionManager.open({
  url: "data:text/html,<h1>parent</h1>",
});
log(`session_id=${session.session_id}`);

// Set up the popup links via DOM (avoids nested-data-URL quote escaping).
{
  const parent = sessionManager.getPage(session.session_id);
  await parent.evaluate(() => {
    const a = (id, label) => {
      const el = document.createElement("a");
      el.id = id;
      el.textContent = label;
      el.target = "_blank";
      el.href = "about:blank";
      el.style.marginRight = "20px";
      document.body.appendChild(el);
    };
    a("l1", "open A");
    a("l2", "open B");
  });
}

const info0 = sessionManager.list().find((s) => s.session_id === session.session_id);
log(`initial tabs: ${info0.tabs.length} — ${info0.tabs.map((t) => t.tab_id).join(", ")}`);
if (info0.tabs.length !== 1) fail("expected 1 tab on fresh session");
ok("session starts with 1 tab");

// ---- Test 1: target=_blank link click auto-registers ----
log("\nTest 1 — clicking a target=_blank link auto-registers the popup");
const mainPage = sessionManager.getPage(session.session_id);
const popup1 = mainPage.context().waitForEvent("page");
await mainPage.click("#l1");
await popup1;
await wait(200);

const info1 = sessionManager.list().find((s) => s.session_id === session.session_id);
log(`tabs after link click: ${info1.tabs.length} — ${info1.tabs.map((t) => `${t.tab_id}@${t.url.slice(0, 50)}`).join(", ")}`);
if (info1.tabs.length !== 2) fail(`expected 2 tabs, got ${info1.tabs.length}`);
const popupTab1 = info1.tabs.find((t) => t.tab_id !== "main");
if (!popupTab1) fail("new popup tab missing from list_tabs");
ok(`popup auto-registered as tab_id=${popupTab1.tab_id} url=${popupTab1.url}`);

// activeTabId should NOT have shifted automatically
if (info1.active_tab_id !== "main") fail(`activeTabId should stay as "main", got "${info1.active_tab_id}"`);
ok("activeTabId did NOT auto-shift — caller still controls focus");

// ---- Test 2: switch_tab to the popup actually works ----
log("\nTest 2 — switch_tab to the auto-registered popup");
await sessionManager.switchTab(session.session_id, popupTab1.tab_id);
const popupPage1 = sessionManager.getPage(session.session_id);
const popupUrl1 = popupPage1.url();
log(`switched-to-tab url: "${popupUrl1}"`);
if (popupUrl1 !== "about:blank") fail(`expected about:blank, got ${popupUrl1}`);
ok("switch_tab + getPage round-trip on the auto-registered popup works");

// ---- Test 3: a second popup gets a different tab id ----
log("\nTest 3 — second target=_blank popup gets a distinct tab id");
await sessionManager.switchTab(session.session_id, "main");
const mainPageAgain = sessionManager.getPage(session.session_id);
const popup2 = mainPageAgain.context().waitForEvent("page");
await mainPageAgain.click("#l2");
await popup2;
await wait(200);

const info2 = sessionManager.list().find((s) => s.session_id === session.session_id);
log(`tabs after 2nd link click: ${info2.tabs.length}`);
if (info2.tabs.length !== 3) fail(`expected 3 tabs, got ${info2.tabs.length}`);
const popupTab2 = info2.tabs.find((t) => t.tab_id !== "main" && t.tab_id !== popupTab1.tab_id);
if (!popupTab2) fail("second popup is missing from list_tabs");
ok(`second popup auto-registered as distinct tab_id=${popupTab2.tab_id}`);

// ---- Test 4: page.close() on a tracked popup auto-removes ----
log("\nTest 4 — page.close() on tracked popup auto-removes from session");
await popupPage1.close();
await wait(300);

const info3 = sessionManager.list().find((s) => s.session_id === session.session_id);
log(`tabs after first popup close: ${info3.tabs.length} — ${info3.tabs.map((t) => t.tab_id).join(", ")}`);
if (info3.tabs.length !== 2) fail(`expected 2 tabs after popup close, got ${info3.tabs.length}`);
if (info3.tabs.find((t) => t.tab_id === popupTab1.tab_id)) fail("closed tab still appears in list_tabs");
ok("closed popup auto-removed from session");

// ---- Test 5: addTab still works with caller-supplied tab_id ----
log("\nTest 5 — addTab still works with caller-supplied tab_id (BC)");
const addResult = await sessionManager.addTab(session.session_id, "named", "data:text/html,<h1>named</h1>");
log(`addTab returned tab_id=${addResult.tab_id}, url=${addResult.url}`);
if (addResult.tab_id !== "named") fail(`expected addTab to honor caller tab_id, got "${addResult.tab_id}"`);

const info4 = sessionManager.list().find((s) => s.session_id === session.session_id);
log(`tabs after addTab: ${info4.tabs.length} — ${info4.tabs.map((t) => t.tab_id).join(", ")}`);
const named = info4.tabs.find((t) => t.tab_id === "named");
if (!named) fail(`"named" tab missing from list_tabs`);
// Ensure no duplicate auto-id entry was left behind by our re-key dance
const duplicate = info4.tabs.find((t) => t.tab_id !== "named" && info4.tabs.filter((x) => x.url === t.url).length > 1);
if (duplicate) fail(`addTab left a duplicate entry: ${JSON.stringify(duplicate)}`);
ok("addTab honors caller-supplied tab_id; no duplicate ghost from the auto-tracker");

await sessionManager.close(session.session_id);

log("\n===== popup-tracking smoke PASSED =====");
process.exit(0);
