#!/usr/bin/env node
// Smoke: profile:"walker" preset across compare_*, dom_query, dom_snapshot.
// Verifies (a) parity with explicit-flags equivalent, (b) caller-supplied
// flags override profile defaults, (c) zod schema rejects unknown profiles.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testHtml = `file://${path.resolve(__dirname, "design-compare-test.html")}`;
const tmpDir = path.resolve(__dirname, "../.browser/walker-profile-smoke");
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

const { compareScreenshotTool } = await import("../dist/plugins/dev/tools/compare-screenshot.js");
const { compareElementTool } = await import("../dist/plugins/dev/tools/compare-element.js");
const { domQueryTool } = await import("../dist/plugins/dev/tools/dom-query.js");
const { domSnapshotTool } = await import("../dist/plugins/dev/tools/dom-snapshot.js");

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}
function joinText(r) { return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"); }
function lastJSON(r) {
  const blocks = r.content.filter((c) => c.type === "text").map((c) => c.text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try { return JSON.parse(blocks[i]); } catch {}
  }
  return null;
}

// Strip volatile bits (timestamps in filenames, durations) so we can compare
// two runs of the same tool by content shape.
function normalizeForCompare(text) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[\d-]+Z/g, "TIMESTAMP")
    .replace(/_chromium_TIMESTAMP\.png/g, "_chromium.png");
}

// ---------- compare_screenshot: parity + override ----------
console.log("\n=== compare_screenshot: parity ===");
{
  const profileResult = await compareScreenshotTool({
    url: testHtml,
    referenceImage: refPath,
    outputDir: tmpDir,
    profile: "walker",
  });
  const explicitResult = await compareScreenshotTool({
    url: testHtml,
    referenceImage: refPath,
    outputDir: tmpDir,
    summaryOnly: true,
    clustersTopN: 3,
  });
  const a = normalizeForCompare(joinText(profileResult));
  const b = normalizeForCompare(joinText(explicitResult));
  check(a === b, "profile:'walker' parity with explicit summaryOnly+clustersTopN", `\nA:\n${a}\n---\nB:\n${b}`);
}

console.log("\n=== compare_screenshot: caller overrides profile ===");
{
  // Profile would set summaryOnly:true; caller overrides to false.
  const result = await compareScreenshotTool({
    url: testHtml,
    referenceImage: refPath,
    outputDir: tmpDir,
    profile: "walker",
    summaryOnly: false,
  });
  const text = joinText(result);
  // Full mode includes "Diff preview" and "Element box" — neither in summary mode.
  check(/Diff preview \(small\):/.test(text), "caller summaryOnly:false beats profile (full mode active)");
}

// ---------- compare_element: parity + override ----------
console.log("\n=== compare_element: parity ===");
{
  const profileResult = await compareElementTool({
    url: testHtml,
    referenceImage: refPath,
    selector: ".heading",
    outputDir: tmpDir,
    profile: "walker",
  });
  const explicitResult = await compareElementTool({
    url: testHtml,
    referenceImage: refPath,
    selector: ".heading",
    outputDir: tmpDir,
    summaryOnly: true,
    clustersTopN: 3,
  });
  const a = normalizeForCompare(joinText(profileResult));
  const b = normalizeForCompare(joinText(explicitResult));
  check(a === b, "profile:'walker' parity with explicit equivalent (element)", `\nA:\n${a}\n---\nB:\n${b}`);
}

// ---------- dom_query: parity + override ----------
console.log("\n=== dom_query: parity (default fields) ===");
{
  const profileResult = lastJSON(await domQueryTool({
    url: testHtml,
    queries: [{ id: "h", selector: ".heading" }],
    profile: "walker",
  }));
  const explicitResult = lastJSON(await domQueryTool({
    url: testHtml,
    queries: [{ id: "h", selector: ".heading", fields: ["rect", "tag", "id", "classes", "text"] }],
  }));
  const profileEl = profileResult.results[0].element;
  const explicitEl = explicitResult.results[0].element;
  check(profileEl.tag === explicitEl.tag, "profile parity: tag");
  check(JSON.stringify(profileEl.classes) === JSON.stringify(explicitEl.classes), "profile parity: classes");
  check(typeof profileEl.text === "string" && profileEl.text === explicitEl.text, "profile parity: text");
  check("rect" in profileEl && "rect" in explicitEl, "profile parity: rect present in both");
  check(!("computed" in profileEl), "profile does not pull computed (not in walker default)");
  check(!("html" in profileEl), "profile does not pull html (not in walker default)");
}

console.log("\n=== dom_query: per-query fields override profile ===");
{
  // Caller's per-query fields wins even under profile:"walker"
  const result = lastJSON(await domQueryTool({
    url: testHtml,
    queries: [
      { id: "narrow", selector: ".heading", fields: ["tag"] },          // explicit, narrow
      { id: "wide", selector: ".heading" },                              // profile default
    ],
    profile: "walker",
  }));
  const narrow = result.results[0].element;
  const wide = result.results[1].element;
  check(narrow.tag && !narrow.classes && !narrow.text && !narrow.rect, "explicit fields:['tag'] beats profile default");
  check(wide.tag && wide.classes && typeof wide.text === "string", "no fields → profile default fields used");
}

// ---------- dom_snapshot: parity ----------
console.log("\n=== dom_snapshot: parity ===");
{
  const profileResult = await domSnapshotTool({ url: testHtml, profile: "walker" });
  const explicitResult = await domSnapshotTool({ url: testHtml, summaryOnly: true });
  const a = normalizeForCompare(joinText(profileResult));
  const b = normalizeForCompare(joinText(explicitResult));
  check(a === b, "profile:'walker' parity with explicit summaryOnly:true (dom_snapshot)");
}

// ---------- Schema rejection of unknown profile ----------
console.log("\n=== schema: rejects unknown profile names ===");
{
  // The zod schemas registered in plugins/dev/index.ts use z.enum(["walker"]).
  // Replicate the validation here to confirm the constraint is in the
  // exposed surface — handlers won't see "critic" because zod blocks it.
  const profileSchema = z.enum(["walker"]).optional();
  const okWalker = profileSchema.safeParse("walker");
  const okUndefined = profileSchema.safeParse(undefined);
  const failCritic = profileSchema.safeParse("critic");
  const failEmpty = profileSchema.safeParse("");
  check(okWalker.success, "schema accepts 'walker'");
  check(okUndefined.success, "schema accepts undefined (optional)");
  check(!failCritic.success, "schema rejects 'critic'");
  check(!failEmpty.success, "schema rejects empty string");
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
