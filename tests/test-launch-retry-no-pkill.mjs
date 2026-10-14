#!/usr/bin/env node
// A failed launch must not kill other browsers on the machine.
//
// launchSession retries a failed launch. It used to run
// `pkill -f chrome-headless-shell` between attempts, which killed every
// headless Chromium on the machine, including the browsers of other
// browser-mcp servers. This test keeps an unrelated headless Chromium open,
// makes this process's launches fail, and checks:
// 1. launchServer fails on every attempt: the unrelated browser still answers.
// 2. launchServer succeeds but connect fails: the launched server is killed
//    (nothing else cleans it up), and the unrelated browser still answers.
// Failures are forced by replacing methods on Playwright's shared `chromium`
// object, which dist/utils/browser.js uses too. Launches Playwright Chromium.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "..", "dist");
const { launchSession, setLaunchConfig } = await import(pathToFileURL(path.join(dist, "utils/browser.js")).href);

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

// Stands in for another server's browser.
const other = await chromium.launch();
const otherPage = await (await other.newContext()).newPage();

async function otherAlive() {
  try {
    return other.isConnected() && (await otherPage.evaluate(() => 1 + 1)) === 2;
  } catch {
    return false;
  }
}

const realLaunchServer = chromium.launchServer;
const realConnect = chromium.connect;
setLaunchConfig({ launchRetries: 2 });

try {
  console.log("1. launchServer fails");
  let calls = 0;
  chromium.launchServer = async () => {
    calls++;
    throw new Error("forced launch failure");
  };
  let error;
  try {
    await launchSession({ browser: "chromium" });
  } catch (e) {
    error = e;
  }
  chromium.launchServer = realLaunchServer;
  check(/forced launch failure/.test(String(error)) && calls === 2, "launch fails after 2 attempts", { error: String(error), calls });
  check(await otherAlive(), "the unrelated headless Chromium is still running");

  console.log("2. connect fails after launchServer");
  const launched = [];
  chromium.launchServer = async (...args) => {
    const s = await realLaunchServer.apply(chromium, args);
    launched.push(s);
    return s;
  };
  chromium.connect = async () => {
    throw new Error("forced connect failure");
  };
  error = undefined;
  try {
    await launchSession({ browser: "chromium" });
  } catch (e) {
    error = e;
  }
  chromium.launchServer = realLaunchServer;
  chromium.connect = realConnect;
  check(/forced connect failure/.test(String(error)) && launched.length === 2, "launch fails after 2 attempts", { error: String(error), launched: launched.length });
  const exited = launched.map((s) => {
    const p = s.process();
    return p.exitCode !== null || p.signalCode !== null;
  });
  check(exited.length === 2 && exited.every(Boolean), "each launched-but-unconnected server was killed", exited);
  check(await otherAlive(), "the unrelated headless Chromium is still running");
} finally {
  chromium.launchServer = realLaunchServer;
  chromium.connect = realConnect;
  await other.close().catch(() => {});
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
