import type { Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

// Bundled discovery: returns every clickable / form element on the page with
// the metadata an agent needs to drive it — role, accessible name, visible
// text, bbox, and a Playwright-ready `selector_hint` you can drop straight
// into click() / type_text() / etc. Collapses the common dom_query +
// accessibility_snapshot multi-call pattern into one round-trip and adds the
// value the agent always reconstructs by hand: a click-ready selector string.

export interface ListInteractiveElementsParams {
  url?: string;
  session_id?: string;
  tab_id?: string;
  /** CSS selector to scope the scan (default: "body" — entire page). */
  scope?: string;
  /** Max elements to return. Default 100. */
  cap?: number;
  /** Include non-visible elements (hidden, off-screen) in the result. Default false. */
  include_hidden?: boolean;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
  viewport?: { width: number; height: number };
}

interface InteractiveElement {
  tag: string;
  type: string;
  role: string | null;
  name: string;
  text: string | null;
  value: string | null;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  selector_hint: string;
}

interface Result {
  scope: string;
  count: number;
  truncated: boolean;
  totalMatched: number;
  elements: InteractiveElement[];
}

export async function listInteractiveElementsTool(params: ListInteractiveElementsParams) {
  const {
    url,
    session_id,
    tab_id,
    scope = "body",
    cap = 100,
    include_hidden = false,
    actions = [],
    useBrowserStack = false,
    viewport = { width: 1280, height: 720 },
  } = params;

  if (!session_id && !url) {
    return {
      content: [{ type: "text" as const, text: "url is required when session_id is not provided" }],
      isError: true,
    };
  }

  let page: Page;
  let cleanup: (() => Promise<void>) | null = null;

  if (session_id) {
    sessionManager.touch(session_id);
    page = sessionManager.getPage(session_id, tab_id);
  } else {
    const session = await launchSession({
      browser: "chromium" as BrowserName,
      viewport,
      useBrowserStack,
    });
    page = session.page;
    cleanup = () => closeSession(session);
  }

  try {
    if (url) await navigateTo(page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    const result: Result = await page.evaluate(runInPage, { scope, cap, includeHidden: include_hidden });

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}

// In-page collector. Stays self-contained — no external function refs.
function runInPage(args: { scope: string; cap: number; includeHidden: boolean }): Result {
  const { scope, cap, includeHidden } = args;
  const root = document.querySelector(scope) ?? document.body;

  // Interactive-element query. Broad enough to catch ARIA-roled elements
  // that aren't semantic HTML, narrow enough that we don't drown the agent
  // in keyboard-tabbable but not-meaningful elements.
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "[contenteditable=\"true\"]",
    "[contenteditable=\"\"]",
    "[role=\"button\"]",
    "[role=\"link\"]",
    "[role=\"menuitem\"]",
    "[role=\"menuitemcheckbox\"]",
    "[role=\"menuitemradio\"]",
    "[role=\"tab\"]",
    "[role=\"option\"]",
    "[role=\"combobox\"]",
    "[role=\"textbox\"]",
    "[role=\"searchbox\"]",
    "[role=\"checkbox\"]",
    "[role=\"radio\"]",
    "[role=\"switch\"]",
    "[role=\"slider\"]",
  ].join(", ");

  const all = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    if (el.offsetParent === null && cs.position !== "fixed") return false;
    return true;
  }

  function getRole(el: Element): string | null {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const implicit: Record<string, string> = {
      a: "link", button: "button",
      textarea: "textbox", select: "combobox",
    };
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      const inputRole: Record<string, string> = {
        button: "button", submit: "button", reset: "button", image: "button",
        checkbox: "checkbox", radio: "radio",
        range: "slider",
        text: "textbox", email: "textbox", password: "textbox", tel: "textbox",
        search: "searchbox", url: "textbox", number: "spinbutton",
      };
      return inputRole[t] ?? "textbox";
    }
    return implicit[tag] ?? null;
  }

  function getType(el: Element): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      const map: Record<string, string> = {
        text: "text-input", email: "email-input", password: "password-input",
        tel: "tel-input", search: "search-input", url: "url-input",
        number: "number-input", date: "date-input", time: "time-input",
        checkbox: "checkbox", radio: "radio",
        submit: "submit", button: "button", reset: "reset",
        file: "file", range: "range",
      };
      return map[t] ?? `input-${t}`;
    }
    if (el.getAttribute("contenteditable")) return "contenteditable";
    const role = el.getAttribute("role");
    if (role) return role;
    return tag;
  }

  function clip(s: string, n: number): string {
    if (!s) return s;
    return s.length <= n ? s : s.slice(0, n) + "…";
  }

  function getAccessibleName(el: Element): string {
    // aria-labelledby (resolve refs)
    const lblby = el.getAttribute("aria-labelledby");
    if (lblby) {
      const parts: string[] = [];
      for (const id of lblby.split(/\s+/)) {
        const ref = document.getElementById(id);
        if (ref && (ref.textContent || "").trim()) parts.push((ref.textContent || "").trim());
      }
      if (parts.length > 0) return clip(parts.join(" "), 120);
    }
    const ariaLabel = (el.getAttribute("aria-label") || "").trim();
    if (ariaLabel) return clip(ariaLabel, 120);

    const tag = el.tagName.toLowerCase();

    // <label for=> association for form controls
    if (el.id && (tag === "input" || tag === "select" || tag === "textarea")) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && (lbl.textContent || "").trim()) return clip((lbl.textContent || "").trim(), 120);
    }
    // wrapping <label>
    const wrapLabel = el.closest("label");
    if (wrapLabel && (wrapLabel.textContent || "").trim()) {
      return clip((wrapLabel.textContent || "").trim(), 120);
    }

    // <img alt=...> when this IS the img
    if (tag === "img") {
      const alt = (el.getAttribute("alt") || "").trim();
      if (alt) return clip(alt, 120);
    }

    // value as last resort for submit/button inputs
    if (tag === "input") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset") {
        const v = ((el as HTMLInputElement).value || "").trim();
        if (v) return clip(v, 120);
      }
      const placeholder = ((el as HTMLInputElement).placeholder || "").trim();
      if (placeholder) return clip(placeholder, 120);
    }
    // textarea placeholder fallback
    if (tag === "textarea") {
      const placeholder = ((el as HTMLTextAreaElement).placeholder || "").trim();
      if (placeholder) return clip(placeholder, 120);
    }

    // textContent fallback (for buttons, links, role=button on divs)
    const t = ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    if (t) return clip(t, 120);

    // title attribute very last resort
    const title = (el.getAttribute("title") || "").trim();
    if (title) return clip(title, 120);

    return "";
  }

  function makeSelectorHint(el: Element, role: string | null, name: string, text: string | null): string {
    // Escape inner quotes for the Playwright selector syntax.
    const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // 1. role + name — most robust
    if (role && name) return `role=${role}[name=${JSON.stringify(name)}]`;
    // 2. id-anchored CSS — stable
    if (el.id) return `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}`;
    // 3. text= for elements with short, unique-ish visible text
    if (text && text.length <= 60) return `text=${JSON.stringify(text)}`;
    if (name && name.length <= 60) return `text=${JSON.stringify(name)}`;
    // 4. aria-label CSS attribute selector
    const al = el.getAttribute("aria-label");
    if (al) return `${el.tagName.toLowerCase()}[aria-label=${JSON.stringify(al)}]`;
    // 5. name attribute
    const nameAttr = el.getAttribute("name");
    if (nameAttr) return `${el.tagName.toLowerCase()}[name=${JSON.stringify(nameAttr)}]`;
    // 6. Last resort: tag + nth-of-type within parent — fragile, flag with `?`
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
      const idx = siblings.indexOf(el);
      if (idx >= 0) return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
    }
    return el.tagName.toLowerCase();
  }

  // Build the result
  const collected: InteractiveElement[] = [];
  let totalMatched = 0;

  for (const el of all) {
    const visible = isVisible(el);
    if (!includeHidden && !visible) continue;
    totalMatched++;
    if (collected.length >= cap) continue;

    const role = getRole(el);
    const type = getType(el);
    const name = getAccessibleName(el);
    const rawText = ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    const text = rawText.length > 0 ? clip(rawText, 120) : null;
    const value = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
      ? (el.value ?? "").slice(0, 200)
      : null;
    const r = el.getBoundingClientRect();
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    const selector_hint = makeSelectorHint(el, role, name, text);

    collected.push({
      tag: el.tagName.toLowerCase(),
      type,
      role,
      name,
      text,
      value,
      rect,
      visible,
      selector_hint,
    });
  }

  return {
    scope,
    count: collected.length,
    truncated: collected.length < totalMatched,
    totalMatched,
    elements: collected,
  };
}
