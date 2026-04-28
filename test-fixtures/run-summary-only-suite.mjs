#!/usr/bin/env node
// Smoke: summaryOnly support across the six blob-returning dev tools.
// Verifies each tool (a) accepts the flag, (b) produces a meaningfully
// smaller payload, (c) preserves the high-signal fields critic agents need.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testHtml = `file://${path.resolve(__dirname, "design-compare-test.html")}`;

const { domSnapshotTool } = await import("../dist/plugins/dev/tools/dom-snapshot.js");
const { accessibilitySnapshotTool } = await import("../dist/plugins/dev/tools/accessibility.js");
const { networkLogTool } = await import("../dist/plugins/dev/tools/network-log.js");
const { consoleCaptureTool } = await import("../dist/plugins/dev/tools/console-capture.js");
const { performanceMetricsTool } = await import("../dist/plugins/dev/tools/performance.js");
const { schemaExtractTool } = await import("../dist/plugins/dev/tools/schema-extract.js");

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}
function joinText(r) {
  return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
function lastJSON(r) {
  const blocks = r.content.filter((c) => c.type === "text").map((c) => c.text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try { return JSON.parse(blocks[i]); } catch {}
  }
  return null;
}

// ---------- dom_snapshot ----------
console.log("\n=== dom_snapshot ===");
{
  const full = await domSnapshotTool({ url: testHtml });
  const summary = await domSnapshotTool({ url: testHtml, summaryOnly: true });
  const fullText = joinText(full);
  const summaryText = joinText(summary);
  console.log(`  fullChars=${fullText.length}  summaryChars=${summaryText.length}`);
  console.log(`  --- summary ---\n${summaryText.split("\n").map((l) => `  | ${l}`).join("\n")}`);
  check(summaryText.length < fullText.length, "summary smaller than full");
  const j = lastJSON(summary);
  check(j && typeof j.totalNodes === "number" && j.totalNodes > 0, "summary has totalNodes");
  check(j && j.byTag && typeof j.byTag.div === "number", "summary has byTag with div");
  check(j && j.rootTag === "body", "summary has rootTag");
}

// ---------- accessibility_snapshot ----------
console.log("\n=== accessibility_snapshot ===");
{
  const full = await accessibilitySnapshotTool({ url: testHtml });
  const summary = await accessibilitySnapshotTool({ url: testHtml, summaryOnly: true });
  const fullText = joinText(full);
  const summaryText = joinText(summary);
  console.log(`  fullChars=${fullText.length}  summaryChars=${summaryText.length}`);
  check(summaryText.length < fullText.length, "summary smaller than full");
  const j = lastJSON(summary);
  check(j && typeof j.totalNodes === "number", "summary has totalNodes");
  check(j && j.byRole && typeof j.byRole === "object", "summary has byRole");
  check(j && typeof j.headingCount === "number", "summary has headingCount");

  // assertRules findings should still surface in summary mode.
  const summaryWithAsserts = await accessibilitySnapshotTool({
    url: testHtml,
    assertRules: ["img-has-alt"],
    summaryOnly: true,
  });
  const txt = joinText(summaryWithAsserts);
  check(/A11y rule asserts:/.test(txt), "summary mode preserves rule findings");
}

// ---------- network_log ----------
// Note: at small N (<10), the aggregate structure may be larger than raw
// entries — that's expected. summaryOnly is targeted at high-volume cases
// where walker calls return tens of requests; we drive enough volume here.
console.log("\n=== network_log ===");
{
  const fireMany = [
    {
      action: "evaluate",
      script: "for (let i=0; i<25; i++) fetch('https://httpbin.org/get?i='+i).catch(()=>null); return new Promise(r => setTimeout(r, 1500));",
    },
  ];
  const full = await networkLogTool({ url: testHtml, actions: fireMany });
  const summary = await networkLogTool({ url: testHtml, actions: fireMany, summaryOnly: true });
  const fullText = joinText(full);
  const summaryText = joinText(summary);
  console.log(`  fullChars=${fullText.length}  summaryChars=${summaryText.length}`);
  const j = lastJSON(summary);
  if (j && typeof j.totalRequests === "number" && j.totalRequests >= 10) {
    check(summaryText.length < fullText.length, "summary smaller than full at high volume");
    check(typeof j.totalRequests === "number", "summary has totalRequests");
    check(j.byStatus && typeof j.byStatus === "object", "summary has byStatus");
    check(j.byContentType && typeof j.byContentType === "object", "summary has byContentType");
    check(Array.isArray(j.slowestN), "summary has slowestN array");
    check(typeof j.errorCount === "number", "summary has errorCount");
  } else {
    console.log("  (insufficient requests captured — network unreachable in this env; skipping size + field checks)");
  }
}

// ---------- console_capture ----------
// Same caveat as network_log: at small N the structured aggregate may
// exceed raw output. Drive enough volume to demonstrate the win.
console.log("\n=== console_capture ===");
{
  const setup = [
    {
      action: "evaluate",
      script: "for (let i=0; i<30; i++) console.log('log message ' + i + ' with a fair bit of content padding'); console.warn('warn one'); console.error('error one'); console.error('error two with a longer body to test truncation');",
    },
  ];
  const full = await consoleCaptureTool({ url: testHtml, actions: setup });
  const summary = await consoleCaptureTool({ url: testHtml, actions: setup, summaryOnly: true });
  const fullText = joinText(full);
  const summaryText = joinText(summary);
  console.log(`  fullChars=${fullText.length}  summaryChars=${summaryText.length}`);
  console.log(`  --- summary ---\n${summaryText.split("\n").map((l) => `  | ${l}`).join("\n")}`);
  check(summaryText.length < fullText.length, "summary smaller than full at high volume");
  const j = lastJSON(summary);
  check(j && typeof j.totalLogs === "number" && j.totalLogs >= 30, "summary has totalLogs");
  check(j && j.byType && typeof j.byType === "object", "summary has byType");
  check(j && Array.isArray(j.errorPreviews), "summary has errorPreviews array");
  check(j && j.errorPreviews.some((p) => p.type === "error"), "errorPreviews include error type");
}

// ---------- performance_metrics ----------
console.log("\n=== performance_metrics ===");
{
  const full = await performanceMetricsTool({ url: testHtml });
  const summary = await performanceMetricsTool({ url: testHtml, summaryOnly: true });
  const fullText = joinText(full);
  const summaryText = joinText(summary);
  console.log(`  fullChars=${fullText.length}  summaryChars=${summaryText.length}`);
  console.log(`  --- summary ---\n${summaryText.split("\n").map((l) => `  | ${l}`).join("\n")}`);
  check(summaryText.length < fullText.length, "summary smaller than full");
  check(/LCP=/.test(summaryText) && /CLS=/.test(summaryText), "summary has LCP + CLS in pipe-format");
  check(!/{|}/.test(summaryText.split("\n").pop()), "summary last line is not JSON");
}

// ---------- schema_extract ----------
console.log("\n=== schema_extract ===");
{
  const inject = [
    {
      action: "evaluate",
      script: `
        const s1 = document.createElement('script');
        s1.type = 'application/ld+json';
        s1.textContent = JSON.stringify({"@context":"https://schema.org","@type":"WebPage","name":"Test","description":"x".repeat(500)});
        document.head.appendChild(s1);
        const s2 = document.createElement('script');
        s2.type = 'application/ld+json';
        s2.textContent = JSON.stringify({"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q1?","acceptedAnswer":{"@type":"Answer","text":"Some answer with Q1? embedded"}}]});
        document.head.appendChild(s2);
      `,
    },
  ];
  const full = await schemaExtractTool({ url: testHtml, actions: inject });
  const summary = await schemaExtractTool({ url: testHtml, actions: inject, summaryOnly: true });
  const fullText = joinText(full);
  const summaryText = joinText(summary);
  console.log(`  fullChars=${fullText.length}  summaryChars=${summaryText.length}`);
  check(summaryText.length < fullText.length, "summary smaller than full");
  const j = lastJSON(summary);
  check(j && j.summary && j.summary.blockCount === 2, "summary preserves block count");
  check(j && Array.isArray(j.blocks) && j.blocks.length === 2, "summary keeps per-block diagnostics");
  check(j && j.blocks.every((b) => !("parsed" in b)), "summary drops `parsed` from blocks");
  check(j && j.blocks.every((b) => !("rawPreview" in b)), "summary drops `rawPreview` from blocks");
  check(j && j.blocks.some((b) => b.issues.includes("faq-question-in-answer")), "summary preserves issues array");
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
