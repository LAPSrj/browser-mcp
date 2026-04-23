import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import { getBlocks } from "../utils/wp-data.js";

export function createGetBlocksHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
) {
  return async (params: {
    post_id: number;
    include_inner?: boolean;
  }): Promise<ToolResponse> => {
    const { post_id, include_inner = false } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      sessionHooks,
      toolName: "gutenberg_get_blocks",
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

      const blocks = await getBlocks(session.page, include_inner);

      return {
        content: [{
          type: "text",
          text: blocks.length > 0
            ? JSON.stringify(blocks, null, 2)
            : "No blocks in editor.",
        }],
      };
    } finally {
      await core.closeSession(session);
    }
  };
}
