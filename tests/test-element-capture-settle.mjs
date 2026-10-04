#!/usr/bin/env node
/**
 * Element captures on a page that reveals content on scroll.
 *
 * The fixture page (served locally) has `scroll-behavior: smooth` and red
 * cards that start at opacity 0 and fade in when an IntersectionObserver
 * adds `.is-visible`, the pattern of scroll-entrance animations:
 *
 *   #row     three cards below the fold, staggered 0 / 300 / 600 ms
 *   #tall    a section 2500px tall with a card at its top and one at its
 *            bottom, each revealed by its own observer
 *   #spin    a revealed card next to an infinite spinner
 *
 *   1. A plain Playwright element screenshot catches the cards hidden (the bug).
 *   2. element_screenshot shows every card in #row.
 *   3. screenshot({session_id, selector}) shows every card in #row.
 *   4. A capture of #tall shows its bottom card, which sits below the viewport.
 *   5. Full-page captures (screenshot({full_page}), multi_screenshot fullPage)
 *      show every card and leave the page at its starting scroll position.
 *      A lazy image inside a hidden element (like the WP admin bar avatar)
 *      never loads and must not hold the wait.
 *   6. An infinite animation doesn't hold the capture until the timeout.
 *
 * Usage: node tests/test-element-capture-settle.mjs
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "..", "dist");
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);
const { elementScreenshotTool } = await load("core/element-screenshot.js");
const { screenshotTool } = await load("core/screenshot.js");
const { capturePrimitives } = await load("core/primitives.js");
const { sessionManager } = await load("core/sessions.js");
const { settleElementForCapture } = await load("utils/settle-element.js");

let passed = 0;
let failed = 0;
function assert(cond, name, detail) {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const HTML = `<!doctype html><html><head><style>
  html { scroll-behavior: smooth; }
  body { margin: 0; background: #fff; }
  .spacer { height: 1500px; }
  .row { display: flex; width: 600px; height: 100px; }
  .card { width: 200px; height: 100px; background: rgb(220, 20, 20); }
  .reveal { opacity: 0; translate: 0 24px; transition: opacity 600ms ease-out, translate 600ms ease-out; }
  .reveal.is-visible { opacity: 1; translate: none; }
  #tall { position: relative; width: 600px; height: 2500px; }
  #tall .card { position: absolute; left: 0; }
  #spin { display: flex; width: 600px; height: 100px; }
  .spinner { width: 100px; height: 100px; animation: turn 1s linear infinite; background: rgb(20, 20, 220); }
  @keyframes turn { to { rotate: 360deg; } }
</style></head><body>
  <div style="display: none"><img loading="lazy" width="64" height="64" src="/never.png" alt=""></div>
  <div class="spacer"></div>
  <div id="row" class="row">
    <div class="card reveal"></div>
    <div class="card reveal" style="transition-delay: 300ms"></div>
    <div class="card reveal" style="transition-delay: 600ms"></div>
  </div>
  <div class="spacer"></div>
  <section id="tall">
    <div class="card reveal" style="top: 0"></div>
    <div class="card reveal" style="top: 2300px"></div>
  </section>
  <div class="spacer"></div>
  <div id="spin"><div class="card reveal"></div><div class="spinner"></div></div>
  <div class="spacer"></div>
  <script>
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
      }
    }, { threshold: 0.15 });
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  // Never answers, so the hidden lazy image would stay incomplete for good.
  if (req.url === "/never.png") return;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const isRed = (png, x, y) => {
  const i = (y * png.width + x) * 4;
  return png.data[i] > 200 && png.data[i + 1] < 60 && png.data[i + 2] < 60;
};
const rowCardsRed = (png) => [100, 300, 500].map((x) => isRed(png, x, 50));

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-settle-"));
try {
  console.log("\n1. Plain element screenshot (no wait)");
  {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(url);
    const png = PNG.sync.read(await page.locator("#row").screenshot({ type: "png" }));
    const red = rowCardsRed(png);
    assert(red.some((r) => !r), "a capture without the wait misses cards (the bug)", JSON.stringify(red));
    await browser.close();
  }

  console.log("\n2. element_screenshot");
  {
    const res = await elementScreenshotTool({ url, selector: "#row", outputDir: outDir });
    const img = res.content.find((c) => c.type === "image");
    const png = PNG.sync.read(Buffer.from(img.data, "base64"));
    assert(rowCardsRed(png).every(Boolean), "every card in the row is fully shown", JSON.stringify(rowCardsRed(png)));
    assert(!res.content.some((c) => c.type === "text" && /mid-animation/.test(c.text)), "no unsettled warning");
  }

  console.log("\n3. screenshot({session_id, selector})");
  {
    const session = await sessionManager.open({ browser: "chromium", viewport: { width: 1280, height: 720 }, url });
    try {
      const res = await capturePrimitives.screenshot.handler({
        session_id: session.session_id,
        selector: "#row",
        output_dir: outDir,
      });
      const out = JSON.parse(res.content[0].text);
      const png = PNG.sync.read(await fs.readFile(out.path));
      assert(rowCardsRed(png).every(Boolean), "every card in the row is fully shown", JSON.stringify(rowCardsRed(png)));
      assert(!out.warning, "no unsettled warning", out.warning);

      const tall = JSON.parse((await capturePrimitives.screenshot.handler({
        session_id: session.session_id,
        selector: "#tall",
        output_dir: outDir,
      })).content[0].text);
      const tallPng = PNG.sync.read(await fs.readFile(tall.path));
      console.log("\n4. Element taller than the viewport");
      assert(tallPng.height === 2500, "the capture covers the whole section", `height ${tallPng.height}`);
      assert(isRed(tallPng, 100, 50), "the top card is shown");
      assert(isRed(tallPng, 100, 2350), "the bottom card, below the viewport, is shown");
    } finally {
      await sessionManager.close(session.session_id);
    }
  }

  // Page y of each card's centre, for the full-page checks.
  const cardCentres = async (page) => page.evaluate(() =>
    Array.from(document.querySelectorAll(".card")).map((c) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + scrollY + r.height / 2) };
    }));

  console.log("\n5. Full-page captures");
  {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(url);
    const centres = await cardCentres(page);
    const plain = PNG.sync.read(await page.screenshot({ type: "png", fullPage: true }));
    const plainRed = centres.filter((c) => isRed(plain, c.x, c.y)).length;
    assert(plainRed === 0, "a full-page capture without the wait shows no cards (the bug)", `${plainRed}/${centres.length}`);
    await browser.close();

    const session = await sessionManager.open({ browser: "chromium", viewport: { width: 1280, height: 720 }, url });
    try {
      const out = JSON.parse((await capturePrimitives.screenshot.handler({
        session_id: session.session_id,
        full_page: true,
        output_dir: outDir,
      })).content[0].text);
      const png = PNG.sync.read(await fs.readFile(out.path));
      const red = centres.filter((c) => isRed(png, c.x, c.y)).length;
      assert(red === centres.length, "screenshot({full_page}) shows every card", `${red}/${centres.length}`);
      assert(!out.warning, "no unsettled warning", out.warning);
      const scrollY = await sessionManager.getPage(session.session_id).evaluate(() => scrollY);
      assert(scrollY === 0, "the page is back at its starting scroll position", `scrollY ${scrollY}`);
    } finally {
      await sessionManager.close(session.session_id);
    }

    const res = await screenshotTool({ url, fullPage: true, outputDir: outDir });
    const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const saved = text.match(/\S+screenshot_chromium_\S+?\.png/)?.[0];
    assert(!!saved, "multi_screenshot saved a file", text.slice(0, 200));
    if (saved) {
      const png = PNG.sync.read(await fs.readFile(saved));
      const red = centres.filter((c) => isRed(png, c.x, c.y)).length;
      assert(red === centres.length, "multi_screenshot fullPage shows every card", `${red}/${centres.length}`);
    }
    assert(!/mid-animation/.test(text), "no unsettled warning");
  }

  console.log("\n6. Infinite animation next to a reveal");
  {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(url);
    const loc = page.locator("#spin");
    const r = await settleElementForCapture(loc, { timeoutMs: 4000 });
    assert(r.settled, "the wait reports settled");
    assert(r.waitedMs < 2000, "the spinner didn't hold the wait", `${r.waitedMs} ms`);
    const png = PNG.sync.read(await loc.screenshot({ type: "png" }));
    assert(isRed(png, 100, 50), "the revealed card is shown");
    await browser.close();
  }
} finally {
  server.closeAllConnections();
  server.close();
  await fs.rm(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
