#!/usr/bin/env node
// Tool behaviors that cost agents extra calls or context, checked through the
// MCP server over an in-memory transport. Launches Playwright Chromium.
//
// 1. element_screenshot inline_image:false returns only the saved path.
// 2. A selector matching several elements gives a short strict-mode error.
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
const server = createServer({ outputDir: tmp });
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
} finally {
  await client.close();
  await server.close();
  await sessionManager.closeAll?.("test").catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
