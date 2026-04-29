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
import { findDiffClusters, formatClusters, formatClustersCompact } from "../../../utils/diff-clusters.js";
import { annotateClusters } from "../../../utils/cluster-dom-hints.js";
import type { CompareMode } from "./visual-diff.js";

export interface CompareScreenshotParams {
  url: string;
  referenceImage: string;
  browser?: string;
  actions?: AnyAction[];
  outputDir?: string;
  mode?: CompareMode;
  threshold?: number;
  maxDiffPercent?: number;
  waitForNetworkIdle?: boolean;
  useBrowserStack?: boolean;
  delay?: number;
  startY?: number;
  endY?: number;
  startX?: number;
  endX?: number;
  ignoreImages?: boolean;
  ignoreBackgrounds?: boolean;
  ignoreAllImages?: boolean;
  ignoreText?: boolean;
  ignoreElements?: IgnoreElement[];
  ignoreRegions?: Array<{ x: number; y: number; width: number; height: number; mode?: "invisible" | "position-only"; reason?: string }>;
  summaryOnly?: boolean;
  clustersTopN?: number;
  profile?: "walker";
}

const WALKER_PROFILE_COMPARE_SCREENSHOT: Partial<CompareScreenshotParams> = {
  summaryOnly: true,
  clustersTopN: 3,
};

export async function compareScreenshotTool(rawParams: CompareScreenshotParams) {
  const params = rawParams.profile === "walker"
    ? { ...WALKER_PROFILE_COMPARE_SCREENSHOT, ...rawParams }
    : rawParams;
  const {
    url,
    referenceImage,
    browser = "chromium",
    actions = [],
    outputDir = ".browser",
    mode = "precise",
    maxDiffPercent = 5,
    waitForNetworkIdle = true,
    useBrowserStack = false,
    delay = 0,
    startY,
    endY,
    startX,
    endX,
    ignoreImages,
    ignoreBackgrounds,
    ignoreAllImages,
    ignoreText,
    ignoreElements,
    ignoreRegions,
    summaryOnly = false,
    clustersTopN = 5,
  } = params;

  const threshold = params.threshold ?? (mode === "design" ? 0.3 : 0.1);

  const refBuffer = await fs.readFile(referenceImage);
  const refImg = PNG.sync.read(refBuffer);

  const viewportWidth = refImg.width;
  const viewportHeight = refImg.height;

  const session = await launchSession({
    browser: browser as BrowserName,
    viewport: { width: viewportWidth, height: viewportHeight },
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

    const screenshotOptions: Record<string, unknown> = { type: "png" };

    if (startY !== undefined || endY !== undefined || startX !== undefined || endX !== undefined) {
      const clipX = startX ?? 0;
      const clipY = startY ?? 0;
      const clipWidth = (endX ?? viewportWidth) - clipX;
      const clipHeight = (endY ?? viewportHeight) - clipY;
      screenshotOptions.clip = { x: clipX, y: clipY, width: clipWidth, height: clipHeight };
    }

    const screenshotBuffer = await session.page.screenshot(screenshotOptions);
    const pageImg = PNG.sync.read(screenshotBuffer);

    const maskRegions: MaskRegion[] = await collectMaskRegions(session.page, { ignoreImages, ignoreBackgrounds, ignoreAllImages, ignoreText, ignoreElements });
    if (ignoreRegions?.length) {
      for (const r of ignoreRegions) {
        maskRegions.push({ x: r.x, y: r.y, width: r.width, height: r.height, mode: r.mode ?? "invisible", reason: r.reason });
      }
    }

    if (pageImg.width !== refImg.width || pageImg.height !== refImg.height) {
      const screenshotFilename = generateFilename({ prefix: "compare-actual", browser, extension: "png" });
      const screenshotPath = await saveFile(path.join(outputDir, screenshotFilename), screenshotBuffer);
      const previewFilename = generateFilename({ prefix: "compare-actual-preview", browser, extension: "png" });
      const previewPath = await saveFile(path.join(outputDir, previewFilename), createPreviewBuffer(screenshotBuffer));

      const content: Array<{ type: string; text: string }> = [];
      if (actionStopMsg) {
        content.push({ type: "text", text: actionStopMsg });
      }
      content.push({
        type: "text",
        text: [
          `Image dimensions don't match.`,
          `  Reference: ${refImg.width}x${refImg.height}`,
          `  Screenshot: ${pageImg.width}x${pageImg.height}`,
          `  Screenshot saved: ${screenshotPath}`,
          `  Screenshot preview (small): ${previewPath}`,
          `Adjust startY/endY/startX/endX or viewport to get matching dimensions.`,
        ].join("\n"),
      });
      return { content };
    }

    const clipX = startX ?? 0;
    const clipY = startY ?? 0;
    const maskCoverage = maskRegions.length > 0
      ? computeMaskCoverage(maskRegions, { x: clipX, y: clipY, width: pageImg.width, height: pageImg.height })
      : 0;
    if (maskRegions.length > 0) {
      applyMask(pageImg, maskRegions, clipX, clipY);
      applyMask(refImg, maskRegions, clipX, clipY);
    }

    const { width, height } = refImg;
    const diff = new PNG({ width, height });

    const mismatchedPixels = pixelmatch(
      refImg.data,
      pageImg.data,
      diff.data,
      width,
      height,
      { threshold }
    );

    const totalPixels = width * height;
    const diffPercentage = (mismatchedPixels / totalPixels) * 100;
    const isMatch = diffPercentage <= maxDiffPercent;

    const clusters = findDiffClusters(diff, { topN: clustersTopN });
    const clusterAnnotations = await annotateClusters(session.page, clusters, {
      offsetX: clipX,
      offsetY: clipY,
    });

    const diffBuffer = PNG.sync.write(diff);
    const diffFilename = generateFilename({ prefix: "compare-diff", browser, extension: "png" });
    const diffPath = await saveFile(path.join(outputDir, diffFilename), diffBuffer);
    const diffPreviewPath = summaryOnly
      ? undefined
      : await saveFile(
          path.join(outputDir, generateFilename({ prefix: "compare-diff-preview", browser, extension: "png" })),
          createPreviewBuffer(diffBuffer),
        );

    const screenshotFilename = generateFilename({ prefix: "compare-actual", browser, extension: "png" });
    const screenshotPath = await saveFile(path.join(outputDir, screenshotFilename), screenshotBuffer);
    const screenshotPreviewPath = summaryOnly
      ? undefined
      : await saveFile(
          path.join(outputDir, generateFilename({ prefix: "compare-actual-preview", browser, extension: "png" })),
          createPreviewBuffer(screenshotBuffer),
        );

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    if (summaryOnly) {
      content.push({
        type: "text",
        text: [
          `Compare result:`,
          `  Match: ${isMatch ? "YES" : "NO"}`,
          `  Diff: ${diffPercentage.toFixed(2)}% (${mismatchedPixels} of ${totalPixels} pixels)`,
          `  Mode: ${mode} | Threshold: ${threshold} | Max diff: ${maxDiffPercent}%`,
          ...(maskRegions.length > 0
            ? [`  Mask: ${maskRegions.length} region${maskRegions.length === 1 ? "" : "s"}, ${maskCoverage.toFixed(1)}% coverage`]
            : []),
          ...formatClustersCompact(clusters, clipX, clipY),
          `  Diff: ${diffPath}`,
          `  Actual: ${screenshotPath}`,
          `  Reference: ${referenceImage}`,
        ].join("\n"),
      });
    } else {
      content.push({
        type: "text",
        text: [
          `Compare result:`,
          `  Match: ${isMatch ? "YES" : "NO"}`,
          `  Diff: ${diffPercentage.toFixed(2)}% (${mismatchedPixels} of ${totalPixels} pixels)`,
          `  Mode: ${mode}`,
          `  Threshold: ${threshold}`,
          `  Max diff: ${maxDiffPercent}%`,
          ...(maskRegions.length > 0 ? [`  Masked regions: ${maskRegions.length}`, `  Mask coverage: ${maskCoverage.toFixed(1)}%`] : []),
          ...maskRegions
            .filter((r) => r.reason)
            .map((r) => `    - [${r.mode}] x=${Math.floor(r.x)} y=${Math.floor(r.y)} w=${Math.ceil(r.width)} h=${Math.ceil(r.height)} — ${r.reason}`),
          ...formatClusters(clusters, clipX, clipY, clusterAnnotations),
          `  Reference: ${referenceImage}`,
          `  Screenshot saved: ${screenshotPath}`,
          `  Screenshot preview (small): ${screenshotPreviewPath}`,
          `  Diff image saved: ${diffPath}`,
          `  Diff preview (small): ${diffPreviewPath}`,
        ].join("\n"),
      });
    }
    if (maskCoverage > 60 && ignoreAllImages && ignoreText) {
      content.push({
        type: "text",
        text: `⚠ mask coverage ${maskCoverage.toFixed(1)}% with ignoreAllImages + ignoreText — this is the mask-pair-fabrication fingerprint. Re-run unmasked and report both scores.`,
      });
    } else if (maskCoverage > 50) {
      content.push({
        type: "text",
        text: `⚠ mask coverage ${maskCoverage.toFixed(1)}% exceeds 50% — verify the diff is measuring meaningful surface area before trusting the score.`,
      });
    }
    if (clusterAnnotations.length > 0 && !summaryOnly) {
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
