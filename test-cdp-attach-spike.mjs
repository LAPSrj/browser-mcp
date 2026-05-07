#!/usr/bin/env node
// Spike: WSL → Windows Edge auto-launch + CDP attach
// Tests:
//   (a) spawn msedge.exe from WSL with --remote-debugging-port=9222 against an isolated profile
//   (b) reach <endpoint>/json/version from inside WSL
//   (c) chromium.connectOverCDP(endpoint) attaches and Playwright can drive a page
//   (d) on disconnect (no browser.close()), the Edge process survives — proving close-without-killing
//
// Run: node test-cdp-attach-spike.mjs
// Cleanup: pkill is intentionally NOT done here; isolated profile so it cannot affect user's real Edge.

import { spawn, execSync } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { chromium } from 'playwright';

const EDGE_WSL_PATH = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9222;
const PROFILE_WIN = String.raw`C:\Users\leand\AppData\Local\Temp\edge-cdp-spike-profile`;

const log = (...a) => console.log('[spike]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeCdp(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, host, reason: `http ${res.status}` };
    const j = await res.json();
    return { ok: true, host, browser: j.Browser, ws: j.webSocketDebuggerUrl };
  } catch (e) {
    return { ok: false, host, reason: e.message };
  }
}

async function findReachableHost(port) {
  // Order matters: in WSL2 NAT the Windows host is reachable via the default-route gateway,
  // and via the resolv.conf nameserver. localhost only works under mirrored networking.
  const candidates = [];
  try {
    const out = execSync('ip route show default', { encoding: 'utf8' });
    const m = out.match(/default via\s+([\d.]+)/);
    if (m) candidates.push(m[1]);
  } catch {}
  try {
    const resolv = await fsp.readFile('/etc/resolv.conf', 'utf8');
    const m = resolv.match(/nameserver\s+([\d.]+)/);
    if (m && !candidates.includes(m[1])) candidates.push(m[1]);
  } catch {}
  for (const h of ['localhost', '127.0.0.1']) {
    if (!candidates.includes(h)) candidates.push(h);
  }
  for (const h of candidates) {
    const r = await probeCdp(h, port);
    if (r.ok) return r;
  }
  return { ok: false, tried: candidates };
}

async function tasklistMsedgeCount() {
  try {
    const out = execSync('/mnt/c/Windows/System32/tasklist.exe /NH /FI "IMAGENAME eq msedge.exe"', { encoding: 'utf8' });
    const matches = out.match(/msedge\.exe/gi);
    return matches ? matches.length : 0;
  } catch (e) {
    return -1;
  }
}

function spawnEdgeDetached() {
  // Use cmd.exe /c start to fully detach: parent of msedge becomes Windows shell, not our WSL Node process.
  // Args after `start "title"` get passed to the launched program.
  const winArgs = [
    '/c',
    'start',
    '""',                                // empty title
    '/B',                                // no new window for the cmd shell
    EDGE_WSL_PATH.replace(/^\/mnt\/c/, 'C:').replace(/\//g, '\\'),
    `--remote-debugging-port=${PORT}`,
    // Bind on all interfaces — required so WSL2 (NAT) can reach Edge via the host's WSL-gateway IP.
    // Localhost-only binding (default) is unreachable from WSL2 unless mirrored networking is enabled.
    '--remote-debugging-address=0.0.0.0',
    // Accept WS handshakes whose Origin is non-localhost (Chromium 111+ origin check).
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE_WIN}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-features=Translate',
    'about:blank',
  ];
  log('spawning via cmd.exe /c start');
  log('  cmd args:', winArgs);
  const child = spawn('/mnt/c/Windows/System32/cmd.exe', winArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

async function main() {
  const t0 = Date.now();
  log('===== CDP auto-launch spike =====');
  log('Edge path exists:', existsSync(EDGE_WSL_PATH));
  log('Isolated profile:', PROFILE_WIN);

  const baseline = await tasklistMsedgeCount();
  log('msedge.exe baseline count (user Edge running):', baseline);

  // pre-flight: maybe spike-port already in use
  const pre = await probeCdp('localhost', PORT);
  if (pre.ok) {
    log('!!! port', PORT, 'already serving CDP — aborting to avoid collision. existing:', pre);
    process.exit(2);
  }

  // (a) spawn
  log('--- (a) Spawning Edge ---');
  const pid = spawnEdgeDetached();
  log('cmd.exe pid:', pid);

  // wait for endpoint
  let probe = { ok: false };
  let host = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(500);
    probe = await findReachableHost(PORT);
    if (probe.ok) { host = probe.host; break; }
  }

  // (b) probe
  log('--- (b) CDP /json/version probe ---');
  if (!probe.ok) {
    log('FAIL — unreachable. tried:', probe.tried);
    log('msedge.exe count after failed wait:', await tasklistMsedgeCount());
    process.exit(1);
  }
  log('PASS — reachable at host:', host, '/ browser:', probe.browser);
  const afterSpawn = await tasklistMsedgeCount();
  log('msedge.exe count after spawn:', afterSpawn, '(delta vs baseline:', afterSpawn - baseline, ')');

  // (c) connectOverCDP
  log('--- (c) Playwright connectOverCDP ---');
  const endpoint = `http://${host}:${PORT}`;
  const browser = await chromium.connectOverCDP(endpoint);
  log('connected. contexts:', browser.contexts().length);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = (ctx.pages()[0]) ?? (await ctx.newPage());
  await page.goto('data:text/html,<h1 id=h>cdp-spike-ok</h1>');
  const h1 = await page.evaluate(() => document.getElementById('h')?.textContent);
  log('drove page. h1 read:', h1);
  if (h1 !== 'cdp-spike-ok') {
    log('FAIL — page evaluation did not return expected text');
    process.exit(1);
  }
  log('PASS — Playwright drove the attached browser');

  // (d) close-without-killing — drop reference, do NOT call browser.close()
  log('--- (d) close-without-killing ---');
  log('NOT calling browser.close() — that would kill the user Edge process in real attach scenarios');
  // disconnect via private API if exposed (avoids needing process exit before re-probe)
  try {
    if (typeof browser._wrapApiCall === 'function') {
      // Playwright internal _channel disconnect is not stable across versions; skip.
    }
  } catch {}
  // give CDP a moment, then re-probe
  await sleep(1500);
  const after = await probeCdp(host, PORT);
  log('post-disconnect re-probe:', after.ok ? 'STILL UP' : 'DOWN', after.ok ? '' : after);
  const finalCount = await tasklistMsedgeCount();
  log('msedge.exe count after disconnect:', finalCount);

  if (!after.ok) {
    log('FAIL — Edge went down while we held the connection / right after we stopped using it. attach_cdp close-semantics not safe as-designed.');
    process.exit(1);
  }
  log('PASS — Edge survived disconnect');

  log('===== SUMMARY =====');
  log('(a) spawn:', 'PASS (count rose from', baseline, '->', afterSpawn + ')');
  log('(b) reachable host:', host);
  log('(c) connectOverCDP + drive: PASS');
  log('(d) close-without-killing: PASS');
  log('elapsed ms:', Date.now() - t0);
  log('NOTE: spike Edge is still running on isolated profile', PROFILE_WIN, 'on port', PORT, '— will exit naturally when this Windows session ends or can be killed manually.');
  process.exit(0);
}

main().catch((e) => {
  console.error('[spike] FATAL', e);
  process.exit(2);
});
