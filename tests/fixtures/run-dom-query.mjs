#!/usr/bin/env node
// Smoke + bench: dom_query covers field shapes, error semantics, presets,
// pseudoElement, requireVisible, session reuse. Bench compares N×ephemeral
// computed_styles vs 1×dom_query against the same selector set.
//
// Run after `npm run build`.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testHtml = `file://${path.resolve(__dirname, "design-compare-test.html")}`;

const { domQueryTool } = await import("../../dist/plugins/dev/tools/dom-query.js");
const { computedStylesTool } = await import("../../dist/plugins/dev/tools/computed-styles.js");

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

function parse(toolResult) {
  const text = toolResult.content.find((c) => c.type === "text")?.text;
  return JSON.parse(text);
}

// ===========================================================================
// 1. Field shape coverage — single ephemeral call exercises every field.
// ===========================================================================
console.log("\n=== Test 1: Field shape coverage ===");
{
  const res = parse(await domQueryTool({
    url: testHtml,
    queries: [
      {
        id: "heading",
        selector: ".heading",
        fields: ["rect", "tag", "id", "classes", "text", "role", "visible", "attributes", "computed"],
        attributes: ["class", "data-missing-attr"],
        computed: ["box", "text", "background-color"],
      },
    ],
  }));
  const r = res.results[0];
  check(r.found === true, "found");
  check(r.id === "heading", "id echoed");
  check(r.element.tag === "h1", "tag is lowercase 'h1'");
  check(r.element.id === null, "id null when absent");
  check(Array.isArray(r.element.classes) && r.element.classes.includes("heading"), "classes array");
  // innerText reflects rendered text — text-transform: uppercase on .heading
  // turns "Test Heading" into "TEST HEADING". Case-insensitive match.
  check(typeof r.element.text === "string" && /test heading/i.test(r.element.text), "text trimmed innerText");
  check(r.element.role === "heading", "role implicit for h1");
  check(r.element.visible === true, "visible true");
  check(r.element.attributes.class === "heading", "attribute class returned");
  check(r.element.attributes["data-missing-attr"] === null, "missing attr is null");
  check(r.element.computed["font-size"] === "72px", "computed font-size from text preset");
  check(r.element.computed["padding-top"] === "40px", "computed padding-top from box preset");
  check(r.element.computed["box-sizing"] === "content-box" || r.element.computed["box-sizing"] === "border-box", "computed box-sizing from box preset");
  check(r.element.computed["background-color"] === "rgb(0, 0, 0)", "computed background-color literal");
  check(typeof r.element.rect === "object" && r.element.rect.width > 0, "rect populated");
  check(res.meta.session === "ephemeral", "meta.session reports ephemeral");
}

// ===========================================================================
// 2. Multiple queries in one call — siblings independent.
// ===========================================================================
console.log("\n=== Test 2: Multiple queries, mixed match modes ===");
{
  const res = parse(await domQueryTool({
    url: testHtml,
    queries: [
      { id: "first-child", selector: ".container > div", match: "first", fields: ["tag", "classes"] },
      { id: "all-children", selector: ".container > div", match: "all", fields: ["tag", "classes"] },
      { id: "container-flex", selector: ".container", fields: ["computed"], computed: ["flex"] },
    ],
  }));
  const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
  check(byId["first-child"].found && byId["first-child"].element.classes.includes("child-a"), "first match returns child-a");
  check(byId["all-children"].found && Array.isArray(byId["all-children"].elements), "all returns array");
  check(byId["all-children"].matchedCount === 3, "matchedCount = 3");
  check(byId["all-children"].elements[2].classes.includes("overflow-child"), "all preserves order");
  check(byId["container-flex"].element.computed["display"] === "flex", "flex preset returns display:flex");
  check(byId["container-flex"].element.computed["gap"] === "24px", "flex preset returns gap:24px");
  check(byId["container-flex"].element.computed["flex-direction"] === "column", "flex preset returns flex-direction");
}

// ===========================================================================
// 3. Selector-syntax error vs no-match — distinct.
// ===========================================================================
console.log("\n=== Test 3: Error semantics ===");
{
  const res = parse(await domQueryTool({
    url: testHtml,
    queries: [
      { id: "no-match", selector: ".does-not-exist" },
      { id: "bad-syntax", selector: "div..bad..selector" },
      { id: "ok", selector: ".heading", fields: ["tag"] },
    ],
  }));
  const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
  check(byId["no-match"].found === false && !byId["no-match"].error, "no-match: found=false, no error");
  check(byId["bad-syntax"].found === false && typeof byId["bad-syntax"].error === "string", "bad-syntax: found=false WITH error string");
  check(byId["ok"].found === true, "good query in same batch still runs");
  check(res.meta.errors === 1, "meta.errors counts only the bad selector");
  check(res.meta.found === 1, "meta.found counts only matched");
}

// ===========================================================================
// 4. pseudoElement — read ::before computed styles.
// ===========================================================================
console.log("\n=== Test 4: pseudoElement ===");
{
  const res = parse(await domQueryTool({
    url: testHtml,
    queries: [
      {
        id: "before",
        selector: ".with-pseudo",
        pseudoElement: "before",
        fields: ["computed"],
        computed: ["width", "height", "background-color"],
      },
    ],
  }));
  const r = res.results[0];
  check(r.found === true, "pseudo found");
  check(r.pseudoElement === "before", "pseudoElement echoed");
  check(r.element.computed["width"] === "60px", "::before width 60px");
  check(r.element.computed["height"] === "4px", "::before height 4px");
  check(r.element.computed["background-color"] === "rgb(255, 0, 0)", "::before background-color");
  check(r.element.rect === undefined, "rect omitted under pseudoElement");
}

// ===========================================================================
// 5. requireVisible — hidden element default vs opt-in.
// ===========================================================================
console.log("\n=== Test 5: requireVisible ===");
{
  // Inject a hidden element via actions (eval before query) to avoid editing fixture.
  const res = parse(await domQueryTool({
    url: testHtml,
    actions: [
      { action: "evaluate", script: "const d = document.createElement('div'); d.id='hidden-test'; d.style.display='none'; d.textContent='hidden'; document.body.appendChild(d);" },
    ],
    queries: [
      { id: "default", selector: "#hidden-test", fields: ["tag"] },
      { id: "see-hidden", selector: "#hidden-test", fields: ["tag", "visible"], requireVisible: false },
    ],
  }));
  const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
  check(byId["default"].found === false, "default requireVisible:true filters hidden element");
  check(byId["see-hidden"].found === true, "requireVisible:false surfaces hidden element");
  check(byId["see-hidden"].element.visible === false, "explicit visible field reports false");
}

// ===========================================================================
// 6. match:"all" cap — synthetic 60-element DOM forces truncation.
// ===========================================================================
console.log("\n=== Test 6: match:'all' cap + truncated flag ===");
{
  const res = parse(await domQueryTool({
    url: testHtml,
    actions: [
      {
        action: "evaluate",
        script: "for (let i=0; i<60; i++) { const s = document.createElement('span'); s.className='cap-test'; s.textContent=`x${i}`; document.body.appendChild(s); }",
      },
    ],
    queries: [
      { id: "capped", selector: ".cap-test", match: "all", fields: ["tag"] },
    ],
  }));
  const r = res.results[0];
  check(r.found === true, "found");
  check(Array.isArray(r.elements) && r.elements.length === 50, "elements length capped at 50");
  check(r.matchedCount === 60, "matchedCount reports actual 60");
  check(r.truncated === true, "truncated flag set");
}

// ===========================================================================
// 7. session reuse — open a session, run two dom_query calls, verify reuse.
// ===========================================================================
console.log("\n=== Test 7: session reuse via session_id ===");
{
  const { sessionManager } = await import("../../dist/core/sessions.js");
  const session = await sessionManager.open({
    browser: "chromium",
    viewport: { width: 1280, height: 720 },
    url: testHtml,
  });
  try {
    const res1 = parse(await domQueryTool({
      session_id: session.session_id,
      queries: [{ id: "h", selector: ".heading", fields: ["tag", "rect"] }],
    }));
    check(res1.meta.session === "reused", "first call: meta.session reused");
    check(res1.results[0].found === true, "first call: heading found via session");

    // Second call without re-navigating — page state reused.
    const res2 = parse(await domQueryTool({
      session_id: session.session_id,
      queries: [{ id: "c", selector: ".container", fields: ["tag", "computed"], computed: ["display"] }],
    }));
    check(res2.meta.session === "reused", "second call: meta.session reused");
    check(res2.results[0].element.computed["display"] === "flex", "second call: container display:flex");
  } finally {
    await sessionManager.close(session.session_id);
  }
}

// ===========================================================================
// 8. Empirical bench — N×computed_styles vs 1×dom_query (covering same data).
// ===========================================================================
console.log("\n=== Test 8: bench — N×computed_styles vs 1×dom_query ===");
{
  const selectors = [".heading", ".eyebrow", ".container", ".child-a", ".child-b", ".overflow-child", ".animated", ".no-pseudo"];
  const props = ["font-size", "color", "padding-top", "background-color"];

  // Ephemeral: each call launches its own browser.
  const tStartCS = Date.now();
  const csResults = [];
  for (const sel of selectors) {
    const r = await computedStylesTool({
      url: testHtml,
      selector: sel,
      properties: props,
    });
    csResults.push(parse(r));
  }
  const tCS = Date.now() - tStartCS;

  // dom_query single ephemeral call covering the same set.
  const tStartDQ = Date.now();
  const dqRes = parse(await domQueryTool({
    url: testHtml,
    queries: selectors.map((sel) => ({ id: sel, selector: sel, fields: ["computed"], computed: props })),
  }));
  const tDQ = Date.now() - tStartDQ;

  console.log(`  N×computed_styles (N=${selectors.length}): ${tCS}ms`);
  console.log(`  1×dom_query (same N selectors): ${tDQ}ms`);
  console.log(`  speedup: ${(tCS / tDQ).toFixed(1)}x`);

  check(dqRes.results.length === selectors.length, "dom_query returns same count");
  check(dqRes.results.every((r) => r.found && r.element.computed["font-size"]), "dom_query covers all selectors with computed values");
  check(tDQ < tCS, `dom_query faster than N×computed_styles (${tDQ}ms vs ${tCS}ms)`);

  // Token-cost proxy: response size.
  const csChars = csResults.reduce((acc, r) => acc + JSON.stringify(r).length, 0);
  const dqChars = JSON.stringify(dqRes).length;
  console.log(`  N×computed_styles total chars: ${csChars}`);
  console.log(`  1×dom_query total chars: ${dqChars}`);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
