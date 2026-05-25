#!/usr/bin/env node
/**
 * Smoke: verify session_id reuse on the dev plugin tools that just got
 * lifted, plus the MCP boolean-coercion preprocess on open_session schema.
 *
 * Run after `npx tsc`.
 */
import { z } from "zod";
import { sessionManager } from "../dist/core/sessions.js";
import { pageMetadataTool } from "../dist/plugins/dev/tools/page-metadata.js";
import { domSnapshotTool } from "../dist/plugins/dev/tools/dom-snapshot.js";
import { consoleCaptureTool } from "../dist/plugins/dev/tools/console-capture.js";
import { schemaExtractTool } from "../dist/plugins/dev/tools/schema-extract.js";
import { accessibilitySnapshotTool } from "../dist/plugins/dev/tools/accessibility.js";
import { computedStylesTool } from "../dist/plugins/dev/tools/computed-styles.js";
import { networkLogTool } from "../dist/plugins/dev/tools/network-log.js";
import { performanceMetricsTool } from "../dist/plugins/dev/tools/performance.js";

const log = (...a) => console.log("[t]", ...a);
const fail = (m) => { console.error("[t] FAIL", m); process.exit(1); };
const ok = (m) => log("PASS —", m);

// ---- Part 1: zod boolean-coercion preprocess ----
//      Reproduce the union schema used on attach_cdp, verify "true"/"false"
//      strings map to booleans (the original bug), and verify a bogus string
//      like "yes" is rejected (the regex narrowing).
log("\n=== Part 1: zod attach_cdp preprocess ===");
const attachCdpSchema = z.preprocess(
  (v) => (v === "true" ? true : v === "false" ? false : v),
  z.union([
    z.boolean(),
    z.string().regex(/^https?:\/\//i),
  ]),
);

function check(name, input, expected) {
  const r = attachCdpSchema.safeParse(input);
  if (expected === "error") {
    if (r.success) fail(`${name}: expected validation error, got ${JSON.stringify(r.data)}`);
    ok(`${name}: rejected as expected (${r.error.issues[0]?.message?.slice(0, 60)})`);
    return;
  }
  if (!r.success) fail(`${name}: validation failed — ${r.error.issues[0]?.message}`);
  if (typeof r.data !== typeof expected || r.data !== expected) {
    fail(`${name}: expected ${JSON.stringify(expected)} (${typeof expected}), got ${JSON.stringify(r.data)} (${typeof r.data})`);
  }
  ok(`${name}: coerced ${JSON.stringify(input)} → ${JSON.stringify(r.data)}`);
}

check("string 'true' → boolean true", "true", true);
check("string 'false' → boolean false", "false", false);
check("boolean true stays boolean", true, true);
check("boolean false stays boolean", false, false);
check("http URL stays string", "http://localhost:9222", "http://localhost:9222");
check("https URL stays string", "https://example.com:9222", "https://example.com:9222");
check("garbage string 'yes' rejected", "yes", "error");
check("garbage string 'localhost:9222' rejected (no scheme)", "localhost:9222", "error");

// ---- Part 2: session_id reuse on lifted dev tools ----
log("\n=== Part 2: session_id reuse on lifted dev tools ===");
log("opening a session against a data: URL (no network needed)...");
const dataUrl = "data:text/html,<!doctype html><html lang='en'><head><title>Smoke Test</title><meta name='description' content='session-id smoke'><meta property='og:title' content='OG Title'></head><body><h1 id='heading'>Hello</h1><p class='para'>World</p><script type='application/ld+json'>{\"@context\":\"https://schema.org\",\"@type\":\"WebPage\",\"name\":\"Test\"}</script></body></html>";

const session = await sessionManager.open({ url: dataUrl });
log(`session_id=${session.session_id}`);

async function runAndCheck(name, fn) {
  const r = await fn();
  if (r.isError) fail(`${name}: tool returned isError. Content: ${JSON.stringify(r.content)}`);
  ok(`${name}: returned ${r.content.length} content block(s)`);
  return r;
}

try {
  await runAndCheck("page_metadata via session_id", () =>
    pageMetadataTool({ session_id: session.session_id })
  );
  await runAndCheck("dom_snapshot via session_id", () =>
    domSnapshotTool({ session_id: session.session_id, selector: "body", maxDepth: 2 })
  );
  await runAndCheck("accessibility_snapshot via session_id", () =>
    accessibilitySnapshotTool({ session_id: session.session_id, summaryOnly: true })
  );
  await runAndCheck("computed_styles via session_id (no includeSource)", () =>
    computedStylesTool({ session_id: session.session_id, selector: "h1", filter: "all", properties: ["color", "display"] })
  );
  await runAndCheck("computed_styles via session_id WITH includeSource (CDP path)", () =>
    computedStylesTool({ session_id: session.session_id, selector: "h1", includeSource: true, properties: ["color"] })
  );
  await runAndCheck("schema_extract via session_id", () =>
    schemaExtractTool({ session_id: session.session_id, summaryOnly: true })
  );
  await runAndCheck("console_capture via session_id (empty session, no logs)", () =>
    consoleCaptureTool({ session_id: session.session_id, summaryOnly: true })
  );
  await runAndCheck("network_log via session_id (no activity)", () =>
    networkLogTool({ session_id: session.session_id, summaryOnly: true })
  );
  await runAndCheck("performance_metrics via session_id", () =>
    performanceMetricsTool({ session_id: session.session_id, summaryOnly: true })
  );

  // ---- Part 3: confirm validation rejects "no session_id, no url" ----
  log("\n=== Part 3: missing-url-and-session_id rejection ===");
  const missing = await pageMetadataTool({});
  if (!missing.isError) fail("expected page_metadata with no inputs to error");
  ok("page_metadata with no url/session_id correctly errors");

  log("\n===== ALL CHECKS PASSED =====");
} finally {
  await sessionManager.close(session.session_id);
}

process.exit(0);
