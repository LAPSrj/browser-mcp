import type { Page, Locator, FrameLocator } from "playwright";

// Frame-pierce delimiter for cross-frame selectors. Whitespace-padded `>>>`
// chains `frameLocator()` calls; the final segment becomes a `locator()`
// inside the innermost frame. Playwright's own `>>` is intra-frame
// locator-chain and is NOT split here.
//
//   "#btn"                            → page.locator("#btn")
//   "iframe.outer >>> #btn"           → page.frameLocator("iframe.outer").locator("#btn")
//   "iframe.a >>> iframe.b >>> #btn"  → page.frameLocator("iframe.a").frameLocator("iframe.b").locator("#btn")
//
// Required whitespace-padding keeps `>>>` from colliding with CSS attribute
// values that might contain the literal sequence — none in valid CSS would
// be whitespace-padded that way, so the discrimination is safe in practice.
const FRAME_PIERCE = /\s+>>>\s+/;

export function hasFramePierce(selector: string): boolean {
  return FRAME_PIERCE.test(selector);
}

export function splitFramePierce(selector: string): string[] {
  return selector.split(FRAME_PIERCE);
}

/**
 * Resolve a selector to a Playwright Locator, transparently piercing
 * `>>>`-separated frames. Works for same-origin frames AND cross-origin
 * OOPIFs (Playwright handles the renderer-process boundary internally).
 */
export function resolveLocator(page: Page, selector: string): Locator {
  if (!hasFramePierce(selector)) {
    return page.locator(selector);
  }
  const parts = splitFramePierce(selector);
  if (parts.length < 2) {
    // Pathological: pierce token with empty inner / outer segment.
    return page.locator(selector);
  }
  let frame: FrameLocator = page.frameLocator(parts[0]);
  for (let i = 1; i < parts.length - 1; i++) {
    frame = frame.frameLocator(parts[i]);
  }
  return frame.locator(parts[parts.length - 1]);
}

// How long a click or hover keeps retrying while another element covers the
// target before giving up, instead of the full action timeout.
const COVERED_GIVE_UP_MS = 5000;

// Pages whose clicks and hovers move the mouse like a person (open_session
// human_mouse), and where each page's mouse was left.
const humanMousePages = new WeakSet<Page>();
const lastMouse = new WeakMap<Page, { x: number; y: number }>();

export function setHumanMouse(page: Page, on: boolean): void {
  if (on) humanMousePages.add(page);
  else humanMousePages.delete(page);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Move the mouse to (x, y) along a curve with uneven speed, one whole-pixel
 * mousemove every 8-16 ms, from where it was left. Playwright's own move
 * jumps straight to the element's center in one event.
 */
async function moveMouseLikeAPerson(page: Page, x: number, y: number): Promise<void> {
  const from = lastMouse.get(page) ?? {
    x: Math.max(0, Math.round(x + between(-300, 300))),
    y: Math.max(0, Math.round(y + between(-200, 200))),
  };
  const dx = x - from.x;
  const dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.min(30, Math.max(8, Math.round(dist / 25)));
  // Control point off to one side of the straight line, for a slight arc.
  const bend = between(0.1, 0.3) * dist * (Math.random() < 0.5 ? -1 : 1);
  const cx = from.x + dx / 2 - (dist ? (dy / dist) * bend : 0);
  const cy = from.y + dy / 2 + (dist ? (dx / dist) * bend : 0);
  await page.mouse.move(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    const t = s < 0.5 ? 2 * s * s : 1 - (-2 * s + 2) ** 2 / 2; // ease in and out
    const px = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * cx + t ** 2 * x;
    const py = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * cy + t ** 2 * y;
    await page.mouse.move(i === steps ? x : Math.round(px), i === steps ? y : Math.round(py));
    await sleep(between(8, 16));
  }
  lastMouse.set(page, { x, y });
}

/**
 * Click or hover the way a person would: Playwright's actionability checks
 * first (a trial run that doesn't act), then a curved mouse path to a random
 * whole-pixel point in the middle of the element (or `position` if given),
 * and a 50-150 ms press for each click.
 */
async function humanPointerAction(
  locator: Locator,
  kind: "click" | "hover",
  opts: { timeout?: number; force?: boolean } & Record<string, unknown>,
  timeout: number | undefined,
): Promise<void> {
  if (!opts.force) {
    if (kind === "click") await locator.click({ ...opts, timeout, trial: true });
    else await locator.hover({ ...opts, timeout, trial: true });
  }
  const box = await locator.boundingBox({ timeout });
  if (!box) throw new Error(`${kind}: the element has no box on the page (hidden or detached).`);
  const pos = opts.position as { x: number; y: number } | undefined;
  const x = Math.round(box.x + (pos ? pos.x : box.width * between(0.3, 0.7)));
  const y = Math.round(box.y + (pos ? pos.y : box.height * between(0.3, 0.7)));
  const page = locator.page();
  await moveMouseLikeAPerson(page, x, y);
  if (kind === "hover") return;
  const button = (opts.button as "left" | "right" | "middle" | undefined) ?? "left";
  const clickCount = (opts.clickCount as number | undefined) ?? 1;
  for (let i = 1; i <= clickCount; i++) {
    if (i > 1) await sleep(between(80, 140));
    await page.mouse.down({ button, clickCount: i });
    await sleep(between(50, 150));
    await page.mouse.up({ button, clickCount: i });
  }
}

/**
 * Click or hover `locator`, failing after COVERED_GIVE_UP_MS when another
 * element keeps intercepting pointer events. Playwright otherwise retries
 * for the whole timeout (30 s by default) although a full-screen overlay or
 * cookie banner rarely goes away on its own. A wait that fails for any other
 * reason (not visible yet, still animating) carries on with the rest of the
 * timeout. Playwright performs no click or hover before its actionability
 * checks pass, so the second attempt can't act twice.
 */
export async function pointerActionFailingFastWhenCovered(
  locator: Locator,
  kind: "click" | "hover",
  selector: string,
  opts: { timeout?: number; force?: boolean } & Record<string, unknown>,
): Promise<void> {
  const act = (timeout: number | undefined) =>
    humanMousePages.has(locator.page())
      ? humanPointerAction(locator, kind, opts, timeout)
      : kind === "click"
        ? locator.click({ ...opts, timeout })
        : locator.hover({ ...opts, timeout });

  if (opts.force || (opts.timeout !== undefined && opts.timeout <= COVERED_GIVE_UP_MS)) {
    await act(opts.timeout);
    return;
  }
  const start = Date.now();
  try {
    await act(COVERED_GIVE_UP_MS);
    return;
  } catch (error) {
    const e = error as Error;
    if (e.name !== "TimeoutError") throw e;
    const log = e.message.replace(/\x1b\[[0-9;]*m/g, "");
    const covers = [...log.matchAll(/- (.+?) intercepts pointer events/g)];
    if (covers.length > 0) {
      const cover = covers[covers.length - 1][1];
      throw new Error(
        `${kind} on ${selector} didn't happen: ${cover} covers it and intercepts pointer events ` +
          `(still covered after ${COVERED_GIVE_UP_MS / 1000} s). Close or wait out the covering element ` +
          `(e.g. wait_for_selector with state "hidden"), or run hit_test to see what is on top. ` +
          `force:true skips the check, but a real user couldn't ${kind} it.`,
      );
    }
  }
  // Without an explicit timeout the retry gets the context default, so a
  // slow element can take up to COVERED_GIVE_UP_MS longer than before.
  await act(opts.timeout !== undefined ? Math.max(1, opts.timeout - (Date.now() - start)) : undefined);
}
