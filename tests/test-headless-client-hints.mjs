#!/usr/bin/env node
/**
 * Headless Chromium sessions must send the client hints and Accept-Language a
 * visible session sends: sec-ch-ua headers and navigator.userAgentData
 * (brands, high-entropy values) without "HeadlessChrome", and the same
 * Accept-Language header and navigator.languages, with and without a locale.
 * Checked on the page, a cross-site iframe, a dedicated worker, an addTab tab,
 * a popup's JS, and the one-shot path. Known exceptions, not checked: a
 * popup's first request and service workers. Needs a display for the visible
 * session; Linux only. Run after `npx tsc`.
 */
import http from "node:http";
import { sessionManager } from "../dist/core/sessions.js";
import { evaluateScriptTool } from "../dist/plugins/dev/tools/evaluate-script.js";

if (process.platform !== "linux" || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) {
  console.log("SKIP: needs Linux with a display for the visible Chromium to compare against");
  process.exit(0);
}

let failures = 0;
const check = (cond, label, detail) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond || detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const HEADERS = ["user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "accept-language"];
const requests = new Map();
const SIGNALS = `(async () => ({
  brands: navigator.userAgentData.brands,
  high: await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "fullVersionList", "formFactors", "model", "platformVersion", "wow64"]),
  languages: navigator.languages,
}))()`;
const handler = (req, res) => {
  const tag = new URL(req.url, "http://x").searchParams.get("t");
  if (tag) requests.set(`${tag}${new URL(req.url, "http://x").pathname}`, Object.fromEntries(HEADERS.map((h) => [h, req.headers[h] ?? null])));
  res.setHeader("content-type", req.url.startsWith("/worker.js") ? "text/javascript" : "text/html");
  if (req.url.startsWith("/worker.js")) return res.end(`${SIGNALS}.then((s) => postMessage(s));`);
  if (req.url.startsWith("/frame")) return res.end(`<script>${SIGNALS}.then((s) => parent.postMessage({ frame: s }, "*"))</script>`);
  res.end(`<!doctype html><title>t</title><img src="/img.png?t=${tag}"><iframe src="http://localhost:${other.address().port}/frame?t=${tag}"></iframe>`);
};
const main = http.createServer(handler);
const other = http.createServer(handler);
await new Promise((r) => main.listen(0, "127.0.0.1", r));
await new Promise((r) => other.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${main.address().port}`;

async function sample(headless, tag, open = {}) {
  const s = await sessionManager.open({ headless, ...open });
  try {
    const page = sessionManager.getPage(s.session_id);
    await page.addInitScript(() => { window.__frame = null; window.addEventListener("message", (e) => { if (e.data?.frame) window.__frame = e.data.frame; }); });
    await page.goto(`${base}/page?t=${tag}`);
    await page.waitForFunction(() => window.__frame, null, { timeout: 5000 });
    const out = { page: await page.evaluate(SIGNALS), frame: await page.evaluate(() => window.__frame) };
    out.worker = await page.evaluate((u) => new Promise((r) => { new Worker(u).onmessage = (e) => r(e.data); }), `${base}/worker.js?t=${tag}`);
    const tab = await sessionManager.addTab(s.session_id, "t2", `${base}/page?t=${tag}-tab`);
    out.tab = await sessionManager.getPage(s.session_id, tab.tab_id).evaluate(SIGNALS);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate((u) => window.open(u), `${base}/page?t=${tag}-popup`)]);
    await popup.waitForLoadState();
    out.popup = await popup.evaluate(SIGNALS);
    return out;
  } finally {
    await sessionManager.close(s.session_id);
  }
}

function compare(label, headless, visible, headlessTag, visibleTag) {
  for (const key of Object.keys(visible)) check(same(headless[key], visible[key]), `${label}: ${key} JS matches`, { headless: headless[key], visible: visible[key] });
  for (const path of ["/page", "/img.png", "/frame", "/worker.js"]) {
    const h = requests.get(`${headlessTag}${path}`);
    const v = requests.get(`${visibleTag}${path}`);
    check(h && same(h, v), `${label}: ${path} request headers match`, { headless: h, visible: v });
  }
  const tabH = requests.get(`${headlessTag}-tab/page`);
  const tabV = requests.get(`${visibleTag}-tab/page`);
  check(tabH && same(tabH, tabV), `${label}: addTab request headers match`, { headless: tabH, visible: tabV });
}

try {
  const visible = await sample(false, "v");
  const headless = await sample(true, "h");
  compare("default", headless, visible, "h", "v");
  check(!JSON.stringify(headless).includes("Headless"), "default: no JS value says Headless");

  const visibleDe = await sample(false, "vde", { locale: "de-DE" });
  const headlessDe = await sample(true, "hde", { locale: "de-DE" });
  compare("locale de-DE", headlessDe, visibleDe, "hde", "vde");

  const oneShot = await evaluateScriptTool({ url: `${base}/page?t=one`, script: `return ${SIGNALS}` });
  const oneShotSignals = JSON.parse(oneShot.content[0].text.replace(/^[^{]*/, ""));
  check(same(oneShotSignals, visible.page), "one-shot: JS matches", oneShotSignals);
  check(same(requests.get("one/page"), requests.get("v/page")), "one-shot: request headers match", requests.get("one/page"));
} finally {
  main.close();
  other.close();
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
