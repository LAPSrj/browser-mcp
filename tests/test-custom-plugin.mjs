#!/usr/bin/env node
/**
 * The custom plugin: tools defined by a JSON file that run commands and type
 * their output into fields, or return it.
 *
 * Coverage:
 *  1. The loader rejects bad files (unknown keys, version, run+fill, undeclared
 *     placeholders, reserved params, bad targets, bad error keys).
 *  2. A "return" tool gets the page URL and returns stdout.
 *  3. A fill tool types values without returning them, skips steps whose
 *     selector wasn't passed, and ignores stderr on exit 0.
 *  4. Exit codes map to the file's messages, with {stderr}, and a default.
 *  5. Values starting with "-" are refused; ENOENT names the PATH.
 *  6. {url} comes from the field's iframe.
 *  7. Typing is refused on non-https pages away from localhost, while
 *     tracing, and when the page changes origin during the command.
 *
 * Run after `npm run build` (or `npx tsc`).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const { loadCustomConfig, fillArgv } = await import(path.join(root, "dist/plugins/custom/config.js"));
const { default: customPlugin } = await import(path.join(root, "dist/plugins/custom/index.js"));
const { sessionManager } = await import(path.join(root, "dist/core/sessions.js"));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}
const text = (res) => res.content.map((c) => c.text).join("\n");
const SECRET = "S3cr3t-Value!";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "custom-plugin-"));
const writeConfig = (name, obj) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
};
const loadError = (obj) => {
  try {
    loadCustomConfig(writeConfig("bad.json", obj));
    return "";
  } catch (e) {
    return e.message;
  }
};

const FAKE = [process.execPath, path.join(__dirname, "fixtures/fake-secret-cmd.mjs")];
const ERRORS = { "1": "Not saved.", "2": "Pick one: {stderr}", "4": "Locked, ask the user." };
const config = {
  version: 1,
  tools: {
    list: { description: "List accounts.", run: [...FAKE, "list", "{url}"], output: "return" },
    login: {
      description: "Fill the login.",
      params: {
        account: { description: "Account id", required: true },
        user_selector: { description: "Username field" },
        pass_selector: { description: "Password field" },
      },
      fill: [
        { target: "{user_selector}", run: [...FAKE, "get", "{url}", "username", "--account", "{account}"] },
        { target: "{pass_selector}", run: [...FAKE, "get", "{url}", "password", "--account", "{account}"] },
      ],
      errors: ERRORS,
    },
    echo: {
      description: "Type the URL the command got.",
      params: { selector: { description: "Field", required: true } },
      fill: [{ target: "{selector}", run: [...FAKE, "get", "{url}", "echo_url", "--account", "a1"] }],
    },
    nocmd: {
      description: "Command that doesn't exist.",
      run: ["no-such-command-for-custom-plugin-test"],
      output: "return",
    },
  },
};

console.log("\n=== 1. Loader checks ===");
check(!loadError(config), "test config loads", loadError(config));
check(/version/.test(loadError({ ...config, version: 2 })), "rejects version 2");
check(/extra|unrecognized/i.test(loadError({ ...config, extra: 1 })), "rejects an unknown top-level key", loadError({ ...config, extra: 1 }));
const tool = (t) => loadError({ version: 1, tools: { t } });
check(/unrecognized/i.test(tool({ description: "x", run: ["a"], output: "return", oops: 1 })), "rejects an unknown tool key");
check(/either "run" or "fill"/.test(tool({ description: "x", run: ["a"], output: "return", fill: [{ target: "{s}", run: ["a"] }], params: { s: { description: "s" } } })), "rejects run and fill together");
check(/needs "output": "return"/.test(tool({ description: "x", run: ["a"] })), "rejects run without output");
check(/\{nope\} is not/.test(tool({ description: "x", run: ["a", "{nope}"], output: "return" })), "rejects an undeclared placeholder");
check(/reserved/.test(tool({ description: "x", run: ["a"], output: "return", params: { url: { description: "u" } } })), "rejects a reserved param name");
check(/one placeholder/.test(tool({ description: "x", params: { s: { description: "s" } }, fill: [{ target: "#id", run: ["a"] }] })), "rejects a target that isn't a param");
check(/exit codes/.test(tool({ description: "x", run: ["a"], output: "return", errors: { one: "m" } })), "rejects a bad error key");
check(/can't start with "-"/.test((() => { try { fillArgv(["x", "{a}"], { a: "--flag" }); } catch (e) { return e.message; } })()), "fillArgv refuses a leading -");

// ---- servers: the login page on 127.0.0.1, an iframe on localhost ----
let otherBase = "";
const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  if (req.url === "/frame") return res.end(page(`<iframe src="${otherBase}/inner"></iframe>`));
  if (req.url === "/redirect-soon") {
    return res.end(page(`<input id="user"><script>setTimeout(() => { location.href = "${otherBase}/inner"; }, 600);</script>`));
  }
  res.end(page(`<form><input id="user"><input id="pass" type="password"></form>`));
});
const other = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page(`<input id="inner">`));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await new Promise((r) => other.listen(0, "localhost", r));
const base = `http://127.0.0.1:${server.address().port}`;
otherBase = `http://localhost:${other.address().port}`;

const tools = {};
customPlugin.register(
  {
    registerTool: (def) => { tools[def.name] = def; },
    core: { getSessionPage: (id, tab) => sessionManager.getPage(id, tab) },
  },
  { configFile: writeConfig("good.json", config) },
);
const call = (name, args) => tools[name].handler({ session_id: session.session_id, ...args }).catch((e) => ({ content: [{ text: e.message }], isError: true, thrown: true }));

const session = await sessionManager.open({ browser: "chromium", url: `${base}/login` });
const live = sessionManager.getPage(session.session_id);
try {
  console.log("\n=== 2. Return tool ===");
  let r = await call("list", {});
  check(!r.isError && JSON.parse(text(r))[0].site === "127.0.0.1", "returns stdout for the page's URL", text(r));

  console.log("\n=== 3. Fill tool ===");
  r = await call("login", { account: "a1", user_selector: "#user", pass_selector: "#pass" });
  check(!r.isError, "login succeeds", text(r));
  check(!text(r).includes(SECRET), "result doesn't contain the value", text(r));
  check(/Filled user_selector \(\d+ chars\)/.test(text(r)) && /Filled pass_selector/.test(text(r)), "result lists both fields", text(r));
  check(await live.inputValue("#user") === `username:${SECRET}`, "username typed without the trailing newline", await live.inputValue("#user"));
  check(await live.inputValue("#pass") === `password:${SECRET}`, "password typed", await live.inputValue("#pass"));
  await live.fill("#user", "");
  r = await call("login", { account: "a1", pass_selector: "#pass" });
  check(!r.isError && !/user_selector/.test(text(r)) && await live.inputValue("#user") === "", "skips a step whose selector wasn't passed", text(r));
  r = await call("login", { account: "a1" });
  check(r.isError && /Pass at least one of: user_selector, pass_selector/.test(text(r)), "no selectors is an error", text(r));

  console.log("\n=== 4. Exit codes ===");
  r = await call("login", { account: "missing", user_selector: "#user" });
  check(r.isError && text(r) === "Not saved.", "exit 1 → the file's message", text(r));
  r = await call("login", { account: "many", user_selector: "#user" });
  check(r.isError && /^Pick one: id\tusername/.test(text(r)), "exit 2 → message with {stderr}", text(r));
  r = await call("login", { account: "locked", user_selector: "#user" });
  check(r.isError && text(r) === "Locked, ask the user.", "exit 4 → the file's message", text(r));
  r = await call("login", { account: "odd", user_selector: "#user" });
  check(r.isError && /exited with code 7: strange failure/.test(text(r)), "unmapped code → default message", text(r));
  r = await call("login", { account: "empty", user_selector: "#user" });
  check(r.isError && /printed nothing/.test(text(r)), "empty output isn't typed", text(r));
  r = await call("login", { account: "a1", user_selector: "#user", pass_selector: "#missing-field" });
  check(r.isError && !text(r).includes(SECRET), "a missing field fails the call without the value", text(r));

  console.log("\n=== 5. Arguments and PATH ===");
  r = await call("login", { account: "--min-valid", user_selector: "#user" });
  check(r.isError && /can't start with "-"/.test(text(r)), "account starting with - is refused", text(r));
  r = await call("nocmd", {});
  check(r.isError && /not on the MCP server's PATH/.test(text(r)), "ENOENT names the PATH", text(r));

  console.log("\n=== 6. {url} from the iframe ===");
  await live.goto(`${base}/frame`);
  await live.frameLocator("iframe").locator("#inner").waitFor();
  r = await call("echo", { selector: "iframe >>> #inner" });
  const typed = await live.frameLocator("iframe").locator("#inner").inputValue();
  check(!r.isError && typed === `${otherBase}/inner`, "command got the iframe's URL", `${text(r)} / typed=${typed}`);

  console.log("\n=== 7. Refusals ===");
  await live.route("http://login.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: page(`<input id="user">`) }));
  await live.goto("http://login.example.test/");
  r = await call("login", { account: "a1", user_selector: "#user" });
  check(r.isError && /only typed on https pages or on localhost/.test(text(r)), "http away from localhost is refused", text(r));
  check(await live.inputValue("#user") === "", "nothing typed there");
  await live.route("http://site.localhost/**", (route) => route.fulfill({ contentType: "text/html", body: page(`<input id="user">`) }));
  await live.goto("http://site.localhost/");
  r = await call("login", { account: "a1", user_selector: "#user" });
  check(!r.isError && await live.inputValue("#user") === `username:${SECRET}`, "http on a *.localhost name is allowed", text(r));

  await live.goto(`${base}/login`);
  sessionManager.setTracing(session.session_id, true);
  r = await call("login", { account: "a1", user_selector: "#user" });
  sessionManager.setTracing(session.session_id, false);
  check(r.isError && /trace_stop/.test(text(r)), "refused while tracing", text(r));

  await live.goto(`${base}/redirect-soon`);
  r = await call("login", { account: "sleepy", user_selector: "#user" });
  check(r.isError && /moved to another site/.test(text(r)), "origin change during the command is refused", text(r));
} finally {
  await sessionManager.close(session.session_id);
  server.close();
  other.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
