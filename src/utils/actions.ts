import type { Page } from "playwright";
import type { CustomActionHandler } from "../plugins/types.js";

// Module-level custom action handlers from plugins.
// Set once at startup by the server after loading plugins.
let globalCustomHandlers: Map<string, CustomActionHandler> = new Map();

/** Register plugin-provided custom action handlers globally. */
export function setCustomActionHandlers(handlers: Map<string, CustomActionHandler>): void {
  globalCustomHandlers = handlers;
}

export interface ClickAction {
  action: "click";
  selector: string;
  optional?: boolean;
  timeout?: number;
  force?: boolean;
}

export interface TypeAction {
  action: "type";
  selector: string;
  text: string;
  optional?: boolean;
  timeout?: number;
}

export interface WaitForSelectorAction {
  action: "wait_for_selector";
  selector: string;
  optional?: boolean;
  timeout?: number;
}

export interface WaitAction {
  action: "wait";
  ms: number;
}

export interface ScrollToAction {
  action: "scroll_to";
  selector: string;
  optional?: boolean;
  timeout?: number;
}

export interface EvaluateAction {
  action: "evaluate";
  script: string;
}

export interface HoverAction {
  action: "hover";
  selector: string;
  optional?: boolean;
  timeout?: number;
  force?: boolean;
}

export interface SelectAction {
  action: "select";
  selector: string;
  value: string;
  optional?: boolean;
  timeout?: number;
}

export interface AssertVisibleAction {
  action: "assert_visible";
  selector: string;
  timeout?: number;
}

export interface AssertHiddenAction {
  action: "assert_hidden";
  selector: string;
  timeout?: number;
}

export interface AssertAttributeAction {
  action: "assert_attribute";
  selector: string;
  attribute: string;
  /** Expected value. When omitted, asserts attribute is present (any value). */
  equals?: string;
  /** When true, asserts attribute is absent. Mutually exclusive with equals. */
  absent?: boolean;
}

export interface AssertTextAction {
  action: "assert_text";
  selector: string;
  /** Expected substring within the element's text content. */
  contains?: string;
  /** Expected exact text content (trimmed). */
  equals?: string;
}

export interface AssertCountAction {
  action: "assert_count";
  selector: string;
  /** Expected number of matching elements. */
  equals: number;
}

export type Action =
  | ClickAction
  | TypeAction
  | WaitForSelectorAction
  | WaitAction
  | ScrollToAction
  | EvaluateAction
  | HoverAction
  | SelectAction
  | AssertVisibleAction
  | AssertHiddenAction
  | AssertAttributeAction
  | AssertTextAction
  | AssertCountAction;

/** Broader type that includes plugin-provided actions alongside core ones. */
export type AnyAction = Action | { action: string; optional?: boolean; timeout?: number; [key: string]: unknown };

function resolveTimeout(act: { timeout?: number; optional?: boolean }): number | undefined {
  if (act.timeout !== undefined) return act.timeout;
  if (act.optional) return 5000;
  return undefined;
}

export interface ActionStopResult {
  index: number;
  action: Action;
  error: string;
}

export interface AssertionResult {
  index: number;
  action: string;
  selector?: string;
  passed: boolean;
  message: string;
}

export async function runActions(
  page: Page,
  actions: AnyAction[],
  customActionHandlers?: Map<string, CustomActionHandler>,
): Promise<{ stoppedAt?: ActionStopResult; assertions: AssertionResult[] }> {
  const assertions: AssertionResult[] = [];
  // Merge global plugin handlers with any explicitly passed handlers
  const allHandlers = globalCustomHandlers.size > 0 || customActionHandlers
    ? new Map([...globalCustomHandlers, ...(customActionHandlers ?? [])])
    : undefined;

  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];
    try {
      switch (act.action) {
        case "click": {
          const a = act as ClickAction;
          const timeout = resolveTimeout(a);
          const opts: Record<string, unknown> = {};
          if (timeout !== undefined) opts.timeout = timeout;
          if (a.force) opts.force = true;
          await page.click(a.selector, opts);
          break;
        }
        case "type": {
          const a = act as TypeAction;
          const timeout = resolveTimeout(a);
          await page.fill(a.selector, a.text, timeout !== undefined ? { timeout } : undefined);
          break;
        }
        case "wait_for_selector": {
          const a = act as WaitForSelectorAction;
          const timeout = resolveTimeout(a) ?? 30000;
          await page.waitForSelector(a.selector, { timeout });
          break;
        }
        case "wait":
          await page.waitForTimeout((act as WaitAction).ms);
          break;
        case "scroll_to": {
          const a = act as ScrollToAction;
          const timeout = resolveTimeout(a);
          await page.locator(a.selector).scrollIntoViewIfNeeded(
            timeout !== undefined ? { timeout } : undefined,
          );
          break;
        }
        case "evaluate":
          await evaluateScript(page, (act as EvaluateAction).script);
          break;
        case "hover": {
          const a = act as HoverAction;
          const timeout = resolveTimeout(a);
          const opts: Record<string, unknown> = {};
          if (timeout !== undefined) opts.timeout = timeout;
          if (a.force) opts.force = true;
          await page.hover(a.selector, opts);
          break;
        }
        case "select": {
          const a = act as SelectAction;
          const timeout = resolveTimeout(a);
          await page.selectOption(
            a.selector,
            a.value,
            timeout !== undefined ? { timeout } : undefined,
          );
          break;
        }
        case "assert_visible":
        case "assert_hidden":
        case "assert_attribute":
        case "assert_text":
        case "assert_count": {
          const result = await runAssertion(page, i, act as Action);
          assertions.push(result);
          break;
        }
        default: {
          // Check for plugin-provided custom action handler
          const handler = allHandlers?.get(act.action);
          if (!handler) {
            throw new Error(`Unknown action: ${act.action}`);
          }
          await handler(page, act as Record<string, unknown>);
          break;
        }
      }
    } catch (error) {
      if ("optional" in act && act.optional) {
        continue;
      }
      // Explicit timeout set → soft stop (return error, don't throw)
      if ("timeout" in act && act.timeout !== undefined) {
        return {
          stoppedAt: {
            index: i,
            action: act as Action,
            error: (error as Error).message,
          },
          assertions,
        };
      }
      throw error;
    }
  }
  return { assertions };
}

/**
 * Run a user-supplied script in the page context and return its result.
 *
 * Playwright's page.evaluate with a string evaluates it as a top-level
 * expression, so `return` throws a SyntaxError. Wrapping the body in an
 * IIFE lets `return` work naturally AND keeps existing statement-style
 * scripts working (they simply return undefined).
 */
export async function evaluateScript(page: Page, script: string): Promise<unknown> {
  const wrapped = `(() => { ${script} })()`;
  return page.evaluate(wrapped);
}

async function runAssertion(page: Page, index: number, act: Action): Promise<AssertionResult> {
  try {
    switch (act.action) {
      case "assert_visible": {
        const a = act as AssertVisibleAction;
        const locator = page.locator(a.selector);
        try {
          await locator.first().waitFor({ state: "visible", timeout: a.timeout ?? 3000 });
          return { index, action: a.action, selector: a.selector, passed: true, message: `visible` };
        } catch {
          return {
            index,
            action: a.action,
            selector: a.selector,
            passed: false,
            message: `expected visible, but element is hidden or missing`,
          };
        }
      }
      case "assert_hidden": {
        const a = act as AssertHiddenAction;
        const locator = page.locator(a.selector);
        try {
          await locator.first().waitFor({ state: "hidden", timeout: a.timeout ?? 3000 });
          return { index, action: a.action, selector: a.selector, passed: true, message: `hidden` };
        } catch {
          return {
            index,
            action: a.action,
            selector: a.selector,
            passed: false,
            message: `expected hidden, but element is visible`,
          };
        }
      }
      case "assert_attribute": {
        const a = act as AssertAttributeAction;
        if (a.equals !== undefined && a.absent) {
          return {
            index, action: a.action, selector: a.selector, passed: false,
            message: `invalid: cannot use both equals and absent`,
          };
        }
        const value = await page.locator(a.selector).first().getAttribute(a.attribute);
        if (a.absent) {
          const passed = value === null;
          return {
            index, action: a.action, selector: a.selector, passed,
            message: passed ? `[${a.attribute}] absent` : `expected [${a.attribute}] absent, got "${value}"`,
          };
        }
        if (a.equals !== undefined) {
          const passed = value === a.equals;
          return {
            index, action: a.action, selector: a.selector, passed,
            message: passed ? `[${a.attribute}] = "${a.equals}"` : `expected [${a.attribute}]="${a.equals}", got ${value === null ? "(absent)" : `"${value}"`}`,
          };
        }
        const passed = value !== null;
        return {
          index, action: a.action, selector: a.selector, passed,
          message: passed ? `[${a.attribute}] present ("${value}")` : `expected [${a.attribute}] present, but absent`,
        };
      }
      case "assert_text": {
        const a = act as AssertTextAction;
        const raw = await page.locator(a.selector).first().textContent();
        const text = (raw ?? "").trim();
        if (a.equals !== undefined) {
          const passed = text === a.equals;
          return {
            index, action: a.action, selector: a.selector, passed,
            message: passed ? `text matches` : `expected text "${a.equals}", got "${text.slice(0, 80)}"`,
          };
        }
        if (a.contains !== undefined) {
          const passed = text.includes(a.contains);
          return {
            index, action: a.action, selector: a.selector, passed,
            message: passed ? `text contains "${a.contains}"` : `expected text to contain "${a.contains}", got "${text.slice(0, 80)}"`,
          };
        }
        return {
          index, action: a.action, selector: a.selector, passed: false,
          message: `invalid: assert_text requires equals or contains`,
        };
      }
      case "assert_count": {
        const a = act as AssertCountAction;
        const count = await page.locator(a.selector).count();
        const passed = count === a.equals;
        return {
          index, action: a.action, selector: a.selector, passed,
          message: passed ? `count = ${count}` : `expected count=${a.equals}, got ${count}`,
        };
      }
      default:
        return { index, action: (act as Action).action, passed: false, message: "unknown assertion" };
    }
  } catch (error) {
    return {
      index,
      action: (act as Action).action,
      selector: (act as { selector?: string }).selector,
      passed: false,
      message: `error: ${(error as Error).message}`,
    };
  }
}

export function formatActionStop(stoppedAt: ActionStopResult): string {
  const act = stoppedAt.action;
  const desc = "selector" in act ? `${act.action} "${(act as { selector: string }).selector}"` : act.action;
  return `Action ${stoppedAt.index + 1} failed (${desc}): ${stoppedAt.error}`;
}

/**
 * Run actions and emit formatted messages for any stop/assertions into the
 * provided content array. Returns the raw result in case the caller needs
 * to branch on stop.
 */
export async function runActionsAndReport(
  page: Page,
  actions: AnyAction[],
  content: Array<{ type: string; text: string }>,
): Promise<{ stoppedAt?: ActionStopResult; assertions: AssertionResult[] }> {
  const result = await runActions(page, actions);
  if (result.stoppedAt) content.push({ type: "text", text: formatActionStop(result.stoppedAt) });
  const msg = formatAssertions(result.assertions);
  if (msg) content.push({ type: "text", text: msg });
  return result;
}

export function formatAssertions(assertions: AssertionResult[]): string | undefined {
  if (assertions.length === 0) return undefined;
  const passed = assertions.filter((a) => a.passed).length;
  const failed = assertions.length - passed;
  const lines = [`Assertions: ${passed} passed, ${failed} failed`];
  for (const a of assertions) {
    const tag = a.passed ? "✓" : "✗";
    const sel = a.selector ? ` ${a.selector}` : "";
    lines.push(`  ${tag} [${a.index + 1}] ${a.action}${sel}: ${a.message}`);
  }
  return lines.join("\n");
}
