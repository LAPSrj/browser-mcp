import fs from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { saveFile, generateFilename } from "../utils/file.js";
import { createPreviewBuffer } from "../utils/resize.js";
import { findDiffClusters, formatClusters } from "../utils/diff-clusters.js";

export type CompareMode = "precise" | "design";

const MODE_DEFAULTS: Record<CompareMode, { threshold: number }> = {
  precise: { threshold: 0.1 },
  design: { threshold: 0.3 },
};

export interface VisualDiffParams {
  imageA: string;
  imageB: string;
  outputDir?: string;
  mode?: CompareMode;
  threshold?: number;
  crop?: boolean;
  maxDiffPercent?: number;
}

function cropPng(src: PNG, w: number, h: number): PNG {
  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const srcOff = (y * src.width) << 2;
    const dstOff = (y * w) << 2;
    src.data.copy(dst.data, dstOff, srcOff, srcOff + (w << 2));
  }
  return dst;
}

export async function visualDiffTool(params: VisualDiffParams) {
  const {
    imageA,
    imageB,
    outputDir = ".browser",
    mode = "precise",
    crop = false,
    maxDiffPercent = 5,
  } = params;

  const threshold = params.threshold ?? MODE_DEFAULTS[mode].threshold;

  const [bufA, bufB] = await Promise.all([
    fs.readFile(imageA),
    fs.readFile(imageB),
  ]);

  const rawA = PNG.sync.read(bufA);
  const rawB = PNG.sync.read(bufB);

  let imgA: PNG = rawA;
  let imgB: PNG = rawB;

  if (rawA.width !== rawB.width || rawA.height !== rawB.height) {
    if (!crop) {
      return {
        content: [{
          type: "text",
          text: `Image dimensions don't match: ${imageA} is ${rawA.width}x${rawA.height}, ${imageB} is ${rawB.width}x${rawB.height}. Images must be the same size for comparison. Use crop: true to auto-crop to the smaller dimensions.`,
        }],
      };
    }
    const w = Math.min(rawA.width, rawB.width);
    const h = Math.min(rawA.height, rawB.height);
    imgA = cropPng(rawA, w, h);
    imgB = cropPng(rawB, w, h);
  }

  const { width, height } = imgA;
  const diff = new PNG({ width, height });

  const mismatchedPixels = pixelmatch(
    imgA.data,
    imgB.data,
    diff.data,
    width,
    height,
    { threshold }
  );

  const totalPixels = width * height;
  const diffPercentage = (mismatchedPixels / totalPixels) * 100;
  const isMatch = diffPercentage <= maxDiffPercent;

  const clusters = findDiffClusters(diff, { topN: 5 });

  const diffBuffer = PNG.sync.write(diff);
  const filename = generateFilename({ prefix: "diff", extension: "png" });
  const filePath = await saveFile(path.join(outputDir, filename), diffBuffer);
  const previewFilename = generateFilename({ prefix: "diff-preview", extension: "png" });
  const previewPath = await saveFile(path.join(outputDir, previewFilename), createPreviewBuffer(diffBuffer));

  return {
    content: [
      {
        type: "text",
        text: [
          `Visual diff result:`,
          `  Match: ${isMatch ? "YES" : "NO"}`,
          `  Diff: ${diffPercentage.toFixed(2)}% (${mismatchedPixels} of ${totalPixels} pixels)`,
          `  Compare size: ${width}x${height}`,
          `  Mode: ${mode}`,
          `  Threshold: ${threshold}`,
          `  Max diff: ${maxDiffPercent}%`,
          ...(crop ? [`  Cropped: yes`] : []),
          ...formatClusters(clusters),
          `  Diff image saved: ${filePath}`,
          `  Diff preview (small): ${previewPath}`,
        ].join("\n"),
      },
    ],
  };
}
