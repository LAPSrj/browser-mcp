#!/usr/bin/env node
import fs from "node:fs";

// Usage: node test-design-compare.mjs <input.json>
// Input JSON should match the DesignCompareParams interface.

const inputPath = process.argv[2];
if (!inputPath) {
  console.log("SKIP: ad-hoc CLI tool — pass an input.json to exercise design_compare. Usage: node tests/test-design-compare.mjs <input.json>");
  process.exit(0);
}

const params = JSON.parse(fs.readFileSync(inputPath, "utf-8"));

const { designCompareTool } = await import("../dist/plugins/design-compare/tools/design-compare.js");
const result = await designCompareTool(params);

for (const item of result.content) {
  if (item.type === "text") console.log(item.text);
}
