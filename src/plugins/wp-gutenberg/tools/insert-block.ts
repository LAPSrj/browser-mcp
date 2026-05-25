import path from "node:path";
import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, waitForBlockType, getEditorFrame, checkEditorError } from "../utils/editor.js";
import { insertBlock, getBlocks, getBlockInfoById, getPostContentClientId, isBlockRegistered, savePost } from "../utils/wp-data.js";
import { resolveGutenbergSession } from "../utils/session.js";

export function createInsertBlockHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
  defaultOutputDir: string,
) {
  return async (params: {
    post_id: number;
    block_name: string;
    attributes?: Record<string, unknown>;
    inner_blocks?: unknown[];
    index?: number;
    root_client_id?: string;
    save?: boolean;
    screenshot?: boolean;
    viewport?: { width: number; height: number };
    outputDir?: string;
    session_id?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      block_name,
      attributes,
      inner_blocks,
      index,
      root_client_id,
      save = false,
      screenshot = true,
      viewport = { width: 1280, height: 720 },
      outputDir = defaultOutputDir,
      session_id,
    } = params;

    const resolved = await resolveGutenbergSession(core, {
      session_id,
      toolName: "gutenberg_insert_block",
      sessionHooks,
      viewport,
    });

    const consoleLogs: string[] = [];

    try {
      // Capture console errors during the whole session
      resolved.page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleLogs.push(msg.text());
        }
      });
      resolved.page.on("pageerror", (error) => {
        consoleLogs.push(error.message);
      });

      await navigateToEditor(resolved.page, post_id, config, auth);

      // Check for editor crash
      const editorError = await checkEditorError(resolved.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      // Check if block type is registered
      const registered = await isBlockRegistered(resolved.page, block_name);
      if (!registered) {
        // Wait a bit in case it loads late
        const found = await waitForBlockType(resolved.page, block_name, 5000);
        if (!found) {
          return {
            content: [{
              type: "text",
              text: `Block type "${block_name}" is not registered. ` +
                `Make sure the plugin providing this block is activated.`,
            }],
            isError: true,
          };
        }
      }

      // Resolve where to insert. In template-locked FSE editing the outer
      // store top level is the locked template canvas — inserting there is
      // silently rejected (the block lands nowhere and never reaches the saved
      // post body). Redirect to the editable post body (the core/post-content
      // controlled inner-block list) unless the caller named an explicit root.
      let effectiveRoot = root_client_id;
      if (!effectiveRoot) {
        const postContentClientId = await getPostContentClientId(resolved.page);
        if (postContentClientId) effectiveRoot = postContentClientId;
      }

      // Insert the block
      const clientId = await insertBlock(
        resolved.page,
        block_name,
        attributes,
        index,
        effectiveRoot,
        inner_blocks,
      );

      // Let the block render
      await resolved.page.waitForTimeout(500);

      // Persist if requested — otherwise the insert dies with the session.
      let savedPost: { id: number; link: string; status: string } | null = null;
      if (save) {
        savedPost = await savePost(resolved.page);
      }

      // Get block state. Look the block up by clientId (resolves at any
      // nesting depth, incl. the post body under core/post-content) rather than
      // scanning only the serialized top-level tree.
      const inserted = await getBlockInfoById(resolved.page, clientId);
      const blocks = await getBlocks(resolved.page);

      const content: Array<{ type: string; [key: string]: unknown }> = [];

      content.push({
        type: "text",
        text: [
          `Block inserted: ${block_name}`,
          `Client ID: ${clientId}`,
          `Valid: ${inserted?.isValid ?? "unknown"}`,
          `Total blocks in editor: ${blocks.length}`,
          inserted ? `Attributes: ${JSON.stringify(inserted.attributes)}` : "",
          inserted?.innerBlockCount
            ? `Inner blocks: ${inserted.innerBlockCount}`
            : "",
          savedPost ? `Saved: ${savedPost.link} (${savedPost.status})` : "Not saved (set save: true to persist)",
        ].filter(Boolean).join("\n"),
      });

      // Take screenshot if requested
      if (screenshot) {
        const screenshotBuffer = await resolved.page.screenshot({ type: "png" });
        const filename = core.generateFilename({
          prefix: "gutenberg-insert",
          browser: "chromium",
          extension: "png",
        });
        const filePath = await core.saveFile(path.join(outputDir, filename), screenshotBuffer);
        const previewPath = await core.saveFile(
          path.join(outputDir, filename.replace(".png", "-preview.png")),
          core.createPreviewBuffer(screenshotBuffer),
        );

        content.push({
          type: "text",
          text: `Screenshot saved: ${filePath} | Preview: ${previewPath}`,
        });
      }

      // Report console errors
      if (consoleLogs.length > 0) {
        content.push({
          type: "text",
          text: `Console errors (${consoleLogs.length}):\n${consoleLogs.join("\n")}`,
        });
      }

      const response: ToolResponse = { content };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}
