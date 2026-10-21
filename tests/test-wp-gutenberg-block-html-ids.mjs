#!/usr/bin/env node
/**
 * Fixture tests for how block_html gives generated ids the same value on
 * the editor and frontend sides (collectEditorBlockIds +
 * reconcileGeneratedIds). No WordPress needed: a blank page with a fake
 * wp.data store stands in for the editor.
 *
 *   1. Theme-generated root id plus a derived "-heading" id and the
 *      aria-labelledby pointing at it match the editor's block-{clientId}
 *      ids, with no knowledge of the theme's id format.
 *   2. A nested block with a theme id pairs by position too.
 *   3. A nested block with no frontend id loses its editor id.
 *   4. An anchored block: the editor id becomes the anchor, so a frontend
 *      that drops the anchor still shows a difference.
 *   5. Ids the blocks don't generate (user ids, href="#…") are untouched.
 *   6. A tag mismatch stops pairing; no frontend found drops editor ids.
 *
 * Usage: node tests/test-wp-gutenberg-block-html-ids.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const { normalizeBlockHtmlOnPage, collectEditorBlockIds, reconcileGeneratedIds } = await import(
  pathToFileURL(path.join(root, "dist/plugins/wp-gutenberg/utils/normalize-html.js")).href
);

let passed = 0;
let failed = 0;
function assert(cond, name, detail) {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// Fake core/block-editor store: block attributes come from window.__attrs.
const setStore = (page, attrs) =>
  page.evaluate((a) => {
    window.__attrs = a;
    window.wp = { data: { select: (s) => s === "core/block-editor" ? {
      getBlock: (cid) => (cid in window.__attrs ? { clientId: cid, attributes: window.__attrs[cid] } : null),
    } : null } };
  }, attrs);

async function run(page, rawEditor, rawFrontend) {
  const editorNorm = await normalizeBlockHtmlOnPage(page, rawEditor);
  const ids = await collectEditorBlockIds(page, rawEditor);
  const frontNorm = rawFrontend === null ? null : await normalizeBlockHtmlOnPage(page, rawFrontend);
  return reconcileGeneratedIds(page, editorNorm, frontNorm, ids);
}

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  console.log("\n1-3, 5. Theme ids, derived ids, nested blocks, user ids");
  {
    await setStore(page, { [C1]: {}, [C2]: {}, [C3]: {} });
    const editor =
      `<section id="block-${C1}" data-block="${C1}" data-type="takt/content-with-media" class="wp-block content-with-media wp-block-takt-content-with-media" aria-labelledby="block-${C1}-heading" tabindex="0">` +
      `<h2 id="block-${C1}-heading">Title</h2>` +
      `<div id="block-${C2}" data-block="${C2}" class="wp-block wp-block-takt-button-row"><a href="#contact">Go</a></div>` +
      `<p id="block-${C3}" data-block="${C3}" class="wp-block">Text</p>` +
      `<span id="user-id">x</span>` +
      `</section>`;
    const frontend =
      `<section id="auto-f02c2485-30" class="content-with-media wp-block-takt-content-with-media" aria-labelledby="auto-f02c2485-30-heading">` +
      `<h2 id="auto-f02c2485-30-heading">Title</h2>` +
      `<div id="auto-9a9a-31" class="wp-block-takt-button-row"><a href="#contact">Go</a></div>` +
      `<p>Text</p>` +
      `<span id="user-id">x</span>` +
      `</section>`;
    const r = await run(page, editor, frontend);
    assert(r.editor === r.frontend, "editor and frontend match", `\n    editor:   ${r.editor}\n    frontend: ${r.frontend}`);
    assert(r.frontend.includes('id="generated-id-0"'), "root id is generated-id-0");
    assert(r.frontend.includes('aria-labelledby="generated-id-0-heading"'), "aria-labelledby follows the root id");
    assert(r.frontend.includes('id="generated-id-0-heading"'), "derived heading id follows the root id");
    assert(r.frontend.includes('id="generated-id-1"'), "nested block pairs by position");
    assert(!r.editor.includes(C3), "nested block without a frontend id loses its editor id");
    assert(r.editor.includes('href="#contact"') && r.editor.includes('id="user-id"'), "unrelated ids untouched");
  }

  console.log("\n4. Anchored block");
  {
    await setStore(page, { [C1]: { anchor: "intro" } });
    const editor = `<section id="block-${C1}" data-block="${C1}" aria-labelledby="block-${C1}-heading"><h2 id="block-${C1}-heading">T</h2></section>`;
    const withAnchor = `<section id="intro" aria-labelledby="intro-heading"><h2 id="intro-heading">T</h2></section>`;
    const r = await run(page, editor, withAnchor);
    assert(r.editor === r.frontend, "anchor on the frontend matches", `\n    editor:   ${r.editor}\n    frontend: ${r.frontend}`);
    const withoutAnchor = `<section id="auto-abc-1" aria-labelledby="auto-abc-1-heading"><h2 id="auto-abc-1-heading">T</h2></section>`;
    const r2 = await run(page, editor, withoutAnchor);
    assert(r2.editor !== r2.frontend, "frontend that drops the anchor still differs");
  }

  console.log("\n6. Tag mismatch and missing frontend");
  {
    await setStore(page, { [C1]: {} });
    const editor = `<section id="block-${C1}" data-block="${C1}"><h2>T</h2></section>`;
    const r = await run(page, editor, `<div id="auto-abc-1"><h2>T</h2></div>`);
    assert(r.editor === "<section><h2>T</h2></section>", "tag mismatch drops the editor id", r.editor);
    assert(r.frontend.includes('id="auto-abc-1"'), "tag mismatch keeps the frontend id");
    const r2 = await run(page, editor, null);
    assert(r2.frontend === null && r2.editor === "<section><h2>T</h2></section>", "no frontend drops editor ids", r2.editor);
  }
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
