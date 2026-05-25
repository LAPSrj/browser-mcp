#!/usr/bin/env node
// End-to-end smoke for align_elements:
//   1. Serve test-fixtures/align-elements-fixture.html on a local port.
//   2. Snap the reference image (no ?shift query → canonical layout).
//   3. Run align_elements against the same URL with ?shift=card-b:12,-7;card-d:-5,3
//      and verify the recovered deltas roughly match (sign-flipped, since
//      the live page is shifted relative to the reference).
//
// Usage: node test-align-elements.mjs

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "align-elements-fixture.html");
const OUT_DIR = path.join(__dirname, ".browser", "align-test");

await fs.mkdir(OUT_DIR, { recursive: true });

// --- tiny static server -----------------------------------------------------
const html = await fs.readFile(FIXTURE, "utf-8");
const server = http.createServer((req, res) => {
  if (!req.url) return res.end();
  // any path serves the same file; query string passes through to the page
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  // --- snap reference -----------------------------------------------------
  const { screenshotTool } = await import("../dist/core/screenshot.js");
  const refResult = await screenshotTool({
    url: `${base}/`,
    outputDir: OUT_DIR,
    viewports: [{ width: 800, height: 600 }],
    fullPage: false,
  });
  // Pluck the saved file path out of the "Saved: <path>" segment.
  const refLines = refResult.content.flatMap((c) => (c.text || "").split("\n"));
  const savedLine = refLines.find((l) => /Saved:\s*\S+\.png/.test(l));
  if (!savedLine) {
    console.error("Could not find Saved: path in screenshot output");
    console.error(refLines.join("\n"));
    process.exit(1);
  }
  const refPath = savedLine.match(/Saved:\s*(\S+\.png)/)[1];
  console.log("Reference captured:", refPath);

  // --- run align_elements --------------------------------------------------
  const { alignElementsTool } = await import("../dist/plugins/dev/tools/align-elements.js");
  const mode = process.env.TEST_MODE || "individual";
  const shiftQuery =
    mode === "uniform"
      ? "shift=card-a:6,4;card-b:6,4;card-c:6,4;card-d:6,4;card-e:6,4"
      : "shift=card-b:12,-7;card-d:-5,3";

  console.log(`\n=== mode=${mode} | shift=${shiftQuery} ===\n`);

  const result = await alignElementsTool({
    url: `${base}/?${shiftQuery}`,
    referenceImage: refPath,
    scope: "main",
    viewport: { width: 800, height: 600 },
    outputDir: OUT_DIR,
    mode: "design",
    summaryOnly: false,
    applyTransform: true,
  });

  for (const item of result.content) {
    if (item.type === "text") console.log(item.text);
  }
} finally {
  server.close();
}
