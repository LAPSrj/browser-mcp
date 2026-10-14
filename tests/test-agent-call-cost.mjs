#!/usr/bin/env node
// Tool behaviors that cost agents extra calls or context, checked through the
// MCP server over an in-memory transport. Launches Playwright Chromium.
//
// 1. element_screenshot inline_image:false returns only the saved path.
// 2. A selector matching several elements gives a short strict-mode error.
// 3. A click on a covered element fails in ~5 s and names the cover; a slow
//    element still gets clicked, once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "..", "dist");
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);

const { createServer } = await load("server.js");
const { sessionManager } = await load("core/sessions.js");
const { PluginRegistry } = await load("plugins/registry.js");
const { resolveUrl } = await load("utils/url.js");
const devPlugin = (await load("plugins/dev/index.js")).default;

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-call-cost-")));
const registry = new PluginRegistry();
await registry.load(devPlugin, {}, { resolveUrl });
registry.seal();
const server = createServer({ outputDir: tmp }, registry);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(clientTransport);

const html = (body) => `data:text/html,${encodeURIComponent(body)}`;

try {
  // -------------------------------------------------------------------------
  console.log("1. element_screenshot inline_image");
  {
    const url = html('<div id="box" style="width:50px;height:50px;background:red"></div>');
    const withImage = await client.callTool({ name: "element_screenshot", arguments: { url, selector: "#box" } });
    check(withImage.content.some((c) => c.type === "image"), "default still returns the image", withImage.content.map((c) => c.type));

    const pathOnly = await client.callTool({
      name: "element_screenshot",
      arguments: { url, selector: "#box", inline_image: false },
    });
    const text = pathOnly.content.map((c) => c.text ?? "").join("\n");
    const saved = text.match(/Saved: (.+\.png)/)?.[1];
    check(!pathOnly.isError && pathOnly.content.every((c) => c.type === "text"), "inline_image:false returns text only", pathOnly.content);
    check(saved && fs.existsSync(saved), "the PNG is still saved", text);
  }

  // -------------------------------------------------------------------------
  console.log("2. strict-mode error is short");
  {
    const links = Array.from({ length: 8 }, (_, i) => `<a href="#">${"long text ".repeat(40)}${i}</a>`).join("");
    const url = html(links);
    const shot = await client.callTool({ name: "element_screenshot", arguments: { url, selector: "a" } });
    const text = shot.content[0]?.text ?? "";
    check(shot.isError && /resolved to 8 elements/.test(text), "error names the match count", text);
    check(/… 5 more/.test(text) && /nth=0/.test(text), "lists 3 matches, the rest as a count, and a hint", text);
    check(text.length < 900 && !/\x1b\[/.test(text), `error is short (${text.length} chars) with no ANSI codes`, text);
  }

  // -------------------------------------------------------------------------
  console.log("3. click on a covered element fails fast");
  {
    const covered = html(
      '<button id="b" onclick="window.clicked=(window.clicked||0)+1">Go</button>' +
        '<div id="veil" style="position:fixed;inset:0"></div>',
    );
    const open = await client.callTool({ name: "open_session", arguments: { url: covered } });
    const sid = JSON.parse(open.content[0].text).session_id;
    const read = async (expr) => {
      const r = await client.callTool({ name: "evaluate_script", arguments: { session_id: sid, script: `return ${expr}` } });
      return JSON.parse(r.content[0].text);
    };

    let t0 = Date.now();
    const blocked = await client.callTool({ name: "click", arguments: { session_id: sid, selector: "#b" } });
    const blockedMs = Date.now() - t0;
    const text = blocked.content[0]?.text ?? "";
    check(blocked.isError && /<div id="veil"><\/div> covers it/.test(text), "error names the covering element", text);
    check(blockedMs < 9000, `fails in ${blockedMs} ms instead of 30 s`);

    // An overlay that goes away within the 5 s window doesn't fail the click.
    await client.callTool({
      name: "evaluate_script",
      arguments: { session_id: sid, script: "setTimeout(() => document.getElementById('veil').remove(), 1000)" },
    });
    const later = await client.callTool({ name: "click", arguments: { session_id: sid, selector: "#b" } });
    check(!later.isError && (await read("window.clicked")) === 1, "click goes through once the overlay is removed", later.content);

    // An element that shows up after the 5 s window still gets clicked once.
    await client.callTool({
      name: "evaluate_script",
      arguments: {
        session_id: sid,
        script:
          "document.getElementById('b').style.display='none';" +
          "setTimeout(() => { document.getElementById('b').style.display=''; }, 6000)",
      },
    });
    t0 = Date.now();
    const slow = await client.callTool({ name: "click", arguments: { session_id: sid, selector: "#b", timeout: 15000 } });
    check(!slow.isError && (await read("window.clicked")) === 2, `slow element clicked once after ${Date.now() - t0} ms`, slow.content);

    await client.callTool({ name: "close_session", arguments: { session_id: sid } });
  }
} finally {
  await client.close();
  await server.close();
  await sessionManager.closeAll?.("test").catch(() => {});
  await registry.destroyAll();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
