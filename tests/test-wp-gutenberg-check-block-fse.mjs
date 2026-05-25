#!/usr/bin/env node
/**
 * Live integration test for the #10 FSE canvas-root-insertion fix.
 *
 * Drives a real Chromium against nyus.localhost (a block theme that edits
 * pages in WP 6.5+ `template-locked` rendering mode) and exercises the
 * COMPILED helpers from dist/ that the insert_block / check_block / clear_blocks
 * tools now use:
 *
 *   - getPostContentClientId   → finds the core/post-content leaf clientId
 *   - insertBlock(root=pcId)   → lands in the post body + syncs to the entity
 *   - insertBlock(root=undef)  → (the bug) lands nowhere on a locked canvas
 *   - getBlockInfoById         → resolves validity at any nesting depth
 *   - clearBlocks              → empties only the body, template intact
 *
 * NOTHING is saved — every mutation dies with the throwaway page, so the demo
 * page is left untouched. Run against a live nyus:
 *
 *   WP_URL=http://nyus.localhost WP_USER=leandro WP_PASS=leandro \
 *     node test-wp-gutenberg-check-block-fse.mjs
 *
 * Defaults target nyus page 471 (Video Gallery) which renders template-locked.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// --- portability guard (auto-applied) ---
import { requireWp } from "./_helpers.mjs";
await requireWp();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const WP_URL = process.env.WP_URL || "http://nyus.localhost";
const WP_USER = process.env.WP_USER || "leandro";
const WP_PASS = process.env.WP_PASS || "leandro";
const POST_ID = parseInt(process.env.POST_ID || "471", 10);

const {
  getPostContentClientId,
  getBlockInfoById,
  insertBlock,
  clearBlocks,
  canvasHasPostContentLeaf,
} = await import(path.join(root, "dist/plugins/wp-gutenberg/utils/wp-data.js"));

let passed = 0;
let failed = 0;
function assert(cond, name, detail) {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function waitForEditor(page) {
  await page.waitForSelector('iframe[name="editor-canvas"], .block-editor-block-list__layout', { timeout: 20000 });
  await page.waitForFunction(() => {
    const wp = window.wp;
    const ed = wp?.data?.select("core/editor");
    return ed && ed.__unstableIsEditorReady && ed.__unstableIsEditorReady();
  }, { timeout: 20000 });
  // Give controlled inner blocks (post body) a beat to register.
  await page.waitForTimeout(800);
}

const editedContent = (page) =>
  page.evaluate(() => window.wp.data.select("core/editor").getEditedPostContent());
const bodyOrderLen = (page, pcId) =>
  page.evaluate((id) => window.wp.data.select("core/block-editor").getBlockOrder(id).length, pcId);
const rootOrderLen = (page) =>
  page.evaluate(() => window.wp.data.select("core/block-editor").getBlockOrder().length);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

try {
  // Login
  await page.goto(`${WP_URL}/wp-login.php`, { waitUntil: "load" });
  await page.fill("#user_login", WP_USER);
  await page.fill("#user_pass", WP_PASS);
  await page.click("#wp-submit");
  await page.waitForURL((u) => !u.toString().includes("wp-login.php"), { timeout: 30000 });

  // Open the template-locked page editor
  await page.goto(`${WP_URL}/wp-admin/post.php?post=${POST_ID}&action=edit`, { waitUntil: "load" });
  await waitForEditor(page);

  console.log("\n=== Detection ===");
  const hasLeaf = await canvasHasPostContentLeaf(page);
  const pcId = await getPostContentClientId(page);
  assert(hasLeaf === true, "canvasHasPostContentLeaf true on template-locked page");
  assert(typeof pcId === "string" && pcId.length > 0, "getPostContentClientId returns a clientId", String(pcId));

  const rootBefore = await rootOrderLen(page);
  const bodyBefore = await bodyOrderLen(page, pcId);

  console.log("\n=== Bug repro: insert at locked canvas root (root=undefined) ===");
  const buggyId = await insertBlock(page, "core/paragraph", { content: "FSE-BUG" }, undefined, undefined, undefined);
  await page.waitForTimeout(400);
  const buggyInfo = await getBlockInfoById(page, buggyId);
  const contentAfterBug = await editedContent(page);
  assert((await bodyOrderLen(page, pcId)) === bodyBefore, "body unchanged by root=undefined insert (block rejected)");
  assert(!contentAfterBug.includes("FSE-BUG"), "buggy block never reaches getEditedPostContent()");

  console.log("\n=== Fix: insert into post body (root=postContentClientId) ===");
  const fixedId = await insertBlock(page, "core/paragraph", { content: "FSE-FIX" }, undefined, pcId, undefined);
  await page.waitForTimeout(400);
  const fixedInfo = await getBlockInfoById(page, fixedId);
  const contentAfterFix = await editedContent(page);
  assert(fixedInfo !== null, "getBlockInfoById resolves the inserted body block");
  assert(fixedInfo?.isValid === true, "inserted block isValid");
  assert((await bodyOrderLen(page, pcId)) === bodyBefore + 1, "body grew by one");
  assert(contentAfterFix.includes("FSE-FIX"), "fixed block syncs into getEditedPostContent()");
  assert((await rootOrderLen(page)) === rootBefore, "template root count unchanged (no template mutation)");

  console.log("\n=== clearBlocks: empties body, preserves template ===");
  const cleared = await clearBlocks(page);
  await page.waitForTimeout(300);
  assert(cleared === bodyBefore + 1, `clearBlocks returns body count (${cleared})`, `expected ${bodyBefore + 1}`);
  assert((await bodyOrderLen(page, pcId)) === 0, "post body emptied");
  assert((await rootOrderLen(page)) === rootBefore, "template parts intact after clear");
  assert((await editedContent(page)).trim() === "", "getEditedPostContent() empty after clear");

  console.log(`\n=== Total: ${passed} passed, ${failed} failed (NOTHING SAVED) ===`);
} finally {
  await context.close();
  await browser.close();
}

process.exit(failed > 0 ? 1 : 0);
