import path from "node:path";
import fs from "node:fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import {
  getBlocks,
  getBlockClientIdByIndex,
  getBlockClientIdByPath,
  getBlockFrontendHints,
  savePost,
  editPostStatus,
} from "../utils/wp-data.js";
import { findBlockOnFrontend } from "../utils/frontend-locator.js";
import { findDiffClusters, formatClusters } from "../../../utils/diff-clusters.js";

/**
 * Composite: (post_id, block identifier, referenceImage) → (score, diff PNG,
 * frontend PNG). Resolves the block on the frontend, scrolls into view,
 * clips to its bounding box, and pixel-compares against the reference.
 *
 * Collapses what was previously 3 tool calls — gutenberg_screenshot_block,
 * visual_diff, and manual scroll + clip logic — into one.
 */
export function createCompareBlockHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
  defaultOutputDir: string,
) {
  return async (params: {
    post_id: number;
    referenceImage: string;
    block_index?: number;
    client_id?: string;
    block_path?: number[];
    block_anchor?: string;
    frontend_selector?: string;
    frontend_padding?: number;
    save_before_frontend?: boolean;
    mode?: "precise" | "design";
    threshold?: number;
    maxDiffPercent?: number;
    viewport?: { width: number; height: number };
    outputDir?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      referenceImage,
      block_index,
      client_id,
      block_path,
      block_anchor,
      frontend_selector,
      frontend_padding = 0,
      save_before_frontend = true,
      mode = "design",
      maxDiffPercent = 5,
      viewport,
      outputDir = defaultOutputDir,
    } = params;

    const refBuffer = await fs.readFile(referenceImage);
    const refImg = PNG.sync.read(refBuffer);
    const threshold = params.threshold ?? (mode === "design" ? 0.3 : 0.1);

    // Match viewport width to reference so the frontend DOM lays out at the
    // same width as Figma exported. Height defaults to ref height but grows
    // if the block extends past it (we clip on the element bbox either way).
    const resolvedViewport = viewport ?? {
      width: refImg.width,
      height: Math.max(refImg.height, 900),
    };

    const session = await core.launchSession({
      browser: "chromium",
      viewport: resolvedViewport,
      sessionHooks,
      toolName: "gutenberg_compare_block",
    });

    try {
      await navigateToEditor(session.page, post_id, config, auth);
      const editorError = await checkEditorError(session.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      // Resolve target block clientId. Anchor lookup reads block attributes.
      let targetClientId = client_id;
      if (!targetClientId && block_anchor) {
        const blocks = await getBlocks(session.page, true);
        targetClientId = findByAnchor(blocks, block_anchor) ?? undefined;
      }
      if (!targetClientId && block_path) {
        targetClientId = await getBlockClientIdByPath(session.page, block_path) ?? undefined;
      }
      if (!targetClientId) {
        const idx = block_index ?? 0;
        targetClientId = await getBlockClientIdByIndex(session.page, idx) ?? undefined;
      }
      if (!targetClientId) {
        return {
          content: [{ type: "text", text: `Block not found. Provide client_id, block_anchor, block_path, or block_index.` }],
          isError: true,
        };
      }

      const blocks = await getBlocks(session.page);
      const blockName = blocks.find((b) => b.clientId === targetClientId)?.name ?? null;
      if (!blockName) {
        return {
          content: [{ type: "text", text: `Could not resolve block name for clientId ${targetClientId}.` }],
          isError: true,
        };
      }

      const frontendHints = await getBlockFrontendHints(session.page, blockName, targetClientId);

      if (save_before_frontend) {
        await editPostStatus(session.page, "publish");
        await savePost(session.page);
      }

      const frontendUrl = await session.page.evaluate(() => {
        const wp = (window as any).wp;
        const post = wp.data.select("core/editor").getCurrentPost();
        return post?.link as string | undefined;
      });
      if (!frontendUrl) {
        return {
          content: [{ type: "text", text: `Could not determine frontend URL. The post may not be published.` }],
          isError: true,
        };
      }

      await core.navigateTo(session.page, frontendUrl);

      const lookup = await findBlockOnFrontend(session.page, frontendHints, frontend_selector);
      if (lookup.matches.length === 0) {
        return {
          content: [{
            type: "text",
            text: [
              `Frontend block not found.`,
              `  tried selectors: ${lookup.triedSelectors.join(", ")}`,
              `Pass frontend_selector to override.`,
            ].join("\n"),
          }],
          isError: true,
        };
      }

      const matchedSelector = lookup.matches[0].matchedBy;
      const locator = session.page.locator(matchedSelector).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      const box = await locator.boundingBox();
      if (!box) {
        return {
          content: [{ type: "text", text: `Could not get bounding box for ${matchedSelector}.` }],
          isError: true,
        };
      }

      // Clip screenshot to the block's bounding box (plus padding), clamped
      // to the viewport to avoid Playwright's clip-out-of-bounds error.
      const clipX = Math.max(0, Math.floor(box.x - frontend_padding));
      const clipY = Math.max(0, Math.floor(box.y - frontend_padding));
      const clipW = Math.min(
        resolvedViewport.width - clipX,
        Math.ceil(box.width + frontend_padding * 2),
      );
      const clipH = Math.min(
        resolvedViewport.height - clipY,
        Math.ceil(box.height + frontend_padding * 2),
      );

      if (clipW <= 0 || clipH <= 0) {
        return {
          content: [{
            type: "text",
            text: `Block bbox has zero/negative area after viewport clamp. Block box: x=${box.x} y=${box.y} w=${box.width} h=${box.height}. Viewport: ${resolvedViewport.width}x${resolvedViewport.height}.`,
          }],
          isError: true,
        };
      }

      const frontendBuffer = await session.page.screenshot({
        type: "png",
        clip: { x: clipX, y: clipY, width: clipW, height: clipH },
      });
      const pageImg = PNG.sync.read(frontendBuffer);

      // Compare at the intersection of frontend and reference. Ref is clipped
      // top-left; frontend is already clipped to block bbox. No alignment
      // magic — the caller is expected to pass a reference that's already
      // cropped to the block.
      const cmpW = Math.min(pageImg.width, refImg.width);
      const cmpH = Math.min(pageImg.height, refImg.height);

      const refCrop = cropPng(refImg, 0, 0, cmpW, cmpH);
      const liveCrop = cropPng(pageImg, 0, 0, cmpW, cmpH);
      const diff = new PNG({ width: cmpW, height: cmpH });
      const mismatchedPixels = pixelmatch(refCrop.data, liveCrop.data, diff.data, cmpW, cmpH, { threshold });
      const totalPixels = cmpW * cmpH;
      const diffPercentage = (mismatchedPixels / totalPixels) * 100;
      const isMatch = diffPercentage <= maxDiffPercent;
      const clusters = findDiffClusters(diff, { topN: 5 });

      const frontendFilename = core.generateFilename({ prefix: "gutenberg-compare-frontend", browser: "chromium", extension: "png" });
      const frontendPath = await core.saveFile(path.join(outputDir, frontendFilename), frontendBuffer);

      const diffBuffer = PNG.sync.write(diff);
      const diffFilename = core.generateFilename({ prefix: "gutenberg-compare-diff", browser: "chromium", extension: "png" });
      const diffPath = await core.saveFile(path.join(outputDir, diffFilename), diffBuffer);
      const diffPreviewPath = await core.saveFile(
        path.join(outputDir, diffFilename.replace(".png", "-preview.png")),
        core.createPreviewBuffer(diffBuffer),
      );

      const payload = {
        match: isMatch,
        score: Number((100 - diffPercentage).toFixed(2)),
        diff_percentage: Number(diffPercentage.toFixed(2)),
        mismatched_pixels: mismatchedPixels,
        total_pixels: totalPixels,
        compare_size: { width: cmpW, height: cmpH },
        frontend_size: { width: pageImg.width, height: pageImg.height },
        reference_size: { width: refImg.width, height: refImg.height },
        frontend_matched_by: matchedSelector,
        frontend_match_count: lookup.matches.length,
        block_name: blockName,
        client_id: targetClientId,
        block_anchor: block_anchor ?? null,
        diff_clusters: clusters,
        frontend_png: frontendPath,
        diff_png: diffPath,
        diff_preview: diffPreviewPath,
      };

      return {
        content: [
          { type: "text", text: JSON.stringify(payload, null, 2) },
          { type: "text", text: formatClusters(clusters).join("\n") || "(no significant diff clusters)" },
        ],
      };
    } finally {
      await core.closeSession(session);
    }
  };
}

function findByAnchor(
  blocks: Array<{ clientId: string; attributes: Record<string, unknown>; innerBlocks?: any[] }>,
  anchor: string,
): string | null {
  for (const b of blocks) {
    if (b.attributes?.anchor === anchor) return b.clientId;
    if (b.innerBlocks && b.innerBlocks.length > 0) {
      const found = findByAnchor(b.innerBlocks, anchor);
      if (found) return found;
    }
  }
  return null;
}

function cropPng(src: PNG, x: number, y: number, w: number, h: number): PNG {
  const dst = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcY = y + row;
    if (srcY < 0 || srcY >= src.height) continue;
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
