#!/usr/bin/env node
// Prompts wait for the agent: dialogs, permission requests and HTTP logins.
//
// Checked over MCP stdio against dist/index.js with the dev plugin, on a
// Playwright Chromium session and a local server:
// 1. A click that opens confirm() returns instead of hanging, and the result
//    lists the prompt. Page tools on that tab are refused until it's answered;
//    list_tabs and list_prompts still work. respond_prompt accept makes
//    confirm() return true; a prompt() gets the agent's text.
// 2. handle_next_dialog still answers the next dialog without holding it.
// 3. An HTTP Basic login holds the navigation: wrong credentials open a new
//    prompt marked credentials_rejected, right ones load the page, dismiss
//    gives the page the 401.
// 4. Permission requests wait: accept grants notifications (a second request
//    doesn't ask again), dismiss rejects getUserMedia with NotAllowedError.
// 5. A prompt on another tab doesn't stop a call on this one; list_sessions
//    shows waiting prompts; closing a tab or a session with a held dialog
//    doesn't hang.
// Launches Playwright Chromium.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "..", "dist", "index.js");

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const AUTH = "Basic " + Buffer.from("agent:secret").toString("base64");
const server = http.createServer((req, res) => {
  if (req.url === "/auth") {
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="staging"', "content-type": "text/plain" });
      return res.end("denied");
    }
    res.setHeader("content-type", "text/html");
    return res.end("<title>in</title><p id=msg>logged in</p>");
  }
  res.setHeader("content-type", "text/html");
  res.end(
    "<button id=c onclick=\"window.r = confirm('Delete post?')\">confirm</button>" +
      "<button id=p onclick=\"window.r = prompt('Name?', 'x')\">prompt</button>",
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, BROWSER_MCP_PLUGINS: "dev" },
    stderr: "ignore",
  }),
);

const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const first = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const call = (name, args) => client.callTool({ name, arguments: args });
const evalValue = async (sid, script, extra = {}) => {
  const r = await call("evaluate_script", { session_id: sid, script, waitForNetworkIdle: false, ...extra });
  try { return JSON.parse(first(r)); } catch { return first(r); }
};
const prompts = async (sid) => JSON.parse(first(await call("list_prompts", { session_id: sid })));

let sid;
try {
  const open = await call("open_session", { url: base });
  sid = JSON.parse(first(open)).session_id;
  check(!open.isError && sid, "open_session", text(open));

  // -------------------------------------------------------------------------
  console.log("1. dialogs wait for the agent");
  const t0 = Date.now();
  const click = await call("click", { session_id: sid, selector: "#c" });
  check(Date.now() - t0 < 10000, "click that opens confirm() returns within 10s", Date.now() - t0);
  check(/p\d+: confirm\(\) on tab main: "Delete post\?"/.test(text(click)), "click result lists the confirm", text(click));

  const shot = await call("screenshot", { session_id: sid });
  check(shot.isError && /was not run: tab main has a confirm\(\) dialog waiting/.test(text(shot)), "screenshot on the tab is refused", text(shot));
  const tabs = await call("list_tabs", { session_id: sid });
  check(!tabs.isError && first(tabs).includes(base), "list_tabs still works", text(tabs));

  const waiting = await prompts(sid);
  check(waiting.length === 1 && waiting[0].kind === "dialog" && waiting[0].dialog_type === "confirm", "list_prompts shows the confirm", waiting);
  const answered = await call("respond_prompt", { session_id: sid, prompt_id: waiting[0].prompt_id, action: "accept" });
  check(!answered.isError && !/Waiting for an answer/.test(text(answered)), "respond_prompt accept", text(answered));
  check((await evalValue(sid, "return window.r")) === true, "confirm() returned true");

  await call("click", { session_id: sid, selector: "#p" });
  const [pr] = await prompts(sid);
  check(pr?.dialog_type === "prompt" && pr.default_value === "x", "prompt() is held with its default value", pr);
  await call("respond_prompt", { session_id: sid, prompt_id: pr?.prompt_id, action: "accept", text: "Ada" });
  check((await evalValue(sid, "return window.r")) === "Ada", "prompt() returned the agent's text");

  // -------------------------------------------------------------------------
  console.log("2. handle_next_dialog");
  await call("handle_next_dialog", { session_id: sid, action: "dismiss" });
  const preset = await call("click", { session_id: sid, selector: "#c" });
  check(!preset.isError && !/Waiting for an answer/.test(text(preset)), "preset dialog is answered without holding", text(preset));
  check((await evalValue(sid, "return window.r")) === false, "confirm() returned false");

  // -------------------------------------------------------------------------
  console.log("3. HTTP login");
  // Dismiss first: after a successful login Chrome sends the cached
  // credentials to the origin up front, so no second prompt would open.
  const nav = await call("navigate", { session_id: sid, url: `${base}/auth` });
  check(/HTTP login \(basic, realm "staging"\)/.test(text(nav)), "navigate result lists the login", text(nav));
  let [login] = await prompts(sid);
  check(login?.kind === "http_auth" && login.realm === "staging" && login.credentials_rejected === false, "list_prompts shows the login", login);
  await call("respond_prompt", { session_id: sid, prompt_id: login?.prompt_id, action: "dismiss" });
  await call("wait_for_load_state", { session_id: sid });
  const denied = await call("get_text", { session_id: sid });
  check(first(denied).includes("denied"), "dismiss gives the page the 401", text(denied));

  await call("navigate", { session_id: sid, url: `${base}/auth` });
  [login] = await prompts(sid);
  const noCreds = await call("respond_prompt", { session_id: sid, prompt_id: login?.prompt_id, action: "accept" });
  check(noCreds.isError && /needs username and password/.test(text(noCreds)), "accept without credentials is an error", text(noCreds));
  await call("respond_prompt", { session_id: sid, prompt_id: login?.prompt_id, action: "accept", username: "agent", password: "wrong" });
  await new Promise((r) => setTimeout(r, 500));
  [login] = await prompts(sid);
  check(login?.kind === "http_auth" && login.credentials_rejected === true, "wrong credentials open a new prompt marked rejected", login);
  await call("respond_prompt", { session_id: sid, prompt_id: login?.prompt_id, action: "accept", username: "agent", password: "secret" });
  await call("wait_for_selector", { session_id: sid, selector: "#msg" });
  const loggedIn = await call("get_text", { session_id: sid, selector: "#msg" });
  check(first(loggedIn) === "logged in", "right credentials load the page", text(loggedIn));

  // -------------------------------------------------------------------------
  console.log("4. permission requests");
  await call("navigate", { session_id: sid, url: base });
  const notif = await call("evaluate_script", {
    session_id: sid,
    waitForNetworkIdle: false,
    script: "window.n = Notification.requestPermission(); return await window.n;",
  });
  check(/permission request for notifications from http:\/\/127\.0\.0\.1/.test(text(notif)), "evaluate result lists the notifications request", text(notif));
  let [perm] = await prompts(sid);
  check(perm?.kind === "permission" && perm.permissions?.[0] === "notifications", "list_prompts shows it", perm);
  await call("respond_prompt", { session_id: sid, prompt_id: perm?.prompt_id, action: "accept" });
  check((await evalValue(sid, "return await window.n")) === "granted", "accept: requestPermission() resolves granted");
  const again = await call("evaluate_script", { session_id: sid, waitForNetworkIdle: false, script: "return await Notification.requestPermission()" });
  check(first(again) === '"granted"' && !/Waiting for an answer/.test(text(again)), "a second request doesn't ask again", text(again));

  await call("evaluate_script", {
    session_id: sid,
    waitForNetworkIdle: false,
    script: "window.m = navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(() => 'ok', (e) => e.name); return await window.m;",
  });
  [perm] = await prompts(sid);
  check(perm?.permissions?.join(",") === "microphone,camera", "getUserMedia asks for microphone + camera", perm);
  await call("respond_prompt", { session_id: sid, prompt_id: perm?.prompt_id, action: "dismiss" });
  check((await evalValue(sid, "return await window.m")) === "NotAllowedError", "dismiss: getUserMedia rejects with NotAllowedError");
  check((await evalValue(sid, "return (await navigator.permissions.query({ name: 'camera' })).state")) === "prompt", "dismiss saves nothing");

  // -------------------------------------------------------------------------
  console.log("5. other tabs, list_sessions, close");
  await call("open_tab", { session_id: sid, tab_id: "other", url: base });
  await call("switch_tab", { session_id: sid, tab_id: "main" });
  await call("click", { session_id: sid, tab_id: "other", selector: "#c" });
  const onMain = await call("get_text", { session_id: sid, selector: "#c" });
  check(!onMain.isError && first(onMain) === "confirm" && /tab other/.test(text(onMain)), "a call on main runs and lists the dialog on tab other", text(onMain));
  const sessions = JSON.parse(first(await call("list_sessions", {})));
  check(sessions.find((s) => s.session_id === sid)?.prompts?.length === 1, "list_sessions shows the waiting prompt", sessions);
  await call("open_tab", { session_id: sid, tab_id: "third", url: base });
  await call("click", { session_id: sid, tab_id: "third", selector: "#c" });
  const closedTab = await call("close_tab", { session_id: sid, tab_id: "third" });
  const left = await prompts(sid);
  check(!closedTab.isError && left.length === 1 && left[0].tab_id === "other", "close_tab with a held dialog drops its prompt", { closedTab: text(closedTab), left });
  const t1 = Date.now();
  const closed = await call("close_session", { session_id: sid });
  check(!closed.isError && Date.now() - t1 < 15000, "close_session with a held dialog", text(closed));
  sid = undefined;
} finally {
  if (sid) await call("close_session", { session_id: sid }).catch(() => {});
  await client.close();
  server.close();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
