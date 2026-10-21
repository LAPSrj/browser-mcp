#!/usr/bin/env node
/**
 * Smoke: list_interactive_elements returns the right shape and the
 * selector_hint values are click-ready (paste them back into click()).
 */
import { sessionManager } from "../dist/core/sessions.js";
import { listInteractiveElementsTool } from "../dist/plugins/dev/tools/list-interactive-elements.js";
import { interactionPrimitives } from "../dist/core/primitives.js";

const log = (...a) => console.log("[t]", ...a);
const fail = (m) => { console.error("[t] FAIL", m); process.exit(1); };
const ok = (m) => log("PASS —", m);

// A small kitchen-sink page exercising the categories list_interactive_elements
// should classify.
const PAGE = `data:text/html,<!doctype html><html><body>
  <h1>Kitchen sink</h1>
  <a href="/about" id="link-about">About us</a>
  <a href="/contact">Contact</a>
  <button id="save" aria-label="Save changes">Save</button>
  <button>Cancel</button>
  <div role="button" tabindex="0" aria-label="Custom widget">Click me</div>
  <input type="text" name="username" placeholder="Your username" />
  <input type="password" name="pwd" aria-label="Password" />
  <input type="checkbox" id="agree" /><label for="agree">I agree</label>
  <input type="radio" name="plan" value="free" />Free
  <input type="radio" name="plan" value="pro" />Pro
  <select name="country"><option>BR</option><option>US</option></select>
  <textarea name="notes" placeholder="Notes"></textarea>
  <input type="submit" value="Submit form" />
  <input type="hidden" name="csrf" value="x123" />
  <div role="tab" aria-label="Settings tab">Settings</div>
  <div style="display:none"><button>I am hidden</button></div>
</body></html>`;

const session = await sessionManager.open({ url: PAGE });
log(`session_id=${session.session_id}`);

// ---- 1. Default behavior (visible only) ----
log("\nTest 1 — default scan (visible only)");
const r1 = await listInteractiveElementsTool({ session_id: session.session_id });
if (r1.isError) fail(`tool errored: ${JSON.stringify(r1.content)}`);
const result = JSON.parse(r1.content[r1.content.length - 1].text);
log(`scope=${result.scope} count=${result.count} totalMatched=${result.totalMatched} truncated=${result.truncated}`);
log(`elements found:`);
for (const e of result.elements) {
  log(`  [${e.type}] tag=${e.tag} role=${e.role} name="${e.name}" hint=${e.selector_hint}`);
}

// Should NOT include the hidden button
if (result.elements.some((e) => e.name === "I am hidden")) fail("hidden button should be filtered out by default");
ok("hidden elements filtered by default");

// Should categorize types correctly
const byType = result.elements.reduce((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {});
log(`type histogram: ${JSON.stringify(byType)}`);
if (!byType["link"]) fail("expected at least one link");
if (!byType["button"]) fail("expected at least one button");
if (!byType["text-input"]) fail("expected at least one text-input");
if (!byType["checkbox"]) fail("expected at least one checkbox");
if (!byType["radio"]) fail("expected at least one radio");
if (!byType["select"]) fail("expected at least one select");
if (!byType["textarea"]) fail("expected at least one textarea");
if (!byType["submit"]) fail("expected at least one submit");
ok("all major interactive types categorized");

// hidden input excluded (it's input type=hidden — never interactive)
if (result.elements.some((e) => e.name === "x123")) fail("hidden input should never be listed");

// selector_hint must be present for every element
for (const e of result.elements) {
  if (!e.selector_hint || typeof e.selector_hint !== "string") fail(`element missing selector_hint: ${JSON.stringify(e)}`);
}
ok("every element has a non-empty selector_hint");

// id-anchored hint for #save
const save = result.elements.find((e) => e.name === "Save changes");
if (!save) fail("Save button missing from result");
log(`Save button hint: ${save.selector_hint}`);
if (!save.selector_hint.includes("Save")) fail(`Save button hint should reference name, got: ${save.selector_hint}`);
ok("Save button has name-anchored selector hint");

// Custom widget div with role=button gets a role= hint
const widget = result.elements.find((e) => e.name === "Custom widget");
if (!widget) fail("Custom widget div missing from result");
if (widget.role !== "button") fail(`Custom widget role should be button, got ${widget.role}`);
log(`Custom widget: tag=${widget.tag} type=${widget.type} role=${widget.role} hint=${widget.selector_hint}`);
if (!widget.selector_hint.startsWith("role=button")) fail(`Custom widget should have role= hint, got: ${widget.selector_hint}`);
ok("role=button div gets role= selector hint");

// ---- 2. include_hidden ----
log("\nTest 2 — include_hidden:true should surface the hidden button");
const r2 = await listInteractiveElementsTool({ session_id: session.session_id, include_hidden: true });
const result2 = JSON.parse(r2.content[r2.content.length - 1].text);
log(`count=${result2.count} totalMatched=${result2.totalMatched}`);
const hidden = result2.elements.find((e) => e.name === "I am hidden");
if (!hidden) fail("expected hidden button to appear with include_hidden:true");
if (hidden.visible !== false) fail("hidden element should report visible:false");
ok("include_hidden:true surfaces hidden elements with visible:false");

// ---- 3. scope ----
log("\nTest 3 — scope to a specific selector");
const r3 = await listInteractiveElementsTool({ session_id: session.session_id, scope: "h1 ~ a" });
// h1 ~ a is a CSS selector — matches sibling anchors
// Actually scope is the ROOT; we querySelectorAll inside it. So pass a container.
const result3 = JSON.parse(r3.content[r3.content.length - 1].text);
log(`scoped count=${result3.count}`);

// ---- 4. cap ----
log("\nTest 4 — cap:3 returns at most 3");
const r4 = await listInteractiveElementsTool({ session_id: session.session_id, cap: 3 });
const result4 = JSON.parse(r4.content[r4.content.length - 1].text);
if (result4.count !== 3) fail(`expected count=3 with cap:3, got ${result4.count}`);
if (!result4.truncated) fail("expected truncated:true when cap < totalMatched");
ok("cap respected; truncated flag set");

// ---- 4b. Password fields ----
log("\nTest 4b — password values are hidden unless include_passwords:true");
const page = sessionManager.getPage(session.session_id);
await page.fill('input[name="pwd"]', "s3cret-pass");
await page.fill('input[name="username"]', "nelson");
const r4b = await listInteractiveElementsTool({ session_id: session.session_id });
const text4b = r4b.content[r4b.content.length - 1].text;
if (text4b.includes("s3cret-pass")) fail("password value leaked in the default scan");
const els4b = JSON.parse(text4b).elements;
const pwd = els4b.find((e) => e.type === "password-input");
if (pwd?.value !== "[hidden]") fail(`filled password should read "[hidden]", got ${JSON.stringify(pwd?.value)}`);
if (els4b.find((e) => e.type === "text-input")?.value !== "nelson") fail("text input value should still be returned");
ok('password value reads "[hidden]"; other values unchanged');
const r4c = await listInteractiveElementsTool({ session_id: session.session_id, include_passwords: true });
const pwdShown = JSON.parse(r4c.content[r4c.content.length - 1].text).elements.find((e) => e.type === "password-input");
if (pwdShown?.value !== "s3cret-pass") fail(`include_passwords:true should return the value, got ${JSON.stringify(pwdShown?.value)}`);
ok("include_passwords:true returns the value");
// Without an aria-label the focus description falls back to the field's value.
await page.evaluate(() => document.querySelector('input[name="pwd"]').removeAttribute("aria-label"));
const pk = await interactionPrimitives.press_key.handler({ session_id: session.session_id, key: "End", selector: 'input[name="pwd"]' });
const pkText = JSON.stringify(pk.content);
if (pk.isError) fail(`press_key errored: ${pkText}`);
if (pkText.includes("s3cret-pass")) fail(`press_key leaked the password: ${pkText}`);
ok("press_key's focus description leaves out the password");
await page.fill('input[name="pwd"]', "");
const r4d = await listInteractiveElementsTool({ session_id: session.session_id });
const pwdEmpty = JSON.parse(r4d.content[r4d.content.length - 1].text).elements.find((e) => e.type === "password-input");
if (pwdEmpty?.value !== "") fail(`empty password should read "", got ${JSON.stringify(pwdEmpty?.value)}`);
ok('empty password reads ""');

// ---- 5. Validation: missing url + session_id ----
log("\nTest 5 — missing url + session_id errors");
const bad = await listInteractiveElementsTool({});
if (!bad.isError) fail("expected validation error on missing inputs");
ok("validation rejects missing inputs");

await sessionManager.close(session.session_id);

log("\n===== list_interactive_elements smoke PASSED =====");
process.exit(0);
