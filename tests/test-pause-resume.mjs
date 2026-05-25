#!/usr/bin/env node
/**
 * Smoke: pause_session + resume_session round-trip preserves cookies +
 * localStorage. Refuses on attach_cdp and record_video sessions.
 *
 * Run after `npm run build`.
 */
import http from "node:http";
import { sessionManager } from "../dist/core/sessions.js";

const log = (...a) => console.log("[t]", ...a);
const fail = (m) => { console.error("[t] FAIL", m); process.exit(1); };
const ok = (m) => log("PASS —", m);

// --- tiny local http server (real http origin so cookies stick) -------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><body><h1>pause-test</h1></body></html>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/`;
log(`local fixture server: ${baseUrl}`);

async function main() {
  // ---- 1. Open a session, plant some cookies + localStorage ----
  log("Test 1 — plant cookies + localStorage on the local http origin");
  const s1 = await sessionManager.open({ url: baseUrl, viewport: { width: 1024, height: 768 } });
  log(`opened session_id=${s1.session_id}`);

  const page1 = sessionManager.getPage(s1.session_id);

  // Cookies need a real http origin (data: URLs don't accept them) — that's
  // what the local server above is for. example.com used to be the easy
  // option but it makes the test internet-dependent.
  await page1.evaluate(() => {
    localStorage.setItem("bm-pause-test", "hello-from-original-session");
    document.cookie = "bm-pause-cookie=cookie-value-original; path=/";
  });
  const beforeLs = await page1.evaluate(() => localStorage.getItem("bm-pause-test"));
  const beforeCookies = await sessionManager.get(s1.session_id).context.cookies();
  log(`pre-pause: ls="${beforeLs}" cookies=${beforeCookies.length}`);
  if (beforeLs !== "hello-from-original-session") fail("localStorage didn't plant");
  if (!beforeCookies.find((c) => c.name === "bm-pause-cookie")) fail("cookie didn't plant");
  ok("planted cookies + localStorage in session 1");

  // ---- 2. pause_session — should close the session and return the snapshot ----
  log("Test 2 — pause_session returns snapshot + closes session");
  const paused = await sessionManager.pauseSession(s1.session_id);
  if (!paused.snapshot) fail("snapshot missing on pause result");
  if (!paused.snapshot.storage_state) fail("snapshot.storage_state missing");
  if (paused.snapshot.url !== baseUrl) fail(`snapshot.url=${paused.snapshot.url}`);
  if (paused.snapshot.viewport.width !== 1024) fail("snapshot.viewport not propagated");
  ok(`pause returned snapshot, url=${paused.snapshot.url}, viewport=${paused.snapshot.viewport.width}x${paused.snapshot.viewport.height}`);

  // verify original session is gone
  try {
    sessionManager.get(s1.session_id);
    fail("original session is still alive after pause");
  } catch {
    ok("original session is gone (as expected)");
  }

  // ---- 3. resume_session — should hydrate cookies + localStorage ----
  log("Test 3 — resume_session restores storage_state");
  const s2 = await sessionManager.resumeSession({ snapshot: paused.snapshot });
  log(`resumed session_id=${s2.session_id}`);
  if (s2.session_id === s1.session_id) fail("resume_session returned the OLD session_id; should be NEW");

  const page2 = sessionManager.getPage(s2.session_id);
  if (!page2.url().startsWith(baseUrl)) fail(`resumed page url is ${page2.url()}, expected ${baseUrl}`);

  const afterLs = await page2.evaluate(() => localStorage.getItem("bm-pause-test"));
  const afterCookies = await sessionManager.get(s2.session_id).context.cookies();
  log(`post-resume: ls="${afterLs}" cookies=${afterCookies.length}`);
  if (afterLs !== "hello-from-original-session") fail(`localStorage NOT restored, got "${afterLs}"`);
  if (!afterCookies.find((c) => c.name === "bm-pause-cookie")) fail("cookie NOT restored");
  ok("storage_state survived pause/resume round-trip");

  await sessionManager.close(s2.session_id);

  // ---- 4. Refuse on record_video ----
  log("Test 4 — pause_session refuses on record_video session");
  const s3 = await sessionManager.open({ url: "data:text/html,<h1>video</h1>", record_video: true });
  let videoRefused = false;
  try { await sessionManager.pauseSession(s3.session_id); }
  catch (e) {
    videoRefused = true;
    if (!/record_video/.test(e.message)) fail(`expected record_video in error message, got: ${e.message}`);
  }
  if (!videoRefused) fail("expected pause to throw on record_video session");
  ok("pause_session correctly refused record_video session");
  await sessionManager.close(s3.session_id);

  // ---- 5. resume_session rejects malformed snapshot ----
  log("Test 5 — resume_session rejects empty / malformed snapshot");
  let badSnapRefused = false;
  try { await sessionManager.resumeSession({ snapshot: {} }); }
  catch (e) {
    badSnapRefused = true;
    if (!/snapshot/.test(e.message)) fail(`expected snapshot in error message, got: ${e.message}`);
  }
  if (!badSnapRefused) fail("expected resume to throw on empty snapshot");
  ok("resume_session correctly refused malformed snapshot");

  log("\n===== ALL CHECKS PASSED =====");
}

await main().catch((e) => {
  console.error("[t] FATAL", e);
  process.exit(1);
}).finally(() => {
  server.close();
});

process.exit(0);
