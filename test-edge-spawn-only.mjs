#!/usr/bin/env node
// Bare-bones spawn diagnostic — spawn Edge with the same args the prod path
// uses, then immediately dump every msedge.exe CommandLine matching our
// session tag to /tmp/edge-cmdlines-debug.json.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { execFileSync as efs } from 'node:child_process';

const SID = `prob-${Date.now()}`;
const TEMP = efs('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %TEMP%'], { encoding: 'utf8' }).trim();
const PROFILE = `${TEMP}\\browser-mcp\\${SID}\\bm-cdp-${SID}`;
const wslProfile = efs('/usr/bin/wslpath', ['-u', PROFILE], { encoding: 'utf8' }).trim();
mkdirSync(wslProfile, { recursive: true });

const EDGE = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;

const args = [
  '/c',
  'start',
  '""',
  '/B',
  EDGE,
  '--remote-debugging-port=9499',
  '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
];

console.log('SID=', SID);
console.log('PROFILE=', PROFILE);
console.log('args=', args);

const child = spawn('/mnt/c/Windows/System32/cmd.exe', args, { detached: true, stdio: 'ignore' });
child.unref();

await new Promise((r) => setTimeout(r, 2500));

// dump every match to a file so we can read it
const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${SID}*' } | ForEach-Object { '{0} :: {1}' -f $_.ProcessId, $_.CommandLine }`;
const out = efs('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log('---PS OUTPUT (', out.split('\n').length, 'lines )---');
console.log(out);

// also check listening ports
const ps2 = `Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 9300 -and $_.LocalPort -le 9999 } | ForEach-Object { '{0}:{1} pid={2}' -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess }`;
const out2 = efs('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-Command', ps2], { encoding: 'utf8' });
console.log('---LISTENING in 9300-9999---');
console.log(out2);

// kill
const ps3 = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${SID}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }`;
efs('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-Command', ps3], { encoding: 'utf8' });
console.log('done');
