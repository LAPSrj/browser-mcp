#!/usr/bin/env node
/**
 * Unit test for resolveUrl: any scheme (data:, file:, about:…) passes through
 * as absolute; host:port and paths are treated as relative.
 *
 * Run after `npm run build` (or `npx tsc`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const { resolveUrl } = await import(path.join(root, "dist/utils/url.js"));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

const BASE = "http://site.localhost";

console.log("\n=== Absolute URLs pass through, with or without a base ===");
for (const url of [
  "https://example.com/a",
  "HTTP://example.com",
  "data:text/html,<title>hi</title>",
  "file:///tmp/x.html",
  "about:blank",
  "chrome://version",
]) {
  check(resolveUrl(url) === url, `no base: ${url}`, resolveUrl(url));
  check(resolveUrl(url, BASE) === url, `with base: ${url}`, resolveUrl(url, BASE));
}

console.log("\n=== Relative URLs resolve against the base ===");
check(resolveUrl("/about", BASE) === `${BASE}/about`, "/about");
check(resolveUrl("about", BASE) === `${BASE}/about`, "about (no leading slash)");
check(resolveUrl("localhost:3000/x", BASE) === `${BASE}/localhost:3000/x`, "host:port is not a scheme");

console.log("\n=== Relative URL without a base throws ===");
let threw = false;
try { resolveUrl("/about"); } catch { threw = true; }
check(threw, "throws for /about with no base");

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
