import { PNG } from "pngjs";

export interface DiffCluster {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

export interface ElementHint {
  tag: string;
  id: string | null;
  classes: string[];
  bbox: { x: number; y: number; width: number; height: number };
  /** Present in `intersecting` lists; absent in `centerStack`. */
  intersectionArea?: number;
  /** intersectionArea / elementArea, in [0, 1]. */
  intersectionRatio?: number;
}

export interface ClusterAnnotation {
  /** Cluster bbox in page coords (post-offset). */
  cluster: { x: number; y: number; width: number; height: number };
  /** elementsFromPoint at cluster center, top 5 stacked. */
  centerStack: ElementHint[];
  /** Elements whose bbox intersects the cluster, filtered + ranked by intersectionRatio. */
  intersecting: ElementHint[];
}

/**
 * Identify contiguous diff regions in a pixelmatch diff image.
 *
 * pixelmatch writes mismatched pixels as red (R=255, G=0, B=0, A=255).
 * We flood-fill 4-connected runs of mismatched pixels using an iterative
 * scan-line algorithm, then return the top-N by pixel count with bbox.
 *
 * Two mismatched pixels are considered in the same cluster when they are
 * within `gap` pixels of each other in any direction (Manhattan). A small
 * gap (default 4) bridges anti-aliasing noise around a single visual delta.
 */
export function findDiffClusters(
  diff: PNG,
  opts: { topN?: number; minPixels?: number; gap?: number } = {},
): DiffCluster[] {
  const topN = opts.topN ?? 5;
  const minPixels = opts.minPixels ?? 20;
  const gap = opts.gap ?? 4;

  const { width, height, data } = diff;
  const isDiff = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const off = i << 2;
    // pixelmatch marks diffs red (255, 0, 0) with opaque alpha, while
    // unchanged pixels are anti-aliased greyscale or transparent. Any
    // strong red channel above 200 with low green/blue counts as diff.
    if (data[off] > 200 && data[off + 1] < 80 && data[off + 2] < 80) {
      isDiff[i] = 1;
    }
  }

  const visited = new Uint8Array(width * height);
  const clusters: DiffCluster[] = [];

  // For each seed pixel, BFS outward with a Chebyshev-distance <= gap
  // neighborhood. Because gap is small (default 4), the per-pixel cost is
  // bounded and the algorithm stays linear in image area.
  const queue: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!isDiff[idx] || visited[idx]) continue;

      queue.length = 0;
      queue.push(idx);
      visited[idx] = 1;

      let minX = x, maxX = x, minY = y, maxY = y, count = 0;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        const cy = (cur / width) | 0;
        const cx = cur - cy * width;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const yStart = Math.max(0, cy - gap);
        const yEnd = Math.min(height - 1, cy + gap);
        const xStart = Math.max(0, cx - gap);
        const xEnd = Math.min(width - 1, cx + gap);
        for (let ny = yStart; ny <= yEnd; ny++) {
          for (let nx = xStart; nx <= xEnd; nx++) {
            const nidx = ny * width + nx;
            if (!visited[nidx] && isDiff[nidx]) {
              visited[nidx] = 1;
              queue.push(nidx);
            }
          }
        }
      }

      if (count >= minPixels) {
        clusters.push({
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
          pixels: count,
        });
      }
    }
  }

  clusters.sort((a, b) => b.pixels - a.pixels);
  return clusters.slice(0, topN);
}

export function formatClusters(
  clusters: DiffCluster[],
  offsetX = 0,
  offsetY = 0,
  annotations?: ClusterAnnotation[],
): string[] {
  if (clusters.length === 0) return [];
  const lines = [`  Top ${clusters.length} diff cluster${clusters.length === 1 ? "" : "s"}:`];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    lines.push(
      `    [${i + 1}] ${c.pixels}px at x=${c.x + offsetX} y=${c.y + offsetY} w=${c.width} h=${c.height}`,
    );
    const ann = annotations?.[i];
    if (ann && ann.intersecting.length > 0) {
      const top = ann.intersecting.slice(0, 4);
      lines.push(
        `        intersecting (${ann.intersecting.length} total, top ${top.length}):`,
      );
      for (const h of top) {
        lines.push(`          ${formatElementSelector(h)}`);
      }
    }
  }
  return lines;
}

function formatElementSelector(h: ElementHint): string {
  const id = h.id ? `#${h.id}` : "";
  const cls = h.classes.length > 0 ? "." + h.classes.slice(0, 3).join(".") : "";
  return `${h.tag}${id}${cls}`;
}
