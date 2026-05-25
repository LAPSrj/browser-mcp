#!/usr/bin/env node
/**
 * Smoke test for axe_audit tool (option 1 from emberwing's accessibility gap report).
 *
 * Coverage:
 *  1. Ephemeral path — audit a fixture with known violations, confirm structure.
 *  2. Session-aware path — open_session, navigate, audit without re-navigating.
 *  3. Rule targeting — request specific rule IDs, confirm scope.
 *  4. include/exclude scoping.
 *  5. summaryOnly response shape.
 *  6. Validation — neither session_id nor url errors out.
 *
 * Run after `npm run build` (or `npx tsc`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const { axeAuditTool } = await import(
  path.join(root, "dist/plugins/dev/tools/axe-audit.js")
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
function parseJson(res) {
  const txt = res.content.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(txt);
  } catch {
    return { _raw: txt };
  }
}

const FIXTURE = "data:text/html," + encodeURIComponent(`
  <!doctype html>
  <html lang="en">
  <head><title>axe-audit smoke fixture</title></head>
  <body>
    <main>
      <h1>Test page</h1>
      <img src="https://example.com/x.png" id="noalt-img">
      <button id="noname-btn"></button>
      <input id="nolabel-input" type="text">
      <a href="#" id="empty-link"></a>
      <div id="scoped-region">
        <img src="https://example.com/y.png" alt="ok image">
        <button>ok button</button>
      </div>
    </main>
  </body>
  </html>
`);

// ===========================================================================
// 1. Ephemeral audit — known violations show up.
// ===========================================================================
console.log("\n=== Test 1: ephemeral audit catches known violations ===");
{
  const res = await axeAuditTool({ url: FIXTURE });
  check(!res.isError, "no isError flag");
  const body = parseJson(res);
  check(typeof body.summary === "object", "summary object present");
  check(Array.isArray(body.violations), "violations array present");
  check(body.summary.counts.violations >= 3, "at least 3 violations (img-alt, button-name, label)", `got ${body.summary.counts.violations}`);
  const ids = (body.violations ?? []).map((v) => v.id);
  check(ids.includes("image-alt"), "image-alt violation present", `got ids: ${ids.join(",")}`);
  check(ids.includes("button-name"), "button-name violation present", `got ids: ${ids.join(",")}`);
  check(ids.includes("label"), "label violation present", `got ids: ${ids.join(",")}`);
  for (const v of body.violations ?? []) {
    if (Array.isArray(v.nodes) && v.nodes.length > 0) {
      check(Array.isArray(v.nodes[0].target), `${v.id}.nodes[0].target is selector array`);
      break;
    }
  }
}

// ===========================================================================
// 2. Session-aware audit — open_session, audit reuses page without re-nav.
// ===========================================================================
console.log("\n=== Test 2: session_id + no url → audit session's current page ===");
{
  const session = await sessionManager.open({
    browser: "chromium",
    viewport: { width: 1024, height: 768 },
    url: FIXTURE,
  });
  try {
    const pageBefore = sessionManager.getPage(session.session_id);
    const urlBefore = pageBefore.url();
    const res = await axeAuditTool({ session_id: session.session_id });
    check(!res.isError, "no isError flag");
    const body = parseJson(res);
    check(body.summary.counts.violations >= 3, "session audit catches the violations", `got ${body.summary?.counts?.violations}`);
    const urlAfter = pageBefore.url();
    check(urlAfter === urlBefore, "page URL unchanged after audit (no re-nav)", `${urlBefore} → ${urlAfter}`);
  } finally {
    await sessionManager.close(session.session_id);
  }
}

// ===========================================================================
// 3. Rule targeting — only run a specific rule.
// ===========================================================================
console.log("\n=== Test 3: rules: [\"image-alt\"] runs only that rule ===");
{
  const res = await axeAuditTool({ url: FIXTURE, rules: ["image-alt"] });
  const body = parseJson(res);
  const ids = (body.violations ?? []).map((v) => v.id);
  check(ids.length >= 1 && ids.every((id) => id === "image-alt"), "only image-alt in violations", `got ids: ${ids.join(",")}`);
}

// ===========================================================================
// 4. exclude scoping — exclude #scoped-region; results should still include violations from outside it.
// ===========================================================================
console.log("\n=== Test 4: exclude scoping ===");
{
  const res = await axeAuditTool({ url: FIXTURE, exclude: ["#scoped-region"] });
  const body = parseJson(res);
  check(body.summary.counts.violations >= 3, "still finds main-tree violations", `got ${body.summary.counts.violations}`);
}

// ===========================================================================
// 5. summaryOnly — no per-violation detail.
// ===========================================================================
console.log("\n=== Test 5: summaryOnly returns counts only ===");
{
  const res = await axeAuditTool({ url: FIXTURE, summaryOnly: true });
  const body = parseJson(res);
  check(typeof body.counts === "object", "summary returned at top level");
  check(body.violations === undefined, "no violations array when summaryOnly");
}

// ===========================================================================
// 6. Validation — neither session_id nor url.
// ===========================================================================
console.log("\n=== Test 6: validation — no session_id and no url ===");
{
  const res = await axeAuditTool({});
  check(res.isError === true, "isError set");
  const txt = res.content.find((c) => c.type === "text")?.text ?? "";
  check(txt.toLowerCase().includes("url"), "error message mentions url", txt);
}

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
