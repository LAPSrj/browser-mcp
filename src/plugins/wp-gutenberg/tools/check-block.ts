import path from "node:path";
import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, waitForBlockType, checkEditorError } from "../utils/editor.js";
import {
  insertBlock, getBlocks, isBlockRegistered, savePost, editPostStatus,
  getBlockFrontendHints,
} from "../utils/wp-data.js";
import { findBlockOnFrontend } from "../utils/frontend-locator.js";
import { walkAccessibilityTree } from "../../../utils/a11y-walker.js";

/**
 * Comprehensive block validation tool. Inserts a block, checks registration,
 * validity, console errors, takes editor + frontend screenshots, and extracts
 * the frontend DOM for the block.
 */
export function createCheckBlockHandler(
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
    frontend_selector?: string;
    viewport?: { width: number; height: number };
    outputDir?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      block_name,
      attributes,
      inner_blocks,
      frontend_selector,
      viewport = { width: 1280, height: 720 },
      outputDir = defaultOutputDir,
    } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport,
      sessionHooks,
      toolName: "gutenberg_check_block",
    });

    const consoleErrors: string[] = [];

    try {
      // Capture errors
      session.page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(msg.text());
        }
      });
      session.page.on("pageerror", (error) => {
        consoleErrors.push(error.message);
      });

      const content: Array<{ type: string; [key: string]: unknown }> = [];
      const results: Record<string, unknown> = {};

      // 1. Navigate to editor
      await navigateToEditor(session.page, post_id, config, auth);

      const editorError = await checkEditorError(session.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      // 2. Check block registration
      let registered = await isBlockRegistered(session.page, block_name);
      if (!registered) {
        registered = await waitForBlockType(session.page, block_name, 5000);
      }
      results.is_registered = registered;

      if (!registered) {
        results.is_valid = false;
        results.console_errors = consoleErrors;
        content.push({
          type: "text",
          text: JSON.stringify(results, null, 2),
        });
        return { content };
      }

      // 3. Insert block
      const clientId = await insertBlock(
        session.page,
        block_name,
        attributes,
        undefined,
        undefined,
        inner_blocks,
      );
      await session.page.waitForTimeout(500);

      // 4. Check validity
      const blocks = await getBlocks(session.page);
      const inserted = blocks.find((b) => b.clientId === clientId);
      results.is_valid = inserted?.isValid ?? false;
      results.block_attributes = inserted?.attributes;

      // 5. Editor screenshot
      const editorBuffer = await session.page.screenshot({ type: "png" });
      const editorFilename = core.generateFilename({
        prefix: "gutenberg-check-editor",
        browser: "chromium",
        extension: "png",
      });
      const editorPath = await core.saveFile(path.join(outputDir, editorFilename), editorBuffer);
      const editorPreviewPath = await core.saveFile(
        path.join(outputDir, editorFilename.replace(".png", "-preview.png")),
        core.createPreviewBuffer(editorBuffer),
      );
      results.editor_screenshot = editorPath;

      // 6. Publish and check frontend
      await editPostStatus(session.page, "publish");
      const postInfo = await savePost(session.page);
      results.post_url = postInfo.link;

      if (postInfo.link) {
        // Before navigating away, gather hints from the editor about how
        // this block will render on the frontend (default class, custom
        // className, actual DOM classes from the iframe)
        const frontendHints = await getBlockFrontendHints(
          session.page,
          block_name,
          clientId,
        );

        await core.navigateTo(session.page, postInfo.link);

        // Frontend screenshot
        const frontendBuffer = await session.page.screenshot({ type: "png", fullPage: true });
        const frontendFilename = core.generateFilename({
          prefix: "gutenberg-check-frontend",
          browser: "chromium",
          extension: "png",
        });
        const frontendPath = await core.saveFile(path.join(outputDir, frontendFilename), frontendBuffer);
        const frontendPreviewPath = await core.saveFile(
          path.join(outputDir, frontendFilename.replace(".png", "-preview.png")),
          core.createPreviewBuffer(frontendBuffer),
        );
        results.frontend_screenshot = frontendPath;

        // Locate the rendered block(s) using hints + optional override.
        // Returns ALL matches, so repeated blocks all get captured.
        const lookup = await findBlockOnFrontend(
          session.page,
          frontendHints,
          frontend_selector,
        );

        if (lookup.matches.length > 0) {
          results.frontend_html = lookup.matches.map((m) => m.html);
          results.frontend_matched_by = lookup.matches[0].matchedBy;
          results.frontend_match_count = lookup.matches.length;
        } else {
          results.frontend_html = null;
          results.frontend_lookup_failed = true;
          results.frontend_tried_selectors = lookup.triedSelectors;
          results.frontend_hints = frontendHints;
        }

        // Accessibility check: scope to the block element when possible,
        // otherwise fall back to the full body
        const a11yRoot = lookup.matches[0]?.matchedBy;
        try {
          const a11yTree = await walkAccessibilityTree(session.page, a11yRoot);
          if (a11yTree) {
            results.accessibility_snapshot = a11yTree;
          }
        } catch {
          // DOM walker is resilient, but evaluate() can fail if the page navigates
        }
      }

      // 7. Console errors
      results.console_errors = consoleErrors;

      content.push({
        type: "text",
        text: JSON.stringify(results, null, 2),
      });

      content.push({
        type: "text",
        text: `Editor: ${editorPath} | Preview: ${editorPreviewPath}`,
      });

      if (results.frontend_screenshot) {
        content.push({
          type: "text",
          text: `Frontend: ${results.frontend_screenshot}`,
        });
      }

      return { content };
    } finally {
      await core.closeSession(session);
    }
  };
}
