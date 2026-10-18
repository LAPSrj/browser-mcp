import type { Page, Frame, Locator, FrameLocator } from "playwright";
import { isHuman, pointerLikeAPerson } from "./human.js";

// Frame-pierce delimiter for cross-frame selectors. Whitespace-padded `>>>`
// chains `frameLocator()` calls; the final segment becomes a `locator()`
// inside the innermost frame. Playwright's own `>>` is intra-frame
// locator-chain and is NOT split here.
//
//   "#btn"                            → page.locator("#btn")
//   "iframe.outer >>> #btn"           → page.frameLocator("iframe.outer").locator("#btn")
//   "iframe.a >>> iframe.b >>> #btn"  → page.frameLocator("iframe.a").frameLocator("iframe.b").locator("#btn")
//   "frame-url=example.com/w >>> #btn" → (the one frame whose URL contains it).locator("#btn")
//
// `frame-url=` picks a frame by its URL instead of by its <iframe> element, so
// it reaches frames that CSS can't, such as one inside a closed shadow root
// (Cloudflare's Turnstile widget). It searches every frame on the page, at
// any depth.
//
// Required whitespace-padding keeps `>>>` from colliding with CSS attribute
// values that might contain the literal sequence — none in valid CSS would
// be whitespace-padded that way, so the discrimination is safe in practice.
const FRAME_PIERCE = /\s+>>>\s+/;
const FRAME_URL = /^frame-url=(["']?)(.+)\1$/;

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
  let scope: Page | Frame | FrameLocator = page;
  for (let i = 0; i < parts.length - 1; i++) {
    const byUrl = parts[i].match(FRAME_URL);
    scope = byUrl ? frameByUrl(page, byUrl[2]) : scope.frameLocator(parts[i]);
  }
  return scope.locator(parts[parts.length - 1]);
}

/** The one child frame whose URL contains `text`; throws when none or several do. */
export function frameByUrl(page: Page, text: string): Frame {
  const children = page.frames().filter((f) => f !== page.mainFrame());
  const hits = children.filter((f) => f.url().includes(text));
  if (hits.length === 1) return hits[0];
  const urls = children.map((f) => f.url()).join(", ") || "(none)";
  throw new Error(
    hits.length === 0
      ? `No iframe on the page has a URL containing "${text}". Iframe URLs: ${urls}`
      : `${hits.length} iframes have a URL containing "${text}", so frame-url= can't tell them apart. Iframe URLs: ${urls}`,
  );
}

// How long a click or hover keeps retrying while another element covers the
// target before giving up, instead of the full action timeout.
const COVERED_GIVE_UP_MS = 5000;

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
    isHuman(locator.page())
      ? pointerLikeAPerson(locator, kind, opts, timeout)
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
          `force:true skips the check, but a real user couldn't ${kind} it.` +
          (/<iframe\b/i.test(cover)
            ? " The cover is an iframe, so the control you want is probably inside it: list_interactive_elements " +
              "lists iframe contents with selectors that reach into the frame."
            : ""),
      );
    }
  }
  // Without an explicit timeout the retry gets the context default, so a
  // slow element can take up to COVERED_GIVE_UP_MS longer than before.
  await act(opts.timeout !== undefined ? Math.max(1, opts.timeout - (Date.now() - start)) : undefined);
}
