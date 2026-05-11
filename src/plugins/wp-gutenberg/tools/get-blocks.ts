import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import { getBlocks } from "../utils/wp-data.js";
import { resolveGutenbergSession } from "../utils/session.js";

export function createGetBlocksHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
) {
  return async (params: {
    post_id: number;
    include_inner?: boolean;
    session_id?: string;
  }): Promise<ToolResponse> => {
    const { post_id, include_inner = false, session_id } = params;

    const resolved = await resolveGutenbergSession(core, {
      session_id,
      toolName: "gutenberg_get_blocks",
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

      const blocks = await getBlocks(resolved.page, include_inner);

      const response: ToolResponse = {
        content: [{
          type: "text",
          text: blocks.length > 0
            ? JSON.stringify(blocks, null, 2)
            : "No blocks in editor.",
        }],
      };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}
