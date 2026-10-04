import type { Locator, Page } from "playwright";

export interface SettleResult {
  /** True when the element had no running finite animation before the timeout. */
  settled: boolean;
  waitedMs: number;
  /** Finite animations/transitions still running at the timeout. */
  pending: number;
}

/**
 * Get an element ready for a screenshot on pages that reveal content on
 * scroll (opacity 0 until an IntersectionObserver adds a class that starts a
 * transition). Playwright's element screenshot scrolls the element into view
 * and captures in the same moment, so those elements come out hidden or
 * half-faded.
 *
 *   1. Scroll the element into view. An element taller than the viewport is
 *      scrolled through top to bottom first, so observers fire for the parts
 *      Playwright would capture beyond the viewport.
 *   2. Wait two frames, so observer callbacks run and start their transitions.
 *   3. Wait until the element, its descendants and its ancestors have no
 *      running finite animation or transition (transition delays included).
 *      Infinite animations (spinners, marquees) are ignored.
 *
 * Scrolling uses behavior "instant", so a page's `scroll-behavior: smooth`
 * doesn't leave the scroll animating during the capture.
 *
 * Never throws for a page that doesn't settle: returns settled: false so the
 * caller can capture anyway and say so.
 */
export async function settleElementForCapture(
  locator: Locator,
  opts: { timeoutMs?: number } = {},
): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  await locator.scrollIntoViewIfNeeded({ timeout: 10000 });
  return locator.evaluate(async (el, timeout) => {
    const start = performance.now();
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const twoFrames = async () => { await frame(); await frame(); };

    const rect = el.getBoundingClientRect();
    if (rect.height > window.innerHeight) {
      const top = rect.top + window.scrollY;
      const bottom = top + rect.height;
      const step = Math.max(1, Math.floor(window.innerHeight * 0.8));
      for (let y = top; y < bottom; y += step) {
        window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
        await twoFrames();
      }
      el.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
    }
    await twoFrames();

    const running = (): number => {
      const animations = [...el.getAnimations({ subtree: true })];
      for (let p = el.parentElement; p; p = p.parentElement) animations.push(...p.getAnimations());
      return animations.filter((a) => {
        if (a.playState !== "running" && !a.pending) return false;
        const end = a.effect?.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      }).length;
    };

    let pending = running();
    while (pending > 0 && performance.now() - start < timeout) {
      await frame();
      pending = running();
    }
    // One more frame so the last transition's end state is painted.
    if (pending === 0) await frame();
    return { settled: pending === 0, waitedMs: Math.round(performance.now() - start), pending };
  }, timeoutMs);
}

/**
 * Get a whole page ready for a screenshot. With `scrollThrough` (full-page and
 * clipped captures, which show content below the viewport), scroll the
 * document from top to bottom with behavior "instant" so scroll-reveal
 * observers and lazy images fire everywhere, then go back to the starting
 * scroll position. Then wait until the document has no running finite
 * animation or transition and every rendered <img> has finished loading.
 *
 * Returns settled: false at the timeout instead of throwing.
 */
export async function settlePageForCapture(
  page: Page,
  opts: { scrollThrough: boolean; timeoutMs?: number },
): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return page.evaluate(async ({ scrollThrough, timeout }) => {
    const start = performance.now();
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const twoFrames = async () => { await frame(); await frame(); };
    const instant = "instant" as ScrollBehavior;

    if (scrollThrough) {
      const startX = window.scrollX;
      const startY = window.scrollY;
      const step = Math.max(1, Math.floor(window.innerHeight * 0.8));
      // scrollHeight is re-read each step: revealed or lazy content can grow the page.
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo({ top: y, behavior: instant });
        await twoFrames();
        if (performance.now() - start > timeout) break;
      }
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: instant });
      await twoFrames();
      window.scrollTo({ left: startX, top: startY, behavior: instant });
    }
    await twoFrames();

    const running = (): number => {
      const animations = document.getAnimations().filter((a) => {
        if (a.playState !== "running" && !a.pending) return false;
        const end = a.effect?.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      }).length;
      // An image with no layout box (inside a hidden menu, e.g. the WP admin
      // bar's avatar) isn't in the capture, and a lazy one never loads.
      const images = Array.from(document.images)
        .filter((img) => !img.complete && img.getClientRects().length > 0).length;
      return animations + images;
    };

    let pending = running();
    while (pending > 0 && performance.now() - start < timeout) {
      await frame();
      pending = running();
    }
    if (pending === 0) await frame();
    return { settled: pending === 0, waitedMs: Math.round(performance.now() - start), pending };
  }, { scrollThrough: opts.scrollThrough, timeout: timeoutMs });
}

export function formatSettleWarning(r: SettleResult, what = "The element"): string {
  return `${what} still had ${r.pending} animation(s) or image load(s) running after ${r.waitedMs} ms, so the capture may show it mid-animation.`;
}
