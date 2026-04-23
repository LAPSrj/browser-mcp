import type { CoreUtils, ResolvedPluginConfig, ToolResponse, SessionHook } from "../../types.js";
import type { WpAuth } from "../auth.js";
import { navigateToEditor, checkEditorError } from "../utils/editor.js";
import {
  selectBlock,
  getBlockClientIdByIndex,
  getBlockClientIdByPath,
} from "../utils/wp-data.js";

/**
 * Select a block in the editor and return a structured list of the buttons
 * that appear in its block toolbar. Useful for asserting "N toolbar buttons
 * registered" / "button X has the expected label" without pixel screenshots.
 */
export function createInspectToolbarHandler(
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
  }): Promise<ToolResponse> => {
    const { post_id, block_index, client_id, block_path } = params;

    const session = await core.launchSession({
      browser: "chromium",
      viewport: { width: 1440, height: 900 },
      sessionHooks,
      toolName: "gutenberg_inspect_toolbar",
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

      await selectBlock(session.page, targetClientId);
      await session.page.waitForTimeout(400);

      const toolbar = await session.page.evaluate(() => {
        // Block toolbar renders in the parent document (outside the editor
        // canvas iframe). It appears as a .block-editor-block-toolbar node
        // containing .components-toolbar-group children of buttons.
        const toolbarEl = document.querySelector(".block-editor-block-toolbar");
        if (!toolbarEl) return { found: false, groups: [], buttons: [] };

        const groups: Array<{ label: string | null; buttonCount: number }> = [];
        const buttons: Array<{
          group: string | null;
          label: string;
          ariaLabel: string | null;
          ariaPressed: string | null;
          ariaExpanded: string | null;
          disabled: boolean;
          hasIcon: boolean;
          className: string;
        }> = [];

        const groupEls = toolbarEl.querySelectorAll(".components-toolbar-group, .components-toolbar");
        for (const g of groupEls) {
          const groupLabel = g.getAttribute("aria-label") || null;
          const btns = g.querySelectorAll<HTMLButtonElement>("button");
          groups.push({ label: groupLabel, buttonCount: btns.length });
          for (const b of btns) {
            const ariaLabel = b.getAttribute("aria-label");
            const text = (b.textContent ?? "").trim();
            const label = ariaLabel?.trim() || text || "(unlabeled)";
            buttons.push({
              group: groupLabel,
              label,
              ariaLabel,
              ariaPressed: b.getAttribute("aria-pressed"),
              ariaExpanded: b.getAttribute("aria-expanded"),
              disabled: b.disabled,
              hasIcon: !!b.querySelector("svg"),
              className: b.className,
            });
          }
        }

        // Some toolbars put buttons directly under the toolbar element
        // without a .components-toolbar-group wrapper. Capture those too.
        const looseButtons = Array.from(toolbarEl.querySelectorAll<HTMLButtonElement>(":scope > button"));
        for (const b of looseButtons) {
          const ariaLabel = b.getAttribute("aria-label");
          const text = (b.textContent ?? "").trim();
          const label = ariaLabel?.trim() || text || "(unlabeled)";
          buttons.push({
            group: null,
            label,
            ariaLabel,
            ariaPressed: b.getAttribute("aria-pressed"),
            ariaExpanded: b.getAttribute("aria-expanded"),
            disabled: b.disabled,
            hasIcon: !!b.querySelector("svg"),
            className: b.className,
          });
        }

        return { found: true, groups, buttons };
      });

      const result = {
        client_id: targetClientId,
        toolbar_found: toolbar.found,
        group_count: toolbar.groups.length,
        groups: toolbar.groups,
        button_count: toolbar.buttons.length,
        buttons: toolbar.buttons,
      };

      if (!toolbar.found) {
        return {
          content: [{
            type: "text",
            text: [
              `Toolbar not found for block ${targetClientId}.`,
              `This usually means the block is not selected or the editor UI has not rendered yet.`,
              `Raw: ${JSON.stringify(result, null, 2)}`,
            ].join("\n"),
          }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } finally {
      await core.closeSession(session);
    }
  };
}
