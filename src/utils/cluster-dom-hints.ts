import type { Page } from "playwright";
import type { DiffCluster, ClusterAnnotation } from "./diff-clusters.js";

export interface AnnotateClustersOptions {
  /** Translate cluster coords (diff-image space) into page coords. */
  offsetX?: number;
  offsetY?: number;
  /** Max intersecting elements per cluster (default 10). */
  cap?: number;
  /**
   * Skip elements whose own area exceeds this multiple of the cluster area.
   * Filters out wrappers (body, section) that always intersect everything.
   * Default 2.
   */
  wrapperRatio?: number;
}

/**
 * For each cluster, return the elements stacked at its center
 * (`document.elementsFromPoint`) plus the elements whose bounding box
 * intersects the cluster bbox (filtered + ranked by impact). Both lists
 * are advisory — pixel diffs span multiple DOM nodes; trust the diff
 * preview as ground truth.
 *
 * Cluster coords are passed in diff-image space; `offsetX`/`offsetY`
 * translate to page space for `getBoundingClientRect` comparisons.
 */
export async function annotateClusters(
  page: Page,
  clusters: DiffCluster[],
  opts: AnnotateClustersOptions = {},
): Promise<ClusterAnnotation[]> {
  if (clusters.length === 0) return [];

  const offsetX = opts.offsetX ?? 0;
  const offsetY = opts.offsetY ?? 0;
  const cap = opts.cap ?? 10;
  const wrapperRatio = opts.wrapperRatio ?? 2;

  const pageBoxes = clusters.map((c) => ({
    x: c.x + offsetX,
    y: c.y + offsetY,
    width: c.width,
    height: c.height,
  }));

  return await page.evaluate(
    ({ boxes, cap, wrapperRatio }) => {
      function elemHint(el: Element) {
        const r = el.getBoundingClientRect();
        const cls =
          el instanceof HTMLElement || el instanceof SVGElement
            ? Array.from(el.classList)
            : [];
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: cls,
          bbox: {
            x: Math.round(r.left * 100) / 100,
            y: Math.round(r.top * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
          },
        };
      }

      const allElements = Array.from(document.body.getElementsByTagName("*"));

      return boxes.map((cb) => {
        const cx = cb.x + cb.width / 2;
        const cy = cb.y + cb.height / 2;

        let centerStack: ReturnType<typeof elemHint>[] = [];
        try {
          centerStack = document
            .elementsFromPoint(cx, cy)
            .slice(0, 5)
            .map(elemHint);
        } catch {
          // viewport-edge or off-screen clusters can throw — skip silently
        }

        const clusterArea = cb.width * cb.height;
        const candidates: Array<{
          el: Element;
          intersectionArea: number;
          intersectionRatio: number;
        }> = [];

        for (const el of allElements) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;

          const ix = Math.max(cb.x, r.left);
          const iy = Math.max(cb.y, r.top);
          const ix2 = Math.min(cb.x + cb.width, r.left + r.width);
          const iy2 = Math.min(cb.y + cb.height, r.top + r.height);
          if (ix2 <= ix || iy2 <= iy) continue;

          const intersectionArea = (ix2 - ix) * (iy2 - iy);
          if (intersectionArea < 1) continue;

          const elementArea = r.width * r.height;
          if (elementArea > wrapperRatio * clusterArea) continue;

          candidates.push({
            el,
            intersectionArea,
            intersectionRatio: intersectionArea / elementArea,
          });
        }

        candidates.sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        const intersecting = candidates
          .slice(0, cap)
          .map(({ el, intersectionArea, intersectionRatio }) => ({
            ...elemHint(el),
            intersectionArea: Math.round(intersectionArea),
            intersectionRatio: Math.round(intersectionRatio * 1000) / 1000,
          }));

        return { cluster: cb, centerStack, intersecting };
      });
    },
    { boxes: pageBoxes, cap, wrapperRatio },
  );
}
