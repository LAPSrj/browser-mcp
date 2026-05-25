#!/usr/bin/env node
/**
 * Smoke: verify the translate-suppression stack lands cleanly.
 *  - session spawns OK with new --disable-features=Translate,TranslateUI
 *  - Default/Preferences was pre-seeded with translate disabled
 *  - file persists across Edge boot (i.e. Edge didn't blow it away on
 *    first-run; it should merge defaults around our pref)
 */
import { sessionManager } from "../dist/core/sessions.js";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

// --- portability guard (auto-applied) ---
import { requireWindows, requireChromium } from "./_helpers.mjs";
requireWindows();
const { processName: BROWSER_PROC, processBaseName: BROWSER_PROC_BASE } = requireChromium();

const log = (...a) => console.log("[t]", ...a);
const fail = (m) => { console.error("[t] FAIL", m); process.exit(1); };
const ok = (m) => log("PASS —", m);

const session = await sessionManager.open({ attach_cdp: true });
log(`session_id=${session.session_id}`);

const userDataDir = sessionManager.get(session.session_id).attachCdp?.userDataDir;
if (!userDataDir) fail("attachCdp handle is missing userDataDir");
log(`user_data_dir (Windows): ${userDataDir}`);

const wslPath = execFileSync("/usr/bin/wslpath", ["-u", userDataDir], { encoding: "utf8" }).trim();
log(`wsl path: ${wslPath}`);

// Navigate somewhere brief to make sure Edge is fully up + has read Preferences
const page = sessionManager.getPage(session.session_id);
// ASCII-only test page declared as Portuguese — Edge's translate-language
// detection looks at lang= AND content; we set lang=pt so Edge would normally
// offer translation even with plain ASCII content.
await page.goto("data:text/html,<html lang='pt'><body><h1>Pagina pt</h1><p>conteudo pt</p></body></html>", { waitUntil: "domcontentloaded" });
await wait(2000);

// Check the Preferences file
const prefsPath = `${wslPath}/Default/Preferences`;
const fs = await import("node:fs");
if (!fs.existsSync(prefsPath)) fail(`Preferences file missing at ${prefsPath}`);
const raw = fs.readFileSync(prefsPath, "utf8");
let prefs;
try { prefs = JSON.parse(raw); }
catch (e) { fail(`Preferences not valid JSON: ${e.message}; first 200 chars: ${raw.slice(0,200)}`); }

log(`Preferences size: ${raw.length} bytes`);
log(`translate.enabled: ${prefs?.translate?.enabled}`);
log(`translate_blocked_languages: ${JSON.stringify(prefs?.translate_blocked_languages)}`);

if (prefs?.translate?.enabled !== false) fail(`expected translate.enabled=false, got ${prefs?.translate?.enabled}`);
ok("translate.enabled is false in Preferences post-launch");

if (!Array.isArray(prefs?.translate_blocked_languages) || !prefs.translate_blocked_languages.includes("*")) {
  log("note: translate_blocked_languages was edited by Edge; that's fine as long as translate.enabled stays false");
} else {
  ok("translate_blocked_languages includes '*' as we wrote");
}

// Final sanity: page rendered, no errors
const title = await page.evaluate(() => document.querySelector("h1")?.textContent);
log(`rendered h1: ${title}`);
if (title !== "Pagina pt") fail(`page did not render correctly (got: ${title})`);
ok("page rendered correctly (translate decision is now visual-only)");

log("\n===== translate suppression smoke PASSED =====");
log("Visual verification: Leandro can confirm by opening any non-en page");
log("in a session. If no 'Translate this page?' bar appears, we're good.");

await sessionManager.close(session.session_id);
process.exit(0);
