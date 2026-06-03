import type { Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

// hit_test — geometric reachability probe. Answers "if a user tapped/clicked at
// this point, what element actually receives it?" by computing a viewport point
// (an element's center, or explicit x/y) and reading document.elementFromPoint
// + elementsFromPoint (the full z-ordered stack) there.
//
// Built for the iOS-Safari file-picker class of bug (a transparent <input
// type=file> sitting BELOW its trigger at a lower z-index, or mispositioned, so
// a genuine tap never lands on it). This is the ONE part of that bug verifiable
// on a real iOS device via the DOM — it needs no file chooser, so it runs where
// click_to_upload can't. Also general: "is this control covered by an overlay?"

export interface HitTestParams extends BrowserStackTarget {
  url?: string;
  session_id?: string;
  tab_id?: string;
  browser?: BrowserName;
  viewport?: { width: number; height: number };
  useBrowserStack?: boolean;
  actions?: AnyAction[];
  waitForNetworkIdle?: boolean;
  delay?: number;
  /** Element whose center to test, AND the intended hit target when expect_selector is omitted. */
  selector?: string;
  /** Explicit viewport point (alternative to selector's center). */
  x?: number;
  y?: number;
  /** Selector the tap is expected to resolve to (defaults to `selector`). */
  expect_selector?: string;
  /** Max elements to report from the z-ordered stack (default 8). */
  stack_depth?: number;
}

// Runs in the page. Resolves the point, reads the hit stack, and computes
// relationships against the intended target + expected selector.
//
// MUST be an ARROW function taking a JSON-STRING arg and returning a JSON
// STRING — three BrowserStack real-device-bridge quirks, all verified on real
// iOS 2026-06-03 (it's a Selenium/WebDriver bridge, not true Playwright
// protocol):
//   1. A *named function declaration* passed to page.evaluate receives NO
//      argument (arg arrives undefined). Arrow functions get it. → arrow.
//   2. An *object* arg arrives mangled in a raw-WebKit map encoding
//      ([{k,v}], 1→{n:1}), so `args.foo` reads undefined in-page. A STRING
//      arg round-trips cleanly. → pass JSON.stringify(...) and parse here.
//   3. A non-string *return* value mangles the same way. A string returns
//      cleanly. → return JSON.stringify(result), JSON.parse host-side.
// (Local Chromium tolerates all of these — this matters only on real devices.)
const runHitTest = (argsJson: string): string => {
  const args = JSON.parse(argsJson) as {
    selector?: string | null;
    x?: number | null;
    y?: number | null;
    expectSelector?: string | null;
    stackDepth: number;
  };
  const selector = args.selector ?? undefined;
  const x = args.x ?? undefined;
  const y = args.y ?? undefined;
  const expectSelector = args.expectSelector ?? undefined;
  const stackDepth = args.stackDepth;

  const describe = (el: Element | null) => {
    if (!el) return null;
    const he = el as HTMLElement;
    const isFileInput = el.tagName === "INPUT" && (el as HTMLInputElement).type === "file";
    const cls = el.classList ? Array.from(el.classList).slice(0, 6) : [];
    let text = "";
    try { text = (he.innerText ?? el.textContent ?? "").trim().slice(0, 40); } catch { /* */ }
    return {
      tag: el.tagName.toLowerCase(),
      id: (el as HTMLElement).id || null,
      classes: cls,
      isFileInput,
      text: text || undefined,
    };
  };
  // Relationship of `el` to `ref`: same / ancestor (el contains ref) /
  // descendant (ref contains el) / unrelated.
  const relation = (el: Element | null, ref: Element | null) => {
    if (!el || !ref) return "none";
    if (el === ref) return "same";
    if (el.contains(ref)) return "ancestor-of-target";
    if (ref.contains(el)) return "descendant-of-target";
    return "unrelated";
  };

  const targetEl = selector ? document.querySelector(selector) : null;
  if (selector && !targetEl) {
    return JSON.stringify({ error: `selector "${selector}" matched no element` });
  }

  // Determine the test point.
  let px = x, py = y, basedOn = "explicit";
  let targetRect: any = null;
  if (targetEl) {
    const r = targetEl.getBoundingClientRect();
    targetRect = { x: r.x, y: r.y, width: r.width, height: r.height };
    if (px === undefined || py === undefined) {
      px = r.left + r.width / 2;
      py = r.top + r.height / 2;
      basedOn = "selector-center";
    }
  }
  if (px === undefined || py === undefined) {
    return JSON.stringify({ error: "no point to test: provide `selector` or both `x` and `y`" });
  }

  const inViewport = px >= 0 && py >= 0 && px <= window.innerWidth && py <= window.innerHeight;
  const topmost = document.elementFromPoint(px, py);
  const stackEls = (document.elementsFromPoint(px, py) || []).slice(0, stackDepth);
  const expectEl = expectSelector ? document.querySelector(expectSelector) : null;

  // Does the tap reach the intended target (topmost is the target, or its
  // ancestor/descendant — i.e. the tap lands within the target's box)?
  const topRelTarget = relation(topmost, targetEl);
  const reachesTarget = targetEl ? ["same", "ancestor-of-target", "descendant-of-target"].includes(topRelTarget) : null;

  // Does the tap reach the expected selector (topmost is it or inside it)?
  let reachesExpected: boolean | null = null;
  let expectedInStack: boolean | null = null;
  if (expectEl) {
    reachesExpected = topmost ? (topmost === expectEl || expectEl.contains(topmost) || topmost.contains(expectEl)) : false;
    expectedInStack = stackEls.some((e) => e === expectEl || expectEl.contains(e) || e.contains(expectEl));
  }

  // Is a file input anywhere in the hit stack at this point?
  const fileInputInStack = stackEls.some((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type === "file");

  // When the topmost isn't the target, what's covering it?
  const coveredBy = targetEl && reachesTarget === false ? describe(topmost) : null;

  return JSON.stringify({
    point: { x: Math.round(px), y: Math.round(py) },
    basedOn,
    inViewport,
    target: targetEl ? { selector, rect: targetRect } : null,
    topmost: describe(topmost),
    stack: stackEls.map(describe),
    fileInputInStack,
    expect: expectSelector ? {
      selector: expectSelector,
      found: !!expectEl,
      reachesExpected,
      presentInStack: expectedInStack,
    } : null,
    verdict: {
      reachesTarget,
      coveredBy,
      // The headline for the upload-tap bug: would a genuine tap here open the
      // file chooser (i.e. land on / forward to a file input)?
      tapWouldHitFileInput: expectEl
        ? reachesExpected
        : (topmost ? (topmost.tagName === "INPUT" && (topmost as HTMLInputElement).type === "file") : false) || fileInputInStack,
    },
  });
};

export async function hitTestTool(params: HitTestParams) {
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
    selector,
    x,
    y,
    expect_selector,
    stack_depth = 8,
  } = params;

  if (!selector && (x === undefined || y === undefined)) {
    return { content: [{ type: "text" as const, text: "hit_test: provide `selector` (its center is tested) or both `x` and `y`." }], isError: true };
  }
  if (!session_id && !url) {
    return { content: [{ type: "text" as const, text: "hit_test: url is required when session_id is not provided." }], isError: true };
  }

  let page: Page;
  let cleanup: (() => Promise<void>) | null = null;
  let usedSession = false;

  if (session_id) {
    sessionManager.touch(session_id);
    page = sessionManager.getPage(session_id, tab_id);
    usedSession = true;
  } else {
    const session = await launchSession({ browser, viewport, useBrowserStack, ...pickBrowserStack(params) });
    page = session.page;
    cleanup = () => closeSession(session);
  }

  try {
    if (url) await navigateTo(page, url, waitForNetworkIdle);

    let actionStopMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
    }
    if (delay > 0) await page.waitForTimeout(delay);

    // runHitTest is an arrow taking a JSON-string arg and returning a JSON
    // string — see its note for the BrowserStack real-device-bridge quirks
    // this works around. null (not undefined) for absent values.
    const raw = await page.evaluate(runHitTest, JSON.stringify({
      selector: selector ?? null,
      x: x ?? null,
      y: y ?? null,
      expectSelector: expect_selector ?? null,
      stackDepth: stack_depth,
    }));
    const result = JSON.parse(raw);

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    content.push({ type: "text", text: JSON.stringify({ session: usedSession ? "reused" : "ephemeral", ...result }, null, 2) });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}
