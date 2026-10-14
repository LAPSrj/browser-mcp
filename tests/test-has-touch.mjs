#!/usr/bin/env node
// has_touch: a page where touch-only CSS applies.
//
// Themes widen hit areas for phones and tablets inside @media (pointer: coarse),
// (any-pointer: coarse) or (hover: none). Without touch emulation every
// browser-mcp page is a desktop with a fine pointer and hover, at any viewport,
// so those rules never apply. Checked over MCP stdio against dist/index.js with
// the dev plugin loaded (the way build-block verify calls it):
//
// 1. Every tool that exposes useBrowserStack also exposes has_touch.
// 2. One-shot evaluate_script at a phone viewport: without has_touch the touch
//    queries don't match; with it they all match and a (pointer: coarse) rule
//    sets the element size. Chromium, Firefox and WebKit.
// 3. open_session with has_touch: the session's page matches the touch queries.
// 4. pause_session / resume_session keeps has_touch.
// 5. has_touch with attach_cdp is an error (it reuses an existing context).
// Launches Playwright browsers.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "..", "dist", "index.js");

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<style>#t{display:block;width:20px;height:20px}" +
      "@media (pointer: coarse){#t{width:44px;height:44px}}</style><a id=t href=#>x</a>",
  );
const PROBE = `const q = (s) => matchMedia(s).matches;
const r = document.getElementById("t").getBoundingClientRect();
return { coarse: q("(pointer: coarse)"), anyCoarse: q("(any-pointer: coarse)"), hoverNone: q("(hover: none)"), w: r.width, h: r.height };`;
const PHONE = { width: 390, height: 844 };

const touchOn = (m) => m && m.coarse && m.anyCoarse && m.hoverNone && m.w === 44 && m.h === 44;
const touchOff = (m) => m && !m.coarse && !m.anyCoarse && m.w === 20 && m.h === 20;

const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, BROWSER_MCP_PLUGINS: "dev" },
    stderr: "ignore",
  }),
);

const text = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const evalJson = (r) => {
  try { return JSON.parse(text(r)); } catch { return null; }
};

try {
  // -------------------------------------------------------------------------
  console.log("1. tool schemas");
  const { tools } = await client.listTools();
  const ephemeral = tools.filter((t) => "useBrowserStack" in (t.inputSchema.properties ?? {}));
  const missing = ephemeral.filter((t) => !("has_touch" in t.inputSchema.properties)).map((t) => t.name);
  check(ephemeral.length > 10 && missing.length === 0, `has_touch on all ${ephemeral.length} ephemeral tools`, missing);

  // -------------------------------------------------------------------------
  console.log("2. one-shot evaluate_script");
  for (const browser of ["chromium", "firefox", "webkit"]) {
    const off = await client.callTool({
      name: "evaluate_script",
      arguments: { url: PAGE, viewport: PHONE, browser, script: PROBE },
    });
    check(!off.isError && touchOff(evalJson(off)), `${browser}: no has_touch → desktop pointer, 20px target`, text(off));

    const on = await client.callTool({
      name: "evaluate_script",
      arguments: { url: PAGE, viewport: PHONE, browser, has_touch: true, script: PROBE },
    });
    check(!on.isError && touchOn(evalJson(on)), `${browser}: has_touch → touch queries match, 44px target`, text(on));
  }

  // -------------------------------------------------------------------------
  console.log("3. open_session");
  const open = await client.callTool({
    name: "open_session",
    arguments: { url: PAGE, viewport: PHONE, has_touch: true },
  });
  check(!open.isError, "open_session with has_touch", text(open));
  const sid = JSON.parse(text(open)).session_id;
  const s = await client.callTool({ name: "evaluate_script", arguments: { session_id: sid, script: PROBE } });
  check(touchOn(evalJson(s)), "session page matches the touch queries", text(s));

  // -------------------------------------------------------------------------
  console.log("4. pause / resume");
  const paused = await client.callTool({ name: "pause_session", arguments: { session_id: sid } });
  const snapshot = JSON.parse(text(paused)).snapshot;
  check(snapshot?.has_touch === true, "snapshot records has_touch", snapshot);
  const resumed = await client.callTool({ name: "resume_session", arguments: { snapshot } });
  check(!resumed.isError, "resume_session", text(resumed));
  const rid = JSON.parse(text(resumed)).session_id;
  const r = await client.callTool({ name: "evaluate_script", arguments: { session_id: rid, script: PROBE } });
  check(touchOn(evalJson(r)), "resumed session still matches the touch queries", text(r));
  await client.callTool({ name: "close_session", arguments: { session_id: rid } });

  // -------------------------------------------------------------------------
  console.log("5. attach_cdp");
  const cdp = await client.callTool({
    name: "open_session",
    arguments: { attach_cdp: "http://localhost:1", has_touch: true },
  });
  check(cdp.isError && /has_touch is not supported with attach_cdp/.test(text(cdp)), "has_touch + attach_cdp is an error", text(cdp));
} finally {
  // Closing stdio ends the server, which closes its sessions.
  await client.close();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
