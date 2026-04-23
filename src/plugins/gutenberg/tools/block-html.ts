import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../auth.js";
import { navigateToEditor, getEditorFrame, checkEditorError } from "../utils/editor.js";
import {
  getBlockClientIdByIndex,
  getBlockClientIdByPath,
  getBlockFrontendHints,
  savePost,
  editPostStatus,
} from "../utils/wp-data.js";
import { findBlockOnFrontend } from "../utils/frontend-locator.js";

/**
 * Return normalized HTML for a block in both editor and frontend contexts.
 * Useful for structural diffing — stronger than pixel diffs for "does the
 * editor render the same thing as the frontend?".
 */
export function createBlockHtmlHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
) {
  return async (params: {
    post_id: number;
    block_index?: number;
    client_id?: string;
    block_path?: number[];
    block_name?: string;
    frontend_selector?: string;
    save_before_frontend?: boolean;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      block_index,
      client_id,
      block_path,
      block_name,
      frontend_selector,
      save_before_frontend = true,
    } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      sessionHooks,
      toolName: "gutenberg_block_html",
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

      // Resolve target block clientId (client_id > block_path > block_index)
      let targetClientId = client_id;
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
            text: `Block not found. Provide client_id, block_path, or block_index pointing at an existing block.`,
          }],
          isError: true,
        };
      }

      // Read the block's name + editor outerHTML from inside the iframe.
      const editorInfo = await session.page.evaluate((cid) => {
        const wp = (window as any).wp;
        const block = wp.data.select("core/block-editor").getBlock(cid);
        const iframe = document.querySelector(
          'iframe[name="editor-canvas"]',
        ) as HTMLIFrameElement | null;
        const doc = iframe?.contentDocument || document;
        const el = doc.querySelector(`[data-block="${cid}"]`);
        return {
          name: (block?.name as string) || null,
          rawHtml: el ? el.outerHTML : null,
        };
      }, targetClientId);

      if (!editorInfo.rawHtml) {
        return {
          content: [{
            type: "text",
            text: `Could not find the block's rendered element in the editor iframe.`,
          }],
          isError: true,
        };
      }

      const editorHtml = normalizeEditorHtml(editorInfo.rawHtml);
      const blockName = block_name || editorInfo.name;

      // Gather hints before navigating away from the editor
      const frontendHints = blockName
        ? await getBlockFrontendHints(session.page, blockName, targetClientId)
        : null;

      // Save so frontend reflects the current editor state
      if (save_before_frontend) {
        await editPostStatus(session.page, "publish");
        await savePost(session.page);
      }

      const frontendUrl = await session.page.evaluate(() => {
        const wp = (window as any).wp;
        const post = wp.data.select("core/editor").getCurrentPost();
        return post?.link as string | undefined;
      });

      let frontendHtml: string | null = null;
      let frontendMatchedBy: string | null = null;
      const diagnostics: Record<string, unknown> = {};

      if (!frontendUrl) {
        diagnostics.frontend_error = "Could not determine frontend URL.";
      } else if (!frontendHints) {
        diagnostics.frontend_error = "Could not gather frontend hints (block name unknown).";
      } else {
        await core.navigateTo(session.page, frontendUrl);
        const lookup = await findBlockOnFrontend(session.page, frontendHints, frontend_selector);
        if (lookup.matches.length > 0) {
          frontendHtml = lookup.matches[0].html;
          frontendMatchedBy = lookup.matches[0].matchedBy;
          if (lookup.matches.length > 1) {
            diagnostics.frontend_match_count = lookup.matches.length;
          }
        } else {
          diagnostics.frontend_tried_selectors = lookup.triedSelectors;
        }
      }

      const result = {
        client_id: targetClientId,
        block_name: blockName,
        editor: editorHtml,
        frontend: frontendHtml,
        frontend_matched_by: frontendMatchedBy,
        ...diagnostics,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } finally {
      await core.closeSession(session);
    }
  };
}

/**
 * Strip editor-only noise from a block's outerHTML so it can be compared
 * structurally against the frontend rendering. Removes:
 *   - data-block, data-rich-text-*, data-type, data-title attributes
 *   - contenteditable, role="document", tabindex, aria-label attributes
 *     that only exist for editor UX
 *   - is-selected / is-hovered / is-highlighted / has-child-selected classes
 *   - .block-editor-block-toolbar and related wrapper nodes
 *   - wp-block-editor internal wrapper classes (block-editor-*)
 */
function normalizeEditorHtml(raw: string): string {
  let html = raw;

  // Remove editor-only attributes (data-*, contenteditable, role=document, tabindex, spellcheck,
  // aria-multiline, aria-describedby-like UX hooks)
  html = html.replace(/\s(data-(?:block|type|title|rich-text-[\w-]+|empty|wp-block)|contenteditable|spellcheck|aria-multiline|tabindex)="[^"]*"/g, "");
  html = html.replace(/\s(data-(?:block|type|title|rich-text-[\w-]+|empty|wp-block)|contenteditable|spellcheck|aria-multiline|tabindex)='[^']*'/g, "");
  html = html.replace(/\srole="document"/g, "");
  html = html.replace(/\srole='document'/g, "");

  // Strip editor-only classes inside class="..." attributes. Handles single
  // class values or space-separated lists while preserving the attribute.
  const editorClasses = [
    "is-selected",
    "is-hovered",
    "is-highlighted",
    "has-child-selected",
    "is-multi-selected",
    "is-typing",
    "is-focused",
    "is-focus-mode",
    "is-reusable",
    "wp-block-post-content",
  ];
  html = html.replace(/class="([^"]*)"/g, (_m, cls) => {
    const kept = String(cls)
      .split(/\s+/)
      .filter((c) => c && !editorClasses.includes(c) && !c.startsWith("block-editor-"))
      .join(" ");
    return kept ? `class="${kept}"` : "";
  });
  html = html.replace(/class='([^']*)'/g, (_m, cls) => {
    const kept = String(cls)
      .split(/\s+/)
      .filter((c) => c && !editorClasses.includes(c) && !c.startsWith("block-editor-"))
      .join(" ");
    return kept ? `class='${kept}'` : "";
  });

  // Remove the floating block toolbar if it got captured (rare — it's
  // usually a sibling of the block element, but we strip it defensively).
  html = html.replace(
    /<div[^>]*class="[^"]*block-editor-block-toolbar[^"]*"[^>]*>[\s\S]*?<\/div>/g,
    "",
  );

  // Collapse whitespace between tags so whitespace-only diffs don't
  // pollute comparisons.
  html = html.replace(/>\s+</g, "><").trim();

  return html;
}
