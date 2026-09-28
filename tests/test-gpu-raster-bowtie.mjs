#!/usr/bin/env node
/**
 * Regression: Chromium GPU rasterization on Mesa's d3d12 driver (WSLg)
 * mis-paints Skia path fills. A box with border-radius + a semi-transparent
 * border + a background renders as an X / "bowtie" (dark wedges from each
 * corner to the center), and concave SVG paths built from 3+ arcs lose their
 * curved parts. Captures must match the SwiftShader (software) render.
 *
 * Coverage:
 *  1. screenshot + element_screenshot tools (one-off launch, default env)
 *  2. open_session headless (default env)
 *  3. WSL only: open_session headed with BROWSER_MCP_GPU=0 (headed Chromium
 *     picks d3d12 + GPU raster on its own, so this path needs the fix too)
 *
 * Run after `npm run build` (or `npx tsc`).
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = (p) => import(pathToFileURL(path.join(root, "dist", p)).href);

const { chromium } = await import("playwright");
const { PNG } = await import("pngjs");
const { default: pixelmatch } = await import("pixelmatch");
const { screenshotTool } = await dist("core/screenshot.js");
const { elementScreenshotTool } = await dist("core/element-screenshot.js");
const { sessionManager } = await dist("core/sessions.js");
const { isWsl } = await dist("utils/wsl.js");

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

const VIEWPORT = { width: 480, height: 180 };
const page = (body) =>
  "data:text/html," +
  encodeURIComponent(`<!doctype html><html style="overflow:hidden"><body style="margin:0;background:#fff">${body}</body></html>`);

const BOX_URL = page(
  `<div id="box" style="position:absolute;left:20px;top:20px;width:200px;height:120px;box-sizing:border-box;` +
  `border-radius:24px;border:6px solid rgba(0,0,0,0.4);background:#3b82f6"></div>`,
);
const ARCS_URL = page(
  `<svg width="480" height="180" viewBox="0 0 480 180">` +
  `<path d="M 20 90 A 50 50 0 0 1 120 90 A 25 25 0 0 1 70 90 A 25 25 0 0 0 20 90 Z" fill="#ef4444"/>` +
  `<path d="M 150 40 A 40 40 0 0 1 230 40 A 40 40 0 0 1 230 120 A 40 40 0 0 1 150 120 A 20 20 0 0 0 150 40 Z" fill="#8b5cf6"/>` +
  `<path d="M 280 30 A 30 30 0 1 0 340 30 A 30 30 0 1 0 400 30 A 30 30 0 1 1 280 150 Z" fill="#f59e0b"/>` +
  `</svg>`,
);

// Points inside the box that the bowtie's dark wedges cover or cut through.
const BOX_POINTS = [
  [120, 80, "center"], [120, 35, "inside top edge"], [120, 125, "inside bottom edge"],
  [35, 80, "inside left edge"], [205, 80, "inside right edge"],
];
const BOX_FILL = [0x3b, 0x82, 0xf6];

// offset = the box's top-left in the image (20,20 on the page; 0,0 when the
// image is an element capture of the box itself).
function boxBowtie(buf, offset = 0) {
  const png = PNG.sync.read(buf);
  return BOX_POINTS.filter(([x, y]) => {
    const i = (png.width * (y - 20 + offset) + (x - 20 + offset)) * 4;
    return [0, 1, 2].some((k) => Math.abs(png.data[i + k] - BOX_FILL[k]) > 24);
  }).map(([x, y, label]) => `${label}@${x},${y}`);
}

function diffPx(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  return pixelmatch(A.data, B.data, null, A.width, A.height, { threshold: 0.2 });
}

// Reference: Playwright's default headless Chromium rasterizes in software
// (SwiftShader), which renders both pages correctly.
async function reference(url) {
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage({ viewport: VIEWPORT });
    await p.goto(url);
    return await p.screenshot();
  } finally { await b.close(); }
}
const REF = { box: await reference(BOX_URL), arcs: await reference(ARCS_URL) };

function checkCaptures(label, box, arcs) {
  const wedges = boxBowtie(box, 20);
  check(wedges.length === 0, `${label}: rounded box has no bowtie`, `wrong pixels at ${wedges.join(", ")}`);
  const boxDiff = diffPx(box, REF.box);
  check(boxDiff < 50, `${label}: rounded box matches software render`, `${boxDiff}px differ`);
  const arcsDiff = diffPx(arcs, REF.arcs);
  check(arcsDiff < 50, `${label}: concave SVG arcs match software render`, `${arcsDiff}px differ`);
}

async function viaScreenshotTool(url) {
  const res = await screenshotTool({ url, viewports: [VIEWPORT], outputDir: "/tmp/bm-bowtie-test", waitForNetworkIdle: false });
  const file = res.content.map((c) => c.text).join(" ").match(/Saved: (\S+)/)?.[1];
  if (!file) throw new Error(`screenshot tool returned no file: ${JSON.stringify(res.content)}`);
  return readFileSync(file);
}

async function viaSession(opts) {
  const s = await sessionManager.open({ viewport: VIEWPORT, ...opts });
  try {
    const p = sessionManager.getPage(s.session_id);
    const shots = [];
    for (const url of [BOX_URL, ARCS_URL]) {
      await p.goto(url);
      shots.push(await p.screenshot());
    }
    return shots;
  } finally { await sessionManager.close(s.session_id); }
}

// A failed capture ("Unable to capture screenshot" was seen on the same GPU
// path) counts as a failure of that section, not a crash of the whole test.
async function section(label, capture) {
  let shots;
  try { shots = await capture(); } catch (e) {
    check(false, `${label}: capture succeeds`, e.message.split("\n")[0]);
    return;
  }
  checkCaptures(label, ...shots);
}

console.log("\n=== 1. screenshot tool, default env ===");
await section("screenshot", async () => [await viaScreenshotTool(BOX_URL), await viaScreenshotTool(ARCS_URL)]);

console.log("\n=== 1b. element_screenshot tool, default env ===");
try {
  const res = await elementScreenshotTool({ url: BOX_URL, selector: "#box", viewport: VIEWPORT, outputDir: "/tmp/bm-bowtie-test" });
  const file = res.content.map((c) => c.text ?? "").join(" ").match(/Saved: (\S+)/)?.[1];
  if (!file) throw new Error(`element_screenshot returned no file: ${res.content.map((c) => c.text ?? "").join(" ")}`);
  const wedges = boxBowtie(readFileSync(file));
  check(wedges.length === 0, "element_screenshot: rounded box has no bowtie", `wrong pixels at ${wedges.join(", ")}`);
} catch (e) {
  check(false, "element_screenshot: capture succeeds", e.message.split("\n")[0]);
}

console.log("\n=== 2. open_session headless, default env ===");
await section("session headless", () => viaSession({ headless: true }));

if (isWsl()) {
  console.log("\n=== 3. open_session headed, BROWSER_MCP_GPU=0 (WSL) ===");
  process.env.BROWSER_MCP_GPU = "0";
  await section("session headed gpu=0", () => viaSession({ headless: false }));
  delete process.env.BROWSER_MCP_GPU;
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
