#!/usr/bin/env node
/**
 * Iframe modals: an agent should be able to find and click controls inside
 * iframes without knowing the `>>>` syntax up front.
 *
 *   - list_interactive_elements lists iframe contents with frame-prefixed
 *     selector hints, including an iframe inside a closed shadow root
 *     (Cloudflare Turnstile's layout), which only `frame-url=` reaches.
 *   - Those hints work in click / check.
 *   - A plain selector that only matches inside one iframe still clicks, and
 *     the result names the frame-prefixed selector.
 *   - A plain selector matching inside two iframes fails with both options.
 *   - Clicking a page button under the iframe fails fast with an iframe hint.
 *   - hit_test follows the point into the iframe.
 *   - accessibility_snapshot adds the iframes' trees.
 *   - wait_for_selector finds content in an iframe that loads late.
 *
 * Needs `npm run build` first.
 */
import http from "node:http";
import { sessionManager } from "../dist/core/sessions.js";
import { interactionPrimitives, waitPrimitives, readPrimitives } from "../dist/core/primitives.js";
import { listInteractiveElementsTool } from "../dist/plugins/dev/tools/list-interactive-elements.js";
import { hitTestTool } from "../dist/plugins/dev/tools/hit-test.js";
import { accessibilitySnapshotTool } from "../dist/plugins/dev/tools/accessibility.js";

const log = (...a) => console.log("[t]", ...a);
let failed = 0;
function check(cond, m) {
  if (cond) log("PASS —", m);
  else { console.error("[t] FAIL —", m); failed++; }
}
const text = (r) => r.content.map((c) => c.text).join("\n");

const CHILD_PAGES = {
  "/consent": `<h2>Cookies</h2>
    <button onclick="document.body.dataset.accepted='1'">Accept all</button>
    <button>Reject</button>`,
  "/challenge": `<label><input type=checkbox id=cb onchange="this.dataset.checked=String(this.checked)"> Verify you are human</label>`,
  "/dup": `<button id=dup>Dup</button>`,
  "/embed": Array.from({ length: 30 }, (_, i) => `<button>Player ${i}</button>`).join(""),
};
const child = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(CHILD_PAGES[new URL(req.url, "http://x").pathname] ?? "");
});
await new Promise((r) => child.listen(0, "127.0.0.1", r));
const C = `http://127.0.0.1:${child.address().port}`;

const PARENT_PAGES = {
  "/": `<body style="margin:0">
    <a href="#top">Page link</a>
    <button id=behind style="position:absolute;left:300px;top:200px" onclick="this.dataset.clicked='1'">Behind</button>
    <iframe title="Consent" src="${C}/consent"
      style="position:fixed;left:200px;top:100px;width:500px;height:300px;border:0;z-index:10;background:#fff"></iframe>
    <div id=host style="position:absolute;left:20px;top:450px"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'closed' });
      root.innerHTML = '<iframe src="${C}/challenge" style="width:300px;height:80px;border:0"></iframe>';
    </script></body>`,
  "/dup": `<iframe src="${C}/dup?a"></iframe><iframe src="${C}/dup?b"></iframe>`,
  // An article page: embeds in the flow, before and after the content, and a
  // fixed consent modal on top.
  "/article": `<body style="margin:0">
    <iframe title="Ad 1" src="${C}/embed?1" style="width:600px;height:120px"></iframe>
    ${Array.from({ length: 10 }, (_, i) => `<a href="#a${i}">Article link ${i}</a>`).join(" ")}
    <iframe title="Video" src="${C}/embed?2" style="width:600px;height:120px"></iframe>
    <iframe title="Ad 2" src="${C}/embed?3" style="width:600px;height:120px"></iframe>
    <iframe title="Consent" src="${C}/consent"
      style="position:fixed;left:100px;top:100px;width:400px;height:200px;border:0;background:#fff"></iframe></body>`,
  "/late": `<script>setTimeout(() => {
      const f = document.createElement('iframe'); f.src = '${C}/consent'; document.body.append(f);
    }, 1500)</script>`,
};
const parent = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PARENT_PAGES[new URL(req.url, "http://x").pathname] ?? "");
});
await new Promise((r) => parent.listen(0, "127.0.0.1", r));
// localhost vs 127.0.0.1 makes the iframes cross-origin (out-of-process).
const P = `http://localhost:${parent.address().port}`;

const session = await sessionManager.open({ url: `${P}/` });
const sid = session.session_id;
try {
  await waitPrimitives.wait_for_selector.handler({ session_id: sid, selector: "text=Accept all", timeout: 10000 });
  await waitPrimitives.wait_for_selector.handler({ session_id: sid, selector: "#cb", timeout: 10000 });

  // ---- list_interactive_elements ----
  const list = JSON.parse(text(await listInteractiveElementsTool({ session_id: sid })));
  log("frames:", JSON.stringify(list.frames));
  const accept = list.elements.find((e) => e.name === "Accept all");
  const cb = list.elements.find((e) => e.name === "Verify you are human");
  check(list.frames?.length === 2, `frames summary lists both iframes (got ${list.frames?.length})`);
  check(accept?.selector_hint === `iframe[title="Consent"] >>> role=button[name="Accept all"]`, `consent hint: ${accept?.selector_hint}`);
  check(cb?.selector_hint?.startsWith("frame-url=127.0.0.1:"), `closed-shadow hint uses frame-url=: ${cb?.selector_hint}`);
  check(accept && accept.rect.x >= 200 && accept.rect.y >= 100, `iframe element rect is in page coordinates (${JSON.stringify(accept?.rect)})`);
  check(list.elements[0].frame !== undefined, "iframe elements come first");
  check(list.elements.some((e) => e.name === "Page link" && !e.frame), "page elements are still listed");

  // ---- click through a page element under the iframe ----
  const covered = await interactionPrimitives.click.handler({ session_id: sid, selector: "#behind" }).catch((e) => ({ thrown: e.message }));
  const coveredMsg = covered.thrown ?? text(covered);
  check(/iframe/.test(coveredMsg) && /list_interactive_elements/.test(coveredMsg), `covered-by-iframe error points at list_interactive_elements`);

  // ---- hit_test follows the point into the iframe ----
  const hit = JSON.parse(text(await hitTestTool({ session_id: sid, selector: "#behind" })));
  check(hit.frames?.[0]?.frame === `iframe[title="Consent"]`, `hit_test enters the consent iframe (${hit.frames?.[0]?.frame})`);
  const hitTarget = JSON.parse(text(await hitTestTool({ session_id: sid, selector: accept.selector_hint })));
  check(hitTarget.verdict?.reachesTarget === true, `hit_test on a frame selector: reachesTarget (${JSON.stringify(hitTarget.verdict)})`);
  const hitShadow = JSON.parse(text(await hitTestTool({ session_id: sid, x: cb.rect.x + 5, y: cb.rect.y + 5 })));
  check(hitShadow.frames?.[0]?.frame?.startsWith("frame-url="), `hit_test enters the closed-shadow iframe (${hitShadow.frames?.[0]?.frame})`);

  // ---- plain selector falls back into the one iframe that has it ----
  const clicked = JSON.parse(text(await interactionPrimitives.click.handler({ session_id: sid, selector: "text=Accept all" })));
  check(clicked.resolved_selector === `iframe[title="Consent"] >>> text=Accept all`, `click result names the frame selector (${clicked.resolved_selector})`);
  const accepted = JSON.parse(text(await readPrimitives.get_attribute.handler({
    session_id: sid, selector: `iframe[title="Consent"] >>> body`, attribute: "data-accepted",
  })));
  check(accepted.value === "1", "Accept all ran inside the iframe");

  // ---- closed shadow root iframe via the listed hint ----
  const checkedRes = await interactionPrimitives.check.handler({ session_id: sid, selector: cb.selector_hint });
  check(!checkedRes.isError, `check via frame-url hint: ${text(checkedRes)}`);
  const checked = JSON.parse(text(await readPrimitives.get_attribute.handler({
    session_id: sid, selector: cb.selector_hint, attribute: "data-checked",
  })));
  check(checked.value === "true", "checkbox inside the closed shadow root is checked");

  // ---- accessibility_snapshot ----
  const a11y = text(await accessibilitySnapshotTool({ session_id: sid }));
  check(/Iframes \(2\)/.test(a11y) && a11y.includes("Verify you are human"), "accessibility_snapshot includes both iframe trees");

  // ---- embeds don't crowd out the page ----
  await sessionManager.getPage(sid).goto(`${P}/article`);
  await waitPrimitives.wait_for_selector.handler({ session_id: sid, selector: `iframe[title="Ad 2"] >>> text=Player 29`, timeout: 10000 });
  await waitPrimitives.wait_for_selector.handler({ session_id: sid, selector: `iframe[title="Consent"] >>> text=Accept all`, timeout: 10000 });
  const art = JSON.parse(text(await listInteractiveElementsTool({ session_id: sid, cap: 20 })));
  const order = art.elements.map((e) => e.frame ?? "page");
  log("article order:", order.join(", "));
  check(order.slice(0, 2).every((f) => f === `iframe[title="Consent"]`), "fixed consent modal comes first");
  check(order.slice(2, 12).every((f) => f === "page"), "all 10 article links come next");
  check(order.slice(12).every((f) => f.startsWith("iframe[title=\"Ad") || f === `iframe[title="Video"]`), "embeds fill the rest");
  const byFrame = Object.fromEntries(art.frames.map((f) => [f.selector, f]));
  check(byFrame[`iframe[title="Consent"]`]?.overlay === true && byFrame[`iframe[title="Video"]`]?.overlay === false,
    "frames marks the modal as overlay and the video as not");
  check(art.frames.length === 4 && byFrame[`iframe[title="Ad 2"]`]?.elements === 30 && byFrame[`iframe[title="Ad 2"]`]?.listed === 0,
    `frames lists a cut-off embed with its count (${JSON.stringify(byFrame[`iframe[title="Ad 2"]`])})`);
  const video = JSON.parse(text(await listInteractiveElementsTool({ session_id: sid, scope: `iframe[title="Video"] >>> body` })));
  check(video.count === 30 && video.elements[0].selector_hint.startsWith(`iframe[title="Video"] >>> `),
    `scope with >>> lists one iframe (${video.count} elements)`);

  // ---- ambiguous plain selector ----
  await sessionManager.getPage(sid).goto(`${P}/dup`);
  await waitPrimitives.wait_for_selector.handler({ session_id: sid, selector: `frame-url=dup?b >>> #dup`, timeout: 10000 }).catch(() => {});
  const dup = await interactionPrimitives.click.handler({ session_id: sid, selector: "#dup" }).catch((e) => ({ thrown: e.message }));
  const dupMsg = dup.thrown ?? text(dup);
  const options = [...dupMsg.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  check(/inside 2 iframes/.test(dupMsg) && options.length === 2 && options[0].includes("dup?a") && options[1].includes("dup?b"),
    `two matching frames → error with both selectors: ${options.join(" | ")}`);
  const pick = await interactionPrimitives.click.handler({ session_id: sid, selector: options[1] ?? "#none" });
  check(!pick.isError, `a suggested selector clicks: ${text(pick).slice(0, 120)}`);

  // ---- missing frame-url ----
  const missing = await interactionPrimitives.click.handler({ session_id: sid, selector: "frame-url=nope.example >>> #x" }).catch((e) => ({ thrown: e.message }));
  check(/No iframe on the page has a URL containing "nope.example"/.test(missing.thrown ?? text(missing)), "unknown frame-url lists the iframe URLs");

  // ---- wait_for_selector on an iframe that loads late ----
  await sessionManager.getPage(sid).goto(`${P}/late`);
  const waited = await waitPrimitives.wait_for_selector.handler({ session_id: sid, selector: "text=Accept all", timeout: 8000 });
  check(!waited.isError && /found inside an iframe/.test(text(waited)), `wait_for_selector finds a late iframe: ${text(waited)}`);
} finally {
  await sessionManager.close(sid).catch(() => {});
  parent.close();
  child.close();
}

log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
