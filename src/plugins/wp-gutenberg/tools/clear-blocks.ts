import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import { clearBlocks, getBlocks, savePost } from "../utils/wp-data.js";

export function createClearBlocksHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
) {
  return async (params: {
    post_id: number;
    skip_save?: boolean;
  }): Promise<ToolResponse> => {
    const { post_id, skip_save = false } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      sessionHooks,
      toolName: "gutenberg_clear_blocks",
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

      const before = await getBlocks(session.page);
      await clearBlocks(session.page);

      const lines = [
        `Post ${post_id}: cleared ${before.length} block(s).`,
      ];

      if (!skip_save) {
        const postInfo = await savePost(session.page);
        lines.push(`Saved. Status: ${postInfo.status}`);
      } else {
        lines.push("Save skipped (skip_save: true).");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } finally {
      await core.closeSession(session);
    }
  };
}
