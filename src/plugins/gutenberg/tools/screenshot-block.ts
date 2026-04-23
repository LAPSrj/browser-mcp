import path from "node:path";
import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../auth.js";
import { navigateToEditor, getEditorFrame, checkEditorError } from "../utils/editor.js";
import {
  getBlocks,
  selectBlock,
  getBlockClientIdByIndex,
  getBlockClientIdByPath,
  getBlockFrontendHints,
  savePost,
  editPostStatus,
} from "../utils/wp-data.js";
import { findBlockOnFrontend } from "../utils/frontend-locator.js";

export function createScreenshotBlockHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
  defaultOutputDir: string,
) {
  return async (params: {
    post_id: number;
    block_index?: number;
    client_id?: string;
    block_path?: number[];
    context?: "editor" | "frontend" | "both";
    save_before_frontend?: boolean;
    hide_editor_chrome?: boolean;
    viewport?: { width: number; height: number };
    outputDir?: string;
    frontend_selector?: string;
    frontend_padding?: number;
    frontend_crop?: boolean;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      block_index,
      client_id,
      block_path,
      context = "editor",
      save_before_frontend = true,
      hide_editor_chrome = false,
      viewport = { width: 1280, height: 720 },
      outputDir = defaultOutputDir,
      frontend_selector,
      frontend_padding = 0,
      frontend_crop = true,
    } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport,
      sessionHooks,
      toolName: "gutenberg_screenshot_block",
    });

    try {
      const content: Array<{ type: string; [key: string]: unknown }> = [];
      let frontendUrl: string | undefined;
      let blockName: string | null = null;
      let targetClientId: string | undefined;

      // --- Editor screenshot ---
      if (context === "editor" || context === "both") {
        await navigateToEditor(session.page, post_id, config, auth);

        const editorError = await checkEditorError(session.page);
        if (editorError) {
          return {
            content: [{ type: "text", text: `Editor error: ${editorError}` }],
            isError: true,
          };
        }

        targetClientId = client_id;
        if (!targetClientId && block_path) {
          targetClientId = await getBlockClientIdByPath(session.page, block_path) ?? undefined;
        }
        if (!targetClientId) {
          const idx = block_index ?? 0;
          targetClientId = await getBlockClientIdByIndex(session.page, idx) ?? undefined;
        }

        if (!targetClientId) {
          const target = client_id ?? (block_path && `path ${JSON.stringify(block_path)}`)
            ?? `index ${block_index ?? 0}`;
          return {
            content: [{
              type: "text",
              text: `Block not found at ${target}. ` +
                `The editor may have no blocks or the target is out of range.`,
            }],
            isError: true,
          };
        }

        if (hide_editor_chrome) {
          await hideEditorChrome(session.page);
        } else {
          await selectBlock(session.page, targetClientId);
        }
        await session.page.waitForTimeout(300);

        const frame = await getEditorFrame(session.page);
        const blockSelector = `[data-block="${targetClientId}"]`;
        const blockElement = frame.locator(blockSelector);

        let screenshotBuffer: Buffer;
        try {
          await blockElement.waitFor({ state: "visible", timeout: 5000 });
          screenshotBuffer = await blockElement.screenshot({ type: "png" });
        } catch {
          screenshotBuffer = await session.page.screenshot({ type: "png" });
          content.push({ type: "text", text: "Could not isolate block element — full editor screenshot taken instead." });
        }

        const filename = core.generateFilename({
          prefix: "gutenberg-block-editor",
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
          text: `Editor screenshot: ${filePath} | Preview: ${previewPath}`,
        });

        const blocks = await getBlocks(session.page);
        const blockInfo = blocks.find((b) => b.clientId === targetClientId);
        blockName = blockInfo?.name ?? null;

        frontendUrl = await session.page.evaluate(() => {
          const wp = (window as any).wp;
          const post = wp.data.select("core/editor").getCurrentPost();
          return post?.link as string | undefined;
        });

        content.push({
          type: "text",
          text: `Blocks in editor: ${blocks.length} | Block: ${targetClientId}`,
        });

        if ((context === "both") && save_before_frontend) {
          await editPostStatus(session.page, "publish");
          await savePost(session.page);
        }
      }

      // --- Frontend screenshot ---
      if (context === "frontend" || context === "both") {
        // Resolve the block id + name from the editor if we didn't already
        // (frontend-only path still has to visit the editor to look up the
        // clientId and the frontend URL).
        if (!targetClientId) {
          await navigateToEditor(session.page, post_id, config, auth);
          targetClientId = client_id;
          if (!targetClientId && block_path) {
            targetClientId = await getBlockClientIdByPath(session.page, block_path) ?? undefined;
          }
          if (!targetClientId) {
            const idx = block_index ?? 0;
            targetClientId = await getBlockClientIdByIndex(session.page, idx) ?? undefined;
          }
          if (!targetClientId) {
            return {
              content: [{
                type: "text",
                text: `Block not found when resolving frontend target.`,
              }],
              isError: true,
            };
          }
          const blocks = await getBlocks(session.page);
          blockName = blocks.find((b) => b.clientId === targetClientId)?.name ?? null;

          if (save_before_frontend) {
            await editPostStatus(session.page, "publish");
            await savePost(session.page);
          }
          frontendUrl = await session.page.evaluate(() => {
            const wp = (window as any).wp;
            const post = wp.data.select("core/editor").getCurrentPost();
            return post?.link as string | undefined;
          });
        }

        // Gather hints while wp.data is still available in the editor.
        const frontendHints = blockName
          ? await getBlockFrontendHints(session.page, blockName, targetClientId)
          : null;

        if (!frontendUrl) {
          content.push({
            type: "text",
            text: "Could not determine frontend URL. The post may not be published.",
          });
        } else {
          await core.navigateTo(session.page, frontendUrl);

          let frontendBuffer: Buffer | undefined;
          let mode = "fullPage";
          if (frontend_crop && frontendHints) {
            const lookup = await findBlockOnFrontend(session.page, frontendHints, frontend_selector);
            if (lookup.matches.length > 0) {
              const matchedSelector = lookup.matches[0].matchedBy;
              const locator = session.page.locator(matchedSelector).first();
              try {
                await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
                const box = await locator.boundingBox();
                if (box) {
                  if (frontend_padding > 0) {
                    const clipX = Math.max(0, Math.floor(box.x - frontend_padding));
                    const clipY = Math.max(0, Math.floor(box.y - frontend_padding));
                    const clipW = Math.ceil(box.width + frontend_padding * 2);
                    const clipH = Math.ceil(box.height + frontend_padding * 2);
                    frontendBuffer = await session.page.screenshot({
                      type: "png",
                      clip: { x: clipX, y: clipY, width: clipW, height: clipH },
                    });
                    mode = `cropped+padding=${frontend_padding}`;
                  } else {
                    frontendBuffer = await locator.screenshot({ type: "png" });
                    mode = "cropped";
                  }
                  content.push({
                    type: "text",
                    text: `Frontend matched by: ${matchedSelector}${lookup.matches.length > 1 ? ` (${lookup.matches.length} total matches, used first)` : ""}`,
                  });
                }
              } catch {
                // Fall through to full-page capture
              }
            } else {
              content.push({
                type: "text",
                text: `Frontend block not found — tried: ${lookup.triedSelectors.join(", ")}. Falling back to full-page screenshot. Pass frontend_selector to override.`,
              });
            }
          }

          if (!frontendBuffer) {
            frontendBuffer = await session.page.screenshot({ type: "png", fullPage: true });
          }

          const filename = core.generateFilename({
            prefix: "gutenberg-block-frontend",
            browser: "chromium",
            extension: "png",
          });
          const filePath = await core.saveFile(path.join(outputDir, filename), frontendBuffer);
          const previewPath = await core.saveFile(
            path.join(outputDir, filename.replace(".png", "-preview.png")),
            core.createPreviewBuffer(frontendBuffer),
          );

          content.push({
            type: "text",
            text: `Frontend screenshot (${mode}): ${filePath} | Preview: ${previewPath}`,
          });
        }
      }

      return { content };
    } finally {
      await core.closeSession(session);
    }
  };
}

/**
 * Prepare the editor for a chrome-free block screenshot:
 *   - Clear the current block selection (removes is-selected outline/toolbar)
 *   - Close the settings sidebar, inserter, and list view panels
 *   - Inject a style sheet into the editor iframe that hides the caret,
 *     rich-text placeholders, and residual selection/hover styling
 *
 * Best-effort: swallows errors from dispatches that don't exist on this
 * WP version.
 */
async function hideEditorChrome(page: import("playwright").Page): Promise<void> {
  await page.evaluate(() => {
    const wp = (window as any).wp;
    if (!wp?.data) return;

    const tryDispatch = (store: string, action: string, ...args: unknown[]) => {
      try {
        const d = wp.data.dispatch(store);
        if (d && typeof d[action] === "function") d[action](...args);
      } catch {
        /* ignore — varies across WP versions */
      }
    };

    tryDispatch("core/block-editor", "clearSelectedBlock");
    tryDispatch("core/edit-post", "closeGeneralSidebar");
    tryDispatch("core/edit-post", "setIsInserterOpened", false);
    tryDispatch("core/edit-post", "setIsListViewOpened", false);
    tryDispatch("core/editor", "setIsInserterOpened", false);
    tryDispatch("core/editor", "setIsListViewOpened", false);

    const iframe = document.querySelector(
      'iframe[name="editor-canvas"]',
    ) as HTMLIFrameElement | null;
    const doc = iframe?.contentDocument;
    if (!doc) return;

    const id = "browser-mcp-hide-chrome";
    if (doc.getElementById(id)) return;
    const style = doc.createElement("style");
    style.id = id;
    style.textContent = `
      [contenteditable] { caret-color: transparent !important; }
      [data-rich-text-placeholder]::before,
      [data-rich-text-placeholder]::after { display: none !important; }
      [data-rich-text-placeholder] { color: transparent !important; }

      .is-selected,
      .is-hovered,
      .is-highlighted,
      .has-child-selected {
        outline: none !important;
        box-shadow: none !important;
      }
      .block-editor-block-list__block::before,
      .block-editor-block-list__block::after { display: none !important; }
    `;
    doc.head.appendChild(style);
  });
}
