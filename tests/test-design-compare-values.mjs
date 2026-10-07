#!/usr/bin/env node
// Comparison rules shared by design_compare and design_audit:
//   - text-align: start/end equal left/right according to the element's direction.
//   - colors: alpha below 1 is part of the color (compared within 0.02), so a
//     semi-transparent expected color fails against an opaque one.
//
// Serves an inline fixture page on a local port and runs both tools against it.
//
// Usage: node tests/test-design-compare-values.mjs

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, ".browser", "design-compare-values");
await fs.mkdir(OUT_DIR, { recursive: true });

const html = `<!doctype html>
<html><head><style>
  body { margin: 0; }
  div { width: 200px; height: 20px; }
  #opaque { background-color: rgb(0, 0, 0); }
  #semi { background-color: rgba(33, 38, 42, 0.6); }
  #clear { background-color: transparent; }
  #start-ltr { text-align: start; }
  #end-ltr { text-align: end; }
  #left-ltr { text-align: left; }
  #start-rtl { text-align: start; direction: rtl; }
</style></head><body><main>
  <div id="opaque"></div>
  <div id="semi"></div>
  <div id="clear"></div>
  <div id="start-ltr">a</div>
  <div id="end-ltr">a</div>
  <div id="left-ltr">a</div>
  <div id="start-rtl">a</div>
</main></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/`;

// [name, selector, property, expected value, should match]
const cases = [
  ["half-alpha vs opaque", "#opaque", "background-color", "rgba(0, 0, 0, 0.5)", false],
  ["opaque vs opaque", "#opaque", "background-color", "#000", true],
  ["same alpha", "#semi", "background-color", "rgba(33, 38, 42, 0.6)", true],
  ["alpha within 0.02", "#semi", "background-color", "rgba(33, 38, 42, 0.61)", true],
  ["alpha outside 0.02", "#semi", "background-color", "rgba(33, 38, 42, 0.65)", false],
  ["opaque vs alpha 0.6", "#semi", "background-color", "rgb(33, 38, 42)", false],
  ["black vs transparent", "#clear", "background-color", "black", false],
  ["transparent vs transparent", "#clear", "background-color", "transparent", true],
  ["left vs start (ltr)", "#start-ltr", "text-align", "left", true],
  ["right vs end (ltr)", "#end-ltr", "text-align", "right", true],
  ["start vs left (ltr)", "#left-ltr", "text-align", "start", true],
  ["right vs start (ltr)", "#start-ltr", "text-align", "right", false],
  ["left vs start (rtl)", "#start-rtl", "text-align", "left", false],
  ["right vs start (rtl)", "#start-rtl", "text-align", "right", true],
];

const elements = cases.map(([name, selector, property, value]) => ({
  name,
  selector,
  expected: { [property]: value },
}));

function check(toolName, parsedElements) {
  let failed = 0;
  cases.forEach(([name, , property, value, shouldMatch], i) => {
    const r = parsedElements[i].results[0];
    const ok = r.match === shouldMatch;
    if (!ok) failed++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${toolName}: ${name}: expected ${property} '${value}', actual '${r.actual}', ` +
      `match=${r.match} (want ${shouldMatch})`,
    );
  });
  return failed;
}

let failed = 0;
try {
  const { designCompareTool } = await import("../dist/plugins/design-compare/tools/design-compare.js");
  const compare = await designCompareTool({ url, viewport: { width: 400, height: 300 }, elements });
  failed += check("design_compare", JSON.parse(compare.content.at(-1).text).elements);

  const { designAuditTool } = await import("../dist/plugins/design-compare/tools/design-audit.js");
  const audit = await designAuditTool({
    url,
    referenceUrl: url,
    rootSelector: "main",
    viewport: { width: 400, height: 300 },
    elements,
    outputDir: OUT_DIR,
  });
  failed += check("design_audit", JSON.parse(audit.content.at(-1).text).designCompare.elements);
} finally {
  server.close();
}

if (failed > 0) {
  console.error(`\n${failed} comparison(s) gave the wrong result`);
  process.exit(1);
}
console.log("\nall comparisons correct");
