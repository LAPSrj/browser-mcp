import type { Page, Frame, Locator, ElementHandle } from "playwright";
import { resolveLocator, hasFramePierce } from "./locator.js";

// Helpers that let tools see and reach content inside iframes: a selector
// prefix for any frame, the frame's position on the page, and a fallback that
// finds a plain selector inside an iframe when it matches nothing on the page
// itself.

/** Child frames of the page at any depth, in document order. */
export function childFrames(page: Page): Frame[] {
  return page.frames().filter((f) => f !== page.mainFrame() && !f.isDetached());
}

/**
 * Selector prefix that reaches `frame`, without the trailing ` >>> `, e.g.
 * `iframe#chat` or `iframe[title="Widget"] >>> iframe[name="inner"]`.
 * Each level uses the first unique CSS for its <iframe> (id, name, title,
 * src), then `frame-url=` (which also reaches frames CSS can't, such as one
 * in a closed shadow root), then the iframe's position among its siblings.
 */
export async function framePath(frame: Frame): Promise<string> {
  const page = frame.page();
  const segments: string[] = [];
  let f: Frame = frame;
  while (f.parentFrame()) {
    const parent = f.parentFrame()!;
    const el = await f.frameElement().catch(() => null);
    const css = el ? await uniqueIframeCss(el, parent) : null;
    if (css) {
      segments.unshift(css);
      f = parent;
      continue;
    }
    const byUrl = uniqueUrlKey(page, f);
    if (byUrl) {
      // frame-url= searches the whole page, so the path starts here.
      segments.unshift(`frame-url=${byUrl}`);
      break;
    }
    const nth = el ? await nthIframe(el, parent) : null;
    segments.unshift(nth ?? "iframe");
    f = parent;
  }
  return segments.join(" >>> ");
}

async function uniqueIframeCss(el: ElementHandle, parent: Frame): Promise<string | null> {
  const candidates = await el.evaluate((node) => {
    const e = node as Element;
    const tag = e.tagName.toLowerCase();
    const out: string[] = [];
    if (e.id) out.push(`${tag}#${CSS.escape(e.id)}`);
    for (const attr of ["name", "title"]) {
      const v = e.getAttribute(attr);
      if (v) out.push(`${tag}[${attr}=${JSON.stringify(v)}]`);
    }
    const src = e.getAttribute("src");
    if (src && !src.startsWith("about:") && !src.startsWith("javascript:")) {
      try {
        const u = new URL(src, location.href);
        out.push(`${tag}[src*=${JSON.stringify(u.host + u.pathname)}]`);
      } catch { /* unparseable src */ }
      out.push(`${tag}[src=${JSON.stringify(src)}]`);
    }
    return out;
  }).catch(() => [] as string[]);
  for (const css of candidates) {
    const loc = parent.locator(css);
    if ((await loc.count().catch(() => 0)) !== 1) continue;
    if (await loc.evaluate((n, target) => n === target, el).catch(() => false)) return css;
  }
  return null;
}

function uniqueUrlKey(page: Page, frame: Frame): string | null {
  const url = frame.url();
  if (!url || url.startsWith("about:")) return null;
  const others = childFrames(page).filter((f) => f !== frame).map((f) => f.url());
  const keys: string[] = [];
  try {
    const u = new URL(url);
    keys.push(u.host + u.pathname);
  } catch { /* not a URL */ }
  keys.push(url);
  return keys.find((k) => !others.some((o) => o.includes(k))) ?? null;
}

async function nthIframe(el: ElementHandle, parent: Frame): Promise<string | null> {
  const all = await parent.locator("iframe").elementHandles().catch(() => []);
  for (let i = 0; i < all.length; i++) {
    if (await all[i].evaluate((n, target) => n === target, el).catch(() => false)) {
      return `iframe >> nth=${i}`;
    }
  }
  return null;
}

/**
 * Where the frame's content starts on the page (main-frame viewport px) and
 * how large its box is, or null when the frame isn't laid out (hidden,
 * detached, zero size).
 */
export async function frameContentBox(
  frame: Frame,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const el = await frame.frameElement().catch(() => null);
  if (!el) return null;
  const box = await el.boundingBox().catch(() => null);
  if (!box || box.width === 0 || box.height === 0) return null;
  const inset = await el.evaluate((node) => {
    const e = node as Element;
    const cs = getComputedStyle(e);
    return { x: e.clientLeft + parseFloat(cs.paddingLeft), y: e.clientTop + parseFloat(cs.paddingTop) };
  }).catch(() => ({ x: 0, y: 0 }));
  return { x: box.x + inset.x, y: box.y + inset.y, width: box.width, height: box.height };
}

export interface Located {
  locator: Locator;
  /** The selector actually used: the caller's, or a frame-prefixed one. */
  selector: string;
}

/**
 * Resolve `selector`, falling back to the iframes when a plain selector
 * matches nothing on the page itself. Exactly one matching frame → its
 * locator; several → an error listing the frame-prefixed selectors; none →
 * the page locator, so the caller's usual wait and error apply.
 */
export async function locate(page: Page, selector: string): Promise<Located> {
  const own = resolveLocator(page, selector);
  if (hasFramePierce(selector)) return { locator: own, selector };
  // An invalid selector counts as a match, so the action reports its own error.
  if ((await own.count().catch(() => 1)) > 0) return { locator: own, selector };
  const hits: Frame[] = [];
  for (const f of childFrames(page)) {
    if ((await f.locator(selector).count().catch(() => 0)) > 0) hits.push(f);
  }
  if (hits.length === 0) return { locator: own, selector };
  const paths = await Promise.all(hits.map(async (f) => `${await framePath(f)} >>> ${selector}`));
  if (hits.length > 1) {
    throw new Error(
      `${selector} matches nothing on the page itself but matches inside ${hits.length} iframes. ` +
        `Use one of: ${paths.map((p) => `\`${p}\``).join(", ")}`,
    );
  }
  return { locator: hits[0].locator(selector), selector: paths[0] };
}

/**
 * Like locate(), but keeps looking until something matches, on the page or
 * in an iframe, or `timeout` ms pass. For waits on content that loads late.
 */
export async function locateWhenPresent(page: Page, selector: string, timeout: number): Promise<Located> {
  if (hasFramePierce(selector)) return { locator: resolveLocator(page, selector), selector };
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = await locate(page, selector);
    if (found.selector !== selector || (await found.locator.count().catch(() => 1)) > 0) return found;
    if (Date.now() >= deadline) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** " (found inside an iframe as `X`)" when locate() used a frame prefix. */
export function frameNote(asked: string, used: string): string {
  return asked === used ? "" : ` (found inside an iframe as \`${used}\`; use that selector next time)`;
}
