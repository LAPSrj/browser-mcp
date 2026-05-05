import path from "node:path";
import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, waitForBlockType, getEditorFrame, checkEditorError } from "../utils/editor.js";
import { insertBlock, getBlocks, isBlockRegistered, savePost } from "../utils/wp-data.js";

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
    } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport,
      sessionHooks,
      toolName: "gutenberg_insert_block",
    });

    const consoleLogs: string[] = [];

    try {
      // Capture console errors during the whole session
      session.page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleLogs.push(msg.text());
        }
      });
      session.page.on("pageerror", (error) => {
        consoleLogs.push(error.message);
      });

      await navigateToEditor(session.page, post_id, config, auth);

      // Check for editor crash
      const editorError = await checkEditorError(session.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      // Check if block type is registered
      const registered = await isBlockRegistered(session.page, block_name);
      if (!registered) {
        // Wait a bit in case it loads late
        const found = await waitForBlockType(session.page, block_name, 5000);
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

      // Insert the block
      const clientId = await insertBlock(
        session.page,
        block_name,
        attributes,
        index,
        root_client_id,
        inner_blocks,
      );

      // Let the block render
      await session.page.waitForTimeout(500);

      // Persist if requested — otherwise the insert dies with the session.
      let savedPost: { id: number; link: string; status: string } | null = null;
      if (save) {
        savedPost = await savePost(session.page);
      }

      // Get block state
      const blocks = await getBlocks(session.page, true);
      const inserted = blocks.find((b) => b.clientId === clientId);

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
        const screenshotBuffer = await session.page.screenshot({ type: "png" });
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

      return { content };
    } finally {
      await core.closeSession(session);
    }
  };
}
