import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import { savePost, editPostStatus } from "../utils/wp-data.js";
import { resolveGutenbergSession } from "../utils/session.js";

export function createPublishHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
) {
  return async (params: {
    post_id: number;
    status?: string;
    session_id?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      status = "publish",
      session_id,
    } = params;

    const resolved = await resolveGutenbergSession(core, {
      session_id,
      toolName: "gutenberg_publish",
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

      // Idempotent publish: skip the editPost + savePost dispatches when the
      // post is already in the requested status AND has no dirty edits. This
      // avoids sending redundant REST calls on re-runs.
      const currentStatus = await resolved.page.evaluate(() => {
        const wp = (window as any).wp;
        const post = wp.data.select("core/editor").getCurrentPost();
        return post?.status as string | undefined;
      });

      const statusNeedsChange = currentStatus !== status;
      if (statusNeedsChange) {
        await editPostStatus(resolved.page, status);
      }

      const isDirty = await resolved.page.evaluate(() => {
        const wp = (window as any).wp;
        const sel = wp.data.select("core/editor");
        return typeof sel.isEditedPostDirty === "function"
          ? sel.isEditedPostDirty()
          : true;
      });

      let postInfo;
      let skipped = false;
      if (statusNeedsChange || isDirty) {
        postInfo = await savePost(resolved.page);
      } else {
        skipped = true;
        postInfo = await resolved.page.evaluate(() => {
          const wp = (window as any).wp;
          const post = wp.data.select("core/editor").getCurrentPost();
          return {
            id: post.id,
            link: post.link,
            status: post.status,
          };
        });
      }

      const response: ToolResponse = {
        content: [{
          type: "text",
          text: [
            skipped
              ? `Post ${post_id} already ${postInfo.status} with no pending changes — save skipped.`
              : `Post ${post_id} saved.`,
            `Status: ${postInfo.status}`,
            `URL: ${postInfo.link}`,
          ].join("\n"),
        }],
      };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}
