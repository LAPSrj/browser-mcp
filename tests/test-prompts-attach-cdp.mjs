#!/usr/bin/env node
// Prompts on an attach_cdp browser (Edge on Windows/WSL by default).
//
// The Playwright-Chromium side is covered by test-prompts.mjs; this checks
// what differs on an attached browser: the profile's existing context, a
// headed window, real devices, and Edge's own login dialog. Over MCP stdio
// with the dev plugin, against public pages (the Windows browser can't reach
// a WSL-only local server under NAT networking):
// 1. confirm() is held and answered.
// 2. Geolocation accept grants it; camera dismiss rejects with
//    NotAllowedError; camera accept lets getUserMedia run (NotFoundError
//    without a camera also counts, since the browser got past the prompt).
// 3. An HTTP Basic login on httpbin.org is held, then loads with credentials.
// 4. After close + reopen on the same profile, geolocation is back to
//    "prompt": Browser.setPermission grants aren't saved in the profile.
// 5. With TEST_USER_DATA_DIR set, that profile is passed as user_data_dir and
//    listed in BROWSER_MCP_AGENT_PROFILES; when this run spawned the browser,
//    its Default/Preferences must have translate.enabled=false.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requireWindows, requireChromium } from "./_helpers.mjs";

requireWindows();
requireChromium();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "..", "dist", "index.js");
const profile = process.env.TEST_USER_DATA_DIR;

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
    env: {
      ...process.env,
      BROWSER_MCP_PLUGINS: "dev",
      ...(profile ? { BROWSER_MCP_AGENT_PROFILES: profile } : {}),
    },
    stderr: "ignore",
  }),
);

const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const first = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const call = (name, args) => client.callTool({ name, arguments: args });
const evalValue = async (sid, script) => {
  const r = await call("evaluate_script", { session_id: sid, script, waitForNetworkIdle: false });
  try { return JSON.parse(first(r)); } catch { return first(r); }
};
const prompts = async (sid) => JSON.parse(first(await call("list_prompts", { session_id: sid })));
const openArgs = { attach_cdp: true, url: "https://example.com", ...(profile ? { user_data_dir: profile } : {}) };
const geoState = "return (await navigator.permissions.query({ name: 'geolocation' })).state";

let sid;
try {
  const open = await call("open_session", openArgs);
  sid = JSON.parse(first(open)).session_id;
  check(!open.isError && sid, "open_session attach_cdp", text(open));
  const status = JSON.parse(first(await call("browser_status", { session_id: sid })));
  console.log(`  (attached_via ${status.attached_via}, profile ${status.user_data_dir})`);

  if (profile && status.attached_via === "spawn") {
    console.log("5. translate pref on the agent profile");
    const prefsPath = execFileSync("/usr/bin/wslpath", ["-u", `${profile}\\Default\\Preferences`], { encoding: "utf8" }).trim();
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    check(prefs?.translate?.enabled === false, "Default/Preferences has translate.enabled=false", prefs?.translate);
  } else if (profile) {
    console.log("5. skipped: the browser was already running, so this run didn't spawn it");
  }

  console.log("1. dialog");
  const confirmCall = await call("evaluate_script", { session_id: sid, waitForNetworkIdle: false, script: "window.r = confirm('Delete post?'); return window.r" });
  check(/confirm\(\) on tab main: "Delete post\?"/.test(text(confirmCall)), "confirm() is held and listed", text(confirmCall));
  let [p] = await prompts(sid);
  await call("respond_prompt", { session_id: sid, prompt_id: p?.prompt_id, action: "accept" });
  check((await evalValue(sid, "return window.r")) === true, "accept: confirm() returned true");

  console.log("2. permissions");
  const geoBefore = await evalValue(sid, geoState);
  console.log(`  (geolocation state before: ${geoBefore})`);
  if (geoBefore === "prompt") {
    await call("evaluate_script", {
      session_id: sid,
      waitForNetworkIdle: false,
      script: "window.g = new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('position'), (e) => r('error ' + e.code), { timeout: 8000 })); return await window.g",
    });
    [p] = await prompts(sid);
    check(p?.kind === "permission" && p.permissions?.join() === "geolocation" && p.url === "https://example.com", "geolocation request is held", p);
    const granted = await call("respond_prompt", { session_id: sid, prompt_id: p?.prompt_id, action: "accept" });
    check(!granted.isError, "respond_prompt accept", text(granted));
    check((await evalValue(sid, geoState)) === "granted", "geolocation is granted");
    const g = await evalValue(sid, "return await Promise.race([window.g, new Promise((r) => setTimeout(() => r('still waiting'), 15000))])");
    check(g === "position" || g === "error 2" || g === "error 3", "getCurrentPosition got past the permission (position or no fix)", g);
  } else {
    check(false, "geolocation starts as prompt on example.com (reset it in the profile's site settings to rerun)", geoBefore);
  }

  await call("evaluate_script", {
    session_id: sid,
    waitForNetworkIdle: false,
    script: "window.m = navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => e.name); return await window.m",
  });
  [p] = await prompts(sid);
  if (p?.permissions?.join() === "camera") {
    await call("respond_prompt", { session_id: sid, prompt_id: p.prompt_id, action: "dismiss" });
    check((await evalValue(sid, "return await window.m")) === "NotAllowedError", "dismiss: getUserMedia rejects with NotAllowedError");
    await call("evaluate_script", {
      session_id: sid,
      waitForNetworkIdle: false,
      script: "window.m = navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => e.name); return await window.m",
    });
    [p] = await prompts(sid);
    await call("respond_prompt", { session_id: sid, prompt_id: p?.prompt_id, action: "accept" });
    const cam = await evalValue(sid, "return await Promise.race([window.m, new Promise((r) => setTimeout(() => r('still waiting'), 15000))])");
    check(cam === "ok" || cam === "NotFoundError" || cam === "NotReadableError", "accept: getUserMedia runs (camera opened, or no usable camera)", cam);
  } else {
    check(false, "camera request is held (camera starts as prompt on example.com)", p ?? (await evalValue(sid, "return await window.m")));
  }

  console.log("3. HTTP login");
  const nav = await call("navigate", { session_id: sid, url: "https://httpbin.org/basic-auth/agent/secret" });
  check(/HTTP login \(basic/.test(text(nav)), "navigate result lists the login", text(nav));
  [p] = await prompts(sid);
  await call("respond_prompt", { session_id: sid, prompt_id: p?.prompt_id, action: "accept", username: "agent", password: "secret" });
  await call("wait_for_load_state", { session_id: sid });
  const body = await call("get_text", { session_id: sid });
  check(/"authenticated": true/.test(first(body)), "credentials load the page", text(body));

  console.log("4. grant after reopening");
  await call("close_session", { session_id: sid });
  sid = undefined;
  const reopen = await call("open_session", openArgs);
  sid = JSON.parse(first(reopen)).session_id;
  const after = await evalValue(sid, geoState);
  check(after === "prompt", "a later session asks again (the grant isn't saved in the profile)", after);
} finally {
  if (sid) await call("close_session", { session_id: sid }).catch(() => {});
  await client.close();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
