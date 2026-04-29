import { PNG } from "pngjs";
import type { DiffCluster } from "./diff-clusters.js";

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShiftResult {
  /** Best translation in pixels (live → reference, integer). */
  delta: { x: number; y: number };
  /** SAD at (0,0) over RGB only. Lower is better. Normalised to 0..1 per pixel. */
  baselineScore: number;
  /** SAD at chosen delta. */
  alignedScore: number;
  /** baselineScore - alignedScore. Positive = improvement. */
  improvement: number;
  /** True when the chosen delta is on the search-window perimeter. */
  hitEdge: boolean;
  /** True when a competing minimum within 1.1× of best exists ≥ 4px away. */
  ambiguous: boolean;
  /** Search radius actually used (after any auto-grow). */
  searchRadius: number;
  /** Pixels considered (template area, after clipping). */
  templatePixels: number;
}

/**
 * Choose a search radius from cluster geometry inside the element's bbox.
 *
 * Idea: the misalignment magnitude can't exceed the cluster's own extent —
 * a 12px-tall red strip implies at most ~12px of vertical shift. We take
 * max(cluster.w, cluster.h) over clusters that overlap the element's bbox,
 * plus a small constant for anti-aliasing / sub-pixel jitter.
 *
 * Returns at least `floor` and at most `ceiling`. If no clusters overlap,
 * returns `floor` (still do a small refinement in case the bbox is just
 * slightly off).
 */
export function clusterShiftRadius(
  clusters: DiffCluster[],
  bbox: BBox,
  opts: { floor?: number; ceiling?: number; pad?: number } = {},
): number {
  const floor = opts.floor ?? 3;
  const ceiling = opts.ceiling ?? 60;
  const pad = opts.pad ?? 4;

  let maxDim = 0;
  for (const c of clusters) {
    const ix = Math.max(bbox.x, c.x);
    const iy = Math.max(bbox.y, c.y);
    const ix2 = Math.min(bbox.x + bbox.width, c.x + c.width);
    const iy2 = Math.min(bbox.y + bbox.height, c.y + c.height);
    if (ix2 <= ix || iy2 <= iy) continue;
    const dim = Math.max(c.width, c.height);
    if (dim > maxDim) maxDim = dim;
  }

  if (maxDim === 0) return floor;
  return Math.min(ceiling, Math.max(floor, maxDim + pad));
}

interface ClippedRegion {
  srcX: number;
  srcY: number;
  width: number;
  height: number;
}

/** Clip a target rect to image bounds; returns null if it has no area. */
function clipRect(img: PNG, x: number, y: number, w: number, h: number): ClippedRegion | null {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { srcX: x0, srcY: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Sum-of-absolute-differences across RGB (alpha skipped) between two regions
 * of the same `width × height`. Each region is referenced by an offset into
 * its parent PNG buffer. Returned value is total absolute delta — caller
 * normalises by area if needed.
 */
function sad(
  a: PNG,
  ax: number,
  ay: number,
  b: PNG,
  bx: number,
  by: number,
  width: number,
  height: number,
): number {
  let total = 0;
  const aw = a.width;
  const bw = b.width;
  const ad = a.data;
  const bd = b.data;
  for (let row = 0; row < height; row++) {
    let aOff = ((ay + row) * aw + ax) << 2;
    let bOff = ((by + row) * bw + bx) << 2;
    for (let col = 0; col < width; col++) {
      total += Math.abs(ad[aOff] - bd[bOff]);
      total += Math.abs(ad[aOff + 1] - bd[bOff + 1]);
      total += Math.abs(ad[aOff + 2] - bd[bOff + 2]);
      aOff += 4;
      bOff += 4;
    }
  }
  return total;
}

/**
 * Find the integer (dx, dy) that minimises SAD between a reference crop and
 * a live crop, both nominally at the same `bbox`. Searches dx, dy ∈
 * [-radius, +radius] and reports the best score, the score at (0, 0), and
 * disambiguation flags.
 *
 * The "template" is the live element's pixels at bbox; the "search image"
 * is the reference. We slide the live template over the reference. A match
 * at offset (dx, dy) means: the live element's content appears in the
 * reference at (bbox.x + dx, bbox.y + dy). Equivalently, applying
 * `transform: translate(dx, dy)` to the live element would (in image space)
 * shift it onto its reference position.
 */
export function findBestShift(
  refImg: PNG,
  liveImg: PNG,
  bbox: BBox,
  opts: { radius: number; ambiguousFactor?: number; ambiguousMinSeparation?: number } = { radius: 8 },
): ShiftResult {
  const { radius } = opts;
  const ambiguousFactor = opts.ambiguousFactor ?? 1.1;
  const ambiguousSep = opts.ambiguousMinSeparation ?? 4;

  // Template = live crop at bbox (no padding here — caller can pre-pad bbox).
  const tpl = clipRect(liveImg, bbox.x, bbox.y, bbox.width, bbox.height);
  if (!tpl) {
    return {
      delta: { x: 0, y: 0 },
      baselineScore: 0,
      alignedScore: 0,
      improvement: 0,
      hitEdge: false,
      ambiguous: false,
      searchRadius: radius,
      templatePixels: 0,
    };
  }

  let bestScore = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  let baselineScore = Infinity;
  let secondBestScore = Infinity;
  let secondBestDx = 0;
  let secondBestDy = 0;

  const norm = tpl.width * tpl.height * 3; // RGB channels per pixel
  if (norm === 0) {
    return {
      delta: { x: 0, y: 0 },
      baselineScore: 0,
      alignedScore: 0,
      improvement: 0,
      hitEdge: false,
      ambiguous: false,
      searchRadius: radius,
      templatePixels: 0,
    };
  }

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const refX = tpl.srcX + dx;
      const refY = tpl.srcY + dy;
      // Reference window must be fully inside the reference image. If it
      // isn't, skip — partial overlaps would bias the score by area.
      if (refX < 0 || refY < 0) continue;
      if (refX + tpl.width > refImg.width) continue;
      if (refY + tpl.height > refImg.height) continue;

      const score = sad(refImg, refX, refY, liveImg, tpl.srcX, tpl.srcY, tpl.width, tpl.height);
      if (dx === 0 && dy === 0) baselineScore = score;
      if (score < bestScore) {
        secondBestScore = bestScore;
        secondBestDx = bestDx;
        secondBestDy = bestDy;
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      } else if (
        score < secondBestScore &&
        (Math.abs(dx - bestDx) + Math.abs(dy - bestDy)) >= ambiguousSep
      ) {
        secondBestScore = score;
        secondBestDx = dx;
        secondBestDy = dy;
      }
    }
  }

  // If (0,0) was out of bounds (shouldn't happen for sensible bboxes) treat
  // it as the worst plausible score so improvement isn't a negative number.
  if (!Number.isFinite(baselineScore)) baselineScore = bestScore;

  const hitEdge =
    Math.abs(bestDx) === radius || Math.abs(bestDy) === radius;
  const ambiguous =
    Number.isFinite(secondBestScore) &&
    secondBestScore <= bestScore * ambiguousFactor &&
    (Math.abs(secondBestDx - bestDx) + Math.abs(secondBestDy - bestDy)) >= ambiguousSep;

  // Normalise to 0..1 per channel (SAD / pixels / channels / 255).
  const baseN = baselineScore / norm / 255;
  const alignedN = bestScore / norm / 255;

  return {
    delta: { x: bestDx, y: bestDy },
    baselineScore: baseN,
    alignedScore: alignedN,
    improvement: baseN - alignedN,
    hitEdge,
    ambiguous,
    searchRadius: radius,
    templatePixels: tpl.width * tpl.height,
  };
}

/**
 * Group elements with similar deltas. Two deltas are "similar" when their
 * Manhattan distance ≤ `tolerance`. Returns groups in input order; each
 * group's `delta` is the rounded mean of its members'. Used to detect rigid
 * shifts that should commit at a common ancestor.
 */
export interface ShiftGroup<T> {
  delta: { x: number; y: number };
  members: T[];
}

export function groupSimilarShifts<T>(
  items: Array<{ value: T; delta: { x: number; y: number } }>,
  tolerance = 2,
): ShiftGroup<T>[] {
  const groups: ShiftGroup<T>[] = [];
  for (const it of items) {
    let placed = false;
    for (const g of groups) {
      if (Math.abs(g.delta.x - it.delta.x) + Math.abs(g.delta.y - it.delta.y) <= tolerance) {
        g.members.push(it.value);
        // Running mean keeps groups stable as members accumulate.
        const n = g.members.length;
        g.delta = {
          x: Math.round(((n - 1) * g.delta.x + it.delta.x) / n),
          y: Math.round(((n - 1) * g.delta.y + it.delta.y) / n),
        };
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ delta: { ...it.delta }, members: [it.value] });
  }
  return groups;
}
