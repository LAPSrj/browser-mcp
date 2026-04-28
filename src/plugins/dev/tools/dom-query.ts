import type { BrowserContext, Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

// Per-query cap for match:"all" — keeps payloads bounded; callers tighten the
// selector or paginate. Hit cap reports `truncated:true`.
const MATCH_ALL_CAP = 50;
// Hard caps on per-element string fields. Walker rarely needs full text/html;
// past these sizes the call is almost certainly the wrong tool.
const TEXT_BYTE_CAP = 2048;
const HTML_BYTE_CAP = 4096;

export type DomField =
  | "rect"
  | "tag"
  | "id"
  | "classes"
  | "text"
  | "html"
  | "role"
  | "visible"
  | "attributes"
  | "computed";

export interface DomQuery {
  id?: string;
  selector: string;
  pseudoElement?: "before" | "after";
  match?: "first" | "all";
  fields?: DomField[];
  computed?: string[];
  attributes?: string[];
  requireVisible?: boolean;
}

export interface DomQueryParams {
  url?: string;
  session_id?: string;
  tab_id?: string;
  browser?: BrowserName;
  viewport?: { width: number; height: number };
  useBrowserStack?: boolean;
  actions?: AnyAction[];
  waitForNetworkIdle?: boolean;
  delay?: number;
  queries: DomQuery[];
  profile?: "walker";
}

const WALKER_PROFILE_DOM_QUERY_FIELDS: DomField[] = ["rect", "tag", "id", "classes", "text"];

interface ElementData {
  rect?: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
  tag?: string;
  id?: string | null;
  classes?: string[];
  text?: string;
  html?: string;
  role?: string | null;
  visible?: boolean;
  attributes?: Record<string, string | null>;
  computed?: Record<string, string>;
}

interface QueryResult {
  id: string;
  selector: string;
  found: boolean;
  pseudoElement?: "before" | "after";
  element?: ElementData;
  elements?: ElementData[];
  matchedCount?: number;
  truncated?: boolean;
  error?: string;
}

// Computed-style presets — locked vocab, expanded inside the page evaluate.
// Walker callers mix preset names with literal property names.
const COMPUTED_PRESETS: Record<string, string[]> = {
  box: [
    "width", "height",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "box-sizing",
  ],
  text: [
    "font-size", "font-weight", "font-family", "line-height",
    "letter-spacing", "text-transform", "color", "text-align",
  ],
  flex: [
    "display", "flex-direction", "flex-wrap",
    "justify-content", "align-items",
    "gap", "row-gap", "column-gap",
  ],
};

function expandComputedSpec(spec: string[] | undefined): string[] {
  if (!spec || spec.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of spec) {
    const expanded = COMPUTED_PRESETS[item] ?? [item];
    for (const prop of expanded) {
      if (!seen.has(prop)) {
        seen.add(prop);
        out.push(prop);
      }
    }
  }
  return out;
}

// Browser-side runner. Receives the full queries array (with computed specs
// pre-expanded) and returns the data array. Per-query selector / evaluate
// errors are caught here so a single bad query doesn't sink siblings.
function runQueriesInPage(args: {
  queries: Array<{
    id: string;
    selector: string;
    pseudoElement?: "before" | "after";
    match: "first" | "all";
    fields: DomField[];
    computed: string[];
    attributes: string[];
    requireVisible: boolean;
  }>;
  matchAllCap: number;
  textByteCap: number;
  htmlByteCap: number;
}): QueryResult[] {
  const { queries, matchAllCap, textByteCap, htmlByteCap } = args;

  function clip(s: string, cap: number): string {
    if (s.length <= cap) return s;
    return s.slice(0, cap) + `…[+${s.length - cap} chars]`;
  }

  function isVisible(el: Element): boolean {
    const style = getComputedStyle(el);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function buildElementData(
    el: Element,
    fields: DomField[],
    computedProps: string[],
    attrNames: string[],
    pseudo?: "before" | "after",
  ): ElementData {
    const want = new Set<DomField>(fields);
    const data: ElementData = {};
    const pseudoSelector = pseudo ? `::${pseudo}` : null;

    if (want.has("rect") && !pseudo) {
      // Pseudo-elements have no DOMRect; suppress under pseudoElement mode.
      const r = el.getBoundingClientRect();
      data.rect = {
        x: r.x, y: r.y, width: r.width, height: r.height,
        top: r.top, right: r.right, bottom: r.bottom, left: r.left,
      };
    }
    if (want.has("tag")) {
      data.tag = el.tagName.toLowerCase();
    }
    if (want.has("id")) {
      data.id = el.id || null;
    }
    if (want.has("classes")) {
      data.classes = el.classList ? Array.from(el.classList) : [];
    }
    if (want.has("text")) {
      const raw = pseudo
        ? (getComputedStyle(el, pseudoSelector!).getPropertyValue("content") || "")
        : ((el as HTMLElement).innerText ?? el.textContent ?? "");
      data.text = clip(raw.trim(), textByteCap);
    }
    if (want.has("html") && !pseudo) {
      data.html = clip(el.outerHTML, htmlByteCap);
    }
    if (want.has("role")) {
      // Computed role: explicit aria-role wins, else a small implicit map.
      const explicit = el.getAttribute("role");
      if (explicit) {
        data.role = explicit;
      } else {
        const t = el.tagName.toLowerCase();
        const implicit: Record<string, string> = {
          a: "link", button: "button", nav: "navigation",
          main: "main", header: "banner", footer: "contentinfo",
          aside: "complementary", section: "region", article: "article",
          h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
          ul: "list", ol: "list", li: "listitem",
          img: "img", input: "textbox", textarea: "textbox", select: "combobox",
        };
        data.role = implicit[t] ?? null;
      }
    }
    if (want.has("visible") && !pseudo) {
      data.visible = isVisible(el);
    }
    if (want.has("attributes") && attrNames.length > 0 && !pseudo) {
      const out: Record<string, string | null> = {};
      for (const name of attrNames) {
        out[name] = el.hasAttribute(name) ? el.getAttribute(name) : null;
      }
      data.attributes = out;
    }
    if (want.has("computed") && computedProps.length > 0) {
      const cs = pseudo ? getComputedStyle(el, pseudoSelector!) : getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const prop of computedProps) {
        out[prop] = cs.getPropertyValue(prop);
      }
      data.computed = out;
    }
    return data;
  }

  const results: QueryResult[] = [];

  for (const q of queries) {
    let elements: Element[] = [];
    try {
      if (q.match === "all") {
        elements = Array.from(document.querySelectorAll(q.selector));
      } else {
        const el = document.querySelector(q.selector);
        if (el) elements = [el];
      }
    } catch (e) {
      results.push({
        id: q.id,
        selector: q.selector,
        found: false,
        ...(q.pseudoElement ? { pseudoElement: q.pseudoElement } : {}),
        error: (e as Error).message || String(e),
      });
      continue;
    }

    if (elements.length === 0) {
      results.push({
        id: q.id,
        selector: q.selector,
        found: false,
        ...(q.pseudoElement ? { pseudoElement: q.pseudoElement } : {}),
      });
      continue;
    }

    if (q.requireVisible) {
      elements = elements.filter((el) => isVisible(el));
      if (elements.length === 0) {
        results.push({
          id: q.id,
          selector: q.selector,
          found: false,
          ...(q.pseudoElement ? { pseudoElement: q.pseudoElement } : {}),
        });
        continue;
      }
    }

    const matchedCount = elements.length;
    let truncated = false;
    if (q.match === "all" && elements.length > matchAllCap) {
      elements = elements.slice(0, matchAllCap);
      truncated = true;
    }

    try {
      if (q.match === "all") {
        const data = elements.map((el) =>
          buildElementData(el, q.fields, q.computed, q.attributes, q.pseudoElement),
        );
        results.push({
          id: q.id,
          selector: q.selector,
          found: true,
          ...(q.pseudoElement ? { pseudoElement: q.pseudoElement } : {}),
          elements: data,
          matchedCount,
          ...(truncated ? { truncated: true } : {}),
        });
      } else {
        const data = buildElementData(elements[0], q.fields, q.computed, q.attributes, q.pseudoElement);
        results.push({
          id: q.id,
          selector: q.selector,
          found: true,
          ...(q.pseudoElement ? { pseudoElement: q.pseudoElement } : {}),
          element: data,
        });
      }
    } catch (e) {
      results.push({
        id: q.id,
        selector: q.selector,
        found: false,
        ...(q.pseudoElement ? { pseudoElement: q.pseudoElement } : {}),
        error: (e as Error).message || String(e),
      });
    }
  }

  return results;
}

export async function domQueryTool(params: DomQueryParams) {
  const {
    url,
    session_id,
    tab_id,
    browser = "chromium" as BrowserName,
    viewport = { width: 1280, height: 720 },
    useBrowserStack = false,
    actions = [],
    waitForNetworkIdle = true,
    delay = 0,
    queries,
  } = params;

  if (!Array.isArray(queries) || queries.length === 0) {
    return {
      content: [{ type: "text" as const, text: "queries must be a non-empty array" }],
      isError: true,
    };
  }
  if (!session_id && !url) {
    return {
      content: [{ type: "text" as const, text: "url is required when session_id is not provided" }],
      isError: true,
    };
  }

  // Profile-derived default for fields when caller doesn't set them per-query.
  // Caller's per-query fields always wins.
  const defaultFields: DomField[] = params.profile === "walker"
    ? WALKER_PROFILE_DOM_QUERY_FIELDS
    : ["rect", "tag"];

  // Pre-expand computed presets host-side; the page-side runner stays simple.
  const expanded = queries.map((q, i) => ({
    id: q.id ?? String(i),
    selector: q.selector,
    pseudoElement: q.pseudoElement,
    match: q.match ?? "first" as const,
    fields: (q.fields ?? defaultFields),
    computed: expandComputedSpec(q.computed),
    attributes: q.attributes ?? [],
    requireVisible: q.requireVisible ?? true,
  }));

  let page: Page;
  let cleanup: (() => Promise<void>) | null = null;
  let usedSession = false;

  if (session_id) {
    sessionManager.touch(session_id);
    page = sessionManager.getPage(session_id, tab_id);
    usedSession = true;
  } else {
    const session = await launchSession({
      browser,
      viewport,
      useBrowserStack,
    });
    page = session.page;
    cleanup = () => closeSession(session);
  }

  try {
    if (url) {
      await navigateTo(page, url, waitForNetworkIdle);
    }

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    if (delay > 0) {
      await page.waitForTimeout(delay);
    }

    const results = await page.evaluate(runQueriesInPage, {
      queries: expanded,
      matchAllCap: MATCH_ALL_CAP,
      textByteCap: TEXT_BYTE_CAP,
      htmlByteCap: HTML_BYTE_CAP,
    });

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });

    const meta = {
      queries: queries.length,
      found: results.filter((r) => r.found).length,
      errors: results.filter((r) => r.error).length,
      session: usedSession ? "reused" : "ephemeral",
    };

    content.push({
      type: "text",
      text: JSON.stringify({ meta, results }, null, 2),
    });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}
