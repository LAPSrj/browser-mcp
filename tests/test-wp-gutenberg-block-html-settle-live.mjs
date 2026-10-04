#!/usr/bin/env node
/**
 * Live test: wp-gutenberg_block_html returns the same editor markup on every
 * call, through the real CLI (fresh browser, fresh editor load per call).
 *
 *   1. A block whose editor view uses FilteredServerSideRender: every capture
 *      includes the server-rendered markup (SSR_MARKER).
 *   2. A post-content block on a template-locked page: no capture has the
 *      first-paint disabled markers (is-editing-disabled, inert).
 *
 * Defaults target the takt-wk test pages (573 PostsCarousel, 335 ScrollingText)
 * on http://wk.localhost; override with the env vars below. Read-only:
 * save_before_frontend is false, so nothing is saved.
 *
 *   WP_URL=http://wk.localhost WP_USER=leandro WP_PASS=leandro \
 *     node tests/test-wp-gutenberg-block-html-settle-live.mjs
 *
 * Env: SSR_POST_ID, SSR_BLOCK, SSR_MARKER, LOCKED_POST_ID, LOCKED_BLOCK, RUNS.
 */

import path from "node:path";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { requireWp } from "./_helpers.mjs";
const wpUrl = await requireWp();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(__dirname, "..", "dist/index.js");
const run = promisify(execFile);

const RUNS = Number(process.env.RUNS ?? 4);
const cases = [
  {
    label: "server-rendered block",
    postId: process.env.SSR_POST_ID ?? "573",
    block: process.env.SSR_BLOCK ?? "takt/posts-carousel",
    mustInclude: process.env.SSR_MARKER ?? "swiper-parent",
  },
  {
    label: "template-locked post-content block",
    postId: process.env.LOCKED_POST_ID ?? "335",
    block: process.env.LOCKED_BLOCK ?? "takt/scrolling-text",
    mustInclude: null,
  },
];

let passed = 0;
let failed = 0;
function assert(cond, name, detail) {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const env = {
  ...process.env,
  BROWSER_MCP_PLUGINS: "wp,wp-gutenberg",
  WP_URL: wpUrl,
  WP_USERNAME: process.env.WP_USER ?? process.env.WP_USERNAME ?? "leandro",
  WP_PASSWORD: process.env.WP_PASS ?? process.env.WP_PASSWORD ?? "leandro",
};
delete env.WP_SITES;

const dir = await mkdtemp(path.join(tmpdir(), "block-html-settle-"));
try {
  for (const c of cases) {
    console.log(`\n${c.label}: post ${c.postId}, ${c.block}, ${RUNS} calls`);
    const editors = [];
    for (let i = 0; i < RUNS; i++) {
      const out = path.join(dir, `${c.postId}-${i}.json`);
      try {
        await run(process.execPath, [
          cli, "wp-gutenberg_block_html",
          "--post_id", c.postId,
          "--block_name", c.block,
          "--save_before_frontend", "false",
          "--result_path", out,
        ], { env, timeout: 120000 });
        editors.push(JSON.parse(await readFile(out, "utf8")).editor);
      } catch (e) {
        editors.push(null);
        console.log(`  call ${i + 1} failed: ${(e.stderr || e.stdout || e.message).toString().trim()}`);
      }
    }
    assert(editors.every((h) => typeof h === "string" && h.length > 0), "every call returned editor HTML");
    const lengths = editors.map((h) => h?.length ?? 0).join(", ");
    assert(editors.every((h) => h === editors[0]), "every call returned the same editor HTML", `lengths ${lengths}`);
    if (c.mustInclude) {
      const hits = editors.filter((h) => h?.includes(c.mustInclude)).length;
      assert(hits === RUNS, `every capture includes the server markup (${c.mustInclude})`, `${hits}/${RUNS}`);
    }
    const marked = editors.filter((h) => h && /is-editing-disabled|\binert=/.test(h)).length;
    assert(marked === 0, "no capture has the first-paint disabled markers", `${marked}/${RUNS}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
