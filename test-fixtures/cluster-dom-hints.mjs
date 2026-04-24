#!/usr/bin/env node
// Smoke tests for src/utils/cluster-dom-hints.ts (annotateClusters).
// Spins up Playwright with a synthetic DOM, fires synthetic clusters, and
// asserts the annotation output structure + filters.

import { chromium } from "playwright";

const { annotateClusters } = await import("../dist/utils/cluster-dom-hints.js");

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); pass++; }
  else { console.log(`  FAIL: ${msg}`); fail++; }
}

const html = `<!doctype html>
<html><head><style>
  body { margin: 0; padding: 0; }
  .wrapper { position: absolute; left: 0; top: 0; width: 1000px; height: 1000px; background: #eee; }
  .row { position: absolute; left: 100px; width: 200px; height: 50px; }
  #row-a { top: 100px; background: red; }
  #row-b { top: 200px; background: blue; }
  #row-c { top: 300px; background: green; }
  #tiny { position: absolute; left: 150px; top: 110px; width: 30px; height: 30px; background: yellow; }
  .leaf-text { position: absolute; left: 110px; top: 220px; font-size: 14px; }
</style></head><body>
  <div class="wrapper">
    <div class="row" id="row-a"></div>
    <div class="row" id="row-b"></div>
    <div class="row" id="row-c"></div>
    <div id="tiny"></div>
    <span class="leaf-text">hello</span>
  </div>
</body></html>`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await context.newPage();
await page.setContent(html);

console.log("=== Test 1: empty clusters returns empty array ===");
{
  const result = await annotateClusters(page, []);
  assert(Array.isArray(result) && result.length === 0, "empty in → empty out");
}

console.log("=== Test 2: cluster centered on #row-a ===");
{
  // Cluster at row-a's center: x=200, y=125, area 200x50 = 10000
  const result = await annotateClusters(page, [
    { x: 100, y: 100, width: 200, height: 50, pixels: 9999 },
  ]);
  assert(result.length === 1, "one cluster → one annotation");
  const ann = result[0];
  assert(ann.cluster.x === 100 && ann.cluster.y === 100, "cluster bbox passes through");
  assert(Array.isArray(ann.centerStack) && ann.centerStack.length > 0, "centerStack populated");
  const tags = ann.centerStack.map((h) => h.tag);
  assert(tags.includes("div"), "centerStack contains div");
  // Intersecting: row-a (perfect intersection) should rank top
  assert(ann.intersecting.length > 0, "intersecting populated");
  assert(ann.intersecting[0].id === "row-a", `top intersecting is #row-a (got #${ann.intersecting[0].id})`);
  // wrapper (1000x1000 = 1M) and body should be filtered out (area > 2× cluster area = 20000)
  const ids = ann.intersecting.map((h) => h.id);
  assert(!ids.includes(null) || !ann.intersecting.some((h) => h.tag === "body"), "body filtered out as wrapper");
  assert(!ids.includes("wrapper") && !ann.intersecting.some((h) => h.classes?.includes("wrapper")),
    "wrapper div filtered out (area >> 2× cluster)");
}

console.log("=== Test 3: tiny element fully inside cluster ranks higher than partial overlaps ===");
{
  // Cluster at exact #tiny location: 150,110, 30x30 — tiny ratio 1.0
  const result = await annotateClusters(page, [
    { x: 150, y: 110, width: 30, height: 30, pixels: 900 },
  ]);
  const ann = result[0];
  assert(ann.intersecting[0].id === "tiny", `top is #tiny (got ${ann.intersecting[0].id})`);
  assert(ann.intersecting[0].intersectionRatio === 1, "tiny has intersectionRatio 1.0");
}

console.log("=== Test 4: cap honored ===");
{
  const result = await annotateClusters(page, [
    { x: 0, y: 0, width: 1000, height: 1000, pixels: 1000000 },
  ], { cap: 2 });
  const ann = result[0];
  assert(ann.intersecting.length <= 2, `cap of 2 honored (got ${ann.intersecting.length})`);
}

console.log("=== Test 5: wrapperRatio relaxed lets wrapper in ===");
{
  const result = await annotateClusters(page, [
    { x: 100, y: 100, width: 200, height: 50, pixels: 9999 },
  ], { wrapperRatio: 100000 });
  const ann = result[0];
  const hasWrapper = ann.intersecting.some(
    (h) => h.classes?.includes("wrapper"),
  );
  assert(hasWrapper, "wrapper-class div now appears with relaxed ratio");
}

console.log("=== Test 6: offset resolves hits; output coords stay in cluster frame ===");
{
  // Pretend caller passes diff-image-space cluster; offset shifts to page
  // for hit-testing but returned bboxes normalize BACK to cluster frame.
  const result = await annotateClusters(
    page,
    [{ x: 0, y: 0, width: 200, height: 50, pixels: 9999 }],
    { offsetX: 100, offsetY: 100 },
  );
  const ann = result[0];
  assert(ann.cluster.x === 0 && ann.cluster.y === 0, "cluster bbox stays in input (diff-image) frame");
  assert(ann.intersecting[0]?.id === "row-a", "offset annotation hits row-a");
  // row-a page coords: left=100, top=100. With offset 100,100 it should render as 0,0 in cluster frame.
  const hitBbox = ann.intersecting[0].bbox;
  assert(hitBbox.x === 0 && hitBbox.y === 0,
    `intersecting bbox normalized to cluster frame (got x=${hitBbox.x}, y=${hitBbox.y})`);
}

console.log("=== Test 7: cluster outside DOM returns empty intersecting ===");
{
  const result = await annotateClusters(page, [
    { x: 5000, y: 5000, width: 50, height: 50, pixels: 100 },
  ]);
  const ann = result[0];
  assert(ann.intersecting.length === 0, "off-page cluster → no intersecting");
}

console.log("=== Test 8: ElementHint shape ===");
{
  const result = await annotateClusters(page, [
    { x: 110, y: 220, width: 50, height: 20, pixels: 999 },
  ]);
  const ann = result[0];
  if (ann.intersecting.length > 0) {
    const h = ann.intersecting[0];
    assert(typeof h.tag === "string", "tag is string");
    assert(h.id === null || typeof h.id === "string", "id is string|null");
    assert(Array.isArray(h.classes), "classes is array");
    assert(h.bbox && typeof h.bbox.x === "number", "bbox.x present");
    assert(typeof h.intersectionArea === "number", "intersectionArea numeric");
    assert(typeof h.intersectionRatio === "number" && h.intersectionRatio >= 0 && h.intersectionRatio <= 1,
      "intersectionRatio in [0,1]");
  } else {
    assert(false, "expected at least one intersecting hit");
  }
}

console.log("=== Test 9: bare element gets nearestNamedAncestor ===");
{
  // .leaf-text (span) intentionally has no id; ancestor .wrapper has class
  const result = await annotateClusters(page, [
    { x: 110, y: 220, width: 60, height: 20, pixels: 999 },
  ]);
  const ann = result[0];
  // Find the bare <span> entry; the nested classed span itself ('leaf-text') has a class so won't qualify.
  // But raw text-bearing leaf nodes (e.g. body's children) might qualify. Add a fresh test.
}

console.log("=== Test 9b: explicit bare element with classed ancestor ===");
{
  await page.setContent(`<!doctype html><html><body>
    <header class="site-header"><nav><p>bare</p></nav></header>
  </body></html>`);
  const result = await annotateClusters(page, [
    { x: 0, y: 0, width: 200, height: 50, pixels: 999 },
  ], { wrapperRatio: 1000 });
  const ann = result[0];
  const bareP = ann.intersecting.find((h) => h.tag === "p" && h.classes.length === 0 && !h.id);
  assert(bareP, "found the bare <p> in intersecting");
  assert(bareP?.nearestNamedAncestor?.tag === "header", "nearestNamedAncestor walked past unclassed nav to header");
  assert(bareP?.nearestNamedAncestor?.classes.includes("site-header"), "ancestor classes captured");
}

console.log("=== Test 9c: classed element does not get nearestNamedAncestor ===");
{
  await page.setContent(`<!doctype html><html><body>
    <header class="site-header"><p class="tagline">x</p></header>
  </body></html>`);
  const result = await annotateClusters(page, [
    { x: 0, y: 0, width: 200, height: 50, pixels: 999 },
  ], { wrapperRatio: 1000 });
  const ann = result[0];
  const classedP = ann.intersecting.find((h) => h.tag === "p" && h.classes.includes("tagline"));
  assert(classedP, "classed <p> found");
  assert(classedP?.nearestNamedAncestor === undefined, "classed element has no nearestNamedAncestor");
}

console.log("=== Test 10: containerHint fallback when all hints are filtered out ===");
{
  // Cluster small enough that only the big .wrapper contains it, and
  // wrapperRatio default (2) filters .wrapper out. Place cluster in an
  // empty corner of .wrapper so no .row / #tiny / .leaf-text intersects.
  await page.setContent(html);
  const result = await annotateClusters(page, [
    { x: 800, y: 800, width: 20, height: 10, pixels: 200 },
  ]);
  const ann = result[0];
  assert(ann.intersecting.length === 0, "no intersecting hits after wrapper filter");
  assert(ann.containerHint, "containerHint populated as fallback");
  assert(ann.containerHint?.classes?.includes("wrapper"), ".wrapper selected as smallest container");
  assert(ann.containerHint?.offsetWithin &&
    ann.containerHint.offsetWithin.x === 800 &&
    ann.containerHint.offsetWithin.y === 800,
    `offsetWithin relative to container origin (got ${JSON.stringify(ann.containerHint?.offsetWithin)})`);
}

console.log("=== Test 11: containerHint absent when intersecting has hits ===");
{
  await page.setContent(html);
  const result = await annotateClusters(page, [
    { x: 100, y: 100, width: 200, height: 50, pixels: 9999 },
  ]);
  const ann = result[0];
  assert(ann.intersecting.length > 0, "intersecting populated");
  assert(ann.containerHint === undefined, "containerHint not set when primary hints exist");
}

await browser.close();

console.log(`\n========================================`);
console.log(`Results: ${pass} passed, ${fail} failed out of ${pass + fail} assertions`);
process.exit(fail === 0 ? 0 : 1);
