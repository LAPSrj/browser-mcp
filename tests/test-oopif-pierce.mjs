#!/usr/bin/env node
/**
 * Smoke for the `>>>` frame-pierce selector syntax.
 *
 *  - Unit tests on resolveLocator() parsing (no browser).
 *  - Integration:
 *      portA serves a parent page that embeds an iframe sourced from portB
 *      (cross-origin → OOPIF in Chromium). Drive interactions inside the
 *      child via `#childFrame >>> #sendButton` and verify the React-style
 *      handler fires (data-clicked + click counter).
 *
 * Exit code 0 on all-pass, 1 otherwise. Skips the integration leg if the
 * dist build is missing (run `npm run build` first).
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[t]", ...a);
const pass = (m) => log("PASS —", m);
const fail = (m) => { console.error("[t] FAIL —", m); process.exitCode = 1; };

let passed = 0;
let failed = 0;
function check(cond, m) {
  if (cond) { pass(m); passed++; }
  else { fail(m); failed++; }
}

// ---------------------------------------------------------------------------
// 1. Unit tests for resolveLocator parsing
// ---------------------------------------------------------------------------
log("\n=== Unit: locator parser ===");
const { hasFramePierce, splitFramePierce } = await import("../dist/utils/locator.js");

check(hasFramePierce("a >>> b") === true, "hasFramePierce: 'a >>> b' is true");
check(hasFramePierce("#foo") === false, "hasFramePierce: '#foo' is false");
check(hasFramePierce("a>>>b") === false, "hasFramePierce: 'a>>>b' (no whitespace) is false — protects CSS values");
check(hasFramePierce("a >> b") === false, "hasFramePierce: '>>' (Playwright intra-frame) is NOT split");
check(hasFramePierce("iframe[src*='octadesk'] >>> #sendButton") === true, "hasFramePierce: real Octadesk-like selector");

const single = splitFramePierce("iframe.outer >>> #btn");
check(single.length === 2 && single[0] === "iframe.outer" && single[1] === "#btn", "splitFramePierce: 2-segment split");

const nested = splitFramePierce("iframe.a >>> iframe.b >>> #btn");
check(nested.length === 3 && nested[1] === "iframe.b", "splitFramePierce: 3-segment split (nested frames)");

const bare = splitFramePierce("#foo");
check(bare.length === 1 && bare[0] === "#foo", "splitFramePierce: bare selector unchanged");

// ---------------------------------------------------------------------------
// 2. Integration: cross-origin OOPIF
// ---------------------------------------------------------------------------
log("\n=== Integration: OOPIF (cross-origin iframe) ===");

let sessionMgr;
try {
  sessionMgr = (await import("../dist/core/sessions.js")).sessionManager;
} catch (e) {
  log("dist/ missing — run `npm run build` first. Skipping integration leg.");
  log(`\nResult: ${passed} passed, ${failed} failed (integration SKIPPED)`);
  process.exit(failed > 0 ? 1 : 0);
}

const PARENT_HTML = await fs.readFile(path.join(__dirname, "fixtures", "oopif-parent.html"), "utf-8");
const CHILD_HTML = await fs.readFile(path.join(__dirname, "fixtures", "oopif-child.html"), "utf-8");

const childServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(CHILD_HTML);
});
await new Promise((r) => childServer.listen(0, "127.0.0.1", r));
const childPort = childServer.address().port;
const childUrl = `http://127.0.0.1:${childPort}/`;

const parentHtmlWithChild = PARENT_HTML.replaceAll("CHILD_URL", childUrl);
const parentServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(parentHtmlWithChild);
});
await new Promise((r) => parentServer.listen(0, "127.0.0.1", r));
const parentPort = parentServer.address().port;
const parentUrl = `http://127.0.0.1:${parentPort}/`;

log(`parent ${parentUrl}  →  iframe ${childUrl}  (different ports = OOPIF)`);

const primitives = await import("../dist/core/primitives.ts.js").catch(async () =>
  await import("../dist/core/primitives.js"),
);
const { interactionPrimitives, waitPrimitives, readPrimitives } = primitives;

const session = await sessionMgr.open({ url: parentUrl });
log(`session_id=${session.session_id}`);

try {
  // Wait for the iframe element + content to be present.
  await waitPrimitives.wait_for_selector.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #sendButton",
    state: "visible",
    timeout: 5000,
  });
  pass("wait_for_selector resolves through `>>>` into OOPIF child");
  passed++;

  // Regression: non-frame selector still works.
  const r1 = await interactionPrimitives.click.handler({
    session_id: session.session_id,
    selector: "#parentBtn",
  });
  check(!r1.isError, "click on parent (non-frame selector) — no error");

  const parentClicked = await readPrimitives.get_attribute.handler({
    session_id: session.session_id,
    selector: "#parentBtn",
    attribute: "data-clicked",
  });
  const parentJson = JSON.parse(parentClicked.content[0].text);
  check(parentJson.value === "1", `parent button data-clicked='1' (got '${parentJson.value}')`);

  // Click child sendButton via `>>>`.
  const r2 = await interactionPrimitives.click.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #sendButton",
  });
  check(!r2.isError, "click `#childFrame >>> #sendButton` — no error");

  const sendClicked = await readPrimitives.get_attribute.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #sendButton",
    attribute: "data-clicked",
  });
  const sendJson = JSON.parse(sendClicked.content[0].text);
  check(sendJson.value === "1", `child sendButton data-clicked='1' inside OOPIF (got '${sendJson.value}')`);

  const count1 = await readPrimitives.get_text.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #clickCount",
  });
  check(count1.content[0].text.trim() === "1", `child clickCount = 1 after first click (got '${count1.content[0].text.trim()}')`);

  // Type into child input via `>>>`, then click send, verify lastValue reflects it.
  await interactionPrimitives.type_text.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #messageInput",
    text: "hello oopif",
  });

  await interactionPrimitives.click.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #sendButton",
  });

  const lastVal = await readPrimitives.get_text.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #lastValue",
  });
  check(lastVal.content[0].text.trim() === "hello oopif", `child lastValue reflects typed text (got '${lastVal.content[0].text.trim()}')`);

  const count2 = await readPrimitives.get_text.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #clickCount",
  });
  check(count2.content[0].text.trim() === "2", `child clickCount = 2 after second click (got '${count2.content[0].text.trim()}')`);

  // hover regression on child
  await interactionPrimitives.hover.handler({
    session_id: session.session_id,
    selector: "#childFrame >>> #sendButton",
  });
  pass("hover through `>>>` — no throw");
  passed++;

} finally {
  await sessionMgr.close(session.session_id).catch(() => {});
  parentServer.close();
  childServer.close();
}

log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
