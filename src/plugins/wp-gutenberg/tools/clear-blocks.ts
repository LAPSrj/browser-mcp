import type { CoreUtils, ToolResponse } from "../../types.js";
import { siteAuthHook, assertCanWrite, type WpSites } from "../../wp/sites.js";
import { resolveToolSite } from "../utils/site.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import { clearBlocks, savePost } from "../utils/wp-data.js";
import { resolveGutenbergSession } from "../utils/session.js";

export function createClearBlocksHandler(
  core: CoreUtils,
  sites: WpSites,
) {
  return async (params: {
    post_id: number;
    skip_save?: boolean;
    session_id?: string;
    site?: string;
    allow_write?: boolean;
  }): Promise<ToolResponse> => {
    const { post_id, skip_save = false, session_id, allow_write } = params;

    const site = resolveToolSite(core, sites, params);
    if (!skip_save) assertCanWrite(site, allow_write, "save the cleared post (or pass skip_save: true)");

    const resolved = await resolveGutenbergSession(core, {
      session_id,
      toolName: "gutenberg_clear_blocks",
      sessionHooks: [siteAuthHook(site)],
    });

    try {
      await navigateToEditor(resolved.page, post_id, site, sites);

      const editorError = await checkEditorError(resolved.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      const cleared = await clearBlocks(resolved.page);

      const lines = [
        `Post ${post_id}: cleared ${cleared} block(s).`,
      ];

      if (!skip_save) {
        const postInfo = await savePost(resolved.page, allow_write);
        lines.push(`Saved. Status: ${postInfo.status}`);
      } else {
        lines.push("Save skipped (skip_save: true).");
      }

      const response: ToolResponse = {
        content: [{ type: "text", text: lines.join("\n") }],
      };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}
