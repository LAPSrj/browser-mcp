#!/usr/bin/env node
// Tool arguments the schema doesn't define, and where files go.
//
// 1. normalizeArgs on hand-built arguments (no browser): camelCase/snake_case
//    renaming, unknown arguments rejected, the default output folder filled in.
// 2. The MCP server end to end over an in-memory transport, run from a temp
//    working directory with outputDir set (BROWSER_MCP_OUTPUT_DIR):
//    - screenshot({session_id, outputDir: ".tmp/shots"}), the call that used
//      to drop outputDir and write .browser/capture-*.png, writes to .tmp/shots
//    - screenshot and save_html without a folder use the configured outputDir
//    - an unknown argument is an error and writes nothing
//    - no .browser folder is created
//    Launches Playwright Chromium.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "..", "dist");
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);

const { createServer, normalizeArgs } = await load("server.js");
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-tool-args-")));
process.chdir(tmp);

// ---------------------------------------------------------------------------
console.log("1. normalizeArgs");

{
  const known = new Set(["session_id", "output_path", "output_dir", "full_page"]);
  const r = normalizeArgs("screenshot", known, { sessionId: "s1", outputDir: ".tmp/a", fullPage: true }, "def");
  check(
    r.params?.session_id === "s1" && r.params?.output_dir === ".tmp/a" && r.params?.full_page === true,
    "camelCase arguments renamed to the snake_case ones the tool defines",
    r,
  );
  check(!("outputDir" in (r.params ?? {})), "the camelCase name isn't passed on", r);

  const d = normalizeArgs("screenshot", known, { session_id: "s1" }, "def");
  check(d.params?.output_dir === "def", "omitted output_dir gets the server default", d);

  const same = normalizeArgs("screenshot", known, { session_id: "s1", output_dir: "x", outputDir: "x" }, "def");
  check(same.params?.output_dir === "x", "both names with the same value are accepted", same);

  const diff = normalizeArgs("screenshot", known, { session_id: "s1", output_dir: "x", outputDir: "y" }, "def");
  check(/same argument but have different values/.test(diff.error ?? ""), "both names with different values are an error", diff);

  const bad = normalizeArgs("screenshot", known, { session_id: "s1", folder: "x" }, "def");
  check(
    /doesn't accept folder/.test(bad.error ?? "") && /Accepted arguments: .*output_dir/.test(bad.error ?? ""),
    "unknown argument is an error that lists the accepted ones",
    bad,
  );

  const camel = normalizeArgs("multi_screenshot", new Set(["url", "outputDir"]), { url: "u", output_dir: "z" }, "def");
  check(camel.params?.outputDir === "z", "snake_case renamed to a camelCase argument too", camel);
}

// ---------------------------------------------------------------------------
console.log("2. MCP server");

const server = createServer({ outputDir: ".tmp/default" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(clientTransport);

const page = pathToFileURL(path.join(__dirname, "fixtures", "design-compare-test.html")).href;
const parse = (r) => JSON.parse(r.content[0].text);

try {
  const { tools } = await client.listTools();
  const shot = tools.find((t) => t.name === "screenshot");
  check(
    shot && "output_dir" in shot.inputSchema.properties && "session_id" in shot.inputSchema.properties,
    "tool list still shows each tool's arguments",
    shot?.inputSchema,
  );

  const open = await client.callTool({ name: "open_session", arguments: { url: page } });
  check(!open.isError, "open_session", open.content);
  const sid = parse(open).session_id;

  const a = await client.callTool({
    name: "screenshot",
    arguments: { session_id: sid, outputDir: ".tmp/shots" },
  });
  const aPath = a.isError ? null : parse(a).path;
  check(
    !a.isError && path.dirname(path.resolve(aPath)) === path.join(tmp, ".tmp/shots") && fs.existsSync(aPath),
    "screenshot with outputDir writes into that folder",
    a.content,
  );

  const b = await client.callTool({ name: "screenshot", arguments: { session_id: sid } });
  const bPath = b.isError ? null : parse(b).path;
  check(
    !b.isError && path.dirname(path.resolve(bPath)) === path.join(tmp, ".tmp/default") && fs.existsSync(bPath),
    "screenshot without a folder uses the configured outputDir",
    b.content,
  );

  const c = await client.callTool({ name: "save_html", arguments: { session_id: sid } });
  const cPath = c.isError ? null : parse(c).path;
  check(
    !c.isError && path.dirname(path.resolve(cPath)) === path.join(tmp, ".tmp/default"),
    "save_html without a folder uses the configured outputDir",
    c.content,
  );

  const before = fs.readdirSync(path.join(tmp, ".tmp/default")).length;
  const d = await client.callTool({
    name: "screenshot",
    arguments: { session_id: sid, out_dir: ".tmp/typo" },
  });
  check(
    d.isError && /doesn't accept out_dir/.test(d.content[0].text),
    "unknown argument is an error",
    d.content,
  );
  check(
    !fs.existsSync(path.join(tmp, ".tmp/typo")) && fs.readdirSync(path.join(tmp, ".tmp/default")).length === before,
    "the rejected call wrote no file",
  );

  await client.callTool({ name: "close_session", arguments: { session_id: sid } });
  check(!fs.existsSync(path.join(tmp, ".browser")), "no .browser folder was created");
} finally {
  await client.close();
  await server.close();
  await sessionManager.closeAll?.("test").catch(() => {});
  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
