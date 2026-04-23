import { z } from "zod";
import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
  ResolvedPluginConfig,
} from "../types.js";
import { WP_CONFIG_SCHEMA } from "../wp/config.js";
import { getSharedWpAuth } from "../wp/auth.js";
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
import type { Page } from "playwright";

async function resolveTargetClientId(
  page: Page,
  params: Record<string, unknown>,
): Promise<string | null> {
  if (typeof params.client_id === "string") return params.client_id;
  if (Array.isArray(params.block_path)) return getBlockClientIdByPath(page, params.block_path as number[]);
  if (typeof params.block_index === "number") return getBlockClientIdByIndex(page, params.block_index);
  return null;
}

// wp-gutenberg: Gutenberg editor workflows. Depends on `wp` for the
// authenticated session. Tool names stay prefixed (wp-gutenberg_insert_block)
// to keep them discoverable under a single domain namespace.
const wpGutenbergPlugin: ScreenshotPlugin = {
  name: "wp-gutenberg",
  version: "0.1.0",
  dependencies: ["wp"],

  getConfigSchema(): PluginConfigSchema {
    return WP_CONFIG_SCHEMA;
  },

  async register(ctx: PluginContext, resolvedConfig: ResolvedPluginConfig): Promise<void> {
    const auth = getSharedWpAuth();
    const defaultOutputDir = ctx.config.outputDir ?? ".browser";

    // Reuse wp's authHook locally for launchSession. Stays in sync with the
    // "wordpress" mode hook wp registers — both do auth-inject with lazy
    // login, but only attempt auto-login when credentials are configured.
    const authHook = async (context: any, page: Page, _toolName: string) => {
      const injected = await auth.injectAuth(context);
      if (!injected && auth.canAutoLogin()) {
        await auth.getStorageState(page);
        await auth.injectAuth(context);
      }
    };
    const sessionHooks = [authHook];

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
        root_client_id: z.string().optional().describe("Parent block's clientId for nested insertion"),
        screenshot: z.boolean().optional().describe("Take a screenshot of the editor after insertion (default: true)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280, height:720})"),
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
        include_inner: z.boolean().optional().describe("Include each block's innerBlocks recursively (default: false)"),
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
        block_path: z.array(z.number()).optional().describe("Path to a nested block, e.g. [0, 1]"),
        context: z.enum(["editor", "frontend", "both"]).optional().describe('What to screenshot (default: "editor")'),
        save_before_frontend: z.boolean().optional().describe("Publish + save the post before capturing the frontend (default: true)"),
        hide_editor_chrome: z.boolean().optional().describe("Deselect blocks and hide editor UI before capturing (default: false)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280, height:720})"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
        frontend_selector: z.string().optional().describe("Custom CSS selector to locate the block on the frontend"),
        frontend_padding: z.number().optional().describe("Pixels of padding around the block bbox (default: 0)"),
        frontend_crop: z.boolean().optional().describe("Clip the frontend screenshot to the block bbox (default: true)"),
      },
      handler: createScreenshotBlockHandler(ctx.core, resolvedConfig, auth, sessionHooks, defaultOutputDir),
    });

    ctx.registerTool({
      name: "inspect_toolbar",
      description:
        "Select a block and return a structured list of the buttons in its block toolbar. " +
        "Returns each button's label, aria-label, pressed/expanded state, disabled state, and icon presence.",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        block_index: z.number().optional().describe("Top-level block index, 0-based"),
        client_id: z.string().optional().describe("Block clientId"),
        block_path: z.array(z.number()).optional().describe("Path to a nested block, e.g. [0, 1]"),
      },
      handler: createInspectToolbarHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "compare_block",
      description:
        "All-in-one block visual regression: resolves a block on the frontend, scrolls it into view, " +
        "clips to its bounding box, and pixel-compares against a reference image. " +
        "Supports block_anchor for stable identification on multi-block test pages.",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        referenceImage: z.string().describe("Path to the reference PNG image"),
        block_index: z.number().optional().describe("Top-level block index, 0-based"),
        client_id: z.string().optional().describe("Block clientId"),
        block_path: z.array(z.number()).optional().describe("Nested path, e.g. [0, 1]"),
        block_anchor: z.string().optional().describe("Block's anchor attribute — stable id for multi-block test pages"),
        frontend_selector: z.string().optional().describe("Custom CSS selector to locate the block on the frontend"),
        frontend_padding: z.number().optional().describe("Pixels of padding around the block bbox (default: 0)"),
        save_before_frontend: z.boolean().optional().describe("Publish + save before reading the frontend (default: true)"),
        mode: z.enum(["precise", "design"]).optional().describe('Comparison mode (default: "design")'),
        threshold: z.number().optional().describe("Pixel diff threshold 0-1"),
        maxDiffPercent: z.number().optional().describe("Maximum diff % to still match (default: 5)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      },
      handler: createCompareBlockHandler(ctx.core, resolvedConfig, auth, sessionHooks, defaultOutputDir),
    });

    ctx.registerTool({
      name: "evaluate",
      description:
        "Run JavaScript inside an authenticated Gutenberg editor page and return the value. " +
        "Uses the cached WP session cookie, waits for wp.data + editor canvas readiness, and wraps the script in an IIFE.",
      schema: {
        post_id: z.number().describe("WordPress post ID of the editor to evaluate in"),
        script: z.string().describe("JavaScript body. Use `return value` to yield a result"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280, height:720})"),
        waitForEditor: z.boolean().optional().describe("Wait for wp.data + editor-canvas readiness (default: true)"),
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
        frontend_selector: z.string().optional().describe("Custom CSS selector to locate the block on the frontend"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      },
      handler: createCheckBlockHandler(ctx.core, resolvedConfig, auth, sessionHooks, defaultOutputDir),
    });

    ctx.registerTool({
      name: "publish",
      description: "Save or publish a WordPress post via the Gutenberg editor.",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        status: z.enum(["publish", "draft", "pending", "private"]).optional().describe('Post status (default: "publish")'),
      },
      handler: createPublishHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "block_html",
      description:
        "Return normalized HTML for a specific block in both editor and frontend contexts. " +
        "Strips editor-only noise so the two strings can be compared structurally.",
      schema: {
        post_id: z.number().describe("WordPress post ID"),
        block_index: z.number().optional().describe("Top-level block index, 0-based (default: 0)"),
        client_id: z.string().optional().describe("Block clientId"),
        block_path: z.array(z.number()).optional().describe("Path to a nested block"),
        block_name: z.string().optional().describe("Block name — auto-detected from the editor when omitted"),
        frontend_selector: z.string().optional().describe("Custom CSS selector to locate the block on the frontend"),
        save_before_frontend: z.boolean().optional().describe("Publish + save before reading the frontend (default: true)"),
      },
      handler: createBlockHtmlHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    ctx.registerTool({
      name: "clear_blocks",
      description:
        "Reset a WordPress post's block list to empty and save. " +
        "Useful for deterministic flows that wipe and rebuild the page each run.",
      schema: {
        post_id: z.number().describe("WordPress post ID to clear"),
        skip_save: z.boolean().optional().describe("Clear in memory but don't save (default: false)"),
      },
      handler: createClearBlocksHandler(ctx.core, resolvedConfig, auth, sessionHooks),
    });

    // --- Custom actions (usable in any tool's actions[] array) ---

    const waitForWpData = async (page: Page) =>
      page.waitForFunction(
        () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
        { timeout: 10000 },
      );

    ctx.registerAction("gutenberg_insert", async (page, params) => {
      const blockName = params.block_name as string;
      if (!blockName) throw new Error("gutenberg_insert requires block_name");
      await waitForWpData(page);
      await insertBlock(
        page,
        blockName,
        params.attributes as Record<string, unknown> | undefined,
        params.index as number | undefined,
        params.root_client_id as string | undefined,
      );
    });

    ctx.registerAction("gutenberg_set_attribute", async (page, params) => {
      const attributes = params.attributes as Record<string, unknown>;
      if (!attributes) throw new Error("gutenberg_set_attribute requires attributes");
      await waitForWpData(page);
      const clientId = await resolveTargetClientId(page, params);
      if (!clientId) throw new Error("gutenberg_set_attribute requires client_id, block_index, or block_path");
      await updateBlockAttributes(page, clientId, attributes);
    });

    ctx.registerAction("gutenberg_clear", async (page, params) => {
      const skipSave = params.skip_save === true;
      await waitForWpData(page);
      await clearBlocks(page);
      if (!skipSave) await savePost(page);
    });

    ctx.registerAction("gutenberg_select_block", async (page, params) => {
      await waitForWpData(page);
      const clientId = await resolveTargetClientId(page, params);
      if (!clientId) throw new Error("gutenberg_select_block requires client_id, block_index, or block_path");
      await selectBlock(page, clientId);
    });

    ctx.registerAction("gutenberg_remove", async (page, params) => {
      await waitForWpData(page);
      const clientId = await resolveTargetClientId(page, params);
      if (!clientId) throw new Error("gutenberg_remove requires client_id, block_index, or block_path");
      await removeBlock(page, clientId);
    });
  },

  async destroy(): Promise<void> {
    // No persistent state to clean up.
  },
};

export default wpGutenbergPlugin;
