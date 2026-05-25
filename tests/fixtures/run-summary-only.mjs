#!/usr/bin/env node
// Smoke: verify summaryOnly:true on compare_screenshot + compare_element
// returns a meaningfully smaller payload and skips preview file generation.
//
// Run after `npm run build`.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testHtml = `file://${path.resolve(__dirname, "design-compare-test.html")}`;
const tmpDir = path.resolve(__dirname, "../.browser/summary-smoke");
await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.goto(testHtml, { waitUntil: "networkidle" });
const refPath = path.join(tmpDir, "ref.png");
await page.screenshot({ path: refPath });
await browser.close();

const { compareScreenshotTool } = await import("../../dist/plugins/dev/tools/compare-screenshot.js");
const { compareElementTool } = await import("../../dist/plugins/dev/tools/compare-element.js");

function joinText(result) {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

async function countFiles() {
  return (await fs.readdir(tmpDir)).length;
}

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

// ---- compare_screenshot: full vs summary ----
console.log("\n=== compare_screenshot: full ===");
const ssBefore = await countFiles();
const ssFull = await compareScreenshotTool({
  url: testHtml,
  referenceImage: refPath,
  outputDir: tmpDir,
});
const ssFullText = joinText(ssFull);
const ssFullFiles = (await countFiles()) - ssBefore;
console.log(`  chars=${ssFullText.length}  filesWritten=${ssFullFiles}`);

console.log("\n=== compare_screenshot: summaryOnly ===");
const ssSummaryBefore = await countFiles();
const ssSummary = await compareScreenshotTool({
  url: testHtml,
  referenceImage: refPath,
  outputDir: tmpDir,
  summaryOnly: true,
});
const ssSummaryText = joinText(ssSummary);
const ssSummaryFiles = (await countFiles()) - ssSummaryBefore;
console.log(`  chars=${ssSummaryText.length}  filesWritten=${ssSummaryFiles}`);
console.log(`  --- response ---\n${ssSummaryText.split("\n").map((l) => `  | ${l}`).join("\n")}`);

check(ssSummaryText.length < ssFullText.length * 0.6, "summary < 60% of full chars", `summary=${ssSummaryText.length} full=${ssFullText.length}`);
check(ssSummaryFiles < ssFullFiles, "summary writes fewer files", `summary=${ssSummaryFiles} full=${ssFullFiles}`);
check(/Match: YES/.test(ssSummaryText), "summary contains Match: YES");
check(/Diff: 0\.00%|Diff: 0\./.test(ssSummaryText), "summary contains Diff: 0.xx%");
check(!/clusterAnnotations:/.test(ssSummaryText), "summary omits clusterAnnotations");
check(!/Diff preview/.test(ssSummaryText), "summary omits 'Diff preview' line");
check(/Match: YES/.test(ssFullText), "full contains Match: YES");

// ---- compare_element: full vs summary (use a selector that resolves) ----
console.log("\n=== compare_element: full ===");
const ceBefore = await countFiles();
const ceFull = await compareElementTool({
  url: testHtml,
  referenceImage: refPath,
  selector: ".heading",
  outputDir: tmpDir,
});
const ceFullText = joinText(ceFull);
const ceFullFiles = (await countFiles()) - ceBefore;
console.log(`  chars=${ceFullText.length}  filesWritten=${ceFullFiles}`);

console.log("\n=== compare_element: summaryOnly ===");
const ceSummaryBefore = await countFiles();
const ceSummary = await compareElementTool({
  url: testHtml,
  referenceImage: refPath,
  selector: ".heading",
  outputDir: tmpDir,
  summaryOnly: true,
});
const ceSummaryText = joinText(ceSummary);
const ceSummaryFiles = (await countFiles()) - ceSummaryBefore;
console.log(`  chars=${ceSummaryText.length}  filesWritten=${ceSummaryFiles}`);
console.log(`  --- response ---\n${ceSummaryText.split("\n").map((l) => `  | ${l}`).join("\n")}`);

check(ceSummaryText.length < ceFullText.length * 0.6, "summary < 60% of full chars (element)", `summary=${ceSummaryText.length} full=${ceFullText.length}`);
check(ceSummaryFiles < ceFullFiles, "summary writes fewer files (element)", `summary=${ceSummaryFiles} full=${ceFullFiles}`);
check(/Match: YES/.test(ceSummaryText), "summary contains Match: YES (element)");
check(!/Cropped reference saved/.test(ceSummaryText), "summary omits 'Cropped reference saved' line");
check(!/Element box:/.test(ceSummaryText), "summary omits 'Element box:' diagnostic");
check(!/clusterAnnotations:/.test(ceSummaryText), "summary omits clusterAnnotations (element)");

// ---- compare_screenshot: mismatch path (forces clusters) ----
console.log("\n=== compare_screenshot: summaryOnly with mismatch (induced clusters) ===");
// Build a corrupted reference: blank PNG of same size, so every pixel diffs.
const { PNG } = await import("pngjs");
const refPng = PNG.sync.read(await fs.readFile(refPath));
const blank = new PNG({ width: refPng.width, height: refPng.height });
blank.data.fill(255);
const blankRefPath = path.join(tmpDir, "blank-ref.png");
await fs.writeFile(blankRefPath, PNG.sync.write(blank));
const ssMismatch = await compareScreenshotTool({
  url: testHtml,
  referenceImage: blankRefPath,
  outputDir: tmpDir,
  summaryOnly: true,
});
const ssMismatchText = joinText(ssMismatch);
console.log(`  chars=${ssMismatchText.length}`);
console.log(`  --- response ---\n${ssMismatchText.split("\n").map((l) => `  | ${l}`).join("\n")}`);
check(/Match: NO/.test(ssMismatchText), "mismatch summary contains Match: NO");
check(/Top \d cluster/.test(ssMismatchText), "mismatch summary contains 'Top N cluster' line");
check(/\[1\] \d+px at x=\d+ y=\d+ \d+x\d+/.test(ssMismatchText), "mismatch summary uses compact cluster format");
check(!/intersecting \(/.test(ssMismatchText), "mismatch summary omits per-cluster 'intersecting' subblock");

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
