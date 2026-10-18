#!/usr/bin/env node
// open_session human_behavior: input that acts like a person's.
//
// Over MCP stdio with the dev plugin, on a page built in about:blank:
// 1. A click sends 8+ whole-pixel mousemoves before the press, holds the
//    button 50-150 ms, and fires one click inside the element. click_count 2
//    fires dblclick, hover doesn't press, a covered element still fails fast,
//    and an evaluate_script "click" action takes the same path.
// 2. type_text clicks into the field, clears it with select-all + Backspace,
//    and types key by key with Shift held for capitals; clear:false adds at
//    the end; long text is pasted (Ctrl+V keys and a paste event); a date is
//    typed into the date input's segments; a time input is set after a
//    pause; the evaluate_script "type" action types too.
// 3. press_key focuses its selector with a click; check clicks the checkbox;
//    select_option clicks the dropdown open, moves with the arrows past a
//    disabled option, presses Enter, and the change event is trusted.
// 4. Clicking an element out of view scrolls with the wheel first; scroll
//    by y uses the wheel and reports the distance moved.
// 5. drag presses, moves along a path and releases over the target.
// 6. A regular session defaults to off: Playwright's one mousemove and fill().
// 7. On Windows/WSL with a Chromium-family browser, attach_cdp defaults to on.
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

const abs = (l, t, w, h) => `position:absolute;left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
const SETUP = `
  document.body.innerHTML =
    '<button id="btn" style="${abs(300, 200, 160, 60)}">Go</button>' +
    '<div id="under" style="${abs(300, 400, 100, 40)}">under</div>' +
    '<div style="${abs(290, 390, 140, 70)};background:#eee">cover</div>' +
    '<input id="name" value="old" style="${abs(40, 40, 200, 30)}">' +
    '<textarea id="bio" style="${abs(40, 100, 200, 60)}"></textarea>' +
    '<input id="day" type="date" style="${abs(40, 180, 200, 30)}">' +
    '<input id="agree" type="checkbox" style="${abs(40, 240, 20, 20)}">' +
    '<select id="color" style="${abs(40, 280, 120, 30)}"><option value="r">Red</option><option value="g">Green</option><option value="x" disabled>Gray</option><option value="b">Blue</option></select>' +
    '<input id="tm" type="time" style="${abs(40, 330, 120, 30)}">' +
    '<div id="src" style="${abs(600, 40, 80, 80)};background:#cfc">src</div>' +
    '<div id="dst" style="${abs(800, 40, 120, 120)};background:#ccf">dst</div>' +
    '<button id="far" style="${abs(300, 3000, 160, 60)}">Far</button>' +
    '<div style="${abs(0, 4000, 10, 10)}"></div>';
  window.__ev = [];
  const id = (e) => (e.target && e.target.id) || (e.target && e.target.tagName) || '';
  for (const t of ['mousemove', 'mouseover', 'mousedown', 'mouseup', 'click', 'dblclick'])
    document.addEventListener(t, (e) => window.__ev.push({ t, x: e.clientX, y: e.clientY, ts: e.timeStamp, id: id(e) }), true);
  document.addEventListener('keydown', (e) => window.__ev.push({ t: 'keydown', key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, ts: e.timeStamp, id: id(e) }), true);
  addEventListener('wheel', (e) => window.__ev.push({ t: 'wheel', dy: e.deltaY, ts: e.timeStamp }), { capture: true, passive: true });
  document.addEventListener('paste', (e) => window.__ev.push({ t: 'paste', len: e.clipboardData.getData('text/plain').length, id: id(e) }), true);
  for (const t of ['change']) document.addEventListener(t, (e) => window.__ev.push({ t, trusted: e.isTrusted, id: id(e) }), true);
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

const value = (sid, sel) => evalValue(sid, `return document.querySelector(${JSON.stringify(sel)}).value`);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const sessions = [];
try {
  console.log("1. clicks");
  const sid = await openOn({ human_behavior: true });
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

  console.log("2. typing");
  await call("type_text", { session_id: sid, selector: "#name", text: "Hi There!" });
  let ev = await evalValue(sid, EVENTS);
  check((await value(sid, "#name")) === "Hi There!", "type_text replaces the value", await value(sid, "#name"));
  const firstKey = ev.findIndex((e) => e.t === "keydown");
  check(ev.slice(0, firstKey).some((e) => e.t === "mousedown" && e.id === "name"), "clicks into the field before typing");
  const keys = ev.filter((e) => e.t === "keydown");
  const [ctrl, a, bs] = keys;
  check(["Control", "Meta"].includes(ctrl?.key) && a?.key.toLowerCase() === "a" && a.ctrl && bs?.key === "Backspace", "clears with select-all + Backspace", keys.slice(0, 3));
  check(a && ctrl && a.ts - ctrl.ts >= 30, "the modifier goes down before the key", a && ctrl && a.ts - ctrl.ts);
  const typed = keys.slice(3).filter((k) => k.key !== "Shift");
  check(typed.map((k) => k.key).join("") === "Hi There!", "one keydown per character", typed.map((k) => k.key));
  check(typed.filter((k) => /[A-Z!]/.test(k.key)).every((k) => k.shift), "Shift held for capitals and !", typed.filter((k) => /[A-Z!]/.test(k.key)));
  const gaps = typed.slice(1).map((k, i) => k.ts - typed[i].ts);
  check(median(gaps) >= 40, "a person's pace between keys", gaps.map(Math.round));

  await call("type_text", { session_id: sid, selector: "#name", text: " again", clear: false });
  check((await value(sid, "#name")) === "Hi There! again", "clear:false adds at the end", await value(sid, "#name"));
  await evalValue(sid, EVENTS);

  const long = "Lorem ipsum dolor sit amet. ".repeat(10);
  const t1 = Date.now();
  await call("type_text", { session_id: sid, selector: "#bio", text: long });
  ev = await evalValue(sid, EVENTS);
  const pasteKeys = ev.filter((e) => e.t === "keydown").map((e) => e.key);
  check((await value(sid, "#bio")) === long && Date.now() - t1 < 8000, "long text goes in at once", { ms: Date.now() - t1 });
  check(ev.some((e) => e.t === "paste" && e.len === long.length && e.id === "bio") && pasteKeys.includes("v") && pasteKeys.some((k) => k === "Control" || k === "Meta"),
    "it's pasted: Ctrl+V keys and a paste event with the text", pasteKeys);

  await call("type_text", { session_id: sid, selector: "#day", text: "2024-05-01" });
  ev = await evalValue(sid, EVENTS);
  check((await value(sid, "#day")) === "2024-05-01", "a date is typed into the date input", await value(sid, "#day"));
  check(ev.some((e) => e.t === "keydown" && e.key === "5") && ev.filter((e) => e.t === "change" && e.id === "day").every((e) => e.trusted),
    "the date's key events and change events are real", ev.filter((e) => e.t === "change"));

  const t2 = Date.now();
  await call("type_text", { session_id: sid, selector: "#tm", text: "09:30" });
  check((await value(sid, "#tm")) === "09:30" && Date.now() - t2 >= 800, "a time input is set after a pause for picking", { ms: Date.now() - t2 });
  await evalValue(sid, EVENTS);

  await call("evaluate_script", { session_id: sid, script: "return 1", actions: [{ action: "type", selector: "#bio", text: "ok" }], waitForNetworkIdle: false });
  ev = await evalValue(sid, EVENTS);
  check((await value(sid, "#bio")) === "ok" && ev.filter((e) => e.t === "keydown" && e.key === "o").length === 1, "the type action types key by key", await value(sid, "#bio"));

  console.log("3. press_key, check, select");
  await call("press_key", { session_id: sid, selector: "#name", key: "End" });
  ev = await evalValue(sid, EVENTS);
  check(ev.some((e) => e.t === "mousedown" && e.id === "name") && ev.some((e) => e.t === "keydown" && e.key === "End"), "press_key clicks its selector, then presses", ev.filter((e) => e.t !== "mousemove").map((e) => e.t));

  await call("check", { session_id: sid, selector: "#agree" });
  ev = await evalValue(sid, EVENTS);
  check((await evalValue(sid, "return document.querySelector('#agree').checked")) === true && clickShape(ev).moves.length >= 8, "check clicks like a person");
  const again = await call("check", { session_id: sid, selector: "#agree" });
  ev = await evalValue(sid, EVENTS);
  check(!again.isError && !ev.some((e) => e.t === "mousedown"), "check on a checked box doesn't click");

  const sel = await call("select_option", { session_id: sid, selector: "#color", value: "b" });
  ev = await evalValue(sid, EVENTS);
  // The open list takes the arrow keys and Enter, so the page sees only the
  // click and the change.
  const changes = ev.filter((e) => e.t === "change" && e.id === "color");
  check((await value(sid, "#color")) === "b" && first(sel).includes('"b"'), "select_option picks the option past a disabled one", first(sel));
  check(ev.some((e) => e.t === "mousedown" && e.id === "color"), "it clicks the dropdown open");
  check(changes.length === 1 && changes[0].trusted, "one trusted change event", changes);
  await call("select_option", { session_id: sid, selector: "#color", label: "Red" });
  ev = await evalValue(sid, EVENTS);
  check((await value(sid, "#color")) === "r" && ev.filter((e) => e.t === "change").every((e) => e.trusted), "and back up by label");

  console.log("4. scrolling");
  await call("click", { session_id: sid, selector: "#far" });
  ev = await evalValue(sid, EVENTS);
  const wheels = ev.filter((e) => e.t === "wheel");
  check(wheels.length >= 5 && ev.some((e) => e.t === "click" && e.id === "far"), "an element out of view is wheeled to, then clicked", { wheels: wheels.length });
  const sc = await call("scroll", { session_id: sid, y: -500 });
  const m = /y=(-?\d+)/.exec(first(sc));
  ev = await evalValue(sid, EVENTS);
  check(m && Number(m[1]) <= -380 && Number(m[1]) >= -620 && ev.some((e) => e.t === "wheel"), "scroll by y uses the wheel and reports the distance", first(sc));
  await call("scroll", { session_id: sid, to: "top" });
  check((await evalValue(sid, "return scrollY")) === 0, "scroll to top");
  await evalValue(sid, EVENTS);

  console.log("5. drag");
  await call("drag", { session_id: sid, from_selector: "#src", to_selector: "#dst" });
  ev = await evalValue(sid, EVENTS);
  const down = ev.findIndex((e) => e.t === "mousedown");
  const up = ev.findIndex((e) => e.t === "mouseup");
  check(down >= 0 && ev[down].id === "src" && up > down && ev[up].id === "dst" && ev.slice(down, up).filter((e) => e.t === "mousemove").length >= 8,
    "drag presses on src, moves along a path, releases on dst", ev.filter((e) => e.t !== "mousemove").map((e) => `${e.t}:${e.id}`));

  console.log("6. regular session default");
  const plain = await openOn({});
  sessions.push(plain);
  await call("click", { session_id: plain, selector: "#btn" });
  const p = clickShape(await evalValue(plain, EVENTS));
  check(p.moves.length === 1 && p.clicks.length === 1, "default off: one mousemove, one click", { moves: p.moves.length, clicks: p.clicks.length });
  await call("type_text", { session_id: plain, selector: "#name", text: "Hi" });
  ev = await evalValue(plain, EVENTS);
  check((await value(plain, "#name")) === "Hi" && !ev.some((e) => e.t === "keydown"), "default off: type_text fills without key events");

  if (isWindowsOrWsl() && detectInstalledChromium()) {
    console.log("7. attach_cdp default");
    const cdp = await openOn({ attach_cdp: true });
    sessions.push(cdp);
    await checkHumanClick(cdp, "attach_cdp default on");
    await call("type_text", { session_id: cdp, selector: "#name", text: "Edge" });
    ev = await evalValue(cdp, EVENTS);
    check((await value(cdp, "#name")) === "Edge" && ev.filter((e) => e.t === "keydown" && e.key !== "Shift").length >= 6, "attach_cdp: types key by key", await value(cdp, "#name"));
    // Edge takes the date field order from the Windows regional settings.
    await call("type_text", { session_id: cdp, selector: "#day", text: "2024-05-01" });
    check((await value(cdp, "#day")) === "2024-05-01", "attach_cdp: a date is typed in the field's order", await value(cdp, "#day"));
    await call("type_text", { session_id: cdp, selector: "#day", text: "2025-12-31" });
    check((await value(cdp, "#day")) === "2025-12-31", "attach_cdp: a second date uses the order that worked", await value(cdp, "#day"));
    await evalValue(cdp, EVENTS);
    await call("select_option", { session_id: cdp, selector: "#color", value: "b" });
    ev = await evalValue(cdp, EVENTS);
    check((await value(cdp, "#color")) === "b" && ev.some((e) => e.t === "change" && e.trusted), "attach_cdp: select_option with the arrows", await value(cdp, "#color"));
  } else {
    console.log("7. attach_cdp default: skipped (needs Windows/WSL and a Chromium-family browser)");
  }
} finally {
  for (const sid of sessions) await call("close_session", { session_id: sid }).catch(() => {});
  await client.close();
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
