#!/usr/bin/env node
/**
 * Fixture tests for waitForBlockToSettle, the wait block_html runs before it
 * reads a block's editor markup. No WordPress needed: a routed page fakes the
 * editor DOM and a minimal wp.data store.
 *
 *   1. FilteredServerSideRender: the block's markup arrives after the hidden
 *      [data-not-ready="true"] node clears; the wait returns only after that.
 *   2. An in-flight /wp/v2/block-renderer/ request holds the wait.
 *   3. Template-locked post content: an is-editing-disabled wrapper whose
 *      store mode is "default" holds the wait past the quiet window until the
 *      re-render drops the marker. A block the store really disables settles.
 *   4. The post-content locator (name + same-name index) reads the right block.
 *   5. Timeout names the condition that never cleared.
 *
 * Usage: node tests/test-wp-gutenberg-block-settle.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const { waitForBlockToSettle, trackBlockRendererRequests } = await import(
  pathToFileURL(path.join(root, "dist/plugins/wp-gutenberg/utils/editor.js")).href
);

let passed = 0;
let failed = 0;
function assert(cond, name, detail) {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const ORIGIN = "http://fixture.test";

// Fake wp.data store: every data-block id exists; editing modes come from
// window.__modes (default "default").
const STORE = `
  window.__modes = {};
  window.wp = { data: { select: (s) => s === "core/block-editor" ? {
    getBlock: (cid) => ({ clientId: cid }),
    getBlockEditingMode: (cid) => window.__modes[cid] ?? "default",
  } : null } };
`;

async function openFixture(browser, body, script, routes = {}) {
  const page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    for (const [frag, handler] of Object.entries(routes)) {
      if (url.includes(frag)) return handler(route);
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>${body}<script>${STORE}${script}</script></body></html>`,
    });
  });
  const tracker = trackBlockRendererRequests(page);
  await page.goto(`${ORIGIN}/`);
  return { page, tracker };
}

const readBlock = (page, cid) =>
  page.evaluate((id) => document.querySelector(`[data-block="${id}"]`)?.outerHTML ?? null, cid);

const browser = await chromium.launch();
try {
  console.log("\n1. FilteredServerSideRender markup arrives late");
  {
    const { page, tracker } = await openFixture(
      browser,
      `<div data-block="b1" data-type="takt/posts-carousel"><div class="heading">H</div></div>
       <div id="filtered-server-side-render-root"><div data-not-ready="true"></div></div>`,
      `setTimeout(() => {
         document.querySelector('[data-block="b1"]').insertAdjacentHTML("beforeend", '<div class="swiper-parent">slides</div>');
         document.querySelector('[data-not-ready]').remove();
       }, 1000);`,
    );
    const early = await readBlock(page, "b1");
    assert(!early.includes("swiper-parent"), "a read at editor-ready misses the server markup (the bug)");
    const t0 = Date.now();
    await waitForBlockToSettle(page, { clientId: "b1" }, tracker);
    const waited = Date.now() - t0;
    const html = await readBlock(page, "b1");
    assert(html.includes("swiper-parent"), "after the wait the read includes the server markup");
    assert(waited >= 1000, "the wait lasted until the hidden node cleared", `${waited} ms`);
    tracker.dispose();
    await page.close();
  }

  console.log("\n2. In-flight /wp/v2/block-renderer/ request");
  {
    const { page, tracker } = await openFixture(
      browser,
      `<div data-block="b1" data-type="takt/x">static</div>`,
      `fetch("/wp-json/wp/v2/block-renderer/takt/x?context=edit");`,
      {
        "/wp/v2/block-renderer/": async (route) => {
          await new Promise((r) => setTimeout(r, 1200));
          await route.fulfill({ contentType: "application/json", body: '{"rendered":""}' });
        },
      },
    );
    const t0 = Date.now();
    await waitForBlockToSettle(page, { clientId: "b1" }, tracker);
    const waited = Date.now() - t0;
    assert(waited >= 1000, "the wait held until the renderer request finished", `${waited} ms`);
    assert(tracker.inFlight() === 0, "no renderer request in flight after the wait");
    tracker.dispose();
    await page.close();
  }

  console.log("\n3. Stale is-editing-disabled markup (template-locked post content)");
  {
    const { page, tracker } = await openFixture(
      browser,
      `<div data-type="core/post-content">
         <section data-block="st" data-type="takt/scrolling-text" class="is-editing-disabled" inert="true" tabindex="-1">
           <ul><li data-block="li1" class="is-editing-disabled" inert="true">one</li></ul>
         </section>
       </div>`,
      // The store already says "default"; the DOM catches up 700 ms later,
      // past the 400 ms quiet window.
      `setTimeout(() => {
         for (const el of document.querySelectorAll(".is-editing-disabled")) {
           el.classList.remove("is-editing-disabled");
           el.removeAttribute("inert");
           el.removeAttribute("tabindex");
         }
       }, 700);`,
    );
    await waitForBlockToSettle(page, { name: "takt/scrolling-text", sameNameIndex: 0, anchor: null }, tracker);
    const html = await readBlock(page, "st");
    assert(!html.includes("is-editing-disabled"), "the read has no disabled markers", html.slice(0, 120));
    assert(!html.includes("inert"), "the read has no inert attribute");
    tracker.dispose();
    await page.close();
  }
  {
    const { page, tracker } = await openFixture(
      browser,
      `<div data-block="tp" data-type="core/template-part" class="is-editing-disabled">header</div>`,
      `window.__modes.tp = "disabled";`,
    );
    const t0 = Date.now();
    await waitForBlockToSettle(page, { clientId: "tp" }, tracker, { timeoutMs: 3000 });
    assert(Date.now() - t0 < 2000, "a block the store really disables settles without waiting for the marker to go");
    tracker.dispose();
    await page.close();
  }

  console.log("\n4. Post-content locator picks the same-name index");
  {
    const { page, tracker } = await openFixture(
      browser,
      `<div data-type="core/post-content">
         <div data-block="a" data-type="takt/x">first</div>
         <div data-block="b" data-type="takt/x"><span class="late-target"></span></div>
       </div>
       <div id="filtered-server-side-render-root"></div>`,
      // Block index 1 changes every 150 ms until 900 ms; block 0 never
      // changes, so a wait on the wrong block would return at ~400 ms.
      `let n = 0;
       const timer = setInterval(() => {
         n++;
         document.querySelector('[data-block="b"] .late-target').textContent = n < 6 ? "step " + n : "second, rendered";
         if (n >= 6) clearInterval(timer);
       }, 150);`,
    );
    const t0 = Date.now();
    await waitForBlockToSettle(page, { name: "takt/x", sameNameIndex: 1, anchor: null }, tracker);
    const waited = Date.now() - t0;
    const html = await readBlock(page, "b");
    assert(html.includes("second, rendered"), "the read has block index 1's final markup", html);
    assert(waited >= 1200, "the wait watched block index 1 until its DOM was quiet", `${waited} ms`);
    tracker.dispose();
    await page.close();
  }

  console.log("\n5. Timeout reports which wait failed");
  {
    const { page, tracker } = await openFixture(
      browser,
      `<div data-block="b1" data-type="takt/x">x</div>
       <div id="filtered-server-side-render-root"><div data-not-ready="true"></div></div>`,
      ``,
    );
    let message = "";
    try {
      await waitForBlockToSettle(page, { clientId: "b1" }, tracker, { timeoutMs: 800 });
    } catch (e) {
      message = e.message;
    }
    assert(message.startsWith("Timed out after 800 ms"), "the wait throws on timeout", message);
    assert(message.includes("server-side render(s) still pending"), "the message names the pending server render");
    assert(!message.includes("block-renderer/ request"), "the message leaves out conditions that were met");

    let missing = "";
    try {
      await waitForBlockToSettle(page, { clientId: "nope" }, tracker, { timeoutMs: 300 });
    } catch (e) {
      missing = e.message;
    }
    assert(missing.includes("not in the editor canvas"), "a missing element is reported", missing);
    tracker.dispose();
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
