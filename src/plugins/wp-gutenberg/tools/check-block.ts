import path from "node:path";
import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, waitForBlockType, checkEditorError } from "../utils/editor.js";
import {
  insertBlock, getBlockInfoById, getPostContentClientId, isBlockRegistered,
  savePost, editPostStatus, getBlockFrontendHints,
} from "../utils/wp-data.js";
import { findBlockOnFrontend } from "../utils/frontend-locator.js";
import { walkAccessibilityTree } from "../../../utils/a11y-walker.js";
import { resolveGutenbergSession } from "../utils/session.js";

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
    session_id?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      block_name,
      attributes,
      inner_blocks,
      frontend_selector,
      viewport = { width: 1280, height: 720 },
      outputDir = defaultOutputDir,
      session_id,
    } = params;

    const resolved = await resolveGutenbergSession(core, {
      session_id,
      toolName: "gutenberg_check_block",
      sessionHooks,
      viewport,
    });

    const consoleErrors: string[] = [];

    try {
      // Capture errors
      resolved.page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(msg.text());
        }
      });
      resolved.page.on("pageerror", (error) => {
        consoleErrors.push(error.message);
      });

      const content: Array<{ type: string; [key: string]: unknown }> = [];
      const results: Record<string, unknown> = {};

      // 1. Navigate to editor
      await navigateToEditor(resolved.page, post_id, config, auth);

      const editorError = await checkEditorError(resolved.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      // 2. Check block registration
      let registered = await isBlockRegistered(resolved.page, block_name);
      if (!registered) {
        registered = await waitForBlockType(resolved.page, block_name, 5000);
      }
      results.is_registered = registered;

      if (!registered) {
        results.is_valid = false;
        results.console_errors = consoleErrors;
        content.push({
          type: "text",
          text: JSON.stringify(results, null, 2),
        });
        const earlyResponse: ToolResponse = { content };
        if (resolved.warnings.length > 0) earlyResponse._warnings = resolved.warnings;
        return earlyResponse;
      }

      // 3. Insert block. In template-locked FSE editing the outer store top
      // level is the locked template canvas — inserting there is silently
      // rejected, producing a false "invalid" verdict. Redirect to the editable
      // post body (the core/post-content controlled inner-block list) when one
      // is present; otherwise (classic / post-only) insert at the top level.
      const postContentClientId = await getPostContentClientId(resolved.page);
      const clientId = await insertBlock(
        resolved.page,
        block_name,
        attributes,
        undefined,
        postContentClientId ?? undefined,
        inner_blocks,
      );
      await resolved.page.waitForTimeout(500);

      // 4. Check validity. Look up by clientId so the block is found at any
      // nesting depth (incl. inside core/post-content), not just top level.
      const inserted = await getBlockInfoById(resolved.page, clientId);
      results.is_valid = inserted?.isValid ?? false;
      results.block_attributes = inserted?.attributes;

      // 5. Editor screenshot
      const editorBuffer = await resolved.page.screenshot({ type: "png" });
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
      await editPostStatus(resolved.page, "publish");
      const postInfo = await savePost(resolved.page);
      results.post_url = postInfo.link;

      if (postInfo.link) {
        // Before navigating away, gather hints from the editor about how
        // this block will render on the frontend (default class, custom
        // className, actual DOM classes from the iframe)
        const frontendHints = await getBlockFrontendHints(
          resolved.page,
          block_name,
          clientId,
        );

        await core.navigateTo(resolved.page, postInfo.link);

        // Frontend screenshot
        const frontendBuffer = await resolved.page.screenshot({ type: "png", fullPage: true });
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
          resolved.page,
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
          const a11yTree = await walkAccessibilityTree(resolved.page, a11yRoot);
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

      const response: ToolResponse = { content };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}
