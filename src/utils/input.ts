import type { Locator, Page } from "playwright";
import {
  between,
  dragLikeAPerson,
  isHuman,
  pasteLikeAPerson,
  pressLikeAPerson,
  scrollIntoViewLikeAPerson,
  sleep,
  typeLikeAPerson,
  wheelLikeAPerson,
} from "./human.js";
import { pointerActionFailingFastWhenCovered } from "./locator.js";

// Keyboard, scroll, drag and form input for the tools and evaluate_script
// actions. Each function acts like a person on a human_behavior page
// (utils/human.ts) and uses Playwright's instant version otherwise.

/**
 * Longer text is pasted instead of typed. People type a name, a search or a
 * short message, and paste longer blocks; typing 200 characters already
 * takes about 25 s.
 */
export const LONG_TEXT = 200;

// Inputs a person sets through a picker. Dates are typed into the field's
// segments; the rest are set directly after a pause for picking.
const PICKER_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"]);

interface FieldInfo {
  focused: boolean;
  hasText: boolean;
  multiline: boolean;
  /** The input type when it's one of PICKER_TYPES. */
  picker: string | null;
  /** Date field order of the page's language, e.g. ["month", "day", "year"]. */
  dateOrder: string[];
}

async function fieldInfo(locator: Locator, timeout?: number): Promise<FieldInfo> {
  return locator.evaluate(
    (el, pickers) => {
      const active = document.activeElement;
      const input = el as HTMLInputElement;
      return {
        focused: el === active || el.contains(active),
        hasText: "value" in el ? String(input.value ?? "").length > 0 : (el.textContent ?? "").length > 0,
        multiline: el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable,
        picker: el.tagName === "INPUT" && pickers.includes(input.type) ? input.type : null,
        dateOrder: new Intl.DateTimeFormat(navigator.language)
          .formatToParts(new Date(2024, 4, 1))
          .filter((p) => ["day", "month", "year"].includes(p.type))
          .map((p) => p.type),
      };
    },
    [...PICKER_TYPES],
    { timeout },
  );
}

// The date field order that worked on a page. The browser takes it from the
// OS regional settings, which can differ from navigator.language (Edge on a
// Windows set to day/month/year reports en-US; verified live).
const dateOrders = new WeakMap<Page, string[]>();

/**
 * Type a YYYY-MM-DD date into a date input's segments: click the first
 * segment and type the digits in the field's order. The order is guessed
 * from the page's language, and a wrong guess is retyped in the next likely
 * order, as a person corrects a date. Returns false when no order gave the
 * date (the caller sets it directly).
 */
async function typeDate(locator: Locator, selector: string, date: string, info: FieldInfo, timeout?: number): Promise<boolean> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const page = locator.page();
  const digits: Record<string, string> = { year: m[1], month: m[2], day: m[3] };
  const known = dateOrders.get(page);
  const orders = [known, info.dateOrder, ["day", "month", "year"], ["month", "day", "year"], ["year", "month", "day"]]
    .filter((o): o is string[] => !!o && o.length === 3)
    .filter((o, i, all) => all.findIndex((x) => x.join() === o.join()) === i)
    .slice(0, 3);
  for (const order of orders) {
    // The first segment starts a few px into the field.
    const box = await locator.boundingBox({ timeout });
    await pointerActionFailingFastWhenCovered(locator, "click", selector, {
      timeout,
      position: { x: Math.round(between(6, 12)), y: Math.round((box?.height ?? 20) / 2) },
    });
    await sleep(between(150, 350));
    await typeLikeAPerson(page, order.map((part) => digits[part]).join(""));
    await sleep(between(150, 300));
    if ((await locator.inputValue({ timeout })) === date) {
      dateOrders.set(page, order);
      return true;
    }
    await sleep(between(300, 700)); // noticing the wrong date
  }
  return false;
}

/** Focus the element by clicking it, unless it already has focus. */
async function focusLikeAPerson(locator: Locator, selector: string, timeout?: number): Promise<FieldInfo> {
  const info = await fieldInfo(locator, timeout);
  if (info.focused) await sleep(between(100, 250));
  else await pointerActionFailingFastWhenCovered(locator, "click", selector, { timeout });
  await sleep(between(150, 400));
  return info;
}

/**
 * Fill a text field. clear (default) replaces the value, otherwise the text
 * is added at the end.
 *
 * Human: click into the field (unless it's focused), select all and delete
 * when clearing, or move the caret to the end when adding, then type key by
 * key, or paste text over LONG_TEXT characters. A date is typed into the
 * date field's segments. Time, color, range and the other picker inputs are
 * set directly after a pause for picking.
 * Otherwise: Playwright fill(), or pressSequentially() when adding.
 */
export async function typeText(
  locator: Locator,
  selector: string,
  text: string,
  opts: { clear?: boolean; pressEnter?: boolean; timeout?: number } = {},
): Promise<void> {
  const page = locator.page();
  const clear = opts.clear !== false;
  if (!isHuman(page)) {
    if (clear) await locator.fill(text, { timeout: opts.timeout });
    else await locator.pressSequentially(text, { timeout: opts.timeout });
    if (opts.pressEnter) await locator.press("Enter");
    return;
  }
  const info = await fieldInfo(locator, opts.timeout);
  const typedDate = info.picker === "date" && (await typeDate(locator, selector, text, info, opts.timeout));
  if (typedDate) {
    // done
  } else if (info.picker) {
    if (info.picker !== "date") await focusLikeAPerson(locator, selector, opts.timeout);
    await sleep(between(800, 2000)); // picking in the browser's picker
    await locator.fill(text, { timeout: opts.timeout });
  } else {
    await focusLikeAPerson(locator, selector, opts.timeout);
    if (clear && info.hasText) {
      await pressLikeAPerson(page, "ControlOrMeta+a");
      await sleep(between(80, 200));
      await pressLikeAPerson(page, "Backspace");
      await sleep(between(150, 350));
    } else if (!clear) {
      await pressLikeAPerson(page, info.multiline ? "ControlOrMeta+End" : "End");
      await sleep(between(100, 250));
    }
    if ([...text].length > LONG_TEXT) await pasteLikeAPerson(page, locator, text);
    else await typeLikeAPerson(page, text);
  }
  if (opts.pressEnter) {
    await sleep(between(250, 700));
    await pressLikeAPerson(page, "Enter");
  }
}

/**
 * Press keys in order; the first on `locator` if given. Human: click to
 * focus it (unless focused), hold each key a person's time, and pause
 * between keys.
 */
export async function pressKeys(
  page: Page,
  keys: string[],
  onEach: (key: string) => Promise<void>,
  target?: { locator: Locator; selector: string; timeout?: number },
): Promise<void> {
  const human = isHuman(page);
  if (human && target) await focusLikeAPerson(target.locator, target.selector, target.timeout);
  for (const [i, key] of keys.entries()) {
    if (human) {
      if (i > 0) await sleep(between(120, 350));
      await pressLikeAPerson(page, key);
    } else if (i === 0 && target) {
      await target.locator.press(key, { timeout: target.timeout });
    } else {
      await page.keyboard.press(key);
    }
    await onEach(key);
  }
}

/** Check or uncheck. Human: click it like a person when its state differs, then confirm the state changed. */
export async function setChecked(locator: Locator, selector: string, checked: boolean, timeout?: number): Promise<void> {
  if (!isHuman(locator.page())) {
    if (checked) await locator.check({ timeout });
    else await locator.uncheck({ timeout });
    return;
  }
  if ((await locator.isChecked({ timeout })) === checked) return;
  await pointerActionFailingFastWhenCovered(locator, "click", selector, { timeout });
  if ((await locator.isChecked({ timeout })) !== checked) {
    throw new Error(`Clicking ${selector} didn't ${checked ? "check" : "uncheck"} it.`);
  }
}

/**
 * Pick an option in a <select>. Human: click it open, move to the option
 * with the arrow keys and press Enter, so the page gets trusted input and
 * change events (Playwright's selectOption sets the value from a script, and
 * its events have isTrusted false; verified live). The mouse can't pick the
 * option because the browser draws the open list outside the page. A
 * <select multiple>, an option that isn't found, or a list where the arrows
 * don't reach the option falls back to selectOption.
 */
export async function selectOption(
  locator: Locator,
  selector: string,
  option: string | { value?: string; label?: string; index?: number },
  timeout?: number,
): Promise<string[]> {
  const page = locator.page();
  if (!isHuman(page)) return locator.selectOption(option, { timeout });
  const plan = await locator.evaluate((el, want) => {
    const s = el as HTMLSelectElement;
    if (s.tagName !== "SELECT" || s.multiple) return null;
    const opts = [...s.options];
    // A string matches the value or the label, as in Playwright.
    const target = opts.findIndex((o, i) =>
      typeof want === "string"
        ? o.value === want || o.label === want
        : want.index !== undefined
          ? i === want.index
          : want.value !== undefined
            ? o.value === want.value
            : o.label === want.label,
    );
    if (target < 0 || opts[target].disabled) return null;
    // Arrow presses: one per enabled option passed on the way (the arrows skip
    // disabled ones). With nothing selected, the first ArrowDown selects the
    // first enabled option.
    const from = s.selectedIndex;
    const down = from < target;
    const steps = opts.filter((o, i) => !o.disabled && (down ? i > from && i <= target : i >= target && i < from)).length;
    return { steps, down, same: from === target, value: opts[target].value };
  }, option, { timeout });
  if (!plan) return locator.selectOption(option, { timeout });
  if (plan.same) return [plan.value];
  await pointerActionFailingFastWhenCovered(locator, "click", selector, { timeout });
  await sleep(between(300, 700)); // reading the list
  for (let i = 0; i < plan.steps; i++) {
    await pressLikeAPerson(page, plan.down ? "ArrowDown" : "ArrowUp");
    await sleep(between(80, 220));
  }
  await sleep(between(150, 400));
  await pressLikeAPerson(page, "Enter");
  await sleep(between(100, 200));
  if ((await locator.inputValue({ timeout })) === plan.value) return [plan.value];
  await pressLikeAPerson(page, "Escape");
  return locator.selectOption(option, { timeout });
}

/** Scroll an element into view. Human: with the mouse wheel. */
export async function scrollIntoView(locator: Locator, timeout?: number): Promise<void> {
  if (isHuman(locator.page())) await scrollIntoViewLikeAPerson(locator, timeout);
  await locator.scrollIntoViewIfNeeded({ timeout });
}

/**
 * Scroll the page to the top, the bottom, or by (dx, dy). Human: with the
 * mouse wheel, so the distance is rounded to whole notches (about 110 px).
 * Returns how far the page moved.
 */
export async function scrollPage(page: Page, to: { top?: boolean; bottom?: boolean; dx?: number; dy?: number }): Promise<{ x: number; y: number }> {
  const pos = () => page.evaluate(() => ({ x: scrollX, y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
  const start = await pos();
  if (isHuman(page)) {
    // For the top and bottom, aim past the end: the wheel stops when the page does.
    const dy = to.top ? -start.y - 300 : to.bottom ? Math.max(0, start.max - start.y) + 300 : (to.dy ?? 0);
    return wheelLikeAPerson(page, to.top || to.bottom ? 0 : (to.dx ?? 0), dy);
  }
  if (to.top) await page.evaluate(() => window.scrollTo(0, 0));
  else if (to.bottom) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  else await page.evaluate(([x, y]) => window.scrollBy(x, y), [to.dx ?? 0, to.dy ?? 0]);
  const end = await pos();
  return { x: end.x - start.x, y: end.y - start.y };
}

/** Drag one element onto another. Human: press, carry along a curved path, release. */
export async function drag(from: Locator, to: Locator, timeout?: number): Promise<void> {
  if (isHuman(from.page())) await dragLikeAPerson(from, to, timeout);
  else await from.dragTo(to, { timeout });
}
