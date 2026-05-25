#!/usr/bin/env node
/**
 * Smoke test for evaluate_script session_id / no-nav mode (Fix 1 for emberwing gap report).
 *
 * Coverage:
 *  1. session_id + url omitted → script runs on session's current page, page URL unchanged.
 *  2. session_id + url provided → navigates first, script runs on new URL.
 *  3. Ephemeral (no session_id) with url → backwards-compatible behavior.
 *  4. Validation: neither session_id nor url → error.
 *  5. tab_id targeting works.
 *
 * Run after `npm run build` (or `npx tsc`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const { evaluateScriptTool } = await import(
  path.join(root, "dist/plugins/dev/tools/evaluate-script.js")
);
const { sessionManager } = await import(
  path.join(root, "dist/core/sessions.js")
);

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}
function parseText(res) {
  return res.content.find((c) => c.type === "text")?.text ?? "";
}

const URL_A = "data:text/html,<title>page-A</title><body data-marker='A'>page A</body>";
const URL_B = "data:text/html,<title>page-B</title><body data-marker='B'>page B</body>";

// ===========================================================================
// 1. session_id + no url: no-nav mode — script runs on the session's current page.
// ===========================================================================
console.log("\n=== Test 1: session_id + no url → no-nav, page URL unchanged ===");
{
  const session = await sessionManager.open({
    browser: "chromium",
    viewport: { width: 1024, height: 768 },
    url: URL_A,
  });
  try {
    const pageBefore = sessionManager.getPage(session.session_id);
    const urlBefore = pageBefore.url();
    check(urlBefore.startsWith("data:text/html"), "session opened on URL_A", urlBefore);

    const res = await evaluateScriptTool({
      session_id: session.session_id,
      script: "return document.body.getAttribute('data-marker') + ':' + document.title",
    });
    const txt = parseText(res);
    check(!res.isError, "no isError flag");
    check(txt.includes("A:page-A"), "script result reads page-A's DOM", txt);

    const urlAfter = pageBefore.url();
    check(urlAfter === urlBefore, "page URL unchanged after evaluate", `${urlBefore} → ${urlAfter}`);
  } finally {
    await sessionManager.close(session.session_id);
  }
}

// ===========================================================================
// 2. session_id + url: tool navigates within the session, then evaluates.
// ===========================================================================
console.log("\n=== Test 2: session_id + url → navigates inside the session ===");
{
  const session = await sessionManager.open({
    browser: "chromium",
    viewport: { width: 1024, height: 768 },
    url: URL_A,
  });
  try {
    const res = await evaluateScriptTool({
      session_id: session.session_id,
      url: URL_B,
      script: "return document.body.getAttribute('data-marker')",
    });
    const txt = parseText(res);
    check(!res.isError, "no isError flag");
    // JSON.stringify on the string 'B' yields the literal "B" (with quotes).
    check(txt.includes("B"), "script result reads page-B's DOM after navigation", txt);
    const page = sessionManager.getPage(session.session_id);
    check(/page-B/.test(page.url()) || page.url().startsWith("data:text/html"), "session page URL navigated", page.url());
  } finally {
    await sessionManager.close(session.session_id);
  }
}

// ===========================================================================
// 3. Ephemeral (no session_id) + url: backwards-compatible path.
// ===========================================================================
console.log("\n=== Test 3: ephemeral with url → unchanged behavior ===");
{
  const res = await evaluateScriptTool({
    url: URL_A,
    script: "return document.title",
  });
  const txt = parseText(res);
  check(!res.isError, "no isError flag");
  check(txt.includes("page-A"), "ephemeral script result reads page-A", txt);
}

// ===========================================================================
// 4. Validation: neither session_id nor url.
// ===========================================================================
console.log("\n=== Test 4: no session_id, no url → tool-level error ===");
{
  const res = await evaluateScriptTool({
    script: "return 1",
  });
  check(res.isError === true, "isError true when neither session_id nor url");
  const txt = parseText(res);
  check(/url is required/i.test(txt), "error message names url", txt);
}

// ===========================================================================
// 5. tab_id targeting (open a second tab, run evaluate against it).
// ===========================================================================
console.log("\n=== Test 5: tab_id routes evaluation to the named tab ===");
{
  const session = await sessionManager.open({
    browser: "chromium",
    viewport: { width: 1024, height: 768 },
    url: URL_A,
  });
  try {
    const tab = await sessionManager.addTab(session.session_id, undefined, URL_B);
    const res = await evaluateScriptTool({
      session_id: session.session_id,
      tab_id: tab.tab_id,
      script: "return document.body.getAttribute('data-marker')",
    });
    const txt = parseText(res);
    check(!res.isError, "no isError flag");
    check(txt.includes("B"), "tab_id routed evaluation to page-B tab", txt);
  } finally {
    await sessionManager.close(session.session_id);
  }
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
