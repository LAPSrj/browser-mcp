#!/usr/bin/env node
/**
 * A navigation that fails before any response must report Chromium's
 * net::ERR_* code: headless Chromium's error page has an empty body, so the
 * code only exists in page.goto's error. network_log must list the failed
 * request too. Run after `npx tsc`.
 */
import http from "node:http";
import { sessionManager } from "../dist/core/sessions.js";
import { navigationPrimitives } from "../dist/core/primitives.js";
import { networkLogTool } from "../dist/plugins/dev/tools/network-log.js";

const fail = (m) => { console.error("[t] FAIL", m); process.exit(1); };
const ok = (m) => console.log("[t] PASS —", m);

const server = http.createServer();
server.on("connection", (socket) => socket.destroy());
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const session = await sessionManager.open({});
try {
  const nav = await navigationPrimitives.navigate.handler({ session_id: session.session_id, url });
  const navText = nav.content[0].text;
  if (!nav.isError) fail(`navigate should error, got ${navText}`);
  if (!navText.includes("ERR_CONNECTION_RESET")) fail(`navigate error lacks the net error code: ${navText}`);
  ok("navigate reports ERR_CONNECTION_RESET");

  const netlog = await networkLogTool({ session_id: session.session_id, url });
  const netText = netlog.content.map((c) => c.text).join("\n");
  if (netText.includes("No network requests captured")) fail(`network_log missed the failed request: ${netText}`);
  if (!netText.includes("net::ERR_CONNECTION_RESET")) fail(`network_log lacks the failure reason: ${netText}`);
  if (!netText.includes("PAGE ERROR")) fail(`network_log lacks the navigation diagnostic: ${netText}`);
  ok("network_log lists the failed request and the page error");

  const bad = await networkLogTool({ session_id: session.session_id, filterUrl: "(" });
  if (!bad.isError) fail("an invalid filterUrl should error");
  ok("network_log rejects an invalid filterUrl");
} finally {
  await sessionManager.close(session.session_id);
  server.close();
}
process.exit(0);
