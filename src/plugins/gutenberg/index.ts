import { z } from "zod";
import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
  ResolvedPluginConfig,
} from "../types.js";
import { GUTENBERG_CONFIG_SCHEMA } from "./config.js";
import { WpAuth } from "./auth.js";
import { createInsertBlockHandler } from "./tools/insert-block.js";
import { createGetBlocksHandler } from "./tools/get-blocks.js";
import { createScreenshotBlockHandler } from "./tools/screenshot-block.js";
import { createCheckBlockHandler } from "./tools/check-block.js";
import { createPublishHandler } from "./tools/publish.js";
import { createClearBlocksHandler } from "./tools/clear-blocks.js";
import { createBlockHtmlHandler } from "./tools/block-html.js";
import { createInspectToolbarHandler } from "./tools/inspect-toolbar.js";
import { createCompareBlockHandler } from "./tools/compare-block.js";
import { createEvaluateHandler } from "./tools/evaluate.js";
import {
  insertBlock,
  selectBlock,
  updateBlockAttributes,
  getBlockClientIdByIndex,
  getBlockClientIdByPath,
  clearBlocks,
  removeBlock,
  savePost,
} from "./utils/wp-data.js";
import type { BrowserContext, Page } from "playwright";

/**
 * Resolve a target block's clientId from an action's params. Supports
 * client_id (direct), block_index (top-level only), or block_path (nested).
 * Returns null if none of the params identify a block.
 */
async function resolveTargetClientId(
  page: Page,
  params: Record<string, unknown>,
): Promise<string | null> {
  if (typeof params.client_id === "string") {
    return params.client_id;
  }
  if (Array.isArray(params.block_path)) {
    return getBlockClientIdByPath(page, params.block_path as number[]);
  }
  if (typeof params.block_index === "number") {
    return getBlockClientIdByIndex(page, params.block_index);
  }
  return null;
}

const gutenbergPlugin: ScreenshotPlugin = {
  name: "gutenberg",
  version: "1.0.0",

  getConfigSchema(): PluginConfigSchema {
    return GUTENBERG_CONFIG_SCHEMA;
  },

  async register(ctx: PluginContext, resolvedConfig: ResolvedPluginConfig): Promise<void> {
    const auth = new WpAuth(resolvedConfig);
    const defaultOutputDir = ctx.config.outputDir ?? ".browser";

    // Session hook: inject cached auth into new browser contexts.
    // Passed directly to launchSession by each plugin tool, AND registered
    // under the "wordpress" mode so core tools can opt in via use:"wordpress".
    // The toolName-prefix filter is gone — the hook is now pure-effect and
    // only runs when explicitly requested.
    const authHook = async (context: BrowserContext, _page: Page, _toolName: string) => {
      const injected = await auth.injectAuth(context);
      if (!injected) {
        // No cached state — perform a fresh login, then inject the result
        await auth.getStorageState(_page);
        await auth.injectAuth(context);
      }
    };
    const sessionHooks = [authHook];

    ctx.registerMode(
      "wordpress",
      sessionHooks,
      "Authenticated WordPress session — injects the cached wp-admin cookie " +
      "into the browser context. Unlocks /wp-admin/* pages, authenticated " +
      "REST endpoints, and post preview URLs for any core tool. Requires " +
      "WP_URL / WP_USERNAME / WP_PASSWORD env vars (same as gutenberg_* tools).",
    );

    // --- Tools ---

    ctx.registerTool({
      name: "insert_block",
      description:
        "Insert a Gutenberg block into the WordPress editor. " +
        "Opens the post editor, inserts the block via wp.data, and returns the block state. " +
        "Optionally takes a screenshot of the editor after insertion.",
      schema: {
        post_id: z.number().describe("WordPress post ID to edit"),
        block_name: z.string().describe('Block name (e.g. "core/paragraph", "my-plugin/my-block")'),
        attributes: z.record(z.string(), z.unknown()).optional().describe("Block attributes to set"),
        index: z.number().optional().describe("Position to insert at within the parent (default: append to end)"),
        root_client_id: z.string().optional().describe("Parent block's clientId for nested insertion (default: insert at top level)"),
        screenshot: z.boolean().optional().describe("Take a screenshot of the editor after insertion (default: true)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional()
          .describe("Viewport size (default: {width:1280, height:720})"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      },
      handler: createInsertBlockHandler(ctx.core, resolvedConfig, auth, sessionHooks, defaultOutputDir),
    });

    ctx.registerTool({
      name: "get_blocks",
      description:
        "Get the list of all blocks in a WordPress post's editor. " +
        "Returns each block's clientId, name, attributes, validity, and inner block count. " +
        "Set include_inner: true to recursively include the nested block tree.",
      schema: {
        post_id: z.number().describe("WordPress post ID to inspect"),
        include_inner: z.boolean().optional().describe(
          "Include each block's innerBlocks recursively as a nested tree (default: false)"
        ),
      },
      handler: createGetBlocksHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "screenshot_block",
      description:
        "Screenshot a specific block in the WordPress editor and/or its frontend rendering. " +
        "Target a block by index (0-based top-level), clientId, or block_path (nested).",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        block_index: z.number().optional().describe("Top-level block index, 0-based (default: 0)"),
        client_id: z.string().optional().describe("Block clientId (alternative to block_index/block_path)"),
        block_path: z.array(z.number()).optional().describe(
          "Path to a nested block, e.g. [0, 1] = second child of the first top-level block"
        ),
        context: z.enum(["editor", "frontend", "both"]).optional()
          .describe('What to screenshot: "editor", "frontend", or "both" (default: "editor")'),
        save_before_frontend: z.boolean().optional().describe(
          "Before capturing the frontend, publish + save the post so the rendered HTML " +
          "reflects the current editor state (default: true)"
        ),
        hide_editor_chrome: z.boolean().optional().describe(
          "Deselect blocks, close side panels, and hide caret / placeholders / selection " +
          "outlines in the editor iframe before capturing. Pairs with visual_diff against " +
          "the frontend screenshot (default: false)"
        ),
        viewport: z.object({ width: z.number(), height: z.number() }).optional()
          .describe("Viewport size (default: {width:1280, height:720})"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
        frontend_selector: z.string().optional().describe(
          "Custom CSS selector to locate the block on the frontend. Overrides auto-detection"
        ),
        frontend_padding: z.number().optional().describe(
          "Pixels of padding around the block when cropping the frontend screenshot (default: 0)"
        ),
        frontend_crop: z.boolean().optional().describe(
          "When true (default), crop the frontend screenshot to the block's bounding box. Set false for full-page capture"
        ),
      },
      handler: createScreenshotBlockHandler(ctx.core, resolvedConfig, auth, sessionHooks, defaultOutputDir),
    });

    ctx.registerTool({
      name: "inspect_toolbar",
      description:
        "Select a block and return a structured list of the buttons in its block toolbar. " +
        "Returns each button's label, aria-label, pressed/expanded state, disabled state, " +
        "and whether it has an icon. Use this instead of a screenshot to assert \"block X has " +
        "N toolbar buttons\" or \"button with label Y exists\".",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        block_index: z.number().optional().describe("Top-level block index, 0-based"),
        client_id: z.string().optional().describe("Block clientId (alternative to block_index/block_path)"),
        block_path: z.array(z.number()).optional().describe(
          "Path to a nested block, e.g. [0, 1] = second child of the first top-level block"
        ),
      },
      handler: createInspectToolbarHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "compare_block",
      description:
        "All-in-one block visual regression: resolves a block on the frontend, scrolls it into " +
        "view, clips to its bounding box, and pixel-compares against a reference image. " +
        "Handles the (post_id + block identifier + figma_png) → (score + diff PNG + frontend PNG) " +
        "flow in one call. Supports block_anchor for stable identification on multi-block test pages.",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        referenceImage: z.string().describe("Path to the reference PNG image (already cropped to the block)"),
        block_index: z.number().optional().describe("Top-level block index, 0-based"),
        client_id: z.string().optional().describe("Block clientId"),
        block_path: z.array(z.number()).optional().describe("Nested path, e.g. [0, 1]"),
        block_anchor: z.string().optional().describe(
          "Block's anchor attribute — the stable identifier for multi-block test pages. Preferred over block_index when the page has multiple blocks of the same type"
        ),
        frontend_selector: z.string().optional().describe(
          "Custom CSS selector to locate the block on the frontend. Overrides auto-detection"
        ),
        frontend_padding: z.number().optional().describe("Pixels of padding around the block bbox (default: 0)"),
        save_before_frontend: z.boolean().optional().describe(
          "Publish + save the post before reading the frontend (default: true)"
        ),
        mode: z.enum(["precise", "design"]).optional().describe(
          'Comparison mode (default: "design" — appropriate for Figma references)'
        ),
        threshold: z.number().optional().describe("Pixel diff threshold 0-1. Overrides mode default"),
        maxDiffPercent: z.number().optional().describe("Maximum diff % to still count as a match (default: 5)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe(
          "Viewport size (default: reference image width × max(ref height, 900))"
        ),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      },
      handler: createCompareBlockHandler(ctx.core, resolvedConfig, auth, sessionHooks, defaultOutputDir),
    });

    ctx.registerTool({
      name: "evaluate",
      description:
        "Run JavaScript inside an authenticated Gutenberg editor page and return the value. " +
        "Uses the same cached WP session cookie as other gutenberg_* tools, so /wp-admin auth is handled " +
        "automatically. Waits for wp.data and the editor canvas iframe to be ready before executing. " +
        "Script runs in an IIFE — use `return value` to yield a result. Returns { value, console, errors }.",
      schema: {
        post_id: z.number().describe("WordPress post ID of the editor to evaluate in"),
        script: z.string().describe("JavaScript body. Wrapped in an IIFE under the hood — use `return value` at top level to yield a result"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional()
          .describe("Viewport size (default: {width:1280, height:720})"),
        waitForEditor: z.boolean().optional().describe(
          "Wait for wp.data and editor-canvas iframe readiness before running the script (default: true)"
        ),
      },
      handler: createEvaluateHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "check_block",
      description:
        "Comprehensive block validation. Inserts a block, checks registration and validity, " +
        "captures console errors, takes editor + frontend screenshots, extracts frontend HTML, " +
        "and runs an accessibility check. Returns all results in one call.",
      schema: {
        post_id: z.number().describe("WordPress post ID to use for testing"),
        block_name: z.string().describe('Block name (e.g. "my-plugin/my-block")'),
        attributes: z.record(z.string(), z.unknown()).optional().describe("Block attributes to set"),
        frontend_selector: z.string().optional().describe(
          "Custom CSS selector to locate the block on the frontend. " +
          "Overrides the automatic detection (which uses wp.blocks.getBlockDefaultClassName, " +
          "custom className attributes, and the block's editor DOM classes)."
        ),
        viewport: z.object({ width: z.number(), height: z.number() }).optional()
          .describe("Viewport size (default: {width:1280, height:720})"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      },
      handler: createCheckBlockHandler(ctx.core, resolvedConfig, auth, sessionHooks, defaultOutputDir),
    });

    ctx.registerTool({
      name: "publish",
      description: "Save or publish a WordPress post via the Gutenberg editor.",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        status: z.enum(["publish", "draft", "pending", "private"]).optional()
          .describe('Post status (default: "publish")'),
      },
      handler: createPublishHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "block_html",
      description:
        "Return normalized HTML for a specific block in both editor and frontend contexts. " +
        "Strips editor-only noise (data-block, rich-text UX attrs, is-selected classes, " +
        "block-editor-* wrapper classes) so the two strings can be compared structurally. " +
        "Stronger than a pixel diff for verifying that editor rendering matches the frontend.",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        block_index: z.number().optional().describe("Top-level block index, 0-based (default: 0)"),
        client_id: z.string().optional().describe("Block clientId (alternative to block_index/block_path)"),
        block_path: z.array(z.number()).optional().describe(
          "Path to a nested block, e.g. [0, 1] = second child of the first top-level block"
        ),
        block_name: z.string().optional().describe(
          "Block name (e.g. \"my-plugin/my-block\") — used to resolve the frontend element. " +
          "Auto-detected from the block in the editor when omitted"
        ),
        frontend_selector: z.string().optional().describe(
          "Custom CSS selector to locate the block on the frontend. Overrides auto-detection"
        ),
        save_before_frontend: z.boolean().optional().describe(
          "Publish + save the post before reading the frontend so rendered HTML reflects " +
          "the current editor state (default: true)"
        ),
      },
      handler: createBlockHtmlHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "clear_blocks",
      description:
        "Reset a WordPress post's block list to empty and save. " +
        "Useful for deterministic/idempotent flows that wipe and rebuild the page each run.",
      schema: {
        post_id: z.number().describe("WordPress post ID to clear"),
        skip_save: z.boolean().optional().describe(
          "If true, clear the blocks in memory but don't save. " +
          "Useful when immediately followed by inserts so both land in a single save (default: false)"
        ),
      },
      handler: createClearBlocksHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    // --- Custom actions (usable in any browser-mcp tool's actions[] array) ---

    ctx.registerAction("gutenberg_insert", async (page: Page, params: Record<string, unknown>) => {
      const blockName = params.block_name as string;
      const attributes = params.attributes as Record<string, unknown> | undefined;
      const index = params.index as number | undefined;
      const rootClientId = params.root_client_id as string | undefined;
      if (!blockName) throw new Error("gutenberg_insert requires block_name");

      // Wait for wp.data to be available
      await page.waitForFunction(
        () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
        { timeout: 10000 },
      );

      await insertBlock(page, blockName, attributes, index, rootClientId);
    });

    ctx.registerAction("gutenberg_set_attribute", async (page: Page, params: Record<string, unknown>) => {
      const attributes = params.attributes as Record<string, unknown>;
      if (!attributes) throw new Error("gutenberg_set_attribute requires attributes");

      await page.waitForFunction(
        () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
        { timeout: 10000 },
      );

      const clientId = await resolveTargetClientId(page, params);
      if (!clientId) {
        throw new Error("gutenberg_set_attribute requires client_id, block_index, or block_path");
      }

      await updateBlockAttributes(page, clientId, attributes);
    });

    ctx.registerAction("gutenberg_clear", async (page: Page, params: Record<string, unknown>) => {
      const skipSave = params.skip_save === true;

      await page.waitForFunction(
        () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
        { timeout: 10000 },
      );

      await clearBlocks(page);
      if (!skipSave) {
        await savePost(page);
      }
    });

    ctx.registerAction("gutenberg_select_block", async (page: Page, params: Record<string, unknown>) => {
      await page.waitForFunction(
        () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
        { timeout: 10000 },
      );

      const clientId = await resolveTargetClientId(page, params);
      if (!clientId) {
        throw new Error("gutenberg_select_block requires client_id, block_index, or block_path");
      }

      await selectBlock(page, clientId);
    });

    ctx.registerAction("gutenberg_remove", async (page: Page, params: Record<string, unknown>) => {
      await page.waitForFunction(
        () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
        { timeout: 10000 },
      );

      const clientId = await resolveTargetClientId(page, params);
      if (!clientId) {
        throw new Error("gutenberg_remove requires client_id, block_index, or block_path");
      }

      await removeBlock(page, clientId);
    });
  },

  async destroy(): Promise<void> {
    // No persistent state to clean up
  },
};

export default gutenbergPlugin;
