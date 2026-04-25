import fs from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { saveFile, generateFilename } from "../../../utils/file.js";
import { createPreviewBuffer } from "../../../utils/resize.js";
import { collectMaskRegions, applyMask, computeMaskCoverage, type IgnoreElement, type MaskRegion } from "../../../utils/mask.js";
import { findDiffClusters, formatClusters } from "../../../utils/diff-clusters.js";
import { annotateClusters } from "../../../utils/cluster-dom-hints.js";
import type { CompareMode } from "./visual-diff.js";

export interface CompareElementParams {
  url: string;
  referenceImage: string;
  selector: string;
  padding?: number;
  browser?: string;
  viewport?: { width: number; height: number };
  actions?: AnyAction[];
  outputDir?: string;
  mode?: CompareMode;
  boundsHandling?: "strict" | "intersect";
  threshold?: number;
  maxDiffPercent?: number;
  waitForNetworkIdle?: boolean;
  useBrowserStack?: boolean;
  delay?: number;
  ignoreImages?: boolean;
  ignoreBackgrounds?: boolean;
  ignoreAllImages?: boolean;
  ignoreText?: boolean;
  ignoreElements?: IgnoreElement[];
  ignoreRegions?: Array<{ x: number; y: number; width: number; height: number; mode?: "invisible" | "position-only"; reason?: string }>;
  alignTo?: "top" | "center";
  alignOn?: {
    referenceRect: { x: number; y: number; width: number; height: number };
    frontendSelector: string;
    mode?: "top-left" | "center";
  };
}

const ALIGN_WARNING_THRESHOLD = 100;
const ERROR_HINTS = [
  "Next steps if this is blocking:",
  `  - retry with boundsHandling: "intersect" to compare the overlapping region only`,
  `  - fall back to visual_diff({ imageA, imageB, crop: true }) on separately-captured images`,
  `  - use alignTo: "top"|"center" (or alignOn) to shift the reference crop to match the live element`,
];

function cropPng(src: PNG, x: number, y: number, w: number, h: number): PNG {
  const dst = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcY = y + row;
    if (srcY < 0) continue;
    if (srcY >= src.height) break;
    const srcX = Math.max(0, x);
    const dstXOffset = srcX - x;
    if (dstXOffset >= w) continue;
    const copyWidth = Math.min(w - dstXOffset, src.width - srcX);
    if (copyWidth <= 0) continue;
    const srcOff = (srcY * src.width + srcX) << 2;
    const dstOff = (row * w + dstXOffset) << 2;
    src.data.copy(dst.data, dstOff, srcOff, srcOff + (copyWidth << 2));
  }
  return dst;
}

export async function compareElementTool(params: CompareElementParams) {
  const {
    url,
    referenceImage,
    selector,
    padding = 50,
    browser = "chromium",
    actions = [],
    outputDir = ".browser",
    mode = "precise",
    boundsHandling = "strict",
    maxDiffPercent = 5,
    waitForNetworkIdle = true,
    useBrowserStack = false,
    delay = 0,
    ignoreImages,
    ignoreBackgrounds,
    ignoreAllImages,
    ignoreText,
    ignoreElements,
    ignoreRegions,
    alignTo,
    alignOn,
  } = params;

  const threshold = params.threshold ?? (mode === "design" ? 0.3 : 0.1);

  const refBuffer = await fs.readFile(referenceImage);
  const refImg = PNG.sync.read(refBuffer);

  const viewport = params.viewport ?? { width: refImg.width, height: refImg.height };

  const session = await launchSession({
    browser: browser as BrowserName,
    viewport,
    useBrowserStack,
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

    const element = session.page.locator(selector);
    await element.waitFor({ state: "visible", timeout: 10000 });
    const box = await element.boundingBox();

    if (!box) {
      const content: Array<{ type: string; text: string }> = [];
      if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
      content.push({ type: "text", text: `Could not get bounding box for selector: ${selector}` });
      return { content, isError: true };
    }

    let cropX = Math.max(0, Math.floor(box.x - padding));
    let cropY = Math.max(0, Math.floor(box.y - padding));
    let cropRight = Math.min(viewport.width, Math.ceil(box.x + box.width + padding));
    let cropBottom = Math.min(viewport.height, Math.ceil(box.y + box.height + padding));

    // Guard degenerate geometry BEFORE any Buffer math — a negative
    // width/height silently propagates as a uint32 underflow into pngjs.
    if (cropRight <= cropX || cropBottom <= cropY) {
      const content: Array<{ type: string; text: string }> = [];
      if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
      content.push({
        type: "text",
        text: [
          `Element crop region has zero or negative area — the element is likely off-screen.`,
          `  Element box: x=${Math.floor(box.x)} y=${Math.floor(box.y)} w=${Math.ceil(box.width)} h=${Math.ceil(box.height)}`,
          `  Viewport: ${viewport.width}x${viewport.height}`,
          `  Crop (clamped to viewport): x=${cropX} y=${cropY} right=${cropRight} bottom=${cropBottom}`,
          `The element may extend past the visible viewport (common on multi-block test pages).`,
          `Next steps: add a scroll_to action before the compare, or raise viewport.height to include the element.`,
        ].join("\n"),
      });
      return { content, isError: true };
    }

    let deltaX = 0;
    let deltaY = 0;
    let alignInfo: string | undefined;
    if (alignTo && alignOn) {
      const content: Array<{ type: string; text: string }> = [];
      if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
      content.push({
        type: "text",
        text: `alignTo and alignOn are mutually exclusive. Pick one: alignTo for top/center shortcut against the element bbox, alignOn for a named anchor pair.`,
      });
      return { content, isError: true };
    }
    if (alignTo) {
      // Element-relative alignment: shift reference so element bbox
      // matches at top-left (alignTo:"top") or center (alignTo:"center").
      // Assumes reference frame origin is also at (0,0) at the element.
      if (alignTo === "center") {
        deltaX = (box.x + box.width / 2) - (refImg.width / 2);
        deltaY = (box.y + box.height / 2) - (refImg.height / 2);
      } else {
        deltaX = box.x;
        deltaY = box.y;
      }
      alignInfo = [
        `alignTo: "${alignTo}" — reference shifted to match element ${alignTo === "center" ? "center" : "origin"}.`,
        `  element bbox: x=${Math.floor(box.x)} y=${Math.floor(box.y)} w=${Math.ceil(box.width)} h=${Math.ceil(box.height)}`,
        `  reference size: ${refImg.width}x${refImg.height}`,
        `  delta: x=${Math.round(deltaX)} y=${Math.round(deltaY)}`,
      ].join("\n");
    } else if (alignOn) {
      const anchorBox = await session.page.locator(alignOn.frontendSelector).boundingBox();
      if (!anchorBox) {
        const content: Array<{ type: string; text: string }> = [];
        if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
        content.push({
          type: "text",
          text: `alignOn.frontendSelector "${alignOn.frontendSelector}" produced no bounding box — element missing or not visible.`,
        });
        return { content, isError: true };
      }
      const ref = alignOn.referenceRect;
      if (alignOn.mode === "center") {
        deltaX = (anchorBox.x + anchorBox.width / 2) - (ref.x + ref.width / 2);
        deltaY = (anchorBox.y + anchorBox.height / 2) - (ref.y + ref.height / 2);
      } else {
        deltaX = anchorBox.x - ref.x;
        deltaY = anchorBox.y - ref.y;
      }
      const overThreshold = Math.abs(deltaX) > ALIGN_WARNING_THRESHOLD || Math.abs(deltaY) > ALIGN_WARNING_THRESHOLD;
      const pre = overThreshold
        ? `⚠ alignOn delta exceeds ${ALIGN_WARNING_THRESHOLD}px — anchors may be misidentified, or offset isn't purely structural. Verify before trusting the aligned diff.`
        : `alignOn delta below ${ALIGN_WARNING_THRESHOLD}px warning threshold.`;
      alignInfo = [
        pre,
        `  mode: ${alignOn.mode ?? "top-left"}`,
        `  frontend anchor (${alignOn.frontendSelector}): x=${Math.floor(anchorBox.x)} y=${Math.floor(anchorBox.y)} w=${Math.ceil(anchorBox.width)} h=${Math.ceil(anchorBox.height)}`,
        `  reference rect: x=${ref.x} y=${ref.y} w=${ref.width} h=${ref.height}`,
        `  delta: x=${Math.round(deltaX)} y=${Math.round(deltaY)}`,
      ].join("\n");
    }

    const aligned = alignTo || alignOn;
    let intersectApplied: string | undefined;

    if (!aligned) {
      if (cropRight > refImg.width || cropBottom > refImg.height) {
        if (boundsHandling === "intersect") {
          const prev = { right: cropRight, bottom: cropBottom };
          cropRight = Math.min(cropRight, refImg.width);
          cropBottom = Math.min(cropBottom, refImg.height);
          intersectApplied = `boundsHandling: "intersect" — clamped crop (was right=${prev.right} bottom=${prev.bottom}) to reference bounds (${refImg.width}x${refImg.height}).`;
        } else {
          const pageImg = PNG.sync.read(await session.page.screenshot({ type: "png" }));
          const cropW = cropRight - cropX;
          const cropH = cropBottom - cropY;
          const pageCrop = cropPng(pageImg, cropX, cropY, cropW, cropH);
          const pageCropBuffer = PNG.sync.write(pageCrop);
          const cropFilename = generateFilename({ prefix: "compare-element-actual", browser, extension: "png" });
          const cropPath = await saveFile(path.join(outputDir, cropFilename), pageCropBuffer);

          const content: Array<{ type: string; text: string }> = [];
          if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
          content.push({
            type: "text",
            text: [
              `Element crop region exceeds reference image bounds.`,
              `  Element region: x=${cropX} y=${cropY} w=${cropW} h=${cropH}`,
              `  Reference size: ${refImg.width}x${refImg.height}`,
              `  Screenshot size: ${pageImg.width}x${pageImg.height}`,
              `  Cropped screenshot saved: ${cropPath}`,
              ``,
              ...ERROR_HINTS,
            ].join("\n"),
          });
          return { content };
        }
      }
    }

    const cropW = cropRight - cropX;
    const cropH = cropBottom - cropY;
    const refCropX = Math.floor(cropX - deltaX);
    const refCropY = Math.floor(cropY - deltaY);

    const screenshotBuffer = await session.page.screenshot({ type: "png" });
    const pageImg = PNG.sync.read(screenshotBuffer);

    const pageCrop = cropPng(pageImg, cropX, cropY, cropW, cropH);

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

    const refCrop = cropPng(refImg, refCropX, refCropY, cropW, cropH);

    const maskCoverage = maskRegions.length > 0
      ? computeMaskCoverage(maskRegions, { x: cropX, y: cropY, width: cropW, height: cropH })
      : 0;

    if (maskRegions.length > 0) {
      applyMask(pageCrop, maskRegions, refCropX, refCropY);
      applyMask(refCrop, maskRegions, refCropX, refCropY);
    }

    const diff = new PNG({ width: cropW, height: cropH });
    const mismatchedPixels = pixelmatch(
      refCrop.data,
      pageCrop.data,
      diff.data,
      cropW,
      cropH,
      { threshold },
    );

    const totalPixels = cropW * cropH;
    const diffPercentage = (mismatchedPixels / totalPixels) * 100;
    const isMatch = diffPercentage <= maxDiffPercent;

    const clusters = findDiffClusters(diff, { topN: 5 });
    const clusterAnnotations = await annotateClusters(session.page, clusters, {
      offsetX: cropX,
      offsetY: cropY,
    });

    const pageCropBuffer = PNG.sync.write(pageCrop);
    const refCropBuffer = PNG.sync.write(refCrop);
    const diffBuffer = PNG.sync.write(diff);

    const actualFilename = generateFilename({ prefix: "compare-element-actual", browser, extension: "png" });
    const actualPath = await saveFile(path.join(outputDir, actualFilename), pageCropBuffer);
    const actualPreviewPath = await saveFile(
      path.join(outputDir, generateFilename({ prefix: "compare-element-actual-preview", browser, extension: "png" })),
      createPreviewBuffer(pageCropBuffer),
    );

    const refCropFilename = generateFilename({ prefix: "compare-element-ref", browser, extension: "png" });
    const refCropPath = await saveFile(path.join(outputDir, refCropFilename), refCropBuffer);

    const diffFilename = generateFilename({ prefix: "compare-element-diff", browser, extension: "png" });
    const diffPath = await saveFile(path.join(outputDir, diffFilename), diffBuffer);
    const diffPreviewPath = await saveFile(
      path.join(outputDir, generateFilename({ prefix: "compare-element-diff-preview", browser, extension: "png" })),
      createPreviewBuffer(diffBuffer),
    );

    const maskSummary = maskRegions
      .filter((r) => r.reason)
      .map((r) => `    - [${r.mode}] x=${Math.floor(r.x)} y=${Math.floor(r.y)} w=${Math.ceil(r.width)} h=${Math.ceil(r.height)} — ${r.reason}`);

    const broadMaskFlagsActive = !!(ignoreAllImages && ignoreText);
    const maskCoverageWarnings: string[] = [];
    if (maskCoverage > 60 && broadMaskFlagsActive) {
      maskCoverageWarnings.push(
        `⚠ mask coverage ${maskCoverage.toFixed(1)}% with ignoreAllImages + ignoreText — this is the mask-pair-fabrication fingerprint. Re-run unmasked and report both scores.`,
      );
    } else if (maskCoverage > 50) {
      maskCoverageWarnings.push(
        `⚠ mask coverage ${maskCoverage.toFixed(1)}% exceeds 50% — verify the diff is measuring meaningful surface area before trusting the score.`,
      );
    }

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    if (intersectApplied) {
      content.push({ type: "text", text: intersectApplied });
    }
    content.push({
      type: "text",
      text: [
        `Element compare result:`,
        `  Selector: ${selector}`,
        `  Match: ${isMatch ? "YES" : "NO"}`,
        `  Diff: ${diffPercentage.toFixed(2)}% (${mismatchedPixels} of ${totalPixels} pixels)`,
        `  Mode: ${mode}`,
        `  Bounds handling: ${boundsHandling}`,
        `  Threshold: ${threshold}`,
        `  Max diff: ${maxDiffPercent}%`,
        ...(maskRegions.length > 0 ? [`  Masked regions: ${maskRegions.length}`, `  Mask coverage: ${maskCoverage.toFixed(1)}%`] : []),
        ...(maskSummary.length > 0 ? [`  Masked region reasons:`, ...maskSummary] : []),
        `  Element box: x=${Math.floor(box.x)} y=${Math.floor(box.y)} w=${Math.ceil(box.width)} h=${Math.ceil(box.height)}`,
        `  Crop region (with ${padding}px padding): x=${cropX} y=${cropY} w=${cropW} h=${cropH}`,
        ...(aligned ? [`  Reference crop origin (aligned): x=${refCropX} y=${refCropY}`] : []),
        ...formatClusters(clusters, cropX, cropY, clusterAnnotations),
        `  Reference: ${referenceImage}`,
        `  Cropped reference saved: ${refCropPath}`,
        `  Cropped screenshot saved: ${actualPath}`,
        `  Cropped screenshot preview: ${actualPreviewPath}`,
        `  Diff image saved: ${diffPath}`,
        `  Diff preview: ${diffPreviewPath}`,
      ].join("\n"),
    });
    if (alignInfo) {
      content.push({ type: "text", text: alignInfo });
    }
    for (const w of maskCoverageWarnings) {
      content.push({ type: "text", text: w });
    }
    if (clusterAnnotations.length > 0) {
      content.push({
        type: "text",
        text: `clusterAnnotations:\n${JSON.stringify(clusterAnnotations, null, 2)}`,
      });
    }

    return { content };
  } finally {
    await closeSession(session);
  }
}
