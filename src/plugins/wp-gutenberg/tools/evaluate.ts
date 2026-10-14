import type { CoreUtils, ToolResponse } from "../../types.js";
import { siteAuthHook, type WpSites } from "../../wp/sites.js";
import { resolveToolSite } from "../utils/site.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import { resolveGutenbergSession } from "../utils/session.js";
import { evaluateScript } from "../../../utils/actions.js";

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
  sites: WpSites,
) {
  return async (params: {
    post_id: number;
    script: string;
    viewport?: { width: number; height: number };
    waitForEditor?: boolean;
    session_id?: string;
    site?: string;
  }): Promise<ToolResponse> => {
    const {
      post_id,
      script,
      viewport = { width: 1280, height: 720 },
      waitForEditor = true,
      session_id,
    } = params;

    const site = resolveToolSite(core, sites, params);
    const resolved = await resolveGutenbergSession(core, {
      session_id,
      toolName: "gutenberg_evaluate",
      sessionHooks: [siteAuthHook(site)],
      viewport,
    });

    const consoleEntries: Array<{ type: string; text: string }> = [];
    const pageErrors: string[] = [];

    try {
      resolved.page.on("console", (msg) => {
        consoleEntries.push({ type: msg.type(), text: msg.text() });
      });
      resolved.page.on("pageerror", (err) => {
        pageErrors.push(err.message);
      });

      await navigateToEditor(resolved.page, post_id, site, sites);

      const editorError = await checkEditorError(resolved.page);
      if (editorError) {
        return {
          content: [{ type: "text", text: `Editor error: ${editorError}` }],
          isError: true,
        };
      }

      if (waitForEditor) {
        // wp.data is the baseline — available once the editor JS has booted.
        // navigateToEditor → waitForEditor already waits for it and for the
        // canvas iframe's document, so this is a cheap second check.
        await resolved.page.waitForFunction(
          () => typeof (window as any).wp !== "undefined" && (window as any).wp.data,
          { timeout: 15000 },
        );
      }

      let value: unknown = undefined;
      let scriptError: string | undefined;
      try {
        value = await evaluateScript(resolved.page, script);
      } catch (err) {
        scriptError = (err as Error).message;
      }

      // Small settle window so any deferred console events raised by the
      // script itself get captured before we return.
      await resolved.page.waitForTimeout(200);

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

      const response: ToolResponse = {
        content: [{ type: "text", text: valueText }],
        isError: scriptError !== undefined,
      };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}
