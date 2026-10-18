import type { Locator, Page } from "playwright";

// open_session human_behavior: input that looks like a person's to bot checks
// (Cloudflare Turnstile and the like). The mouse moves along curves with
// uneven speed, presses are held, the page scrolls with the wheel in notches
// instead of jumping, and text is typed key by key at a person's rhythm.
// Pages are registered per tab by the session (setHumanBehavior).

const humanPages = new WeakSet<Page>();
const lastMouse = new WeakMap<Page, { x: number; y: number }>();

export function setHumanBehavior(page: Page, on: boolean): void {
  if (on) humanPages.add(page);
  else humanPages.delete(page);
}

export function isHuman(page: Page): boolean {
  return humanPages.has(page);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const between = (min: number, max: number) => min + Math.random() * (max - min);
/** How long a person holds a key or mouse button down. */
export const holdMs = () => between(45, 120);

async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  return page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
}

/** Where the mouse is; puts it somewhere in the middle of the viewport the first time. */
async function mouseAt(page: Page): Promise<{ x: number; y: number }> {
  let at = lastMouse.get(page);
  if (!at) {
    const vp = await viewportOf(page);
    at = { x: Math.round(vp.width * between(0.3, 0.7)), y: Math.round(vp.height * between(0.3, 0.7)) };
    await page.mouse.move(at.x, at.y);
    lastMouse.set(page, at);
  }
  return at;
}

type Point = { x: number; y: number };
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

// Path shapes, picked at random for each move. Each maps t in [0, 1] to a
// point between `from` and `to`; `n` is the unit normal to the straight line.
const PATHS: Array<(from: Point, to: Point, n: Point, dist: number) => (t: number) => Point> = [
  // One arc to a side.
  (from, to, n, dist) => {
    const b = between(0.08, 0.3) * dist * pick([-1, 1]);
    const c = { x: (from.x + to.x) / 2 + n.x * b, y: (from.y + to.y) / 2 + n.y * b };
    return (t) => ({
      x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * c.x + t ** 2 * to.x,
      y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * c.y + t ** 2 * to.y,
    });
  },
  // An S: bends one way, then the other.
  (from, to, n, dist) => {
    const b = between(0.05, 0.2) * dist * pick([-1, 1]);
    const c1 = { x: from.x + (to.x - from.x) * 0.3 + n.x * b, y: from.y + (to.y - from.y) * 0.3 + n.y * b };
    const c2 = { x: from.x + (to.x - from.x) * 0.7 - n.x * b, y: from.y + (to.y - from.y) * 0.7 - n.y * b };
    return (t) => cubic(from, c1, c2, to, t);
  },
  // Almost straight, with a slight hand tremor.
  (from, to, n, dist) => {
    const b = between(0, 0.05) * dist * pick([-1, 1]);
    const amp = between(0.5, 2);
    const waves = between(1, 3);
    return (t) => {
      const w = b * Math.sin(Math.PI * t) + amp * Math.sin(2 * Math.PI * waves * t);
      return { x: from.x + (to.x - from.x) * t + n.x * w, y: from.y + (to.y - from.y) * t + n.y * w };
    };
  },
  // A lopsided arc, its widest point early or late.
  (from, to, n, dist) => {
    const b = between(0.1, 0.25) * dist * pick([-1, 1]);
    const at = pick([0.2, 0.75]);
    const c1 = { x: from.x + (to.x - from.x) * at + n.x * b, y: from.y + (to.y - from.y) * at + n.y * b };
    const c2 = { x: from.x + (to.x - from.x) * (at + 0.15) + n.x * b * 0.6, y: from.y + (to.y - from.y) * (at + 0.15) + n.y * b * 0.6 };
    return (t) => cubic(from, c1, c2, to, t);
  },
];

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y,
  };
}

// Speed along the path, picked at random for each move.
const SPEEDS: Array<(s: number) => number> = [
  (s) => 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5, // minimum jerk: smooth start and stop
  (s) => 1 - (1 - s) ** 3, // fast start, slow approach
  (s) => (s < 0.5 ? 2 * s * s : 1 - (-2 * s + 2) ** 2 / 2), // ease in and out
];

/** One movement along a random path and speed, lasting `ms`, one whole-pixel mousemove every 6-14 ms. */
async function sweep(page: Page, from: Point, to: Point, ms: number): Promise<void> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const n = dist ? { x: -dy / dist, y: dx / dist } : { x: 0, y: 0 };
  const path = pick(PATHS)(from, to, n, dist);
  const speed = pick(SPEEDS);
  const steps = Math.min(60, Math.max(4, Math.round(ms / 10)));
  let last = from;
  for (let i = 1; i <= steps; i++) {
    const p = i === steps ? to : path(speed(i / steps));
    const next = { x: Math.round(p.x), y: Math.round(p.y) };
    if (next.x !== last.x || next.y !== last.y) await page.mouse.move(next.x, next.y);
    last = next;
    await sleep(between(6, 14));
  }
}

/**
 * Move the mouse to (x, y) from where it was left, the way a hand does: a
 * random path shape and speed profile each time, taking longer for far or
 * small targets (Fitts's law), and on longer moves sometimes overshooting
 * and correcting. Playwright's own move jumps straight there in one event.
 * `targetWidth` is the element's width in px.
 */
export async function moveMouseLikeAPerson(page: Page, x: number, y: number, targetWidth = 40): Promise<void> {
  const from = lastMouse.get(page) ?? {
    x: Math.max(0, Math.round(x + between(-300, 300))),
    y: Math.max(0, Math.round(y + between(-200, 200))),
  };
  const to = { x, y };
  const dist = Math.hypot(x - from.x, y - from.y);
  const ms = (120 + 140 * Math.log2(dist / Math.max(8, targetWidth) + 1)) * between(0.8, 1.25);
  await page.mouse.move(from.x, from.y);
  if (dist > 150 && Math.random() < 0.3) {
    // Overshoot by 3-8% of the distance, a little off the line, then correct.
    const over = between(0.03, 0.08);
    const past = {
      x: Math.round(x + (x - from.x) * over + between(-6, 6)),
      y: Math.round(y + (y - from.y) * over + between(-6, 6)),
    };
    await sweep(page, from, past, ms * 0.85);
    await sleep(between(30, 90));
    await sweep(page, past, to, between(80, 160));
  } else {
    await sweep(page, from, to, ms);
  }
  lastMouse.set(page, to);
}

/** A random whole-pixel point in the middle of the element, or `position` from its top-left. */
async function pointIn(locator: Locator, timeout: number | undefined, position?: { x: number; y: number }) {
  const box = await locator.boundingBox({ timeout });
  if (!box) throw new Error("the element has no box on the page (hidden or detached).");
  return {
    x: Math.round(box.x + (position ? position.x : box.width * between(0.3, 0.7))),
    y: Math.round(box.y + (position ? position.y : box.height * between(0.3, 0.7))),
    width: box.width,
  };
}

/**
 * Scroll with the mouse wheel, a few notches at a time, until the element is
 * in the viewport. Returns without scrolling further when the wheel moves
 * nothing (an inner scroll box under the mouse, the end of the page); the
 * caller's Playwright action then scrolls the rest the instant way.
 */
export async function scrollIntoViewLikeAPerson(locator: Locator, timeout?: number): Promise<void> {
  const page = locator.page();
  await locator.waitFor({ state: "attached", timeout });
  const vp = await viewportOf(page);
  let box = await locator.boundingBox({ timeout });
  if (!box) return;
  await mouseAt(page);
  for (let round = 0; round < 60; round++) {
    const visibleHeight = Math.min(box.height, vp.height);
    if (box.y >= 0 && box.y + visibleHeight <= vp.height && box.x >= 0 && box.x + Math.min(box.width, vp.width) <= vp.width) return;
    // Aim the element's middle at 35-65% of the viewport height.
    const dy = box.y + visibleHeight / 2 - vp.height * between(0.35, 0.65);
    const notches = Math.min(4, Math.max(1, Math.round(Math.abs(dy) / 110)));
    for (let n = 0; n < notches; n++) {
      await page.mouse.wheel(0, Math.sign(dy) * Math.round(between(95, 125)));
      await sleep(between(30, 80));
    }
    await sleep(between(100, 180)); // smooth scrolling finishing
    const after = await locator.boundingBox({ timeout });
    if (!after || after.y === box.y) return;
    box = after;
  }
}

/**
 * Click or hover the way a person would: wheel the element into view,
 * Playwright's actionability checks (a trial run that doesn't act), a curved
 * mouse path to a random point in the middle of the element (or `position`),
 * and a 50-150 ms press for each click.
 */
export async function pointerLikeAPerson(
  locator: Locator,
  kind: "click" | "hover",
  opts: { timeout?: number; force?: boolean } & Record<string, unknown>,
  timeout: number | undefined,
): Promise<void> {
  if (!opts.force) {
    await scrollIntoViewLikeAPerson(locator, timeout);
    if (kind === "click") await locator.click({ ...opts, timeout, trial: true });
    else await locator.hover({ ...opts, timeout, trial: true });
  }
  const page = locator.page();
  const { x, y, width } = await pointIn(locator, timeout, opts.position as { x: number; y: number } | undefined);
  await moveMouseLikeAPerson(page, x, y, width);
  if (kind === "hover") return;
  const button = (opts.button as "left" | "right" | "middle" | undefined) ?? "left";
  const clickCount = (opts.clickCount as number | undefined) ?? 1;
  await sleep(between(40, 150)); // the hand settles before pressing
  for (let i = 1; i <= clickCount; i++) {
    if (i > 1) await sleep(between(80, 140));
    await page.mouse.down({ button, clickCount: i });
    await sleep(between(50, 150));
    await page.mouse.up({ button, clickCount: i });
  }
}

/** Drag from one element to another with the mouse held down along a curved path. */
export async function dragLikeAPerson(from: Locator, to: Locator, timeout?: number): Promise<void> {
  const page = from.page();
  await scrollIntoViewLikeAPerson(from, timeout);
  await from.hover({ timeout, trial: true });
  const start = await pointIn(from, timeout);
  await moveMouseLikeAPerson(page, start.x, start.y, start.width);
  await sleep(between(40, 150));
  await page.mouse.down();
  await sleep(between(120, 250));
  await to.hover({ timeout, trial: true });
  const end = await pointIn(to, timeout);
  await moveMouseLikeAPerson(page, end.x, end.y, end.width);
  await sleep(between(80, 200));
  await page.mouse.up();
}

/**
 * Wheel the page by about (dx, dy), in notches. Returns the distance it
 * actually moved, which differs from the request at the ends of the page and
 * because a notch is about 110 px.
 */
export async function wheelLikeAPerson(page: Page, dx: number, dy: number): Promise<{ x: number; y: number }> {
  const pos = () => page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const start = await pos();
  await mouseAt(page);
  let moved = { x: 0, y: 0 };
  for (let round = 0; round < 400; round++) {
    const leftY = dy - moved.y;
    const leftX = dx - moved.x;
    if (Math.abs(leftY) < 60 && Math.abs(leftX) < 60) break;
    const stepY = Math.abs(leftY) < 60 ? 0 : Math.sign(leftY) * Math.min(Math.abs(leftY), Math.round(between(95, 125)));
    const stepX = Math.abs(leftX) < 60 ? 0 : Math.sign(leftX) * Math.min(Math.abs(leftX), Math.round(between(95, 125)));
    await page.mouse.wheel(stepX, stepY);
    await sleep(between(30, 80));
    if (round % 4 === 3) {
      await sleep(between(100, 180));
      const now = await pos();
      const next = { x: now.x - start.x, y: now.y - start.y };
      if (next.x === moved.x && next.y === moved.y) break; // end of the page
      moved = next;
    } else {
      moved = { x: moved.x + stepX, y: moved.y + stepY };
    }
  }
  await sleep(between(100, 180));
  const end = await pos();
  return { x: end.x - start.x, y: end.y - start.y };
}

// Characters typed with Shift held on a US keyboard.
const SHIFTED = /[A-Z~!@#$%^&*()_+{}|:"<>?]/;

/** Time between two keys: faster inside words, slower after spaces and punctuation, with an occasional pause. */
function keyGap(prev: string): number {
  let ms = between(45, 140);
  if (prev === " ") ms += between(30, 150);
  if (/[.,;:!?]/.test(prev)) ms += between(150, 400);
  if (prev === "\n") ms += between(300, 700);
  if (Math.random() < 0.03) ms += between(400, 1000);
  return ms;
}

/**
 * Type into the focused element key by key at a person's rhythm, holding
 * Shift for capitals and shifted symbols. Characters a US keyboard doesn't
 * have (accents, emoji) are inserted the way an input method commits them.
 */
export async function typeLikeAPerson(page: Page, text: string): Promise<void> {
  let prev = "";
  for (const ch of text) {
    if (prev) await sleep(keyGap(prev));
    prev = ch;
    if (ch === "\n") {
      await page.keyboard.press("Enter", { delay: holdMs() });
    } else if (/^[\x20-\x7e]$/.test(ch)) {
      const shift = SHIFTED.test(ch);
      if (shift) {
        await page.keyboard.down("Shift");
        await sleep(between(30, 80));
      }
      await page.keyboard.press(ch, { delay: holdMs() });
      if (shift) {
        await sleep(between(20, 60));
        await page.keyboard.up("Shift");
      }
    } else {
      await page.keyboard.insertText(ch);
    }
  }
}

/**
 * Paste `text` into the focused element without touching the OS clipboard
 * (on attach_cdp that's the user's). The page sees real Ctrl+V key events and
 * a paste event carrying the text; if the page doesn't handle the paste
 * itself (rich editors do), the text goes in as one input event. A page can
 * still tell it apart from a real paste: the paste event has isTrusted
 * false, and the input event's inputType is "insertText", not
 * "insertFromPaste". `field` is the element being typed into; the event goes
 * to whatever has focus in its document.
 */
export async function pasteLikeAPerson(page: Page, field: Locator, text: string): Promise<void> {
  await page.keyboard.down("ControlOrMeta");
  await sleep(between(40, 110));
  await page.keyboard.down("v");
  const unhandled = await field.evaluate((el, t) => {
    const target = el.ownerDocument.activeElement ?? el;
    const data = new DataTransfer();
    data.setData("text/plain", t);
    return target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
  }, text);
  if (unhandled) await page.keyboard.insertText(text);
  await sleep(holdMs());
  await page.keyboard.up("v");
  await sleep(between(20, 70));
  await page.keyboard.up("ControlOrMeta");
}

/**
 * Press a key or combo ("Control+a") with the keys held a person's time: each
 * modifier goes down a moment before the next key, and they come up after it.
 */
export async function pressLikeAPerson(page: Page, key: string): Promise<void> {
  // "+" alone, or a trailing "+" as in "Control++", is the key itself.
  const parts = key.length > 1 ? key.split(/\+(?!$)/) : [key];
  const modifiers = parts.slice(0, -1);
  for (const m of modifiers) {
    await page.keyboard.down(m);
    await sleep(between(40, 110));
  }
  await page.keyboard.press(parts[parts.length - 1], { delay: holdMs() });
  for (const m of modifiers.reverse()) {
    await sleep(between(20, 70));
    await page.keyboard.up(m);
  }
}
