import fs from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { saveFile, generateFilename } from "../../../utils/file.js";
import { createPreviewBuffer } from "../../../utils/resize.js";
import { collectMaskRegions, applyMask, type IgnoreElement, type MaskRegion } from "../../../utils/mask.js";
import { findDiffClusters } from "../../../utils/diff-clusters.js";
import { clusterShiftRadius, findBestShift, groupSimilarShifts, type BBox } from "../../../utils/diff-shift.js";
import type { CompareMode } from "./visual-diff.js";

export interface AlignElementsParams extends BrowserStackTarget {
  url: string;
  referenceImage: string;
  scope?: string;
  selectors?: string[];
  refineRadius?: number;
  maxRadius?: number;
  uniformityTolerance?: number;
  minImprovement?: number;
  applyTransform?: boolean;
  topClusters?: number;
  browser?: string;
  viewport?: { width: number; height: number };
  actions?: AnyAction[];
  outputDir?: string;
  mode?: CompareMode;
  threshold?: number;
  waitForNetworkIdle?: boolean;
  useBrowserStack?: boolean;
  delay?: number;
  ignoreImages?: boolean;
  ignoreBackgrounds?: boolean;
  ignoreAllImages?: boolean;
  ignoreText?: boolean;
  ignoreElements?: IgnoreElement[];
  ignoreRegions?: Array<{ x: number; y: number; width: number; height: number; mode?: "invisible" | "position-only"; reason?: string }>;
  summaryOnly?: boolean;
  profile?: "walker";
}

const WALKER_PROFILE_ALIGN: Partial<AlignElementsParams> = {
  summaryOnly: true,
  topClusters: 5,
};

const DATA_ATTR = "data-align-id";

type AlignClassification =
  | "translation"          // clear, unique shift; transform applied
  | "rigid-with-parent"    // shift absorbed by an ancestor; per-element delta zeroed
  | "content-change"       // template found no improvement — pixels differ in kind, not position
  | "size-mismatch"        // template + ref crop differ in shape/extent — translate alone cannot fix
  | "ambiguous"            // multiple equally-good positions — likely repetitive UI
  | "no-clusters";         // no diff in this element's region — already aligned

interface NamedAncestor {
  tag: string;
  id: string | null;
  classes: string[];
}

interface PerElementResult {
  alignId: string;
  selector: string;
  tag: string;
  id: string | null;
  classes: string[];
  /** Nearest ancestor with an id or class. Set only when the element itself has neither. */
  nearestNamedAncestor?: NamedAncestor;
  bbox: BBox;
  delta: { x: number; y: number };
  predictedRadius: number;
  baselineDiff: number;     // 0..1 SAD-normalised
  alignedDiff: number;      // 0..1 SAD-normalised
  improvement: number;
  classification: AlignClassification;
  warnings: string[];
  parentCommittedAt?: string;
}

export async function alignElementsTool(rawParams: AlignElementsParams) {
  const params = rawParams.profile === "walker"
    ? { ...WALKER_PROFILE_ALIGN, ...rawParams }
    : rawParams;
  const {
    url,
    referenceImage,
    scope = "body",
    selectors,
    refineRadius = 3,
    maxRadius = 60,
    uniformityTolerance = 2,
    minImprovement = 0.005,
    applyTransform = true,
    topClusters = 12,
    browser = "chromium",
    actions = [],
    outputDir = ".browser",
    mode = "design",
    waitForNetworkIdle = true,
    useBrowserStack = false,
    delay = 0,
    ignoreImages,
    ignoreBackgrounds,
    ignoreAllImages,
    ignoreText,
    ignoreElements,
    ignoreRegions,
    summaryOnly = false,
  } = params;

  const threshold = params.threshold ?? (mode === "design" ? 0.3 : 0.1);

  const refBuffer = await fs.readFile(referenceImage);
  const refImg = PNG.sync.read(refBuffer);

  const viewport = params.viewport ?? { width: refImg.width, height: refImg.height };

  const session = await launchSession({
    browser: browser as BrowserName,
    viewport,
    useBrowserStack,
    ...pickBrowserStack(params),
  });

  try {
    await navigateTo(session.page, url, waitForNetworkIdle);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(session.page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    if (delay > 0) {
      await session.page.waitForTimeout(delay);
    }

    const initialBuffer = await session.page.screenshot({ type: "png" });
    const initialImg = PNG.sync.read(initialBuffer);

    if (initialImg.width !== refImg.width || initialImg.height !== refImg.height) {
      const content: Array<{ type: string; text: string }> = [];
      if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
      content.push({
        type: "text",
        text: [
          `Image dimensions don't match.`,
          `  Reference: ${refImg.width}x${refImg.height}`,
          `  Screenshot: ${initialImg.width}x${initialImg.height}`,
          `Adjust viewport to match the reference dimensions before aligning.`,
        ].join("\n"),
      });
      return { content, isError: true };
    }

    // Mask regions are applied to the SCORING images only — we don't want
    // ignored content to influence template-match scores. We do not touch
    // initialBuffer (used for the saved "before" file) or the live page.
    const liveForScore = PNG.sync.read(initialBuffer);
    const refForScore = PNG.sync.read(refBuffer);

    const maskRegions: MaskRegion[] = await collectMaskRegions(session.page, {
      ignoreImages,
      ignoreBackgrounds,
      ignoreAllImages,
      ignoreText,
      ignoreElements,
    });
    if (ignoreRegions?.length) {
      for (const r of ignoreRegions) {
        maskRegions.push({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          mode: r.mode ?? "invisible",
          reason: r.reason,
        });
      }
    }
    if (maskRegions.length > 0) {
      applyMask(liveForScore, maskRegions, 0, 0);
      applyMask(refForScore, maskRegions, 0, 0);
    }

    const baselineDiff = new PNG({ width: refImg.width, height: refImg.height });
    const baselineMismatched = pixelmatch(
      refForScore.data,
      liveForScore.data,
      baselineDiff.data,
      refImg.width,
      refImg.height,
      { threshold },
    );
    const totalPixels = refImg.width * refImg.height;
    const baselinePct = (baselineMismatched / totalPixels) * 100;
    const baselineClusters = findDiffClusters(baselineDiff, { topN: topClusters });

    // Resolve candidates. Two paths:
    //   - explicit selectors → tag each match with data-align-id
    //   - cluster-driven     → for each diff cluster, pick the smallest
    //                          well-fitting element inside `scope` and tag it
    const candidates = await resolveCandidates(session.page, {
      scope,
      selectors,
      clusters: baselineClusters,
      attr: DATA_ATTR,
    });

    if (candidates.length === 0) {
      const content: Array<{ type: string; text: string }> = [];
      if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
      content.push({
        type: "text",
        text: [
          `align_elements: no candidate elements found.`,
          `  Baseline diff: ${baselinePct.toFixed(2)}% (${baselineMismatched} of ${totalPixels} pixels)`,
          `  Clusters: ${baselineClusters.length}`,
          selectors
            ? `  Selectors yielded no matches in the live page.`
            : `  No diff cluster intersected a meaningful element inside scope=${scope}.`,
        ].join("\n"),
      });
      return { content };
    }

    // Per-element predict + refine. We do NOT trust bbox numerically —
    // bbox only seeds the search center. The chosen delta is grounded in
    // pixel SAD, so a wrong-by-a-few-px bbox still works as long as the
    // real shift fits in the search radius.
    const results: PerElementResult[] = [];
    for (const cand of candidates) {
      const bbox: BBox = cand.bbox;
      // Search radius: cluster-driven, but keep a sensible floor for
      // anti-aliasing and a ceiling so we don't grind on far-away elements.
      const predicted = clusterShiftRadius(baselineClusters, bbox, {
        floor: refineRadius,
        ceiling: maxRadius,
        pad: 4,
      });

      // Auto-grow once if the first pass hit the search edge.
      let shift = findBestShift(refForScore, liveForScore, bbox, { radius: predicted });
      if (shift.hitEdge && predicted < maxRadius) {
        const grown = Math.min(maxRadius, Math.max(predicted * 2, predicted + 8));
        shift = findBestShift(refForScore, liveForScore, bbox, { radius: grown });
      }

      const warnings: string[] = [];
      if (shift.hitEdge) warnings.push("hit-search-edge");
      if (shift.ambiguous) warnings.push("ambiguous-minimum");

      let classification: AlignClassification;
      if (shift.templatePixels === 0) {
        classification = "size-mismatch";
        warnings.push("zero-template-area");
      } else if (shift.baselineScore < 0.001) {
        classification = "no-clusters";
      } else if (shift.improvement < minImprovement) {
        // Element diffs but no translation reduces it → content change.
        classification = "content-change";
      } else if (shift.ambiguous) {
        classification = "ambiguous";
      } else {
        classification = "translation";
      }

      results.push({
        alignId: cand.alignId,
        selector: `[${DATA_ATTR}="${cand.alignId}"]`,
        tag: cand.tag,
        id: cand.id,
        classes: cand.classes,
        nearestNamedAncestor: cand.nearestNamedAncestor,
        bbox,
        delta: shift.delta,
        predictedRadius: shift.searchRadius,
        baselineDiff: shift.baselineScore,
        alignedDiff: shift.alignedScore,
        improvement: shift.improvement,
        classification,
        warnings,
      });
    }

    // Hierarchical commit: group elements with similar deltas, find a
    // common ancestor for each multi-member group, and rewrite the per-
    // element transforms so the parent absorbs the rigid shift.
    const translatable = results.filter((r) => r.classification === "translation");
    const groups = groupSimilarShifts(
      translatable.map((r) => ({ value: r, delta: r.delta })),
      uniformityTolerance,
    );

    const parentTransforms: Array<{ alignId: string; delta: { x: number; y: number } }> = [];
    let parentTagSeq = 0;
    for (const g of groups) {
      if (g.members.length < 2) continue;
      const ancestor = await findCommonAncestor(
        session.page,
        g.members.map((m) => m.alignId),
        scope,
        DATA_ATTR,
        `align-parent-${parentTagSeq++}`,
      );
      if (!ancestor) continue;
      const ancestorSelector = `[${DATA_ATTR}="${ancestor.alignId}"]`;
      parentTransforms.push({ alignId: ancestor.alignId, delta: g.delta });
      for (const m of g.members) {
        m.classification = "rigid-with-parent";
        m.parentCommittedAt = ancestorSelector;
        // Per-element delta stays for diagnostic clarity; the actual
        // transform is applied at the parent only.
      }
    }

    // Apply transforms.
    let alignedBuffer: Buffer | undefined;
    if (applyTransform) {
      const elementTransforms = results
        .filter((r) => r.classification === "translation" && (r.delta.x !== 0 || r.delta.y !== 0))
        .map((r) => ({ alignId: r.alignId, delta: r.delta }));

      if (elementTransforms.length > 0 || parentTransforms.length > 0) {
        await applyTransforms(session.page, [...parentTransforms, ...elementTransforms], DATA_ATTR);
        // Wait one frame so the rasteriser commits the transforms before
        // we re-screenshot.
        await session.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        alignedBuffer = await session.page.screenshot({ type: "png" });
      }
    }

    // Save artefacts.
    const beforePath = await saveFile(
      path.join(outputDir, generateFilename({ prefix: "align-before", browser, extension: "png" })),
      initialBuffer,
    );
    const baselineDiffPath = await saveFile(
      path.join(outputDir, generateFilename({ prefix: "align-diff-before", browser, extension: "png" })),
      PNG.sync.write(baselineDiff),
    );

    let afterPath: string | undefined;
    let alignedDiffPath: string | undefined;
    let alignedPct = baselinePct;
    if (alignedBuffer) {
      afterPath = await saveFile(
        path.join(outputDir, generateFilename({ prefix: "align-after", browser, extension: "png" })),
        alignedBuffer,
      );
      const alignedImg = PNG.sync.read(alignedBuffer);
      const alignedDiff = new PNG({ width: refImg.width, height: refImg.height });
      // Apply masks again to the post-transform live image so the final
      // diff is comparable to the baseline pre-transform diff.
      if (maskRegions.length > 0) {
        applyMask(alignedImg, maskRegions, 0, 0);
      }
      const alignedMismatched = pixelmatch(
        refForScore.data,
        alignedImg.data,
        alignedDiff.data,
        refImg.width,
        refImg.height,
        { threshold },
      );
      alignedPct = (alignedMismatched / totalPixels) * 100;
      alignedDiffPath = await saveFile(
        path.join(outputDir, generateFilename({ prefix: "align-diff-after", browser, extension: "png" })),
        PNG.sync.write(alignedDiff),
      );
    }

    // Strip the data-align-id attributes so the page is left clean.
    await stripAttribute(session.page, DATA_ATTR);

    // Format response.
    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });

    const summaryLines: string[] = [
      `align_elements result:`,
      `  Scope: ${scope}${selectors ? ` (explicit selectors: ${selectors.length})` : ""}`,
      `  Candidates: ${candidates.length}`,
      `  Baseline diff: ${baselinePct.toFixed(2)}%${alignedBuffer ? ` → Aligned diff: ${alignedPct.toFixed(2)}% (Δ ${(baselinePct - alignedPct).toFixed(2)}pp)` : ""}`,
      `  Translation: ${results.filter((r) => r.classification === "translation").length}`,
      `  Rigid-with-parent: ${results.filter((r) => r.classification === "rigid-with-parent").length}`,
      `  Content-change: ${results.filter((r) => r.classification === "content-change").length}`,
      `  Ambiguous: ${results.filter((r) => r.classification === "ambiguous").length}`,
      `  No-clusters: ${results.filter((r) => r.classification === "no-clusters").length}`,
    ];

    if (parentTransforms.length > 0) {
      summaryLines.push(`  Parent commits: ${parentTransforms.length}`);
    }

    summaryLines.push(`  Before: ${beforePath}`);
    summaryLines.push(`  Baseline diff: ${baselineDiffPath}`);
    if (afterPath) summaryLines.push(`  After: ${afterPath}`);
    if (alignedDiffPath) summaryLines.push(`  Aligned diff: ${alignedDiffPath}`);

    content.push({ type: "text", text: summaryLines.join("\n") });

    if (!summaryOnly) {
      // Per-element verbose block.
      const lines: string[] = [];
      lines.push("Per-element results:");
      for (const r of results) {
        const sel = elementSelectorLabel(r);
        const dxdy = `dx=${r.delta.x} dy=${r.delta.y}`;
        const scores = `base=${(r.baselineDiff * 100).toFixed(2)}% aligned=${(r.alignedDiff * 100).toFixed(2)}% Δ=${(r.improvement * 100).toFixed(2)}pp`;
        const w = r.warnings.length > 0 ? ` (${r.warnings.join(",")})` : "";
        const parent = r.parentCommittedAt ? ` ← committed at ${r.parentCommittedAt}` : "";
        lines.push(`  [${r.classification}] ${sel}: ${dxdy} | ${scores} | r=${r.predictedRadius}${w}${parent}`);
      }
      if (parentTransforms.length > 0) {
        lines.push(`Parent transforms applied:`);
        for (const p of parentTransforms) {
          lines.push(`  [${DATA_ATTR}="${p.alignId}"] translate(${p.delta.x}px, ${p.delta.y}px)`);
        }
      }
      content.push({ type: "text", text: lines.join("\n") });
    } else {
      // Compact: only surface meaningful per-element rows.
      const interesting = results.filter(
        (r) =>
          r.classification === "translation" ||
          r.classification === "ambiguous" ||
          (r.classification === "content-change" && r.baselineDiff > 0.02),
      );
      if (interesting.length > 0) {
        const lines = interesting.slice(0, 8).map((r) => {
          const sel = elementSelectorLabel(r);
          return `  [${r.classification}] ${sel}: dx=${r.delta.x} dy=${r.delta.y} Δ=${(r.improvement * 100).toFixed(2)}pp${r.warnings.length > 0 ? ` (${r.warnings.join(",")})` : ""}`;
        });
        content.push({ type: "text", text: ["Top per-element:", ...lines].join("\n") });
      }
    }

    return { content };
  } finally {
    await closeSession(session);
  }
}

interface CandidateRecord {
  alignId: string;
  bbox: BBox;
  tag: string;
  id: string | null;
  classes: string[];
  nearestNamedAncestor?: NamedAncestor;
}

interface ResolveOptions {
  scope: string;
  selectors?: string[];
  clusters: ReturnType<typeof findDiffClusters>;
  attr: string;
}

/**
 * Tag each candidate element with the data-align-id attribute and return
 * a flat list of records. Two paths:
 *   - explicit selectors: each match in the live page becomes a candidate
 *   - cluster-driven: per cluster, pick the smallest element inside scope
 *     whose bbox is at most 4× the cluster's area; ties broken by area
 */
async function resolveCandidates(
  page: Page,
  opts: ResolveOptions,
): Promise<CandidateRecord[]> {
  if (opts.selectors && opts.selectors.length > 0) {
    return await page.evaluate(
      (args: { sels: string[]; attr: string }) => {
        function classListOf(el: Element): string[] {
          return el instanceof HTMLElement || el instanceof SVGElement
            ? Array.from(el.classList)
            : [];
        }
        function nearestNamedAncestor(el: Element):
          | { tag: string; id: string | null; classes: string[] }
          | undefined {
          if (el.id || classListOf(el).length > 0) return undefined;
          let cur: Element | null = el.parentElement;
          while (cur) {
            const cls = classListOf(cur);
            if (cur.id || cls.length > 0) {
              return { tag: cur.tagName.toLowerCase(), id: cur.id || null, classes: cls };
            }
            cur = cur.parentElement;
          }
          return undefined;
        }

        const out: Array<{
          alignId: string;
          bbox: { x: number; y: number; width: number; height: number };
          tag: string;
          id: string | null;
          classes: string[];
          nearestNamedAncestor?: { tag: string; id: string | null; classes: string[] };
        }> = [];
        let seq = 0;
        for (const sel of args.sels) {
          let matches: Element[] = [];
          try {
            matches = Array.from(document.querySelectorAll(sel));
          } catch {
            continue;
          }
          for (const el of matches) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const alignId = `align-${seq++}`;
            (el as HTMLElement).setAttribute(args.attr, alignId);
            out.push({
              alignId,
              bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              classes: classListOf(el),
              nearestNamedAncestor: nearestNamedAncestor(el),
            });
          }
        }
        return out;
      },
      { sels: opts.selectors, attr: opts.attr },
    );
  }

  // Cluster-driven: pass cluster bboxes into the page; pick the smallest
  // element rooted inside `scope` whose bbox both intersects the cluster
  // and isn't a wrapper (area ≤ 4× cluster area).
  const clusterBoxes = opts.clusters.map((c) => ({
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
  }));
  if (clusterBoxes.length === 0) return [];

  return await page.evaluate(
    (args: { boxes: Array<{ x: number; y: number; width: number; height: number }>; scope: string; attr: string; wrapperRatio: number }) => {
      const root = document.querySelector(args.scope);
      if (!root) return [];

      function classListOf(el: Element): string[] {
        return el instanceof HTMLElement || el instanceof SVGElement
          ? Array.from(el.classList)
          : [];
      }
      function nearestNamedAncestor(el: Element):
        | { tag: string; id: string | null; classes: string[] }
        | undefined {
        if (el.id || classListOf(el).length > 0) return undefined;
        let cur: Element | null = el.parentElement;
        while (cur) {
          const cls = classListOf(cur);
          if (cur.id || cls.length > 0) {
            return { tag: cur.tagName.toLowerCase(), id: cur.id || null, classes: cls };
          }
          cur = cur.parentElement;
        }
        return undefined;
      }

      const all = Array.from(root.querySelectorAll<HTMLElement | SVGElement>("*"));
      const taken = new Set<Element>();
      const out: Array<{
        alignId: string;
        bbox: { x: number; y: number; width: number; height: number };
        tag: string;
        id: string | null;
        classes: string[];
        nearestNamedAncestor?: { tag: string; id: string | null; classes: string[] };
      }> = [];
      let seq = 0;

      for (const cb of args.boxes) {
        const clusterArea = cb.width * cb.height;
        const cap = clusterArea * args.wrapperRatio;
        let best: Element | null = null;
        let bestArea = Infinity;

        for (const el of all) {
          if (taken.has(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const area = r.width * r.height;
          if (area > cap) continue;

          const ix = Math.max(cb.x, r.left);
          const iy = Math.max(cb.y, r.top);
          const ix2 = Math.min(cb.x + cb.width, r.left + r.width);
          const iy2 = Math.min(cb.y + cb.height, r.top + r.height);
          if (ix2 <= ix || iy2 <= iy) continue;

          const intersection = (ix2 - ix) * (iy2 - iy);
          if (intersection < clusterArea * 0.2) continue;

          if (area < bestArea) {
            best = el;
            bestArea = area;
          }
        }

        if (!best) continue;
        taken.add(best);
        const r = best.getBoundingClientRect();
        const alignId = `align-${seq++}`;
        (best as HTMLElement).setAttribute(args.attr, alignId);
        out.push({
          alignId,
          bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
          tag: best.tagName.toLowerCase(),
          id: best.id || null,
          classes: classListOf(best),
          nearestNamedAncestor: nearestNamedAncestor(best),
        });
      }

      return out;
    },
    { boxes: clusterBoxes, scope: opts.scope, attr: opts.attr, wrapperRatio: 4 },
  );
}

/**
 * Find the lowest common ancestor of N tagged elements, tag it, and return
 * its alignId + bbox. The ancestor must be inside `scope`. Returns null if
 * the LCA escapes scope or doesn't exist.
 */
async function findCommonAncestor(
  page: Page,
  alignIds: string[],
  scope: string,
  attr: string,
  newAlignId: string,
): Promise<{ alignId: string } | null> {
  return await page.evaluate(
    (args: { ids: string[]; scope: string; attr: string; newId: string }) => {
      const root = document.querySelector(args.scope);
      if (!root) return null;

      const els = args.ids.map((id) => document.querySelector(`[${args.attr}="${id}"]`));
      if (els.some((e) => !e)) return null;
      if (els.length < 2) return null;

      function ancestors(el: Element): Element[] {
        const chain: Element[] = [];
        let cur: Element | null = el;
        while (cur) {
          chain.push(cur);
          cur = cur.parentElement;
        }
        return chain;
      }

      const chains = els.map((e) => ancestors(e!));
      const first = chains[0];
      let lca: Element | null = null;
      for (const node of first) {
        if (chains.every((c) => c.includes(node))) {
          lca = node;
          break;
        }
      }
      if (!lca) return null;
      if (!root.contains(lca) && lca !== root) return null;
      // Don't commit at the document root — it would also pull elements
      // outside our candidate set.
      if (lca === document.documentElement || lca === document.body) return null;

      (lca as HTMLElement).setAttribute(args.attr, args.newId);
      return { alignId: args.newId };
    },
    { ids: alignIds, scope, attr, newId: newAlignId },
  );
}

async function applyTransforms(
  page: Page,
  transforms: Array<{ alignId: string; delta: { x: number; y: number } }>,
  attr: string,
): Promise<void> {
  await page.evaluate(
    (args: { transforms: Array<{ alignId: string; delta: { x: number; y: number } }>; attr: string }) => {
      for (const t of args.transforms) {
        const el = document.querySelector(`[${args.attr}="${t.alignId}"]`);
        if (!el) continue;
        const styled = el as HTMLElement | SVGElement;
        // Compose with any existing inline transform so we don't blow away
        // page-author transforms (rare but possible). We append our shift.
        const prior = styled.style.transform || "";
        styled.style.transform = `${prior} translate(${t.delta.x}px, ${t.delta.y}px)`.trim();
      }
    },
    { transforms, attr },
  );
}

async function stripAttribute(page: Page, attr: string): Promise<void> {
  await page.evaluate((a: string) => {
    document.querySelectorAll(`[${a}]`).forEach((el) => el.removeAttribute(a));
  }, attr);
}

function elementSelectorLabel(r: PerElementResult): string {
  const self = formatNamed({ tag: r.tag, id: r.id, classes: r.classes });
  // Bare tag (no id, no classes) is unhelpful — disambiguate with the
  // nearest named ancestor when available, mirroring the convention in
  // diff-clusters.formatElementSelector.
  if (!r.id && r.classes.length === 0 && r.nearestNamedAncestor) {
    return `${formatNamed(r.nearestNamedAncestor)} > ${r.tag}`;
  }
  return self || r.alignId;
}

function formatNamed(n: { tag: string; id: string | null; classes: string[] }): string {
  const idPart = n.id ? `#${n.id}` : "";
  const classPart = n.classes.length > 0 ? "." + n.classes.slice(0, 2).join(".") : "";
  return `${n.tag}${idPart}${classPart}`;
}
