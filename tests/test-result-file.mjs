#!/usr/bin/env node
// result_path: tools registered with resultFile: true write their text result
// to a file and return one line (path, bytes, sha256, summary) instead.
//
// 1. applyResultPath on hand-built results (no browser).
// 2. The MCP server end to end over an in-memory transport, with a fake
//    plugin: the schema field appears only on flagged tools, the file holds
//    exactly the inline text, and unflagged tools ignore result_path.
// 3. design_audit through the server against a local fixture page (launches
//    Chromium).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "..", "dist");
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);

const { applyResultPath } = await load("utils/result-file.js");
const { createServer } = await load("server.js");
const { PluginRegistry } = await load("plugins/registry.js");
const { resolveUrl } = await load("utils/url.js");
const { sessionManager } = await load("core/sessions.js");
const designComparePlugin = (await load("plugins/design-compare/index.js")).default;

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const LINE_RE = /^Result written to (.+) \((\d+) bytes, sha256 ([0-9a-f]{64})\)\.(?: (.*))?$/;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-result-file-"));

// ---------------------------------------------------------------------------
console.log("1. applyResultPath");

{
  const r = await applyResultPath(
    { content: [{ type: "text", text: "inline" }], _summary: "s" },
    undefined,
    tmp,
  );
  check(r.content[0].text === "inline" && !("_summary" in r), "no path: inline, _summary dropped", r);
}

{
  const img = { type: "image", data: "AAAA", mimeType: "image/png" };
  const r = await applyResultPath(
    {
      content: [{ type: "text", text: "first" }, img, { type: "text", text: '{"a":1}' }],
      _summary: "two parts",
      _warnings: ["w"],
    },
    "nested/out.txt",
    tmp,
  );
  const m = r.content[0].text.match(LINE_RE);
  const expectedPath = path.join(tmp, "nested/out.txt");
  check(!!m, "summary line has the documented format", r.content[0].text);
  check(m?.[1] === expectedPath, "relative path resolves under outputDir", m?.[1]);
  const body = fs.readFileSync(expectedPath, "utf-8");
  check(body === 'first\n{"a":1}', "text parts joined by newline", body);
  check(m?.[2] === String(Buffer.byteLength(body)), "byte count matches the file");
  check(m?.[3] === sha256(body), "sha256 matches the file");
  check(m?.[4] === "two parts", "tool summary follows the line");
  check(r.content.length === 2 && r.content[1] === img, "image part stays inline", r.content);
  check(r._warnings?.[0] === "w" && !("_summary" in r), "_warnings kept, _summary dropped");
}

{
  const abs = path.join(tmp, "error.txt");
  const r = await applyResultPath(
    { content: [{ type: "text", text: "Error: boom" }], isError: true, _summary: "x" },
    abs,
    tmp,
  );
  check(r.content[0].text === "Error: boom" && r.isError, "error stays inline");
  check(!fs.existsSync(abs), "error writes no file");
}

{
  const r = await applyResultPath(
    { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
    path.join(tmp, "img.txt"),
    tmp,
  );
  check(
    r.content.length === 2 && /result_path ignored/.test(r.content[1].text),
    "image-only result says result_path was ignored",
    r.content,
  );
}

// ---------------------------------------------------------------------------
console.log("2. MCP server, fake plugin");

const BIG = JSON.stringify({ rows: Array.from({ length: 50 }, (_, i) => ({ i, v: "x".repeat(20) })) }, null, 2);

const fakePlugin = {
  name: "fake",
  version: "0.0.0",
  getConfigSchema: () => ({}),
  register(ctx) {
    ctx.registerTool({
      name: "big",
      description: "returns a large result",
      schema: { n: z.number().optional() },
      handler: async (params) => ({
        content: [{ type: "text", text: BIG }],
        _summary: `n=${params.n ?? "none"}; saw result_path: ${"result_path" in params}`,
      }),
      resultFile: true,
    });
    ctx.registerTool({
      name: "small",
      description: "not flagged",
      schema: {},
      handler: async () => ({ content: [{ type: "text", text: "small result" }] }),
    });
  },
};

const coreUtils = { resolveUrl };
const registry = new PluginRegistry();
await registry.load(fakePlugin, {}, coreUtils);
await registry.load(designComparePlugin, {}, coreUtils);
registry.seal();

const server = createServer({ outputDir: tmp }, registry);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(clientTransport);

try {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check("result_path" in (byName.fake_big?.inputSchema.properties ?? {}), "flagged tool exposes result_path");
  check(!("result_path" in (byName.fake_small?.inputSchema.properties ?? {})), "unflagged tool doesn't");
  check(
    "result_path" in (byName["design-compare_design_audit"]?.inputSchema.properties ?? {}),
    "design_audit exposes result_path",
  );
  check(
    !("result_path" in (byName["design-compare_design_compare"]?.inputSchema.properties ?? {})),
    "design_compare doesn't",
  );

  const inline = await client.callTool({ name: "fake_big", arguments: { n: 1 } });
  check(inline.content.length === 1 && inline.content[0].text === BIG, "without result_path: inline as before");
  check(!("_summary" in inline), "without result_path: _summary not sent");

  const out = path.join(tmp, "big.json");
  const filed = await client.callTool({ name: "fake_big", arguments: { n: 1, result_path: out } });
  const m = filed.content[0].text.match(LINE_RE);
  check(filed.content.length === 1 && !!m, "with result_path: one line", filed.content);
  check(fs.readFileSync(out, "utf-8") === BIG, "file is byte-identical to the inline text");
  check(m?.[3] === sha256(BIG), "line's sha256 is the inline text's sha256");
  check(m?.[4] === "n=1; saw result_path: false", "handler never sees result_path", m?.[4]);

  const smallOut = path.join(tmp, "small.txt");
  const small = await client.callTool({ name: "fake_small", arguments: { result_path: smallOut } });
  check(small.content[0].text === "small result" && !fs.existsSync(smallOut), "unflagged tool ignores result_path");

  // -------------------------------------------------------------------------
  console.log("3. design_audit through the server (Chromium)");

  const fixture = pathToFileURL(path.join(__dirname, "fixtures", "design-compare-test.html")).href;
  const auditArgs = {
    url: fixture,
    referenceUrl: fixture,
    rootSelector: ".heading",
    viewport: { width: 800, height: 600 },
    elements: [{ name: "heading", selector: ".heading", expected: { "font-size": "72px", color: "#ffffff" } }],
    outputDir: tmp,
  };
  const auditOut = path.join(tmp, "audit.json");
  const audit = await client.callTool({
    name: "design-compare_design_audit",
    arguments: { ...auditArgs, result_path: auditOut },
  });
  const am = audit.content[0]?.text?.match(LINE_RE);
  check(!audit.isError && audit.content.length === 1 && !!am, "design_audit returns one line", audit.content);
  const auditBody = fs.readFileSync(auditOut, "utf-8");
  const parsed = JSON.parse(auditBody);
  check(am?.[3] === sha256(auditBody), "design_audit sha256 matches its file");
  check(
    am?.[4]?.startsWith(
      `elements found ${parsed.summary.elementsFound}/${parsed.summary.totalElements}; ` +
        `properties matching ${parsed.summary.propertyMatches}/${parsed.summary.totalProperties}; ` +
        `visual score ${parsed.summary.visualDiffScore}`,
    ),
    "design_audit summary reflects the file's summary block",
    am?.[4],
  );
  console.log(`       ${audit.content[0].text}`);
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
