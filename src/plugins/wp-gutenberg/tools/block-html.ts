import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, getEditorFrame, checkEditorError } from "../utils/editor.js";
import {
  getBlockClientIdByIndex,
  getBlockClientIdByPath,
  getBlockFrontendHints,
  savePost,
  editPostStatus,
  canvasHasPostContentLeaf,
  parsePostContentBlocks,
  resolvePostContentTarget,
  locatePostContentBlockElement,
  getBlockTypeRegistryHints,
} from "../utils/wp-data.js";
import type { BlockFrontendHints } from "../utils/wp-data.js";
import { findBlockOnFrontend } from "../utils/frontend-locator.js";
import { normalizeBlockHtmlOnPage } from "../utils/normalize-html.js";
import { resolveGutenbergSession } from "../utils/session.js";

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
    source?: "auto" | "template" | "post_content";
    strip_attributes?: string[];
    strip_classes?: string[];
    strip_css_vars?: string[];
    strip_subtrees?: string[];
    session_id?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      block_index,
      client_id,
      block_path,
      block_name,
      frontend_selector,
      save_before_frontend = true,
      source = "auto",
      strip_attributes,
      strip_classes,
      strip_css_vars,
      strip_subtrees,
      session_id,
    } = params;

    const resolved = await resolveGutenbergSession(core, {
      session_id,
      toolName: "gutenberg_block_html",
      sessionHooks,
    });

    try {
      await navigateToEditor(resolved.page, post_id, config, auth);

      const editorError = await checkEditorError(resolved.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      // Pick the resolution mode. "auto" detects a core/post-content leaf in
      // the canvas tree — the WP invariant signaling that post body lives in
      // a nested BlockEditorProvider invisible to core/block-editor.getBlocks().
      let effectiveSource: "template" | "post_content";
      if (source === "post_content") {
        effectiveSource = "post_content";
      } else if (source === "template") {
        effectiveSource = "template";
      } else {
        effectiveSource = (await canvasHasPostContentLeaf(resolved.page))
          ? "post_content"
          : "template";
      }

      let reportedClientId: string | null = null;
      let editorRawHtml: string | null = null;
      let resolvedBlockName: string | null = null;
      let postContentHints: {
        customClassName: string | null;
        domClasses: string[];
      } | null = null;

      if (effectiveSource === "post_content") {
        if (client_id) {
          return {
            content: [{
              type: "text",
              text:
                `client_id is not usable with source: "post_content" — blocks parsed ` +
                `from getEditedPostContent() have synthetic clientIds that don't ` +
                `match the inner BlockEditor store. Use block_name, block_path, or ` +
                `block_index.`,
            }],
            isError: true,
          };
        }

        const tree = await parsePostContentBlocks(resolved.page);
        const target = resolvePostContentTarget(tree, {
          block_path,
          block_index,
          block_name,
        });
        if (!target) {
          return {
            content: [{
              type: "text",
              text:
                `Block not found in post body. ` +
                (block_name
                  ? `No block named "${block_name}" in the post content parsed from getEditedPostContent().`
                  : `No block at the given block_path / block_index in the parsed post content.`),
            }],
            isError: true,
          };
        }

        const located = await locatePostContentBlockElement(
          resolved.page,
          target.name,
          target.sameNameIndex,
          (target.attributes.anchor as string | undefined) ?? null,
        );
        if (!located) {
          return {
            content: [{
              type: "text",
              text:
                `Resolved "${target.name}" in the parsed post content but couldn't ` +
                `find its rendered element inside the editor iframe's ` +
                `[data-type="core/post-content"] wrapper.`,
            }],
            isError: true,
          };
        }

        editorRawHtml = located.rawHtml;
        reportedClientId = located.domClientId;
        resolvedBlockName = target.name;
        postContentHints = {
          customClassName: (target.attributes.className as string | undefined) ?? null,
          domClasses: located.domClasses,
        };
      } else {
        // template path — canonical behavior. Resolve via core/block-editor's
        // outer store, identical to the pre-`source` plugin.
        let targetClientId = client_id;
        if (!targetClientId && block_path) {
          targetClientId = await getBlockClientIdByPath(resolved.page, block_path) ?? undefined;
        }
        if (!targetClientId) {
          const idx = block_index ?? 0;
          targetClientId = await getBlockClientIdByIndex(resolved.page, idx) ?? undefined;
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

        const editorInfo = await resolved.page.evaluate((cid) => {
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

        editorRawHtml = editorInfo.rawHtml;
        reportedClientId = targetClientId;
        resolvedBlockName = editorInfo.name;
      }

      // Gather default classes for block types that declared
      // supports.className: false. The editor's useBlockProps adds
      // wp-block-{slug} regardless; useBlockProps.save respects the
      // opt-out. Without this strip, every core/paragraph (and friends)
      // inside an InnerBlocks zone produces a guaranteed editor/frontend
      // class diff. Done here while we're still on the editor page —
      // wp.blocks isn't available on the frontend.
      const stripDefaultClasses = await resolved.page.evaluate(() => {
        const wp = (window as any).wp;
        if (!wp?.blocks?.getBlockTypes) return [] as string[];
        const out: string[] = [];
        for (const t of wp.blocks.getBlockTypes()) {
          if (t?.supports?.className === false) {
            const cls = wp.blocks.getBlockDefaultClassName?.(t.name);
            if (cls) out.push(cls);
          }
        }
        return out;
      });

      // Normalize editor HTML on the editor page (DOM-based — handles
      // entities, attribute order, quoting consistently).
      const normalizeOptions = {
        stripDefaultClasses,
        stripAttributes: strip_attributes,
        stripClasses: strip_classes,
        stripCssVars: strip_css_vars,
        stripSubtrees: strip_subtrees,
      };
      const editorHtml = await normalizeBlockHtmlOnPage(
        resolved.page,
        editorRawHtml,
        normalizeOptions,
      );
      const blockName = block_name || resolvedBlockName;

      // Gather frontend hints before navigating away. In post_content mode we
      // already have customClassName + editorDomClasses from the parsed block
      // and located DOM element; only the registry-derived parts need a query.
      let frontendHints: BlockFrontendHints | null = null;
      if (blockName) {
        if (effectiveSource === "post_content" && postContentHints) {
          const reg = await getBlockTypeRegistryHints(resolved.page, blockName);
          frontendHints = {
            defaultClassName: reg.defaultClassName,
            customClassName: postContentHints.customClassName,
            supportsClassName: reg.supportsClassName,
            editorDomClasses: postContentHints.domClasses,
          };
        } else if (reportedClientId) {
          frontendHints = await getBlockFrontendHints(
            resolved.page,
            blockName,
            reportedClientId,
          );
        }
      }

      // Save so frontend reflects the current editor state
      if (save_before_frontend) {
        await editPostStatus(resolved.page, "publish");
        await savePost(resolved.page);
      }

      const frontendUrl = await resolved.page.evaluate(() => {
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
        await core.navigateTo(resolved.page, frontendUrl);
        const lookup = await findBlockOnFrontend(resolved.page, frontendHints, frontend_selector);
        if (lookup.matches.length > 0) {
          // Normalize on the frontend page so both sides go through the
          // same parse → walk → outerHTML pipeline (canonical entities).
          // Same options — symmetric strips, no-ops on the frontend side
          // for entries that don't appear there.
          frontendHtml = await normalizeBlockHtmlOnPage(
            resolved.page,
            lookup.matches[0].html,
            normalizeOptions,
          );
          frontendMatchedBy = lookup.matches[0].matchedBy;
          if (lookup.matches.length > 1) {
            diagnostics.frontend_match_count = lookup.matches.length;
          }
        } else {
          diagnostics.frontend_tried_selectors = lookup.triedSelectors;
        }
      }

      const result = {
        client_id: reportedClientId,
        block_name: blockName,
        source: effectiveSource,
        editor: editorHtml,
        frontend: frontendHtml,
        frontend_matched_by: frontendMatchedBy,
        ...diagnostics,
      };

      const response: ToolResponse = {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}

