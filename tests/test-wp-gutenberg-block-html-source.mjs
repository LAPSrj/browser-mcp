#!/usr/bin/env node
/**
 * Unit tests for wp-gutenberg_block_html post-content sourcing.
 *
 * Covers the pure-logic helpers added for the `source` flag:
 *
 *   1. resolvePostContentTarget by block_name (first depth-first occurrence)
 *   2. resolvePostContentTarget by block_index (top-level)
 *   3. resolvePostContentTarget by block_path (nested)
 *   4. resolvePostContentTarget sameNameIndex math when the same block name
 *      appears multiple times in depth-first order
 *   5. resolvePostContentTarget returns null for out-of-range / missing
 *   6. Block_name match prefers the first occurrence, not the last
 *
 * Live-WP integration coverage (canvas tree detection, parsing, DOM lookup)
 * is left for an integration test run against a real block-theme post; this
 * file pins the resolution math that drives both the editor outerHTML lookup
 * and the DOM-element finder.
 *
 * Usage: node test-wp-gutenberg-block-html-source.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// --- portability guard (auto-applied) ---
import { requireWp } from "./_helpers.mjs";
await requireWp();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const { resolvePostContentTarget } = await import(
  path.join(root, "dist/plugins/wp-gutenberg/utils/wp-data.js")
);

let passed = 0;
let failed = 0;

function assert(condition, name, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A block-theme post body: a paragraph, a CTA, a group containing two more
// paragraphs and a nested CTA. Mirrors what wp.blocks.parse(getEditedPostContent())
// would return on a real post.
const sampleTree = [
  {
    clientId: "p1",
    name: "core/paragraph",
    attributes: { content: "intro" },
    innerBlocks: [],
  },
  {
    clientId: "cta1",
    name: "takt/call-to-action",
    attributes: { heading: "first cta", anchor: "cta-anchor-one" },
    innerBlocks: [],
  },
  {
    clientId: "g1",
    name: "core/group",
    attributes: {},
    innerBlocks: [
      {
        clientId: "p2",
        name: "core/paragraph",
        attributes: { content: "inside group" },
        innerBlocks: [],
      },
      {
        clientId: "p3",
        name: "core/paragraph",
        attributes: { content: "also inside" },
        innerBlocks: [],
      },
      {
        clientId: "cta2",
        name: "takt/call-to-action",
        attributes: { heading: "second cta" },
        innerBlocks: [],
      },
    ],
  },
];

console.log("\nresolvePostContentTarget");

// 1. by block_name — first depth-first occurrence wins
{
  const r = resolvePostContentTarget(sampleTree, { block_name: "takt/call-to-action" });
  assert(r !== null, "by block_name finds something");
  assert(r?.name === "takt/call-to-action", "by block_name returns correct name");
  assert(eq(r?.path, [1]), "by block_name returns first-occurrence path [1]");
  assert(r?.sameNameIndex === 0, "by block_name first occurrence has sameNameIndex 0");
  assert(
    r?.attributes.anchor === "cta-anchor-one",
    "by block_name returns the matched block's attributes (anchor)",
  );
}

// 2. by block_index — top-level
{
  const r = resolvePostContentTarget(sampleTree, { block_index: 2 });
  assert(r?.name === "core/group", "by block_index 2 → core/group");
  assert(eq(r?.path, [2]), "by block_index path is [2]");
  assert(r?.sameNameIndex === 0, "by block_index sameNameIndex 0 (only one core/group)");
}

// 3. by block_path — nested
{
  const r = resolvePostContentTarget(sampleTree, { block_path: [2, 2] });
  assert(r?.name === "takt/call-to-action", "by block_path [2,2] → nested cta");
  assert(eq(r?.path, [2, 2]), "by block_path returns the given path");
}

// 4. sameNameIndex math — two CTAs, second occurrence should be index 1
{
  const r = resolvePostContentTarget(sampleTree, { block_path: [2, 2] });
  assert(
    r?.sameNameIndex === 1,
    "sameNameIndex for second takt/call-to-action in depth-first order is 1",
    `got ${r?.sameNameIndex}`,
  );
}

// 5a. sameNameIndex math — first paragraph (top-level) is sameNameIndex 0
{
  const r = resolvePostContentTarget(sampleTree, { block_path: [0] });
  assert(r?.sameNameIndex === 0, "first paragraph sameNameIndex 0");
}

// 5b. sameNameIndex math — paragraph at [2,0] is depth-first 2nd paragraph
{
  const r = resolvePostContentTarget(sampleTree, { block_path: [2, 0] });
  assert(
    r?.sameNameIndex === 1,
    "paragraph at [2,0] is depth-first second paragraph (sameNameIndex 1)",
    `got ${r?.sameNameIndex}`,
  );
}

// 5c. sameNameIndex math — paragraph at [2,1] is depth-first 3rd paragraph
{
  const r = resolvePostContentTarget(sampleTree, { block_path: [2, 1] });
  assert(
    r?.sameNameIndex === 2,
    "paragraph at [2,1] is depth-first third paragraph (sameNameIndex 2)",
    `got ${r?.sameNameIndex}`,
  );
}

// 6. Out-of-range block_index returns null
{
  const r = resolvePostContentTarget(sampleTree, { block_index: 99 });
  assert(r === null, "block_index 99 returns null");
}

// 7. Out-of-range block_path returns null
{
  const r = resolvePostContentTarget(sampleTree, { block_path: [2, 99] });
  assert(r === null, "block_path [2,99] returns null");
}

// 8. Missing block_name returns null
{
  const r = resolvePostContentTarget(sampleTree, { block_name: "core/nonexistent" });
  assert(r === null, "missing block_name returns null");
}

// 9. No selector at all returns null
{
  const r = resolvePostContentTarget(sampleTree, {});
  assert(r === null, "no selector returns null");
}

// 10. block_name search prefers first depth-first occurrence, not the last
{
  // Build a tree where the same block name appears in a group BEFORE another
  // top-level occurrence; the first depth-first hit should win.
  const tree = [
    {
      clientId: "g0",
      name: "core/group",
      attributes: {},
      innerBlocks: [
        {
          clientId: "ctaA",
          name: "takt/call-to-action",
          attributes: { heading: "buried" },
          innerBlocks: [],
        },
      ],
    },
    {
      clientId: "ctaB",
      name: "takt/call-to-action",
      attributes: { heading: "top-level" },
      innerBlocks: [],
    },
  ];
  const r = resolvePostContentTarget(tree, { block_name: "takt/call-to-action" });
  assert(eq(r?.path, [0, 0]), "block_name picks the deeper-but-earlier occurrence first");
  assert(r?.sameNameIndex === 0, "first depth-first match has sameNameIndex 0");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
