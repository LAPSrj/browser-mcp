#!/usr/bin/env node
// open_session human_mouse: clicks and hovers move the mouse like a person.
//
// Over MCP stdio with the dev plugin, on a page built in about:blank:
// 1. human_mouse:true: a click sends 8+ whole-pixel mousemoves before the
//    press, holds the button 50-150 ms, and fires one click inside the
//    element.
// 2. click_count 2 fires dblclick; hover moves without clicking.
// 3. A covered element still fails fast, naming the cover.
// 4. An evaluate_script "click" action takes the same path.
// 5. A regular session defaults to off: one mousemove, as Playwright sends.
// 6. On Windows/WSL with a Chromium-family browser, attach_cdp defaults to on.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectInstalledChromium, isWindowsOrWsl } from "./_helpers.mjs";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, BROWSER_MCP_PLUGINS: "dev" },
    stderr: "ignore",
  }),
);
const call = (name, args) => client.callTool({ name, arguments: args });
const first = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const evalValue = async (sid, script) => JSON.parse(first(await call("evaluate_script", { session_id: sid, script, waitForNetworkIdle: false })));

const SETUP = `
  document.body.innerHTML = '<button id="btn" style="position:absolute;left:300px;top:200px;width:160px;height:60px">Go</button>' +
    '<div id="under" style="position:absolute;left:300px;top:400px;width:100px;height:40px">under</div>' +
    '<div style="position:absolute;left:290px;top:390px;width:140px;height:70px;background:#eee">cover</div>';
  window.__ev = [];
  for (const t of ['mousemove', 'mouseover', 'mousedown', 'mouseup', 'click', 'dblclick'])
    document.addEventListener(t, (e) => window.__ev.push({ t, x: e.clientX, y: e.clientY, ts: e.timeStamp }), true);
  return true;`;
const EVENTS = "const ev = window.__ev; window.__ev = []; return ev;";
const BOX = "const r = document.getElementById('btn').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom };";

function clickShape(ev) {
  const down = ev.findIndex((e) => e.t === "mousedown");
  const up = ev.findIndex((e) => e.t === "mouseup");
  return {
    moves: ev.slice(0, down).filter((e) => e.t === "mousemove"),
    held: down >= 0 && up >= 0 ? ev[up].ts - ev[down].ts : null,
    clicks: ev.filter((e) => e.t === "click"),
  };
}

async function openOn(args) {
  const r = await call("open_session", { url: "about:blank", ...args });
  const sid = JSON.parse(first(r)).session_id;
  await evalValue(sid, SETUP);
  return sid;
}

async function checkHumanClick(sid, label) {
  const box = await evalValue(sid, BOX);
  const r = await call("click", { session_id: sid, selector: "#btn" });
  check(!r.isError, `${label}: click succeeds`, first(r));
  const { moves, held, clicks } = clickShape(await evalValue(sid, EVENTS));
  check(moves.length >= 8, `${label}: 8+ mousemoves before the press`, moves.length);
  check(moves.every((m) => Number.isInteger(m.x) && Number.isInteger(m.y)), `${label}: whole-pixel coordinates`, moves.slice(-3));
  check(held !== null && held >= 45 && held <= 200, `${label}: button held 50-150 ms`, held);
  check(clicks.length === 1, `${label}: one click`, clicks.length);
  const c = clicks[0];
  check(c && c.x >= box.l && c.x <= box.r && c.y >= box.t && c.y <= box.b, `${label}: click inside the button`, { c, box });
}

const sessions = [];
try {
  console.log("1-4. human_mouse:true on a regular session");
  const sid = await openOn({ human_mouse: true });
  sessions.push(sid);
  await checkHumanClick(sid, "click");

  await call("click", { session_id: sid, selector: "#btn", click_count: 2 });
  const dbl = await evalValue(sid, EVENTS);
  check(dbl.filter((e) => e.t === "dblclick").length === 1, "click_count 2 fires dblclick", dbl.map((e) => e.t).filter((t) => t !== "mousemove"));

  await call("hover", { session_id: sid, selector: "#btn" });
  const hov = await evalValue(sid, EVENTS);
  check(!hov.some((e) => e.t === "click" || e.t === "mousedown"), "hover doesn't press", hov.map((e) => e.t));

  const t0 = Date.now();
  const covered = await call("click", { session_id: sid, selector: "#under" });
  check(covered.isError && /covers it/.test(first(covered)) && Date.now() - t0 < 15000, "covered element fails fast", first(covered).slice(0, 200));

  await call("evaluate_script", { session_id: sid, script: "return 1", actions: [{ action: "click", selector: "#btn" }], waitForNetworkIdle: false });
  const act = clickShape(await evalValue(sid, EVENTS));
  check(act.moves.length >= 8 && act.clicks.length === 1, "evaluate_script click action moves like a person", { moves: act.moves.length, clicks: act.clicks.length });

  console.log("5. regular session default");
  const plain = await openOn({});
  sessions.push(plain);
  await call("click", { session_id: plain, selector: "#btn" });
  const p = clickShape(await evalValue(plain, EVENTS));
  check(p.moves.length === 1 && p.clicks.length === 1, "default off: one mousemove, one click", { moves: p.moves.length, clicks: p.clicks.length });

  if (isWindowsOrWsl() && detectInstalledChromium()) {
    console.log("6. attach_cdp default");
    const cdp = await openOn({ attach_cdp: true });
    sessions.push(cdp);
    await checkHumanClick(cdp, "attach_cdp default on");
  } else {
    console.log("6. attach_cdp default: skipped (needs Windows/WSL and a Chromium-family browser)");
  }
} finally {
  for (const sid of sessions) await call("close_session", { session_id: sid }).catch(() => {});
  await client.close();
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
