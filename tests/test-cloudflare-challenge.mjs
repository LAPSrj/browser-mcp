#!/usr/bin/env node
// Which Playwright/browser-mcp setups pass a Cloudflare challenge.
//
// Live diagnostic against a third-party page, so it runs only on request:
//   CF_TEST=1 node tests/test-cloudflare-challenge.mjs [condition ...]
// Env: CF_URL (default scrapingcourse.com's antibot page), CF_ROUNDS (default 2),
// CF_WAIT_MS (default 40000).
//
// Every round launches a fresh attach_cdp browser on a temp profile and loads
// CF_URL in a new background tab, the same way each time. The conditions
// differ only in what is connected to the browser and what Playwright
// installed. Pass = the tab's title is no longer "Just a moment..." within
// CF_WAIT_MS. Titles come from the browser's /json/list HTTP endpoint, so the
// check itself runs nothing in the page. After the verdict, the tab's
// Playwright/browser-mcp globals are listed where a connection is available.
//
// Conditions:
//   no-playwright     nothing attached; tab opened through /json/new
//   no-binding        Playwright attached, no binding exposed
//   page-binding      Playwright exposeBinding on the tested tab
//   other-tab         exposeBinding on another tab; the tested tab is new
//   after-disconnect  a Playwright process exposed a binding and exited; tab opened through /json/new
//   mcp-tab           a browser-mcp session's own tab (current product behavior)
//   mcp-other-tab     a tab the session didn't open, while the session is attached (like the user's Ctrl+T)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const dist = path.resolve(path.dirname(__filename), "..", "dist");
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);

// Child mode for after-disconnect: attach, expose a binding, exit.
if (process.argv[2] === "--child") {
  const browser = await chromium.connectOverCDP(process.argv[3]);
  const page = browser.contexts()[0].pages()[0];
  await page.exposeBinding("__cfTestBinding", () => 1);
  console.log("bound");
  process.exit(0);
}

if (process.env.CF_TEST !== "1") {
  console.log("SKIP: live Cloudflare diagnostic. Run with CF_TEST=1 node tests/test-cloudflare-challenge.mjs [condition ...]");
  process.exit(0);
}

const { requireWindows, requireChromium } = await import("./_helpers.mjs");
requireWindows();
const { executablePath, processName } = requireChromium();
const { spawnAttachCdpRelay } = await load("utils/cdp-relay.js");
const { sessionManager } = await load("core/sessions.js");

const URL_ = process.env.CF_URL ?? "https://www.scrapingcourse.com/antibot-challenge";
const ROUNDS = Number(process.env.CF_ROUNDS ?? 2);
const WAIT_MS = Number(process.env.CF_WAIT_MS ?? 40000);
const GLOBALS = () => Object.getOwnPropertyNames(window).filter((n) => /playwright|browserMcp|cfTest/i.test(n));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async (endpoint) => (await fetch(`${endpoint}/json/list`)).json();

async function openViaHttp(endpoint) {
  const r = await fetch(`${endpoint}/json/new?${encodeURI(URL_)}`, { method: "PUT" });
  return (await r.json()).id;
}

/** Wait for the challenge to clear on target `id`; reads titles only. */
async function verdict(endpoint, id) {
  const t0 = Date.now();
  let title = "";
  while (Date.now() - t0 < WAIT_MS) {
    await sleep(2000);
    const t = (await targets(endpoint)).find((x) => x.id === id);
    title = t?.title ?? "(tab gone)";
    if (t && t.url.startsWith("http") && title && !/just a moment/i.test(title) && !title.startsWith("http")) {
      return { pass: true, secs: Math.round((Date.now() - t0) / 1000), title };
    }
  }
  return { pass: false, secs: Math.round(WAIT_MS / 1000), title };
}

/** New background tab through CDP, as Playwright-connected code would open it; returns its target id and Page. */
async function newTabVia(browser, context) {
  const cdp = await browser.newBrowserCDPSession();
  const before = new Set(context.pages());
  const { targetId } = await cdp.send("Target.createTarget", { url: URL_, background: true });
  await cdp.detach();
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = context.pages().find((p) => !before.has(p));
    if (!page) await sleep(100);
  }
  return { id: targetId, page };
}

async function targetIdOf(context, page) {
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.detach();
  return targetInfo.targetId;
}

async function freshBrowser() {
  return spawnAttachCdpRelay({
    sessionId: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    executablePath,
    processName,
  });
}

const CONDITIONS = {
  async "no-playwright"() {
    const h = await freshBrowser();
    try {
      return { ...(await verdict(h.endpoint, await openViaHttp(h.endpoint))), globals: "(not checked)" };
    } finally {
      await h.cleanup();
    }
  },

  async "no-binding"() {
    const h = await freshBrowser();
    try {
      const browser = await chromium.connectOverCDP(h.endpoint);
      const context = browser.contexts()[0];
      const { id, page } = await newTabVia(browser, context);
      const v = await verdict(h.endpoint, id);
      return { ...v, globals: await page.evaluate(GLOBALS).catch((e) => e.message) };
    } finally {
      await h.cleanup();
    }
  },

  async "page-binding"() {
    const h = await freshBrowser();
    try {
      const browser = await chromium.connectOverCDP(h.endpoint);
      const context = browser.contexts()[0];
      const page = context.pages()[0];
      await page.exposeBinding("__cfTestBinding", () => 1);
      const id = await targetIdOf(context, page);
      page.goto(URL_).catch(() => {});
      const v = await verdict(h.endpoint, id);
      return { ...v, globals: await page.evaluate(GLOBALS).catch((e) => e.message) };
    } finally {
      await h.cleanup();
    }
  },

  async "other-tab"() {
    const h = await freshBrowser();
    try {
      const browser = await chromium.connectOverCDP(h.endpoint);
      const context = browser.contexts()[0];
      await context.pages()[0].exposeBinding("__cfTestBinding", () => 1);
      const { id, page } = await newTabVia(browser, context);
      const v = await verdict(h.endpoint, id);
      return { ...v, globals: await page.evaluate(GLOBALS).catch((e) => e.message) };
    } finally {
      await h.cleanup();
    }
  },

  async "after-disconnect"() {
    const h = await freshBrowser();
    try {
      const out = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, "--child", h.endpoint], { stdio: ["ignore", "pipe", "inherit"] });
        let s = "";
        child.stdout.on("data", (d) => (s += d));
        child.on("close", (code) => (code === 0 ? resolve(s.trim()) : reject(new Error(`child exit ${code}`))));
      });
      if (out !== "bound") throw new Error(`child said ${out}`);
      return { ...(await verdict(h.endpoint, await openViaHttp(h.endpoint))), globals: "(not checked: no connection)" };
    } finally {
      await h.cleanup();
    }
  },

  async "mcp-tab"() {
    const info = await sessionManager.open({ attach_cdp: true });
    const s = sessionManager.sessions.get(info.session_id);
    try {
      const page = s.pages.get("main");
      const id = await targetIdOf(s.context, page);
      page.goto(URL_).catch(() => {});
      const v = await verdict(s.attachCdp.endpoint, id);
      return { ...v, globals: await page.evaluate(GLOBALS).catch((e) => e.message) };
    } finally {
      await sessionManager.close(info.session_id);
    }
  },

  async "mcp-other-tab"() {
    const info = await sessionManager.open({ attach_cdp: true });
    const s = sessionManager.sessions.get(info.session_id);
    try {
      const { id, page } = await newTabVia(s.browser, s.context);
      const v = await verdict(s.attachCdp.endpoint, id);
      return { ...v, globals: await page.evaluate(GLOBALS).catch((e) => e.message) };
    } finally {
      await sessionManager.close(info.session_id);
    }
  },
};

const picked = process.argv.slice(2);
const names = picked.length ? picked : Object.keys(CONDITIONS);
for (const n of names) if (!CONDITIONS[n]) throw new Error(`Unknown condition "${n}". Known: ${Object.keys(CONDITIONS).join(", ")}`);

console.log(`URL ${URL_}, ${ROUNDS} round(s), ${WAIT_MS / 1000} s wait\n`);
const summary = [];
for (const n of names) {
  let passes = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    let res;
    try {
      res = await CONDITIONS[n]();
    } catch (e) {
      res = { pass: false, error: e.message };
    }
    if (res.pass) passes++;
    console.log(`${n.padEnd(17)} round ${r}: ${res.pass ? "PASS" : "FAIL"} ${JSON.stringify(res)}`);
  }
  summary.push(`${n.padEnd(17)} ${passes}/${ROUNDS} passed`);
}
console.log(`\n${summary.join("\n")}`);
process.exit(0);
