import type { Page } from "playwright";

// Types returned by wp.data queries, kept minimal for serialization

export interface BlockInfo {
  clientId: string;
  name: string;
  attributes: Record<string, unknown>;
  isValid: boolean;
  innerBlockCount: number;
  /** Only present when getBlocks() is called with includeInner: true. */
  innerBlocks?: BlockInfo[];
}

export interface PostInfo {
  id: number;
  link: string;
  status: string;
}

/**
 * Insert a block into the editor via wp.data.dispatch.
 * Returns the new block's clientId.
 *
 * @param index        Position to insert at (default: append to end of parent)
 * @param rootClientId Parent block's clientId for nested insertion (default: top level)
 * @param innerBlocks  Children to seed under this block (recursive). Each node:
 *                     { name, attributes?, innerBlocks? }.
 */
export async function insertBlock(
  page: Page,
  blockName: string,
  attributes?: Record<string, unknown>,
  index?: number,
  rootClientId?: string,
  innerBlocks?: unknown[],
): Promise<string> {
  return page.evaluate(
    ({ name, attrs, idx, root, inner }) => {
      const wp = (window as any).wp;
      const buildTree = (node: any): any =>
        wp.blocks.createBlock(
          node.name,
          node.attributes || {},
          Array.isArray(node.innerBlocks) ? node.innerBlocks.map(buildTree) : [],
        );
      const children = Array.isArray(inner) ? inner.map(buildTree) : [];
      const block = wp.blocks.createBlock(name, attrs || {}, children);
      wp.data.dispatch("core/block-editor").insertBlock(block, idx, root);
      return block.clientId as string;
    },
    { name: blockName, attrs: attributes, idx: index, root: rootClientId, inner: innerBlocks },
  );
}

/**
 * Get all top-level blocks in the editor. When includeInner is true,
 * each block's innerBlocks are returned recursively as a nested tree.
 */
export async function getBlocks(
  page: Page,
  includeInner = false,
): Promise<BlockInfo[]> {
  return page.evaluate((recurse: boolean) => {
    const serialize = (b: any): any => {
      const out: any = {
        clientId: b.clientId,
        name: b.name,
        attributes: b.attributes,
        isValid: b.isValid,
        innerBlockCount: b.innerBlocks ? b.innerBlocks.length : 0,
      };
      if (recurse && b.innerBlocks && b.innerBlocks.length > 0) {
        out.innerBlocks = b.innerBlocks.map(serialize);
      }
      return out;
    };
    const wp = (window as any).wp;
    const blocks = wp.data.select("core/block-editor").getBlocks();
    return blocks.map(serialize);
  }, includeInner);
}

/**
 * Update attributes on a specific block.
 */
export async function updateBlockAttributes(
  page: Page,
  clientId: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ cid, attrs }) => {
      const wp = (window as any).wp;
      wp.data.dispatch("core/block-editor").updateBlockAttributes(cid, attrs);
    },
    { cid: clientId, attrs: attributes },
  );
}

/**
 * Select a block in the editor (opens its toolbar/inspector).
 */
export async function selectBlock(
  page: Page,
  clientId: string,
): Promise<void> {
  await page.evaluate(
    (cid) => {
      const wp = (window as any).wp;
      wp.data.dispatch("core/block-editor").selectBlock(cid);
    },
    clientId,
  );
}

/**
 * Save/publish the post via wp.data.dispatch.
 */
export async function savePost(page: Page): Promise<PostInfo> {
  return page.evaluate(async () => {
    const wp = (window as any).wp;
    await wp.data.dispatch("core/editor").savePost();
    const post = wp.data.select("core/editor").getCurrentPost();
    return {
      id: post.id,
      link: post.link,
      status: post.status,
    };
  });
}

/**
 * Update post status (e.g. switch from draft to publish).
 */
export async function editPostStatus(
  page: Page,
  status: string,
): Promise<void> {
  await page.evaluate(
    (s) => {
      const wp = (window as any).wp;
      wp.data.dispatch("core/editor").editPost({ status: s });
    },
    status,
  );
}

/**
 * Check if a block type is registered.
 */
export async function isBlockRegistered(
  page: Page,
  blockName: string,
): Promise<boolean> {
  return page.evaluate(
    (name) => {
      const wp = (window as any).wp;
      return !!(wp && wp.blocks && wp.blocks.getBlockType(name));
    },
    blockName,
  );
}

export interface BlockFrontendHints {
  /** Default WP-generated class (e.g. "wp-block-my-plugin-my-block"). */
  defaultClassName: string | null;
  /** User-supplied className attribute on this specific block instance. */
  customClassName: string | null;
  /** Whether the block opts out of the default className (supports.className: false). */
  supportsClassName: boolean;
  /** Actual class attribute from the rendered DOM in the editor iframe. */
  editorDomClasses: string[] | null;
}

/**
 * Gather hints about how a block will render on the frontend, to help
 * locate it in the rendered HTML. Reads both the block type registry
 * (for default class logic) and the block's actual editor DOM.
 */
export async function getBlockFrontendHints(
  page: Page,
  blockName: string,
  clientId: string,
): Promise<BlockFrontendHints> {
  return page.evaluate(
    ({ name, cid }) => {
      const wp = (window as any).wp;
      const blockType = wp.blocks.getBlockType(name);

      // WP's official way to get the default class name for a block.
      // Returns strings like "wp-block-paragraph" for core/paragraph,
      // "wp-block-my-plugin-my-block" for my-plugin/my-block.
      let defaultClassName: string | null = null;
      if (typeof wp.blocks.getBlockDefaultClassName === "function") {
        defaultClassName = wp.blocks.getBlockDefaultClassName(name) || null;
      }

      // Whether the block disables the auto-generated class
      const supportsClassName =
        blockType?.supports?.className !== false;

      // The user-supplied className attribute on this block instance
      const block = wp.data.select("core/block-editor").getBlock(cid);
      const customClassName = (block?.attributes?.className as string) || null;

      // Introspect the actual DOM class list from the editor iframe
      let editorDomClasses: string[] | null = null;
      const iframe = document.querySelector(
        'iframe[name="editor-canvas"]',
      ) as HTMLIFrameElement | null;
      const doc = iframe?.contentDocument || document;
      const el = doc.querySelector(`[data-block="${cid}"]`);
      if (el) {
        editorDomClasses = Array.from(el.classList);
      }

      return {
        defaultClassName,
        customClassName,
        supportsClassName,
        editorDomClasses,
      };
    },
    { name: blockName, cid: clientId },
  );
}

/**
 * Get the clientId of a block by its index (0-based) among top-level blocks.
 */
export async function getBlockClientIdByIndex(
  page: Page,
  index: number,
): Promise<string | null> {
  return page.evaluate(
    (idx) => {
      const wp = (window as any).wp;
      const blocks = wp.data.select("core/block-editor").getBlocks();
      if (idx < 0 || idx >= blocks.length) return null;
      return blocks[idx].clientId as string;
    },
    index,
  );
}

/**
 * Get the clientId of a block at a nested path. E.g. [0, 1] = second child
 * of the first top-level block. Returns null if any index is out of range.
 */
export async function getBlockClientIdByPath(
  page: Page,
  path: number[],
): Promise<string | null> {
  return page.evaluate(
    (p) => {
      const wp = (window as any).wp;
      let blocks = wp.data.select("core/block-editor").getBlocks();
      let current: any = null;
      for (const idx of p) {
        if (!Array.isArray(blocks) || idx < 0 || idx >= blocks.length) return null;
        current = blocks[idx];
        blocks = current.innerBlocks || [];
      }
      return (current?.clientId as string) || null;
    },
    path,
  );
}

/**
 * Remove a block from the editor.
 */
export async function removeBlock(
  page: Page,
  clientId: string,
): Promise<void> {
  await page.evaluate(
    (cid) => {
      const wp = (window as any).wp;
      wp.data.dispatch("core/block-editor").removeBlock(cid);
    },
    clientId,
  );
}

/**
 * Reset the editor's block list to empty.
 */
export async function clearBlocks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const wp = (window as any).wp;
    wp.data.dispatch("core/block-editor").resetBlocks([]);
  });
}
