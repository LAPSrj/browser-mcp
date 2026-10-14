#!/usr/bin/env node
/**
 * Live test: wp-gutenberg tools that visit the frontend bring a caller-owned
 * session back to the editor, in the rendering mode it had, and the editor
 * canvas iframe's document is ready when the tool returns.
 *
 *   1. open_session, wp-gutenberg_evaluate sets "post-only" rendering mode.
 *   2. wp-gutenberg_block_html (save_before_frontend: false, so read-only).
 *   3. The session page is the editor again, still "post-only".
 *   4. evaluate_script reads the canvas iframe's body right away.
 *
 * Defaults to the takt-wk template-locked page 335 on http://wk.localhost.
 * Nothing is saved.
 *
 *   WP_URL=http://wk.localhost WP_USER=leandro WP_PASS=leandro \
 *     node tests/test-wp-gutenberg-return-to-editor-live.mjs
 *
 * Env: POST_ID, BLOCK.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requireWp } from "./_helpers.mjs";

const wpUrl = await requireWp();
process.env.WP_URL = wpUrl;
process.env.WP_USERNAME = process.env.WP_USER ?? process.env.WP_USERNAME ?? "leandro";
process.env.WP_PASSWORD = process.env.WP_PASS ?? process.env.WP_PASSWORD ?? "leandro";
delete process.env.WP_SITES;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "..", "dist");
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);

const { createServer } = await load("server.js");
const { sessionManager } = await load("core/sessions.js");
const { PluginRegistry } = await load("plugins/registry.js");
const { resolveUrl } = await load("utils/url.js");
const plugins = [
  (await load("plugins/wp/index.js")).default,
  (await load("plugins/wp-gutenberg/index.js")).default,
  (await load("plugins/dev/index.js")).default,
];

const POST_ID = Number(process.env.POST_ID ?? 335);
const BLOCK = process.env.BLOCK ?? "takt/scrolling-text";

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

// The same core utils src/index.ts gives plugins.
const { launchSession, closeSession } = await load("utils/browser.js");
const { navigateTo } = await load("utils/navigate.js");
const { runActions } = await load("utils/actions.js");
const { saveFile, generateFilename } = await load("utils/file.js");
const { createPreviewBuffer } = await load("utils/resize.js");
const coreUtils = {
  launchSession,
  closeSession,
  getSessionPage: (session_id, tab_id) => {
    const page = sessionManager.getPage(session_id, tab_id);
    sessionManager.touch(session_id);
    return page;
  },
  listSessions: () => sessionManager.list(),
  navigateTo,
  runActions,
  saveFile,
  generateFilename,
  resolveUrl,
  createPreviewBuffer,
};

const registry = new PluginRegistry();
for (const p of plugins) await registry.load(p, {}, coreUtils);
registry.seal();
const server = createServer({}, registry);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(clientTransport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });

try {
  const open = await call("open_session", {});
  const sid = JSON.parse(open.content[0].text).session_id;
  const gbEval = async (script) => {
    const r = await call("wp-gutenberg_evaluate", { session_id: sid, post_id: POST_ID, script });
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text).value;
  };

  console.log(`1. post ${POST_ID}: set post-only mode`);
  const mode = await gbEval(
    "const d = wp.data.dispatch('core/editor'); if (!d.setRenderingMode) return null; " +
      "d.setRenderingMode('post-only'); return wp.data.select('core/editor').getRenderingMode();",
  );
  if (mode === null) {
    console.log("SKIP: this WP has no core/editor setRenderingMode");
    process.exit(0);
  }
  check(mode === "post-only", "rendering mode set", mode);

  console.log("2. block_html");
  const bh = await call("wp-gutenberg_block_html", {
    session_id: sid,
    post_id: POST_ID,
    block_name: BLOCK,
    save_before_frontend: false,
  });
  check(!bh.isError, "block_html succeeded", bh.content[0]?.text?.slice(0, 300));
  check(!bh._warnings?.some((w) => /Couldn't return/.test(w)), "no return warning", bh._warnings);

  console.log("3. session is back on the editor");
  const page = sessionManager.getPage(sid);
  check(/\/wp-admin\/post\.php\?post=\d+&action=edit/.test(page.url()), "page URL is the editor", page.url());

  console.log("4. canvas iframe readable right away");
  const probe = await call("evaluate_script", {
    session_id: sid,
    script:
      "const d = document.querySelector('iframe[name=\"editor-canvas\"]').contentDocument; " +
      "return { body: !!d.body, mode: wp.data.select('core/editor').getRenderingMode() };",
  });
  const probed = probe.isError ? null : JSON.parse(probe.content[0].text);
  check(probed?.body === true, "contentDocument.body is there", probe.content[0]?.text);
  check(probed?.mode === "post-only", "rendering mode is still post-only", probed?.mode);

  await call("close_session", { session_id: sid });
} finally {
  await client.close();
  await server.close();
  await sessionManager.closeAll?.("test").catch(() => {});
  await registry.destroyAll();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
