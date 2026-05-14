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
