#!/usr/bin/env node
import fs from "node:fs";

// Usage: node test-design-audit.mjs <input.json>
// Input JSON should match the DesignAuditParams interface.
// Example: { "url": "http://localhost:8080/test/hero/manual/", "referenceImage": "ref.png", "rootSelector": ".block", "elements": [...] }

const inputPath = process.argv[2];
if (!inputPath) {
  console.log("SKIP: ad-hoc CLI tool — pass an input.json to exercise design_audit. Usage: node tests/test-design-audit.mjs <input.json>");
  process.exit(0);
}

const params = JSON.parse(fs.readFileSync(inputPath, "utf-8"));

const { designAuditTool } = await import("../dist/plugins/design-compare/tools/design-audit.js");
const result = await designAuditTool(params);

for (const item of result.content) {
  if (item.type === "text") console.log(item.text);
}
