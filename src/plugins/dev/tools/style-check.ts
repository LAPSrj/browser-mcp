import type { Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

export interface StyleCheckParams extends BrowserStackTarget {
  url?: string;
  session_id?: string;
  tab_id?: string;
  selector: string;
  expected: Record<string, string>;
  tolerance_px?: number;
  viewport?: { width: number; height: number };
  actions?: AnyAction[];
  useBrowserStack?: boolean;
}

interface Mismatch {
  property: string;
  expected: string;
  actual: string;
  within_tolerance?: boolean;
}

interface Match {
  property: string;
  value: string;
}

function valuesMatch(expected: string, actual: string, tolerancePx: number): "exact" | "tolerance" | false {
  if (expected === actual) return "exact";
  if (tolerancePx <= 0) return false;

  const expNum = parseFloat(expected);
  const actNum = parseFloat(actual);
  if (isNaN(expNum) || isNaN(actNum)) return false;

  const expUnit = expected.replace(/^[\d.\-+]+/, "");
  const actUnit = actual.replace(/^[\d.\-+]+/, "");
  if (expUnit !== actUnit) return false;

  return Math.abs(expNum - actNum) <= tolerancePx ? "tolerance" : false;
}

export async function styleCheckTool(params: StyleCheckParams) {
  const {
    url,
    session_id,
    tab_id,
    selector,
    expected,
    tolerance_px = 0,
    viewport = { width: 1280, height: 720 },
    actions = [],
    useBrowserStack = false,
  } = params;

  if (!session_id && !url) {
    return {
      content: [{ type: "text" as const, text: "url is required when session_id is not provided" }],
      isError: true,
    };
  }

  const propNames = Object.keys(expected);
  if (propNames.length === 0) {
    return {
      content: [{ type: "text" as const, text: "expected must contain at least one CSS property to check" }],
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

    const actual = await page.evaluate(
      ({ sel, props }) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const computed = getComputedStyle(el);
        const result: Record<string, string> = {};
        for (const p of props) {
          result[p] = computed.getPropertyValue(p);
        }
        return result;
      },
      { sel: selector, props: propNames },
    );

    if (actual === null) {
      return {
        content: [{ type: "text" as const, text: `No element found matching selector: ${selector}` }],
        isError: true,
      };
    }

    const mismatches: Mismatch[] = [];
    const matches: Match[] = [];

    for (const prop of propNames) {
      const exp = expected[prop];
      const act = actual[prop] ?? "";
      const matchResult = valuesMatch(exp, act, tolerance_px);
      if (matchResult) {
        matches.push({ property: prop, value: act });
        if (matchResult === "tolerance") {
          mismatches.push({ property: prop, expected: exp, actual: act, within_tolerance: true });
        }
      } else {
        mismatches.push({ property: prop, expected: exp, actual: act });
      }
    }

    const realMismatches = mismatches.filter((m) => !m.within_tolerance);
    const passed = realMismatches.length === 0;

    const result = {
      selector,
      passed,
      total: propNames.length,
      matches: matches.length,
      mismatches: realMismatches.length,
      ...(realMismatches.length > 0 ? { failures: realMismatches } : {}),
      ...(mismatches.some((m) => m.within_tolerance)
        ? { within_tolerance: mismatches.filter((m) => m.within_tolerance) }
        : {}),
    };

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}
