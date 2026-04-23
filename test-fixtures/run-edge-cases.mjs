#!/usr/bin/env node
/**
 * Edge case test runner for design_compare tool.
 * Runs against test-fixtures/design-compare-test.html via file:// URL.
 *
 * Usage: node test-fixtures/run-edge-cases.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testHtml = `file://${path.resolve(__dirname, "design-compare-test.html")}`;

const { designCompareTool } = await import("../dist/plugins/design-compare/tools/design-compare.js");

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

function parseResult(toolResult) {
  const text = toolResult.content.find((c) => c.type === "text")?.text;
  return JSON.parse(text);
}

// ---- Test 1: Basic property comparison (matches + mismatches) ----
console.log("\n=== Test 1: Basic property comparison ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "heading",
        selector: ".heading",
        expected: {
          "font-size": "72px",
          "color": "#ffffff",
          "font-weight": "700",
          "text-transform": "uppercase",
          "letter-spacing": "-1.8px",
          "padding": "99px",  // intentional mismatch
        },
      },
    ],
  }));
  assert(result.summary.elementsFound === 1, "element found");
  assert(result.summary.matches === 5, "5 properties match");
  assert(result.summary.mismatches === 1, "1 property mismatches (padding)");
  const paddingResult = result.elements[0].results.find((r) => r.property === "padding");
  assert(paddingResult && !paddingResult.match, "padding is a mismatch");
  assert(paddingResult?.delta, "padding has a delta");
}

// ---- Test 2: Element not found ----
console.log("\n=== Test 2: Element not found ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "ghost",
        selector: ".does-not-exist",
        expected: { "font-size": "16px", "color": "red" },
      },
    ],
  }));
  assert(result.elements[0].found === false, "element reported as not found");
  assert(result.summary.elementsFound === 0, "elementsFound is 0");
  assert(result.summary.mismatches === 2, "all expected properties counted as mismatches");
}

// ---- Test 3: Empty expected (no properties) ----
console.log("\n=== Test 3: Empty expected ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "heading-bbox-only",
        selector: ".heading",
        expected: {},
      },
    ],
  }));
  assert(result.elements[0].found === true, "element found");
  assert(result.elements[0].boundingBox !== undefined, "bounding box returned");
  assert(result.elements[0].results.length === 0, "no property results");
  assert(result.summary.matches === 0 && result.summary.mismatches === 0, "zero matches and mismatches");
}

// ---- Test 4: Malformed selector ----
console.log("\n=== Test 4: Malformed selector ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "bad-selector",
        selector: ".foo[",
        expected: { "font-size": "16px" },
      },
    ],
  }));
  assert(result.elements[0].found === false, "malformed selector reported as not found (no crash)");
}

// ---- Test 5: Pseudo-element exists ----
console.log("\n=== Test 5: Pseudo-element exists ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "eyebrow",
        selector: ".eyebrow.with-pseudo",
        expected: { "font-size": "14px" },
        pseudoElements: {
          "::before": {
            "width": "60px",
            "height": "4px",
            "background-color": "#ff0000",
          },
        },
      },
    ],
  }));
  const pseudo = result.elements[0].pseudoElements?.[0];
  assert(pseudo?.found === true, "pseudo-element found");
  assert(pseudo?.matches === 3, "all 3 pseudo properties match");
}

// ---- Test 6: Pseudo-element doesn't exist ----
console.log("\n=== Test 6: Pseudo-element doesn't exist ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "no-pseudo",
        selector: ".no-pseudo",
        expected: { "font-size": "16px" },
        pseudoElements: {
          "::before": { "width": "60px" },
        },
      },
    ],
  }));
  const pseudo = result.elements[0].pseudoElements?.[0];
  assert(pseudo?.found === false, "pseudo-element reported as not found");
  assert(pseudo?.mismatches === 1, "pseudo property counted as mismatch");
}

// ---- Test 7: Empty elements array ----
console.log("\n=== Test 7: Empty elements array ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [],
  }));
  assert(result.summary.totalElements === 0, "totalElements is 0");
  assert(result.elements.length === 0, "empty elements array");
}

// ---- Test 8: Layout gap measurement ----
console.log("\n=== Test 8: Layout gap measurement ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [],
    layout: {
      gaps: [
        {
          between: [".child-a", ".child-b"],
          expected: "24px",
          axis: "vertical",
        },
      ],
    },
  }));
  assert(result.layout?.gaps?.[0]?.match === true, "24px vertical gap matches");
}

// ---- Test 9: Layout gap with missing element ----
console.log("\n=== Test 9: Layout gap with missing element ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [],
    layout: {
      gaps: [
        {
          between: [".child-a", ".ghost-element"],
          expected: "24px",
          axis: "vertical",
        },
      ],
    },
  }));
  assert(result.layout?.gaps?.[0]?.match === false, "gap with missing element fails");
  assert(result.layout?.gaps?.[0]?.error?.includes("not found"), "error mentions selector not found");
}

// ---- Test 10: Containment (child within parent) ----
console.log("\n=== Test 10: Containment check ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [],
    layout: {
      containment: [
        { child: ".child-a", parent: ".container", expectClipped: false },
      ],
    },
  }));
  assert(result.layout?.containment?.[0]?.match === true, "child-a contained in container");
  assert(result.layout?.containment?.[0]?.contained === true, "contained is true");
}

// ---- Test 11: Containment (child overflows parent) ----
console.log("\n=== Test 11: Containment overflow ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [],
    layout: {
      containment: [
        { child: ".overflow-child", parent: ".container", expectClipped: true },
      ],
    },
  }));
  assert(result.layout?.containment?.[0]?.match === true, "overflow child expectClipped=true matches");
  assert(result.layout?.containment?.[0]?.contained === false, "contained is false (overflows)");
  assert(result.layout?.containment?.[0]?.overflow !== undefined, "overflow details present");
}

// ---- Test 12: Color normalization ----
console.log("\n=== Test 12: Color normalization ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "heading-color",
        selector: ".heading",
        expected: {
          "color": "white",
          "background-color": "rgb(0, 0, 0)",
        },
      },
    ],
  }));
  assert(result.elements[0].results.every((r) => r.match), "color normalization: white = #ffffff, rgb(0,0,0) = #000");
}

// ---- Test 12b: Font-family primary comparison ----
console.log("\n=== Test 12b: Font-family primary comparison ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "heading-font",
        selector: ".heading",
        expected: {
          "font-family": "Arial",
        },
      },
    ],
  }));
  assert(result.elements[0].results[0].match === true, "font-family primary match: 'Arial' matches 'Arial, sans-serif, ...'");
}

// ---- Test 13: freezeAnimations ----
console.log("\n=== Test 13: freezeAnimations ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    freezeAnimations: true,
    elements: [
      {
        name: "animated",
        selector: ".animated",
        expected: { "font-size": "20px" },
      },
    ],
  }));
  assert(result.elements[0].found === true, "animated element found with freezeAnimations");
  assert(result.elements[0].results[0].match === true, "font-size matches with frozen animations");
}

// ---- Test 14: Multiple selectors matching ----
console.log("\n=== Test 14: Multiple matching elements ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [
      {
        name: "children",
        selector: ".container > div",
        expected: { "width": "200px" },
      },
    ],
  }));
  assert(result.elements[0].matchCount > 1, `matchCount reports ${result.elements[0].matchCount} elements`);
}

// ---- Test 15: Malformed selector in layout gap ----
console.log("\n=== Test 15: Malformed selector in layout gap ===");
{
  const result = parseResult(await designCompareTool({
    url: testHtml,
    elements: [],
    layout: {
      gaps: [
        { between: [".child-a", ".bad["], expected: "10px", axis: "vertical" },
      ],
    },
  }));
  assert(result.layout?.gaps?.[0]?.match === false, "malformed selector in gap fails gracefully");
}

// ---- Summary ----
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
if (failed > 0) process.exit(1);
