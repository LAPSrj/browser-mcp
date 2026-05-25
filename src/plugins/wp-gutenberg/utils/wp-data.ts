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
 * Clear the editable post body and return how many top-level blocks were
 * removed.
 *
 * In `template-locked` (FSE block-theme) editing the editable body is the
 * controlled inner-block list of the `core/post-content` block; resetting the
 * OUTER store would wipe the surrounding template. So when a post-content block
 * is present we empty only its inner blocks (verified live: template parts stay
 * intact and `getEditedPostContent()` empties). Otherwise (classic theme /
 * `post-only` mode) the outer store IS the post body — reset it.
 */
export async function clearBlocks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wp = (window as any).wp;
    const select = wp.data.select("core/block-editor");
    const dispatch = wp.data.dispatch("core/block-editor");
    const blocks = select.getBlocks();
    let pcId: string | null = null;
    const walk = (arr: any[]): void => {
      for (const b of arr) {
        if (pcId) return;
        if (b?.name === "core/post-content") { pcId = b.clientId as string; return; }
        if (Array.isArray(b?.innerBlocks) && b.innerBlocks.length > 0) walk(b.innerBlocks);
      }
    };
    walk(blocks);
    if (pcId) {
      const count = select.getBlockOrder(pcId).length;
      dispatch.replaceInnerBlocks(pcId, [], false);
      return count;
    }
    const count = select.getBlockOrder().length;
    dispatch.resetBlocks([]);
    return count;
  });
}

// ---------------------------------------------------------------------------
// Post-content sourcing (block-theme posts)
//
// In WP 6.5+ block themes, a post's editor mounts a canvas template tree
// (`core/template-part[header] → main-wrapper → core/post-content → footer`)
// where `core/post-content` is a renderer leaf. The actual post body blocks
// live in a nested `useEntityBlockEditor("postType","post")` provider and are
// invisible to `wp.data.select("core/block-editor").getBlocks()` from outside.
// To capture a block in the post body, parse `getEditedPostContent()` for
// resolution and use `[data-block]` on the rendered DOM to pull outerHTML.
// ---------------------------------------------------------------------------

export interface ParsedPostContentBlock {
  /** Synthetic clientId from `wp.blocks.parse` — NOT the inner-store clientId on the rendered DOM. */
  clientId: string;
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks: ParsedPostContentBlock[];
}

/**
 * Find the clientId of the `core/post-content` block in the canvas tree, or
 * null when there is none (classic-theme posts / `post-only` rendering mode).
 *
 * In WP 6.5+ block-theme editing the post editor mounts in `template-locked`
 * rendering mode: the OUTER `core/block-editor` store holds the template tree
 * (`core/template-part[header] → … → core/post-content → core/template-part`)
 * and the locked canvas root REJECTS insertions. The editable post body is the
 * controlled inner-block list of the `core/post-content` block — reachable in
 * the SAME store via that block's clientId (verified live: `getBlockOrder(pc)`
 * / `insertBlock(block, idx, pc)` operate on the body and sync to
 * `getEditedPostContent()`; no nested entity-store dispatch is required).
 */
export async function getPostContentClientId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const wp = (window as any).wp;
    const blocks = wp.data.select("core/block-editor").getBlocks();
    let found: string | null = null;
    const walk = (arr: any[]): void => {
      for (const b of arr) {
        if (found) return;
        if (b?.name === "core/post-content") { found = b.clientId as string; return; }
        if (Array.isArray(b?.innerBlocks) && b.innerBlocks.length > 0) walk(b.innerBlocks);
      }
    };
    walk(blocks);
    return found;
  });
}

/**
 * Detect whether the canvas tree contains a `core/post-content` leaf at any
 * depth. This is the WP-defined signal that post body lives in a nested store
 * — a deterministic invariant, not a heuristic.
 */
export async function canvasHasPostContentLeaf(page: Page): Promise<boolean> {
  return (await getPostContentClientId(page)) !== null;
}

/**
 * Look up a single block's info by clientId via `getBlock`. Unlike
 * `getBlocks()` (which only walks the serialized outer/template tree and omits
 * controlled inner blocks such as a post body under `core/post-content`), this
 * resolves a block at ANY nesting depth — so it correctly reports validity for
 * blocks inserted into the post body in `template-locked` editing.
 */
export async function getBlockInfoById(
  page: Page,
  clientId: string,
): Promise<BlockInfo | null> {
  return page.evaluate((cid) => {
    const wp = (window as any).wp;
    const b = wp.data.select("core/block-editor").getBlock(cid);
    if (!b) return null;
    return {
      clientId: b.clientId,
      name: b.name,
      attributes: b.attributes,
      isValid: b.isValid,
      innerBlockCount: b.innerBlocks ? b.innerBlocks.length : 0,
    };
  }, clientId);
}

/**
 * Parse the post body (`getEditedPostContent()`) into a block tree. ClientIds
 * are synthetic — locate the DOM element via `locatePostContentBlockElement`.
 */
export async function parsePostContentBlocks(
  page: Page,
): Promise<ParsedPostContentBlock[]> {
  return page.evaluate(() => {
    const wp = (window as any).wp;
    const html = (wp.data.select("core/editor").getEditedPostContent() as string) ?? "";
    const parsed = wp.blocks.parse(html) as any[];
    const serialize = (b: any): any => ({
      clientId: b.clientId,
      name: b.name,
      attributes: b.attributes || {},
      innerBlocks: Array.isArray(b.innerBlocks) ? b.innerBlocks.map(serialize) : [],
    });
    return parsed.map(serialize);
  });
}

export interface PostContentResolution {
  name: string;
  attributes: Record<string, unknown>;
  /** Path through the parsed tree, e.g. [0, 1]. */
  path: number[];
  /** Depth-first index among same-name occurrences in the parsed tree. */
  sameNameIndex: number;
}

/**
 * Resolve a target block within the parsed post body by name / index / path.
 * Returns null if nothing matches.
 */
export function resolvePostContentTarget(
  tree: ParsedPostContentBlock[],
  by: { block_path?: number[]; block_index?: number; block_name?: string },
): PostContentResolution | null {
  // Compute the same-name index for a target identified by its depth-first path.
  const sameNameIndexFor = (path: number[], name: string): number => {
    let count = 0;
    let found = false;
    const walk = (arr: ParsedPostContentBlock[], prefix: number[]): boolean => {
      for (let i = 0; i < arr.length; i++) {
        const p = [...prefix, i];
        const isTarget = p.length === path.length && p.every((v, k) => v === path[k]);
        if (arr[i].name === name) {
          if (isTarget) {
            found = true;
            return true;
          }
          count++;
        }
        if (isTarget) {
          found = true;
          return true;
        }
        if (walk(arr[i].innerBlocks, p)) return true;
      }
      return false;
    };
    walk(tree, []);
    return found ? count : -1;
  };

  if (by.block_path) {
    let arr = tree;
    let current: ParsedPostContentBlock | null = null;
    for (const idx of by.block_path) {
      if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
      current = arr[idx];
      arr = current.innerBlocks;
    }
    if (!current) return null;
    return {
      name: current.name,
      attributes: current.attributes,
      path: by.block_path,
      sameNameIndex: sameNameIndexFor(by.block_path, current.name),
    };
  }

  if (typeof by.block_index === "number") {
    const idx = by.block_index;
    if (idx < 0 || idx >= tree.length) return null;
    const b = tree[idx];
    return {
      name: b.name,
      attributes: b.attributes,
      path: [idx],
      sameNameIndex: sameNameIndexFor([idx], b.name),
    };
  }

  if (by.block_name) {
    const target = by.block_name;
    let hit: { block: ParsedPostContentBlock; path: number[] } | null = null;
    const find = (arr: ParsedPostContentBlock[], prefix: number[]): void => {
      for (let i = 0; i < arr.length; i++) {
        if (hit) return;
        const p = [...prefix, i];
        if (arr[i].name === target) {
          hit = { block: arr[i], path: p };
          return;
        }
        find(arr[i].innerBlocks, p);
      }
    };
    find(tree, []);
    if (!hit) return null;
    const found = hit as { block: ParsedPostContentBlock; path: number[] };
    return {
      name: found.block.name,
      attributes: found.block.attributes,
      path: found.path,
      sameNameIndex: sameNameIndexFor(found.path, found.block.name),
    };
  }

  return null;
}

/**
 * Locate a post-body block's rendered element in the editor iframe.
 *
 *   1. If `anchor` is set, prefer `iframe doc.querySelector("#<anchor>")`.
 *   2. Else: find `[data-type="<name>"]` elements inside the canvas
 *      `[data-type="core/post-content"]` wrapper, in document order, and
 *      pick the one at `sameNameIndex`.
 */
export async function locatePostContentBlockElement(
  page: Page,
  blockName: string,
  sameNameIndex: number,
  anchor: string | null,
): Promise<{ rawHtml: string; domClientId: string | null; domClasses: string[] } | null> {
  return page.evaluate(
    ({ name, nth, anchorAttr }) => {
      const iframe = document.querySelector(
        'iframe[name="editor-canvas"]',
      ) as HTMLIFrameElement | null;
      const doc = iframe?.contentDocument || document;

      if (anchorAttr) {
        const el = doc.getElementById(anchorAttr);
        if (el) {
          return {
            rawHtml: el.outerHTML,
            domClientId: el.getAttribute("data-block"),
            domClasses: Array.from(el.classList),
          };
        }
        // Anchor not in DOM yet — fall through to position-based.
      }

      const postContentWrapper = doc.querySelector('[data-type="core/post-content"]');
      if (!postContentWrapper) return null;

      const sameNameElements = Array.from(
        postContentWrapper.querySelectorAll(`[data-type="${CSS.escape(name)}"]`),
      );
      if (nth < 0 || nth >= sameNameElements.length) return null;
      const el = sameNameElements[nth];
      return {
        rawHtml: el.outerHTML,
        domClientId: el.getAttribute("data-block"),
        domClasses: Array.from(el.classList),
      };
    },
    { name: blockName, nth: sameNameIndex, anchorAttr: anchor },
  );
}

/**
 * Build the registry-derived parts of `BlockFrontendHints` for a block name.
 * Used in post_content mode where the block-instance className and editor-DOM
 * classes are already available from the parsed block + located element, but
 * we still need defaultClassName + supportsClassName from the block registry.
 */
export async function getBlockTypeRegistryHints(
  page: Page,
  blockName: string,
): Promise<{ defaultClassName: string | null; supportsClassName: boolean }> {
  return page.evaluate((name) => {
    const wp = (window as any).wp;
    const blockType = wp.blocks.getBlockType(name);
    let defaultClassName: string | null = null;
    if (typeof wp.blocks.getBlockDefaultClassName === "function") {
      defaultClassName = wp.blocks.getBlockDefaultClassName(name) || null;
    }
    const supportsClassName = blockType?.supports?.className !== false;
    return { defaultClassName, supportsClassName };
  }, blockName);
}
