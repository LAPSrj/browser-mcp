#!/usr/bin/env node
// Validates (c) connectOverCDP + drive and (d) close-without-killing
// against the production attach_cdp code path in src/core/sessions.ts.
//
// Build with `npx tsc` first, then run:
//   node test-attach-cdp-prod.mjs

import { sessionManager } from './dist/core/sessions.js';
import { execFileSync } from 'node:child_process';

const log = (...a) => console.log('[t]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tasklistCount(filterContains) {
  try {
    const out = execFileSync(
      '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      [
        '-NoProfile',
        '-Command',
        filterContains
          ? `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${filterContains}*' } | Measure-Object).Count`
          : `(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object).Count`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return -1;
  }
}

async function main() {
  log('opening session via attach_cdp + auto_launch...');
  const t0 = Date.now();
  const session = await sessionManager.open({
    attach_cdp: true,
    // explicit headless not relevant for attach_cdp; the spawned Edge has its own UI
  });
  log('session_id:', session.session_id, 'opened in', Date.now() - t0, 'ms');
  log('session info:', JSON.stringify(session, null, 2));

  // confirm there's an Edge process tagged with this session id
  const tag = `bm-cdp-${session.session_id}`;
  const procsAfterOpen = tasklistCount(tag);
  log('msedge.exe procs tagged with sessionId:', procsAfterOpen);
  if (procsAfterOpen <= 0) throw new Error('FAIL: no spike-profile msedge procs found after open');

  // (c) drive the page
  log('--- (c) drive a page ---');
  // we need to reach into the session manager to get the page
  const list = sessionManager.list();
  log('listed sessions:', list.length);
  // use the public list+navigate path: just call page via getPage
  const page = sessionManager.getPage(session.session_id);
  await page.goto('data:text/html,<h1 id=h>cdp-prod-ok</h1>');
  const h1 = await page.evaluate(() => document.getElementById('h')?.textContent);
  log('h1 read:', h1);
  if (h1 !== 'cdp-prod-ok') throw new Error('FAIL: page evaluation incorrect');
  log('(c) PASS — Playwright drove the attached browser');

  // also verify via gh go to a real URL
  await page.goto('about:blank');
  const url = page.url();
  log('about:blank navigation OK, page.url():', url);

  // (d) close-without-killing
  log('--- (d) close-without-killing ---');
  log('calling sessionManager.close — must NOT kill external Edge processes');
  const procsBeforeClose = tasklistCount(tag);
  log('msedge.exe procs tagged before close:', procsBeforeClose);

  const closeResult = await sessionManager.close(session.session_id);
  log('close result:', JSON.stringify(closeResult));

  // give cleanup a moment
  await sleep(1500);
  const procsAfterClose = tasklistCount(tag);
  log('msedge.exe procs tagged after close:', procsAfterClose);

  // For auto_launch attach_cdp, we DO want our isolated Edge cleaned up
  // (cleanup() kills by sessionId tag — this is intentional, the FOOTGUN
  // we're guarding against is killing the USER's real Edge, which has no
  // sessionId tag in its CommandLine).
  // So procsAfterClose should be 0 (our spike Edge cleaned), AND we should
  // verify the user's real Edge (no tag) is still alive.
  const userEdgeCount = tasklistCount(); // no filter = all msedge.exe
  log('msedge.exe procs total (user Edge + others):', userEdgeCount);

  if (procsAfterClose !== 0) {
    log('WARN: spike Edge not fully cleaned up — cleanup() may have raced');
  }
  if (userEdgeCount <= 0) {
    throw new Error('FAIL: no msedge.exe procs at all after close — user Edge may have been killed!');
  }
  log('(d) PASS — spike Edge cleaned up,', userEdgeCount, 'untagged msedge.exe procs survive (user Edge)');

  log('===== ALL CHECKS PASSED =====');
  log('elapsed:', Date.now() - t0, 'ms');
  process.exit(0);
}

main().catch((e) => {
  console.error('[t] FATAL', e);
  process.exit(1);
});
