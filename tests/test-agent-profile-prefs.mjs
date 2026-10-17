#!/usr/bin/env node
// BROWSER_MCP_AGENT_PROFILES: which user_data_dir paths browser-mcp may edit,
// and the translate pref it writes into them.
// 1. isAgentProfile matches listed paths case-insensitively for Windows
//    paths, ignores trailing separators and / vs \, and matches nothing
//    when the variable is unset.
// 2. disableTranslatePref keeps every other pref, creates Default/Preferences
//    when missing, leaves an unchanged file untouched, and refuses to
//    replace a file that isn't valid JSON.
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAgentProfile, disableTranslatePref } from "../dist/utils/cdp-relay.js";

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

console.log("1. isAgentProfile");
const env = { BROWSER_MCP_AGENT_PROFILES: "C:\\edge-cdp-profile; D:/Agents/Chrome Profile/" };
check(isAgentProfile("C:\\edge-cdp-profile", env), "exact path");
check(isAgentProfile("c:\\EDGE-CDP-PROFILE\\", env), "case and trailing backslash");
check(isAgentProfile("D:\\Agents\\Chrome Profile", env), "forward slashes and a trailing slash in the list");
check(!isAgentProfile("C:\\edge-cdp-profile2", env), "a longer path doesn't match");
check(!isAgentProfile("C:\\edge-cdp-profile", {}), "unset variable matches nothing");
check(isAgentProfile("/home/a/profile/", { BROWSER_MCP_AGENT_PROFILES: "/home/a/profile" }), "POSIX path");
check(!isAgentProfile("/home/a/Profile", { BROWSER_MCP_AGENT_PROFILES: "/home/a/profile" }), "POSIX paths stay case-sensitive");

console.log("2. disableTranslatePref");
const root = mkdtempSync(path.join(os.tmpdir(), "bm-prefs-"));
const dir = path.join(root, "Default");
mkdirSync(dir);
const file = path.join(dir, "Preferences");
writeFileSync(file, JSON.stringify({ translate: { enabled: true, other: 1 }, profile: { name: "agents" } }));
disableTranslatePref(dir);
let prefs = JSON.parse(readFileSync(file, "utf8"));
check(prefs.translate.enabled === false && prefs.translate.other === 1 && prefs.profile.name === "agents", "sets the pref and keeps the rest", prefs);

const mtime = statSync(file).mtimeMs;
await new Promise((r) => setTimeout(r, 20));
disableTranslatePref(dir);
check(statSync(file).mtimeMs === mtime, "already off: the file isn't rewritten");

const fresh = path.join(root, "fresh", "Default");
disableTranslatePref(fresh);
prefs = JSON.parse(readFileSync(path.join(fresh, "Preferences"), "utf8"));
check(prefs.translate?.enabled === false, "creates Default/Preferences when missing", prefs);

writeFileSync(file, "{not json");
let threw = false;
try { disableTranslatePref(dir); } catch (e) { threw = /not valid JSON/.test(e.message); }
check(threw && readFileSync(file, "utf8") === "{not json", "invalid JSON is an error and the file is left as it was");

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
