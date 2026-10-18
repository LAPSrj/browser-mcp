import type { Page, Frame } from "playwright";
import { hasFramePierce, resolveLocator, splitFramePierce } from "../../../utils/locator.js";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";
import { childFrames, frameContentBox, framePath } from "../../../utils/frames.js";

// Bundled discovery: returns every clickable / form element on the page with
// the metadata an agent needs to drive it — role, accessible name, visible
// text, bbox, and a Playwright-ready `selector_hint` you can drop straight
// into click() / type_text() / etc. Collapses the common dom_query +
// accessibility_snapshot multi-call pattern into one round-trip and adds the
// value the agent always reconstructs by hand: a click-ready selector string.

export interface ListInteractiveElementsParams extends BrowserStackTarget {
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
  /** Selector prefix of the iframe holding the element; absent on the page itself. */
  frame?: string;
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
      ...pickBrowserStack(params),
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

    let result: Record<string, unknown>;
    if (hasFramePierce(scope)) {
      result = await scanOneFrame(page, scope, cap, include_hidden);
    } else {
      const own: Result = await page.evaluate(runInPage, { scope, cap, includeHidden: include_hidden });
      // A whole-page scan also covers iframes (cross-origin and closed-shadow-root
      // ones too). Overlay iframes (modals, consent banners, chat widgets) come
      // before the page's elements, because they block it. Embeds (video, ads,
      // maps) come after, so they can't push the page's own elements past the cap.
      const framed = scope === "body" ? await scanFrames(page, cap, include_hidden) : null;
      const overlays = framed?.elements.filter((e) => framed.overlay.has(e.frame!)) ?? [];
      const embeds = framed?.elements.filter((e) => !framed.overlay.has(e.frame!)) ?? [];
      const elements = [...overlays, ...own.elements, ...embeds].slice(0, cap);
      const totalMatched = own.totalMatched + (framed?.totalMatched ?? 0);
      const frames = framed?.frames.map((f) => ({
        ...f,
        listed: elements.filter((e) => e.frame === f.selector).length,
      })) ?? [];
      result = {
        scope,
        count: elements.length,
        truncated: elements.length < totalMatched,
        totalMatched,
        ...(frames.length > 0 ? { frames } : {}),
        elements,
      };
    }

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}

interface FrameSummary {
  /** Selector prefix for the frame; join with " >>> " and an inner selector. */
  selector: string;
  url: string;
  /** True for an iframe laid over the page (fixed position and on top), such as a modal. */
  overlay: boolean;
  /** Interactive elements found in the frame (before the cap). */
  elements: number;
}

// Iframes smaller than this (tracking pixels, hidden helpers) aren't scanned.
const MIN_FRAME_PX = 5;

// Runs the collector in every laid-out child frame. Each element's
// selector_hint gets the frame prefix, and its rect moves to page coordinates.
async function scanFrames(
  page: Page,
  cap: number,
  includeHidden: boolean,
): Promise<{ elements: InteractiveElement[]; totalMatched: number; frames: FrameSummary[]; overlay: Set<string> }> {
  const elements: InteractiveElement[] = [];
  const frames: FrameSummary[] = [];
  const overlay = new Set<string>();
  const overlayFrames = new Set<Frame>();
  let totalMatched = 0;
  for (const frame of childFrames(page)) {
    const box = await frameContentBox(frame);
    if (!includeHidden && (!box || box.width < MIN_FRAME_PX || box.height < MIN_FRAME_PX)) continue;
    // A nested frame is an overlay when the frame holding it is one.
    const parent = frame.parentFrame();
    const isOverlay = parent && parent !== page.mainFrame()
      ? overlayFrames.has(parent)
      : await isOverlayIframe(frame);
    if (isOverlay) overlayFrames.add(frame);
    const r = await frame.evaluate(runInPage, { scope: "body", cap, includeHidden }).catch(() => null);
    if (!r) continue;
    const prefix = await framePath(frame);
    if (isOverlay) overlay.add(prefix);
    frames.push({ selector: prefix, url: frame.url(), overlay: isOverlay, elements: r.totalMatched });
    totalMatched += r.totalMatched;
    elements.push(...r.elements.map((el) => inFrame(el, prefix, box)));
  }
  return { elements, totalMatched, frames, overlay };
}

function inFrame(
  el: InteractiveElement,
  prefix: string,
  box: { x: number; y: number } | null,
): InteractiveElement {
  return {
    ...el,
    frame: prefix,
    rect: box ? { ...el.rect, x: el.rect.x + Math.round(box.x), y: el.rect.y + Math.round(box.y) } : el.rect,
    selector_hint: `${prefix} >>> ${el.selector_hint}`,
  };
}

// An overlay iframe is position:fixed (itself or an ancestor, through shadow
// roots) and on top at its own center. That matches modals, consent banners,
// and chat widgets, but not video, ad, or map embeds in the page flow.
async function isOverlayIframe(frame: Frame): Promise<boolean> {
  const el = await frame.frameElement().catch(() => null);
  if (!el) return false;
  return el.evaluate((iframe) => {
    const up = (n: Node): Node | null => n.parentNode ?? (n as ShadowRoot).host ?? null;
    let fixed = false;
    for (let n: Node | null = iframe; n && !fixed; n = up(n)) {
      fixed = n.nodeType === Node.ELEMENT_NODE && getComputedStyle(n as Element).position === "fixed";
    }
    if (!fixed) return false;
    const r = (iframe as Element).getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    for (let n: Node | null = iframe; n; n = up(n)) if (n === top) return true;
    return false;
  }).catch(() => false);
}

// scope with ` >>> ` (e.g. `iframe[title="Video"] >>> body`): list only the
// contents of that frame, under the CSS after the last ` >>> `.
async function scanOneFrame(page: Page, scope: string, cap: number, includeHidden: boolean): Promise<Record<string, unknown>> {
  const handle = await resolveLocator(page, scope).first().elementHandle({ timeout: 5000 });
  const frame = handle ? await handle.ownerFrame() : null;
  if (!frame) throw new Error(`scope "${scope}" matched nothing`);
  const inner = splitFramePierce(scope).pop()!;
  const prefix = await framePath(frame);
  const r: Result = await frame.evaluate(runInPage, { scope: inner, cap, includeHidden });
  const box = await frameContentBox(frame);
  return { ...r, scope, frame: prefix, elements: r.elements.map((el) => inFrame(el, prefix, box)) };
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
