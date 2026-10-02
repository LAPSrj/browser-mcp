import { z } from "zod";
import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
} from "../types.js";
import { getSharedWpSites, assertCanWrite } from "../wp/sites.js";
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

// Recursive schema for an InnerBlocks tree node — { name, attributes?, innerBlocks? }.
type InnerBlockNode = {
  name: string;
  attributes?: Record<string, unknown>;
  innerBlocks?: InnerBlockNode[];
};
const innerBlockSchema: z.ZodType<InnerBlockNode> = z.lazy(() =>
  z.object({
    name: z.string().describe('e.g. "core/paragraph"'),
    attributes: z.record(z.string(), z.unknown()).optional(),
    innerBlocks: z.array(innerBlockSchema).optional(),
  }),
);

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

  // Site settings come from the wp plugin (WP_URL / WP_SITES).
  getConfigSchema(): PluginConfigSchema {
    return {};
  },

  async register(ctx: PluginContext): Promise<void> {
    const sites = getSharedWpSites();
    const defaultOutputDir = ctx.config.outputDir ?? ".browser";
    const siteNames = sites.list.map((s) => s.name).join(", ");

    // --- Tools ---

    // Shared session_id schema — opt into a persistent open_session()-owned
    // page rather than spinning a per-call ephemeral browser. Lets multi-call
    // flows (clear → block_html → check) share editor state instead of each
    // tool re-navigating from scratch.
    const sessionIdSchema = z.string().optional().describe(
      "open_session id; runs on its active page. Omit for a one-call ephemeral session.",
    );

    const siteSchema = z.string().optional().describe(
      `Site name (case-insensitive): ${siteNames}. ` +
      "Default: the session_id page's site if configured, else the first site.",
    );

    const allowWriteSchema = z.boolean().optional().describe(
      "Required (true) to save on a site with WP_REQUIRE_ALLOW_WRITE set; other sites always allow saves. Default false.",
    );

    ctx.registerTool({
      name: "insert_block",
      description:
        "Insert a block into a post in the Gutenberg editor and return the block state. In memory only unless save:true. " +
        "On template-locked FSE posts it goes into the post body (core/post-content) instead of the locked template.",
      schema: {
        post_id: z.number(),
        block_name: z.string().describe('e.g. "core/paragraph"'),
        attributes: z.record(z.string(), z.unknown()).optional(),
        inner_blocks: z.array(innerBlockSchema).optional().describe(
          "Nested children to create in the same call; needed when items carry attributes (e.g. social-links)",
        ),
        index: z.number().optional().describe("Position in the parent (default: end)"),
        root_client_id: z.string().optional().describe(
          "Parent clientId for nested insertion (default: core/post-content on template-locked FSE posts)",
        ),
        save: z.boolean().optional().describe("Save the post (default false)"),
        screenshot: z.boolean().optional().describe("Editor screenshot after insert (default true)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Default {width:1280, height:720}"),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        session_id: sessionIdSchema,
        site: siteSchema,
        allow_write: allowWriteSchema,
      },
      handler: createInsertBlockHandler(ctx.core, sites, defaultOutputDir),
    });

    ctx.registerTool({
      name: "get_blocks",
      description:
        "List a post's blocks in the editor: clientId, name, attributes, validity, inner block count.",
      schema: {
        post_id: z.number(),
        include_inner: z.boolean().optional().describe("Include nested blocks recursively (default false)"),
        session_id: sessionIdSchema,
        site: siteSchema,
      },
      handler: createGetBlocksHandler(ctx.core, sites),
    });

    ctx.registerTool({
      name: "screenshot_block",
      description:
        "Screenshot one block in the editor and/or on the frontend.",
      schema: {
        post_id: z.number(),
        block_index: z.number().optional().describe("Top-level index, 0-based (default 0)"),
        client_id: z.string().optional(),
        block_path: z.array(z.number()).optional().describe("Nested block path, e.g. [0, 1]"),
        context: z.enum(["editor", "frontend", "both"]).optional().describe('Default "editor"'),
        save_before_frontend: z.boolean().optional().describe("Publish and save before the frontend capture (default true)"),
        hide_editor_chrome: z.boolean().optional().describe("Deselect and hide editor UI (default false)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Default {width:1280, height:720}"),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        frontend_selector: z.string().optional().describe("CSS selector for the block on the frontend"),
        frontend_padding: z.number().optional().describe("px around the block (default 0)"),
        frontend_crop: z.boolean().optional().describe("Clip to the block (default true)"),
        session_id: sessionIdSchema,
        site: siteSchema,
        allow_write: allowWriteSchema,
      },
      handler: createScreenshotBlockHandler(ctx.core, sites, defaultOutputDir),
    });

    ctx.registerTool({
      name: "inspect_toolbar",
      description:
        "Select a block and list its toolbar buttons: label, aria-label, pressed, expanded, disabled, icon.",
      schema: {
        post_id: z.number(),
        block_index: z.number().optional().describe("Top-level index, 0-based"),
        client_id: z.string().optional(),
        block_path: z.array(z.number()).optional().describe("Nested block path, e.g. [0, 1]"),
        session_id: sessionIdSchema,
        site: siteSchema,
      },
      handler: createInspectToolbarHandler(ctx.core, sites),
    });

    ctx.registerTool({
      name: "compare_block",
      description:
        "Pixel-compare a block's frontend rendering, clipped to its box, with a reference PNG.",
      schema: {
        post_id: z.number(),
        referenceImage: z.string().describe("Reference PNG path"),
        block_index: z.number().optional().describe("Top-level index, 0-based"),
        client_id: z.string().optional(),
        block_path: z.array(z.number()).optional().describe("Nested block path, e.g. [0, 1]"),
        block_anchor: z.string().optional().describe("Block anchor attribute; stable on multi-block pages"),
        frontend_selector: z.string().optional().describe("CSS selector for the block on the frontend"),
        frontend_padding: z.number().optional().describe("px around the block (default 0)"),
        save_before_frontend: z.boolean().optional().describe("Publish and save first (default true)"),
        mode: z.enum(["precise", "design"]).optional().describe('Default "design"'),
        threshold: z.number().optional().describe("Per-pixel threshold 0-1"),
        maxDiffPercent: z.number().optional().describe("Default 5"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional(),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        session_id: sessionIdSchema,
        site: siteSchema,
        allow_write: allowWriteSchema,
      },
      handler: createCompareBlockHandler(ctx.core, sites, defaultOutputDir),
    });

    ctx.registerTool({
      name: "evaluate",
      description:
        "Run JS in a post's logged-in Gutenberg editor and return the value.",
      schema: {
        post_id: z.number(),
        script: z.string().describe("Wrapped in an IIFE; use `return` to yield a value"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Default {width:1280, height:720}"),
        waitForEditor: z.boolean().optional().describe("Wait for wp.data and the editor canvas (default true)"),
        session_id: sessionIdSchema,
        site: siteSchema,
      },
      handler: createEvaluateHandler(ctx.core, sites),
    });

    ctx.registerTool({
      name: "check_block",
      description:
        "Insert a block, save the post, and return registration, validity, console errors, editor and frontend screenshots, " +
        "frontend HTML, and an accessibility check. On template-locked FSE posts it inserts into core/post-content.",
      schema: {
        post_id: z.number(),
        block_name: z.string().describe('e.g. "my-plugin/my-block"'),
        attributes: z.record(z.string(), z.unknown()).optional(),
        inner_blocks: z.array(innerBlockSchema).optional(),
        frontend_selector: z.string().optional().describe("CSS selector for the block on the frontend"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional(),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        session_id: sessionIdSchema,
        site: siteSchema,
        allow_write: allowWriteSchema,
      },
      handler: createCheckBlockHandler(ctx.core, sites, defaultOutputDir),
    });

    ctx.registerTool({
      name: "publish",
      description: "Save or publish a WordPress post via the Gutenberg editor.",
      schema: {
        post_id: z.number(),
        status: z.enum(["publish", "draft", "pending", "private"]).optional().describe('Default "publish"'),
        session_id: sessionIdSchema,
        site: siteSchema,
        allow_write: allowWriteSchema,
      },
      handler: createPublishHandler(ctx.core, sites),
    });

    ctx.registerTool({
      name: "block_html",
      description:
        "Return a block's editor and frontend HTML, normalized for structural comparison (Gutenberg editor-only markup removed). " +
        "The strip_* params remove project-specific runtime markup from both sides.",
      schema: {
        post_id: z.number(),
        block_index: z.number().optional().describe("Top-level index, 0-based (default 0)"),
        client_id: z.string().optional().describe(
          "Not usable with source \"post_content\"; use block_name, block_path, or block_index there",
        ),
        block_path: z.array(z.number()).optional().describe("Nested block path"),
        block_name: z.string().optional().describe("Default: detected from the editor"),
        frontend_selector: z.string().optional().describe("CSS selector for the block on the frontend"),
        save_before_frontend: z.boolean().optional().describe("Publish and save first (default true)"),
        source: z.enum(["auto", "template", "post_content"]).optional().describe(
          "Block tree to find the target in. \"auto\" (default): the parsed post body on block-theme posts, else the editor tree. " +
          "\"template\": the editor tree (template-wrapped on block themes). \"post_content\": the parsed post body.",
        ),
        strip_attributes: z.array(z.string()).optional().describe(
          'Attribute names, exact or trailing-* prefix (e.g. "data-scroll-*")',
        ),
        strip_classes: z.array(z.string()).optional().describe("Exact class names"),
        strip_css_vars: z.array(z.string()).optional().describe(
          'Custom properties to drop from inline styles, with the leading -- (e.g. "--scroll-rotate")',
        ),
        strip_subtrees: z.array(z.string()).optional().describe("Elements with any of these classes are removed with their subtree"),
        session_id: sessionIdSchema,
        site: siteSchema,
        allow_write: allowWriteSchema,
      },
      handler: createBlockHtmlHandler(ctx.core, sites),
      resultFile: true,
    });

    ctx.registerTool({
      name: "clear_blocks",
      description:
        "Remove all blocks from a post and save. On template-locked FSE posts only core/post-content is emptied; the template stays.",
      schema: {
        post_id: z.number(),
        skip_save: z.boolean().optional().describe("Don't save (default false)"),
        session_id: sessionIdSchema,
        site: siteSchema,
        allow_write: allowWriteSchema,
      },
      handler: createClearBlocksHandler(ctx.core, sites),
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
        params.inner_blocks as unknown[] | undefined,
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
      // Refuse before clearing, so a refused save doesn't leave the editor
      // holding an unsaved empty post.
      const site = sites.forUrl(page.url());
      if (!skipSave && site) {
        assertCanWrite(site, params.allow_write === true, "save the cleared post (or pass skip_save: true)");
      }
      await waitForWpData(page);
      await clearBlocks(page);
      if (!skipSave) await savePost(page, params.allow_write === true);
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
