import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import { savePost, editPostStatus } from "../utils/wp-data.js";

export function createPublishHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
) {
  return async (params: {
    post_id: number;
    status?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      status = "publish",
    } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      sessionHooks,
      toolName: "gutenberg_publish",
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

      // Idempotent publish: skip the editPost + savePost dispatches when the
      // post is already in the requested status AND has no dirty edits. This
      // avoids sending redundant REST calls on re-runs.
      const currentStatus = await session.page.evaluate(() => {
        const wp = (window as any).wp;
        const post = wp.data.select("core/editor").getCurrentPost();
        return post?.status as string | undefined;
      });

      const statusNeedsChange = currentStatus !== status;
      if (statusNeedsChange) {
        await editPostStatus(session.page, status);
      }

      const isDirty = await session.page.evaluate(() => {
        const wp = (window as any).wp;
        const sel = wp.data.select("core/editor");
        return typeof sel.isEditedPostDirty === "function"
          ? sel.isEditedPostDirty()
          : true;
      });

      let postInfo;
      let skipped = false;
      if (statusNeedsChange || isDirty) {
        postInfo = await savePost(session.page);
      } else {
        skipped = true;
        postInfo = await session.page.evaluate(() => {
          const wp = (window as any).wp;
          const post = wp.data.select("core/editor").getCurrentPost();
          return {
            id: post.id,
            link: post.link,
            status: post.status,
          };
        });
      }

      return {
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
    } finally {
      await core.closeSession(session);
    }
  };
}
