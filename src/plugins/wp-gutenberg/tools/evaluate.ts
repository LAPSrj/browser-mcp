import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";

/**
 * Run arbitrary JS inside an authenticated Gutenberg editor page and return
 * its result. Reuses the plugin's WP auth session hook so the cookie is
 * attached automatically — unlike core `evaluate_script`, which hits the
 * /wp-admin login wall.
 *
 * Captures console.* calls and runtime errors alongside the return value so
 * multi-step debugging scripts (selection inspection, wp.data probing) can
 * log intermediate state without a separate console_capture pass.
 */
export function createEvaluateHandler(
  core: CoreUtils,
  config: ResolvedPluginConfig,
  auth: WpAuth,
  sessionHooks: SessionHook[],
) {
  return async (params: {
    post_id: number;
    script: string;
    viewport?: { width: number; height: number };
    waitForEditor?: boolean;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      script,
      viewport = { width: 1280, height: 720 },
      waitForEditor = true,
    } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport,
      sessionHooks,
      toolName: "gutenberg_evaluate",
    });

    const consoleEntries: Array<{ type: string; text: string }> = [];
    const pageErrors: string[] = [];

    try {
      session.page.on("console", (msg) => {
        consoleEntries.push({ type: msg.type(), text: msg.text() });
      });
      session.page.on("pageerror", (err) => {
        pageErrors.push(err.message);
      });

      await navigateToEditor(session.page, post_id, config, auth);

      const editorError = await checkEditorError(session.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      if (waitForEditor) {
        // wp.data is the baseline — available once the editor JS has booted.
        await session.page.waitForFunction(
          () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
          { timeout: 15000 },
        );
        // The editor canvas iframe exists on modern WP; wait for its
        // contentDocument to be parseable so iframe-reaching scripts don't
        // race the iframe load. Best-effort — older WPs without the iframe
        // still pass through after a short wait.
        await session.page.waitForFunction(
          () => {
            const iframe = document.querySelector('iframe[name="editor-canvas"]') as HTMLIFrameElement | null;
            if (!iframe) return true; // no iframe on this WP version
            return iframe.contentDocument?.readyState === "complete";
          },
          { timeout: 10000 },
        ).catch(() => { /* tolerate — iframe may not exist on older WP */ });
      }

      // Wrap in IIFE so top-level `return` works, matching evaluate_script.
      const wrapped = `(() => { ${script} })()`;

      let value: unknown = undefined;
      let scriptError: string | undefined;
      try {
        value = await session.page.evaluate(wrapped);
      } catch (err) {
        scriptError = (err as Error).message;
      }

      // Small settle window so any deferred console events raised by the
      // script itself get captured before we return.
      await session.page.waitForTimeout(200);

      const payload = {
        value,
        console: consoleEntries,
        errors: scriptError ? [...pageErrors, scriptError] : pageErrors,
      };

      let valueText: string;
      try {
        valueText = JSON.stringify(payload, null, 2);
      } catch {
        // Circular / non-serializable script return — stringify fields separately
        valueText = JSON.stringify({
          value: String(value),
          console: consoleEntries,
          errors: payload.errors,
          warning: "value was not JSON-serializable; stringified via String()",
        }, null, 2);
      }

      return {
        content: [{ type: "text", text: valueText }],
        isError: scriptError !== undefined,
      };
    } finally {
      await core.closeSession(session);
    }
  };
}
