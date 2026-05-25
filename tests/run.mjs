#!/usr/bin/env node
/**
 * Test runner for browser-mcp.
 *
 * Walks `tests/test-*.mjs`, runs each as its own Node child, captures stdout +
 * stderr, and categorizes the outcome:
 *
 *   - PASS  — child exit 0 and stdout contains no `SKIP:` line.
 *   - SKIP  — child exit 0 and stdout's first non-empty line starts with
 *             `SKIP:`. Used by `requireWindows()` / `requireChromium()` /
 *             `requireWp()` from `_helpers.mjs` to bow out cleanly when the
 *             test's environment isn't available.
 *   - FAIL  — child exit non-zero.
 *
 * Usage:
 *   npm test                       — run everything
 *   npm test -- pause              — run only tests whose filename contains
 *                                    "pause" (substring filter)
 *   npm test -- --list             — print the list of tests and exit
 *   node tests/run.mjs <filters>   — same; the filters are positional
 *
 * Exits non-zero if any test FAILed. SKIPs don't count as failures.
 *
 * Pass `--verbose` (or set TESTS_VERBOSE=1) to forward child stdout/stderr
 * line-by-line. Default is a compact one-line-per-test report with the body
 * captured for FAILs only.
 */
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose") || process.env.TESTS_VERBOSE === "1";
const LIST_ONLY = argv.includes("--list");
const filters = argv.filter((a) => !a.startsWith("--"));

const all = readdirSync(__dirname)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
  .sort();

const tests = filters.length
  ? all.filter((f) => filters.some((q) => f.includes(q)))
  : all;

if (LIST_ONLY) {
  for (const t of tests) console.log(t);
  process.exit(0);
}

if (tests.length === 0) {
  console.error(`No tests matched filters [${filters.join(", ")}].`);
  process.exit(2);
}

console.log(`Running ${tests.length} test${tests.length === 1 ? "" : "s"} from ${__dirname}\n`);

let passed = 0;
let skipped = 0;
const failures = [];
const skippedReasons = [];
const t0 = Date.now();

for (const t of tests) {
  const tStart = Date.now();
  const result = await runOne(path.join(__dirname, t));
  const ms = Date.now() - tStart;
  const tag = result.outcome.padEnd(4, " ");
  const reason = result.reason ? `  ${result.reason}` : "";
  console.log(`[${tag}] ${t}  (${ms}ms)${reason}`);

  if (result.outcome === "PASS") passed++;
  else if (result.outcome === "SKIP") {
    skipped++;
    skippedReasons.push(`${t}: ${result.reason}`);
  } else {
    failures.push({ name: t, body: result.body });
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${passed} passed, ${skipped} skipped, ${failures.length} failed in ${elapsed}s`);

if (failures.length && !VERBOSE) {
  console.log("\n--- failure output ---");
  for (const f of failures) {
    console.log(`\n=== ${f.name} ===`);
    console.log(f.body);
  }
}

process.exit(failures.length > 0 ? 1 : 0);

// ---------------------------------------------------------------------------

function runOne(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [filePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = String(d);
      stdout += s;
      if (VERBOSE) process.stdout.write(s);
    });
    child.stderr.on("data", (d) => {
      const s = String(d);
      stderr += s;
      if (VERBOSE) process.stderr.write(s);
    });
    child.on("close", (code) => {
      const skipLine = firstSkipLine(stdout);
      if (code === 0 && skipLine) {
        resolve({ outcome: "SKIP", reason: skipLine });
      } else if (code === 0) {
        resolve({ outcome: "PASS" });
      } else {
        resolve({
          outcome: "FAIL",
          reason: `exit ${code}`,
          body: `${stdout}\n${stderr}`.trim(),
        });
      }
    });
  });
}

function firstSkipLine(stdout) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("SKIP:")) return trimmed;
    return null;
  }
  return null;
}
